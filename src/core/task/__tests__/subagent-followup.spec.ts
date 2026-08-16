import { Task } from "../Task"

describe("Task retained sub-agent follow-up", () => {
	it("cancels a bounded agent wait when the current turn is interrupted", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			taskCancellationController: new AbortController(),
		}) as Task

		const wait = task.beginAgentWait()
		task.cancelCurrentRequest()

		expect(wait.signal.aborted).toBe(true)
		wait.dispose()
	})

	it("repairs the terminal tool boundary and resumes without prompting", async () => {
		const attemptId = "attempt-1"
		const ask = vi.spyOn(Task.prototype, "ask")
		const initiateTaskLoop = vi.fn(async () => undefined)
		const overwriteApiConversationHistory = vi.fn(async () => undefined)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "child-1",
			taskKind: "subagent",
			clineMessages: [],
			apiConversationHistory: [],
			isInitialized: false,
			abort: false,
			abandoned: false,
			getSavedClineMessages: vi.fn(async () => [
				{ ts: 1, type: "say", say: "text", text: "Inspect the parser" },
				{ ts: 2, type: "say", say: "completion_result", text: "Initial report" },
			]),
			overwriteClineMessages: vi.fn(async () => undefined),
			reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
			getSavedApiConversationHistory: vi.fn(async () => [
				{ role: "user", content: [{ type: "text", text: "Inspect the parser" }] },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: attemptId,
							name: "attempt_completion",
							input: { result: "Initial report" },
						},
					],
				},
			]),
			say: vi.fn(async () => undefined),
			overwriteApiConversationHistory,
			initiateTaskLoop,
			providerRef: { deref: () => ({ postStateToWebviewWithoutTaskHistory: vi.fn() }) },
		}) as Task

		await (task as any).resumeTaskFromHistory("Check the edge case next")

		expect(ask).not.toHaveBeenCalled()
		expect((task as any).say).toHaveBeenCalledWith("user_feedback", "Check the edge case next")
		expect(overwriteApiConversationHistory).toHaveBeenCalled()
		expect(initiateTaskLoop).toHaveBeenCalledWith([
			{
				type: "tool_result",
				tool_use_id: attemptId,
				content: "Task was interrupted before this tool call could be completed.",
			},
			{ type: "text", text: "<user_message>\nCheck the edge case next\n</user_message>" },
		])
	})
})
