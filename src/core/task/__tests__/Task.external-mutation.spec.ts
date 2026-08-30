import { Task } from "../Task"

const makeTask = (overrides: Record<string, unknown> = {}) =>
	Object.assign(Object.create(Task.prototype), {
		abort: false,
		didComplete: false,
		_taskMode: "code",
		isTaskLoopActive: true,
		activeAsk: { type: "followup", ts: 1 },
		askKind: "primary",
		askId: "parent-1",
		askResponse: undefined,
		askResponseText: undefined,
		askResponseImages: undefined,
		isWaitingForFirstChunk: false,
		isStreaming: false,
		presentAssistantMessageHasPendingUpdates: false,
		pendingSteerMessage: undefined,
		commandExecutionEvidence: new Map(),
		messageQueueService: { isEmpty: () => true },
		clineMessages: [{ ts: 1, type: "ask", ask: "followup", text: "Review changes", isAnswered: false }],
		checkpointSave: vi.fn(async () => undefined),
		saveClineMessages: vi.fn(async () => undefined),
		cancelAutoApprovalTimeout: vi.fn(),
		...overrides,
	}) as Task

describe("Task external mutation capability", () => {
	it("allows a parent whose active loop is safely paused on human input", () => {
		const task = makeTask()

		expect(task.getExternalMutationCapability()).toEqual({
			allowed: true,
			state: "available",
			reason: "The parent is paused for your review.",
		})
	})

	it.each([
		["active generation", { activeAsk: undefined, isStreaming: true }, "pauses for your input"],
		["tool presentation", { activeAsk: { type: "tool", ts: 1 } }, "pauses for your input"],
		["command", { commandExecutionEvidence: new Map([["command", { status: "running" }]]) }, "command to finish"],
		["resuming", { askResponse: "messageResponse" }, "resuming"],
	])("rejects external mutation during %s", (_label, overrides, reason) => {
		const task = makeTask(overrides)

		expect(task.getExternalMutationCapability()).toMatchObject({
			allowed: false,
			state: "busy",
			reason: expect.stringContaining(reason),
		})
	})

	it("rejects queued model work", () => {
		const task = makeTask({ messageQueueService: { isEmpty: () => false } })

		expect(task.getExternalMutationCapability()).toMatchObject({
			allowed: false,
			reason: expect.stringContaining("queued work"),
		})
	})

	it("denies Apply in Plan while retaining proposal discard capability", () => {
		const task = makeTask({ _taskMode: "architect" })

		expect(task.getExternalMutationCapability()).toEqual({
			allowed: false,
			state: "unavailable",
			reason: "Plan mode cannot apply Worker changes. Switch to Code mode to apply this proposal.",
		})
		expect(task.getSubagentChangeSetDiscardCapability()).toMatchObject({
			allowed: true,
			state: "available",
		})
	})

	it("defers a racing user response until the mutation lease releases", () => {
		const task = makeTask()
		const lease = task.acquireExternalMutation("applying Worker changes")
		expect(lease.release).toBeTypeOf("function")

		task.handleWebviewAskResponse("messageResponse", "APPLIED")
		expect((task as any).askResponse).toBeUndefined()
		expect(task.getExternalMutationCapability()).toMatchObject({ allowed: false, state: "busy" })

		lease.release!()
		expect((task as any).askResponse).toBe("messageResponse")
		expect((task as any).askResponseText).toBe("APPLIED")
		expect((task as any).clineMessages[0].isAnswered).toBe(true)
	})

	it("does not publish a child command as parent verification evidence", () => {
		const recordParentVerificationEvidence = vi.fn()
		const task = makeTask({
			taskKind: "subagent",
			providerRef: new WeakRef({ recordParentVerificationEvidence }),
			commandExecutionEvidence: new Map(),
		})

		task.beginCommandExecution("child-command", "child-execution", "Get-Content src/example.ts")
		task.completeCommandExecution("child-command", { exitCode: 0 })

		expect(recordParentVerificationEvidence).not.toHaveBeenCalled()
	})

	it("records an immutable, deduplicated verification scope for command evidence", () => {
		const task = makeTask({ taskKind: "primary", commandExecutionEvidence: new Map() })
		const requestedScope = ["change-1", "change-1", "change-2"]

		task.beginCommandExecution("verification-command", "execution-1", "pnpm test", requestedScope)
		requestedScope.push("change-3")

		const firstRead = task.getCommandExecutionEvidence()
		expect(firstRead[0]?.verificationChangeSetIds).toEqual(["change-1", "change-2"])

		firstRead[0]?.verificationChangeSetIds?.push("change-4")
		expect(task.getCommandExecutionEvidence()[0]?.verificationChangeSetIds).toEqual(["change-1", "change-2"])
	})
})
