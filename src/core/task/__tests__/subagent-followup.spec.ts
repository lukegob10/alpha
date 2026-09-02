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
		const overwriteApiConversationHistory = vi.fn(async () => true)
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
		expect(initiateTaskLoop).toHaveBeenCalledWith(
			[
				{
					type: "tool_result",
					tool_use_id: attemptId,
					content: "Task was interrupted before this tool call could be completed.",
				},
				{ type: "text", text: "<user_message>\nCheck the edge case next\n</user_message>" },
			],
			undefined,
		)
	})

	it("keeps persisted steering and a retained follow-up in distinct user-message envelopes", async () => {
		const waitId = "wait-1"
		const persistedSteering = "<user_message>\nPING_BEFORE_INTERRUPT=25428\n</user_message>"
		const initiateTaskLoop = vi.fn(async () => undefined)
		const overwriteApiConversationHistory = vi.fn(async () => true)
		const onFollowupPersisted = vi.fn()
		const initialUserMessage = { role: "user", content: [{ type: "text", text: "Initial task" }] }
		const interruptedAssistantMessage = {
			role: "assistant",
			content: [{ type: "tool_use", id: waitId, name: "wait_agent", input: { timeout_ms: 300_000 } }],
		}
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "child-1",
			taskKind: "subagent",
			clineMessages: [],
			apiConversationHistory: [],
			isInitialized: false,
			abort: false,
			abandoned: false,
			getSavedClineMessages: vi.fn(async () => [
				{ ts: 1, type: "say", say: "text", text: "Initial task" },
				{ ts: 2, type: "say", say: "user_feedback", text: "PING_BEFORE_INTERRUPT=25428" },
			]),
			overwriteClineMessages: vi.fn(async () => undefined),
			reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
			getSavedApiConversationHistory: vi.fn(async () => [
				initialUserMessage,
				interruptedAssistantMessage,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: waitId, content: '{"cancelled":true}' },
						{ type: "text", text: persistedSteering },
					],
				},
			]),
			say: vi.fn(async () => undefined),
			overwriteApiConversationHistory,
			initiateTaskLoop,
			providerRef: { deref: () => ({ postStateToWebviewWithoutTaskHistory: vi.fn() }) },
		}) as Task

		await (task as any).resumeTaskFromHistory("SECOND_RUN", onFollowupPersisted)

		expect(overwriteApiConversationHistory).toHaveBeenCalledWith([initialUserMessage, interruptedAssistantMessage])
		expect(initiateTaskLoop).toHaveBeenCalledWith(
			[
				{ type: "tool_result", tool_use_id: waitId, content: '{"cancelled":true}' },
				{ type: "text", text: persistedSteering },
				{ type: "text", text: "<user_message>\nSECOND_RUN\n</user_message>" },
			],
			onFollowupPersisted,
		)
	})
})
