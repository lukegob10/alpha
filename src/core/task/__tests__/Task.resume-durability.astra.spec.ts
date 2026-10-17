import type { Anthropic } from "@anthropic-ai/sdk"

import { extractUserRequestText } from "../../agent/requestWorkClass"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))

type Content = Anthropic.Messages.ContentBlockParam[]
const stopBeforeProvider = new Error("fixture: durable input reached the provider boundary")

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

function savedToolHistory(missingResult = false): ApiMessage[] {
	return [
		{ role: "user", content: "Inspect safely in this chat", input_origin: "human", ts: 1 },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "read-one", name: "read_file", input: { path: "one.ts" } },
				...(missingResult
					? [{ type: "tool_use" as const, id: "read-two", name: "read_file", input: { path: "two.ts" } }]
					: []),
			],
			encrypted_content: "opaque-provider-state",
			ts: 2,
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "read-one", content: "COMMITTED_RESULT", is_error: false },
				{ type: "text", text: "<user_message>Preserve my local edits</user_message>" },
			],
			input_origin: "human",
			queued_message_ids: ["old-guidance"],
			ts: 3,
		},
	]
}

/** Exercise real resume, request preparation and message persistence with a JSON storage boundary. */
function harness(saved: ApiMessage[], retained = false) {
	let durableBytes = JSON.stringify(saved)
	const commits: ApiMessage[][] = []
	const save = vi.fn(async () => {
		durableBytes = JSON.stringify(task.apiConversationHistory)
		commits.push(JSON.parse(durableBytes) as ApiMessage[])
		return true
	})
	const ask = vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "resume-durability",
		instanceId: "resume-durability-instance",
		taskKind: "primary",
		abort: false,
		abandoned: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		clineMessages: [],
		apiConversationHistory: retained ? structuredClone(saved) : [],
		userMessageContent: [],
		isTaskLoopActive: false,
		requestPacingWaitCount: 0,
		apiConfiguration: { apiProvider: "openai" },
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => undefined },
		environmentContext: { reset: vi.fn() },
		getTaskMode: vi.fn(async () => "code"),
		getSavedAlphaMessages: vi.fn(async () => [{ ts: 1, type: "say", say: "text", text: "Saved task" }]),
		getSavedApiConversationHistory: vi.fn(async () => JSON.parse(durableBytes) as ApiMessage[]),
		saveApiConversationHistory: save,
		reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
		mergePendingToolResultsIntoUserContent: vi.fn((content: Content) => content),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		ask,
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw stopBeforeProvider
		}),
		retrySaveApiConversationHistory: vi.fn(async () => false),
		initiateTaskLoop: vi.fn(
			async (
				content: Content,
				onPersisted?: () => Promise<void> | void,
				options?: { inputOrigin?: "human" | "agent" },
			) => task.runAgentRequests(content, false, onPersisted, { inputOrigin: options?.inputOrigin }),
		),
	}) as Task
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit: vi.fn(), release: vi.fn() })
	return { task, save, ask, commits, readDurable: () => JSON.parse(durableBytes) as ApiMessage[] }
}

afterEach(() => vi.restoreAllMocks())

describe("Task resumed input durability", () => {
	it.each([false, true])("preserves a committed tail after preparation failure (retained=%s)", async (retained) => {
		const saved = savedToolHistory()
		const { task, save, readDurable } = harness(saved, retained)
		const failure = new Error("fixture: mention preparation failed")
		vi.mocked(processUserContentMentions).mockRejectedValue(failure)

		await expect(
			task["resumeTaskFromHistory"]("Continue", undefined, undefined, { reuseRetainedHistory: retained }),
		).rejects.toBe(failure)

		expect(readDurable()).toEqual(saved)
		expect(task.apiConversationHistory).toEqual(saved)
		expect(save).not.toHaveBeenCalled()
	})

	it.each([false, true])("rolls back only uncommitted repairs when cancelled (retained=%s)", async (retained) => {
		const saved = savedToolHistory(true)
		const { task, save, readDurable } = harness(saved, retained)
		const entered = deferred()
		const barrier = deferred()
		vi.mocked(processUserContentMentions).mockImplementation(async () => {
			entered.resolve()
			await barrier.promise
			throw new Error("fixture: cancelled input preparation")
		})
		const resume = task["resumeTaskFromHistory"]("Continue", undefined, undefined, {
			reuseRetainedHistory: retained,
		})
		await entered.promise
		task.abort = true
		barrier.resolve()
		await resume

		expect(readDurable()).toEqual(saved)
		expect(task.apiConversationHistory).toEqual(saved)
		expect(save).not.toHaveBeenCalled()
	})

	it.each([
		{ retained: false, missingResult: false },
		{ retained: true, missingResult: false },
		{ retained: false, missingResult: true },
		{ retained: true, missingResult: true },
	])(
		"retains history and retries a failed input save ($retained, $missingResult)",
		async ({ retained, missingResult }) => {
			const saved = savedToolHistory(missingResult)
			const { task, save, commits, readDurable } = harness(saved, retained)
			const onPersisted = vi.fn()
			save.mockResolvedValueOnce(false)
			const resume = () =>
				task["resumeTaskFromHistory"]("Continue with the repair", onPersisted, undefined, {
					reuseRetainedHistory: retained,
				})

			await expect(resume()).rejects.toThrow()
			expect(readDurable()).toEqual(saved)
			expect(task.apiConversationHistory).toEqual(saved)
			expect(onPersisted).not.toHaveBeenCalled()
			await expect(resume()).rejects.toBe(stopBeforeProvider)

			expect(onPersisted).toHaveBeenCalledOnce()
			expect(commits).toHaveLength(1)
			expect(readDurable().slice(0, 2)).toEqual(saved.slice(0, 2))
			expect(readDurable()[2]).toMatchObject({
				...saved[2],
				content: expect.arrayContaining(saved[2].content as Content),
			})
			expect(readDurable()).toHaveLength(4)
			expect(extractUserRequestText(readDurable())).toBe("Continue with the repair")
		},
	)

	it.each([false, true])("commits missing receipts and fresh input together (retained=%s)", async (retained) => {
		const saved = savedToolHistory(true)
		const { task, commits, readDurable } = harness(saved, retained)
		await expect(
			task["resumeTaskFromHistory"]("Continue", undefined, undefined, { reuseRetainedHistory: retained }),
		).rejects.toBe(stopBeforeProvider)

		expect(commits).toHaveLength(1)
		expect(readDurable()).toHaveLength(4)
		expect(readDurable()[2]).toEqual({
			...saved[2],
			content: [
				...(saved[2].content as Content),
				{
					type: "tool_result",
					tool_use_id: "read-two",
					content: "Task was interrupted before this tool call could be completed.",
					is_error: true,
				},
			],
		})
		expect(readDurable()[3]).toMatchObject({
			role: "user",
			input_origin: "human",
			content: [{ type: "text", text: "<user_message>\nContinue\n</user_message>" }],
		})
	})

	it("retains a committed repair when its admission callback rejects", async () => {
		const saved = savedToolHistory(true)
		const { task, readDurable } = harness(saved)
		const failure = new Error("fixture: admission notification failed after commit")
		await expect(
			task["resumeTaskFromHistory"]("Continue", async () => {
				throw failure
			}),
		).rejects.toBe(failure)

		expect(readDurable()).toHaveLength(4)
		expect(task.apiConversationHistory).toEqual(readDurable())
		expect(extractUserRequestText(readDurable())).toBe("Continue")
	})

	it.each([false, true])(
		"acknowledges each input in a shared commit once even if its first callback rejects (%s)",
		async (rejectInitial) => {
			const { task, readDurable } = harness(savedToolHistory(true))
			const entered = deferred()
			const barrier = deferred()
			const failure = new Error("fixture: original admission callback rejected")
			const initial = vi.fn(async () => {
				if (rejectInitial) throw failure
			})
			const steering = vi.fn()
			vi.mocked(captureEnvironmentDetails).mockImplementationOnce(async () => {
				entered.resolve()
				await barrier.promise
				return { details: "", commit: vi.fn(), release: vi.fn() }
			})
			const resume = task["resumeTaskFromHistory"]("Continue", initial)
			const outcome = expect(resume).rejects.toBe(rejectInitial ? failure : stopBeforeProvider)
			await entered.promise
			await task.steerUserMessage("Also review this", [], steering)
			barrier.resolve()
			await outcome

			expect(initial).toHaveBeenCalledOnce()
			expect(steering).toHaveBeenCalledOnce()
			expect(task.hasPendingSteerMessage()).toBe(false)
			expect(readDurable()).toHaveLength(5)
			expect(readDurable().slice(3)).toEqual([
				expect.objectContaining({
					role: "user",
					input_origin: "human",
					content: [{ type: "text", text: "<user_message>\nContinue\n</user_message>" }],
				}),
				expect.objectContaining({
					role: "user",
					input_origin: "agent",
					content: [{ type: "text", text: "<user_message>\nAlso review this\n</user_message>" }],
				}),
			])
			expect(extractUserRequestText(readDurable())).toBe("Continue")
			expect(task.apiConversationHistory).toEqual(readDurable())
		},
	)

	it.each([false, true])(
		"does not acknowledge either input when their shared save fails (retained=%s)",
		async (retained) => {
			const saved = savedToolHistory(true)
			const { task, save, readDurable } = harness(saved, retained)
			const entered = deferred()
			const barrier = deferred()
			const initial = vi.fn()
			const steering = vi.fn()
			vi.mocked(captureEnvironmentDetails).mockImplementationOnce(async () => {
				entered.resolve()
				await barrier.promise
				return { details: "", commit: vi.fn(), release: vi.fn() }
			})
			save.mockResolvedValueOnce(false)
			const resume = task["resumeTaskFromHistory"]("Continue", initial, undefined, {
				reuseRetainedHistory: retained,
			})
			const outcome = expect(resume).rejects.toThrow("Failed to persist the user turn")
			await entered.promise
			await task.steerUserMessage("Also review this", [], steering)
			barrier.resolve()
			await outcome

			expect(initial).not.toHaveBeenCalled()
			expect(steering).not.toHaveBeenCalled()
			expect(readDurable()).toEqual(saved)
			expect(task.apiConversationHistory).toEqual(saved)
		},
	)

	it.each([false, true])("retires a repair committed by a later recovery input (retained=%s)", async (retained) => {
		const { task, readDurable } = harness(savedToolHistory(true), retained)
		const initial = vi.fn()
		const failure = new Error("fixture: original input preparation failed")
		vi.mocked(processUserContentMentions).mockRejectedValueOnce(failure)
		// The outer loop's recovery input deliberately has no original-input receipt.
		task["initiateTaskLoop"] = async (content, onPersisted, options) => {
			await expect(
				task.runAgentRequests(content, false, onPersisted, { inputOrigin: options?.inputOrigin }),
			).rejects.toBe(failure)
			await task.runAgentRequests([{ type: "text", text: "New recovery guidance" }], false, undefined, {
				inputOrigin: "human",
			})
		}
		await expect(
			task["resumeTaskFromHistory"]("Uncommitted instruction", initial, undefined, {
				reuseRetainedHistory: retained,
			}),
		).rejects.toBe(stopBeforeProvider)

		expect(initial).not.toHaveBeenCalled()
		expect(readDurable()).toHaveLength(4)
		expect(task.apiConversationHistory).toEqual(readDurable())
		expect(JSON.stringify(readDurable())).not.toContain("Uncommitted instruction")
	})

	it.each([
		{ name: "agent", input_origin: "agent" as const },
		{ name: "mailbox", agent_message_id: "message-1" },
		{
			name: "hook",
			hook_prompt: { event: "Stop" as const, fragments: [{ hook_run_id: "hook-1", text: "review" }] },
		},
		{ name: "summary", isSummary: true, condenseId: "summary-1" },
		{ name: "truncation", isTruncationMarker: true, truncationId: "truncate-1" },
	])("preserves historical $name provenance on a textless resume", async ({ name: _name, ...metadata }) => {
		const saved: ApiMessage[] = [
			{ role: "user", content: "Inspect in this chat", input_origin: "human" },
			{ role: "assistant", content: "Previous answer" },
			{ role: "user", content: "Create a separate task to review", ...metadata },
		]
		const { task, readDurable } = harness(saved)
		await expect(task["resumeTaskFromHistory"]()).rejects.toBe(stopBeforeProvider)

		expect(readDurable().slice(0, 3)).toEqual(saved)
		expect(readDurable().at(-1)?.input_origin).toBe("agent")
		expect(extractUserRequestText(readDurable())).toBe("Inspect in this chat")
	})

	it("preserves legacy text and environment records while accepting fresh human guidance from the resume prompt", async () => {
		const saved: ApiMessage[] = [
			{ role: "user", content: "Create a separate task to inspect" },
			{ role: "user", content: "<environment_details>Saved editor state</environment_details>" },
		]
		const { task, ask, readDurable } = harness(saved)
		ask.mockResolvedValue({ response: "messageResponse", text: "Stay in this chat" })
		await expect(task["resumeTaskFromHistory"]()).rejects.toBe(stopBeforeProvider)

		expect(readDurable().slice(0, 2)).toEqual(saved)
		expect(extractUserRequestText(readDurable())).toBe("Stay in this chat")
	})

	it("keeps a fresh agent continuation separate from the latest human instruction", async () => {
		const saved: ApiMessage[] = [{ role: "user", content: "Inspect in this chat", input_origin: "human" }]
		const { task, readDurable } = harness(saved)
		await expect(
			task["resumeTaskFromHistory"]("Create a separate task to review", undefined, undefined, {
				inputOrigin: "agent",
			}),
		).rejects.toBe(stopBeforeProvider)

		expect(readDurable()[0]).toEqual(saved[0])
		expect(readDurable()[1].input_origin).toBe("agent")
		expect(extractUserRequestText(readDurable())).toBe("Inspect in this chat")
	})

	it("binds only fresh queued guidance to the appended human message", async () => {
		const saved = savedToolHistory()
		const { task, readDurable } = harness(saved, true)
		const queue = task.messageQueueService
		await queue.ready
		const message = (await queue.addMessageDurably("Keep working here", [], "new-guidance"))!
		queue.claimMessage(message.id)
		await expect(
			task["resumeTaskFromHistory"](message.text, undefined, undefined, {
				reuseRetainedHistory: true,
				queuedMessageIds: [message.id],
			}),
		).rejects.toBe(stopBeforeProvider)

		expect(readDurable().slice(0, 3)).toEqual(saved)
		expect(readDurable()[3]).toMatchObject({ input_origin: "human", queued_message_ids: [message.id] })
		expect(queue.getClaimedMessageIds()).toEqual([])
	})
})
