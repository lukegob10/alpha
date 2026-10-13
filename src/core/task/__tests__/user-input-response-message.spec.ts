import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import type { AlphaMessage, UserInputResponseData } from "@alpha-code/types"

import { Task } from "../Task"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"

const userInputResponse: UserInputResponseData = {
	questions: [{ header: "Scope", question: "Which workspace should I inspect?", answers: ["Current workspace"] }],
}
const feedbackText = "Which workspace should I inspect?\nCurrent workspace"

function createTask(messages: AlphaMessage[] = []) {
	const persisted: AlphaMessage[][] = []
	const created: AlphaMessage[] = []
	const updated: AlphaMessage[] = []
	const task = Object.create(Task.prototype) as Task
	const saveAlphaMessages = vi.fn(async () => {
		persisted.push(JSON.parse(JSON.stringify(task.clineMessages)))
		return true
	})
	Object.assign(task, {
		taskKind: "primary",
		taskId: "receipt-task",
		instanceId: "primary",
		abort: false,
		abandoned: false,
		clineMessages: structuredClone(messages),
		apiConversationHistory: [],
		lastMessageTs: 123,
		resetCompletionRecoveryState: vi.fn(),
		publishAlphaMessageCreated: vi.fn(async (message: AlphaMessage) => created.push(structuredClone(message))),
		updateAlphaMessage: vi.fn(async (message: AlphaMessage) => updated.push(structuredClone(message))),
		saveAlphaMessages,
		enqueueAlphaMessagesSave: vi.fn(async (createSnapshot: () => AlphaMessage[], onPersisted?: () => void) => {
			persisted.push(JSON.parse(JSON.stringify(createSnapshot())))
			onPersisted?.()
			return true
		}),
	})
	return { task, persisted, created, updated, saveAlphaMessages }
}

describe("Task user input response metadata", () => {
	it.each([undefined, false, true])(
		"publishes and persists receipt metadata on a new message (partial=%s)",
		async (partial) => {
			const { task, persisted, created } = createTask()
			const images = ["data:image/png;base64,example"]

			await task.say("user_feedback", feedbackText, images, partial, undefined, undefined, { userInputResponse })

			expect(created).toHaveLength(1)
			expect(created[0]).toMatchObject({ say: "user_feedback", text: feedbackText, images, userInputResponse })
			expect(persisted.at(-1)).toEqual(created)
			expect(task.apiConversationHistory).toEqual([])
		},
	)

	it("retains the receipt after the existing task-message persistence reader reloads it", async ({
		onTestFinished,
	}) => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-user-input-response-"))
		onTestFinished(async () => fs.rm(globalStoragePath, { recursive: true, force: true }))
		const { task, saveAlphaMessages } = createTask()
		saveAlphaMessages.mockImplementation(async () => {
			await saveTaskMessages({ messages: task.clineMessages, taskId: task.taskId, globalStoragePath })
			return true
		})

		await task.say("user_feedback", feedbackText, undefined, undefined, undefined, undefined, { userInputResponse })

		const reloaded = await readTaskMessages({ taskId: task.taskId, globalStoragePath, requireExisting: true })
		expect(reloaded).toHaveLength(1)
		expect(reloaded[0]).toMatchObject({ text: feedbackText, userInputResponse })
	})

	it.each([true, false])(
		"preserves the receipt while updating an existing partial row (partial=%s)",
		async (partial) => {
			const { task, persisted, created, updated } = createTask([
				{ ts: 1, type: "say", say: "user_feedback", text: "Starting reply", partial: true },
			])

			await task.say("user_feedback", feedbackText, undefined, partial, undefined, undefined, {
				userInputResponse,
			})

			expect(created).toEqual([])
			expect(updated).toHaveLength(1)
			expect(updated[0]).toMatchObject({ ts: 1, text: feedbackText, partial, userInputResponse })
			if (!partial) expect(persisted.at(-1)).toEqual(updated)
		},
	)

	it("clears stale receipt metadata when a partial feedback row is replaced by plain text", async () => {
		const { task, persisted, updated } = createTask([
			{ ts: 1, type: "say", say: "user_feedback", text: feedbackText, partial: true, userInputResponse },
		])

		await task.say("user_feedback", "Use another workspace", undefined, false)

		expect(updated[0]?.text).toBe("Use another workspace")
		expect(updated[0]?.userInputResponse).toBeUndefined()
		expect(persisted.at(-1)?.[0]?.userInputResponse).toBeUndefined()
	})

	it.each([true, false])(
		"replaces the receipt alongside retried unconsumed feedback (withReceipt=%s)",
		async (withReceipt) => {
			const { task, persisted, created, updated } = createTask([
				{
					ts: 1,
					type: "say",
					say: "user_feedback",
					text: feedbackText,
					userInputResponse,
					queuedMessageIds: ["submission-1"],
				},
			])
			const text = withReceipt ? feedbackText : "Use another workspace"

			await task.say("user_feedback", text, undefined, undefined, undefined, undefined, {
				queuedMessageIds: ["submission-1"],
				...(withReceipt ? { userInputResponse } : {}),
			})

			expect(created).toEqual([])
			expect(updated).toHaveLength(1)
			expect(updated[0]?.text).toBe(text)
			expect(updated[0]?.userInputResponse).toEqual(withReceipt ? userInputResponse : undefined)
			expect(persisted.at(-1)).toEqual(JSON.parse(JSON.stringify(updated)))
		},
	)

	it("rejects receipt metadata on another message kind before publishing", async () => {
		const { task, created, persisted } = createTask()

		await expect(
			task.say("text", feedbackText, undefined, undefined, undefined, undefined, { userInputResponse }),
		).rejects.toThrow("User input responses can only be attached to user feedback.")

		expect(created).toEqual([])
		expect(persisted).toEqual([])
	})

	it("redacts private paths in receipt fields and feedback text without mutating the caller's payload", async () => {
		const { task, created, persisted } = createTask()
		const privateRoot = path.resolve("hidden-task-storage")
		const privateWorkspace = path.join(privateRoot, "worktree")
		Object.assign(task, {
			taskKind: "subagent",
			subagentRole: "worker",
			subagentPrivateWorkspaceRoot: privateRoot,
		})
		Object.defineProperty(task, "cwd", { value: privateWorkspace })
		const response: UserInputResponseData = {
			questions: [
				{
					header: privateRoot,
					question: `Which files from ${privateWorkspace} should I inspect?`,
					answers: [`Inspect ${path.join(privateWorkspace, "src", "index.ts")}`],
				},
			],
		}
		const original = structuredClone(response)
		const text = `${response.questions[0]!.question}\n${response.questions[0]!.answers[0]}`

		await task.say("user_feedback", text, undefined, undefined, undefined, undefined, {
			userInputResponse: response,
		})

		expect(created[0]).toMatchObject({
			text: `Which files from . should I inspect?\nInspect .${path.sep}src${path.sep}index.ts`,
			userInputResponse: {
				questions: [
					{
						header: ".",
						question: "Which files from . should I inspect?",
						answers: [`Inspect .${path.sep}src${path.sep}index.ts`],
					},
				],
			},
		})
		expect(persisted.at(-1)).toEqual(created)
		expect(response).toEqual(original)
	})
})
