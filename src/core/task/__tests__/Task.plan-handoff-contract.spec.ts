import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AlphaMessage, TaskDesignHandoff } from "@alpha-code/types"

import { parseProposedPlan } from "../../../shared/plan-mode"
import { Task } from "../Task"

const planBody = "# Storage plan\n\n- Use the selected database.\n- Test migration recovery."
const plan = `<proposed_plan>\n${planBody}\n</proposed_plan>`

function createCompletionTask(mode: "code" | "architect" = "architect", taskKind: "primary" | "subagent" = "primary") {
	const task = Object.create(Task.prototype) as Task
	const commitAlphaMessageMutation = vi.fn(
		async (
			timestamp: number,
			_context: string,
			mutate: (message: AlphaMessage | undefined) => AlphaMessage | undefined,
			handoff?: TaskDesignHandoff,
		) => {
			const index = task.clineMessages.findIndex((message) => message.ts === timestamp)
			const message = mutate(index >= 0 ? structuredClone(task.clineMessages[index]) : undefined)
			if (!message) return undefined
			if (index >= 0) task.clineMessages[index] = message
			else task.clineMessages.push(message)
			if (handoff) task.designHandoff = structuredClone(handoff)
			return { message, created: index < 0 }
		},
	)
	const say = vi.fn(async () => {})
	Object.defineProperty(task, "cwd", { value: "F:/workspace" })
	Object.assign(task, {
		taskId: "plan-handoff-root",
		taskKind,
		clineMessages: [],
		getTaskMode: vi.fn(async () => mode),
		commitAlphaMessageMutation,
		publishAlphaMessageCreated: vi.fn(async () => {}),
		updateAlphaMessage: vi.fn(async () => {}),
		say,
	})
	return { task, say, commitAlphaMessageMutation }
}

describe("terminal Plan handoff ownership", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it.each([
		"Which database should the application use?",
		"I cannot inspect the repository because access is unavailable.",
		"# Suggested direction\n\n- Investigate storage first.",
		"",
		" \n\t ",
		"<proposed_plan></proposed_plan>",
		"<proposed_plan>\n# Incomplete proposal",
		"<proposed_plan>outer<proposed_plan>inner</proposed_plan></proposed_plan>",
		"<proposed_plan>one</proposed_plan><proposed_plan>two</proposed_plan>",
		"</proposed_plan>",
		`Here is a possible approach:\n${plan}\nPlease choose a database first.`,
	])("preserves conversational or invalid final text without declaring a handoff: %j", async (text) => {
		const { task, commitAlphaMessageMutation } = createCompletionTask()

		await task.presentCompletionResult(text)

		expect(task.clineMessages).toEqual([
			expect.objectContaining({ type: "say", say: "completion_result", text, partial: false }),
		])
		expect(task.designHandoff).toBeUndefined()
		expect(commitAlphaMessageMutation).toHaveBeenCalledWith(
			expect.any(Number),
			"the completion result",
			expect.any(Function),
			undefined,
		)
	})

	it("stores the explicitly completed primary Plan without changing its mode", async () => {
		const { task } = createCompletionTask()

		await task.presentCompletionResult(plan, ["diagram.png"])

		expect(task.clineMessages).toEqual([
			expect.objectContaining({ text: plan, images: ["diagram.png"], partial: false }),
		])
		expect(task.designHandoff).toEqual({
			title: "Storage plan",
			markdown: planBody,
			sourceTaskId: task.taskId,
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
			updatedAt: expect.any(Number),
		})
		expect(await task.getTaskMode()).toBe("architect")
	})

	it("retains a prior handoff when a rejected revision ends with a question", async () => {
		const { task, commitAlphaMessageMutation } = createCompletionTask()
		await task.presentCompletionResult(plan)
		const stored = structuredClone(task.designHandoff)
		// A follow-up turn owns a fresh response row; the earlier artifact remains readable.
		Object.assign(task, { currentAssistantResponseMessageTs: undefined })
		vi.advanceTimersByTime(1)
		commitAlphaMessageMutation.mockClear()

		const clarification = "The prior storage choice is unsuitable. Which database should replace it?"
		await task.presentCompletionResult(clarification)

		expect(task.designHandoff).toEqual(stored)
		expect(task.clineMessages.at(-1)).toMatchObject({ say: "completion_result", text: clarification })
		expect(parseProposedPlan(task.clineMessages.at(-1)?.text ?? "")).toBeUndefined()
		expect(commitAlphaMessageMutation).toHaveBeenCalledWith(
			expect.any(Number),
			"the completion result",
			expect.any(Function),
			undefined,
		)
	})

	it("keeps streaming plan content out of the completed handoff boundary", async () => {
		const { task, say, commitAlphaMessageMutation } = createCompletionTask()

		await task.presentCompletionResult(plan, undefined, true)

		expect(say).toHaveBeenCalledExactlyOnceWith("text", plan, undefined, true)
		expect(commitAlphaMessageMutation).not.toHaveBeenCalled()
		expect(task.designHandoff).toBeUndefined()
	})

	it.each([
		["code", "primary"],
		["architect", "subagent"],
	] as const)("does not author a handoff from a %s %s completion", async (mode, kind) => {
		const { task, commitAlphaMessageMutation } = createCompletionTask(mode, kind)

		await task.presentCompletionResult(plan)

		expect(task.designHandoff).toBeUndefined()
		expect(task.clineMessages[0]?.text).toBe(plan)
		expect(commitAlphaMessageMutation).toHaveBeenCalledWith(
			expect.any(Number),
			"the completion result",
			expect.any(Function),
			undefined,
		)
	})
})
