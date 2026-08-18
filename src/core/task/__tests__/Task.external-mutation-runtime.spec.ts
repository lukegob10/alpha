import { Task } from "../Task"

const makePausedTask = (overrides: Record<string, unknown> = {}) =>
	Object.assign(Object.create(Task.prototype), {
		abort: false,
		didComplete: false,
		isTaskLoopActive: true,
		externalMutationLease: undefined,
		activeAsk: { type: "followup" },
		askResponse: undefined,
		isWaitingForFirstChunk: false,
		isStreaming: true,
		presentAssistantMessageHasPendingUpdates: true,
		commandExecutionEvidence: new Map(),
		messageQueueService: { isEmpty: () => true },
		pendingSteerMessage: undefined,
		...overrides,
	}) as Task

describe("Task external mutation runtime state", () => {
	it("allows a presented follow-up even while sticky stream flags remain set", () => {
		expect(makePausedTask().getExternalMutationCapability()).toEqual({
			allowed: true,
			state: "available",
			reason: "The parent is paused for your review.",
		})
	})

	it("allows an interrupted parent reconstructed without its in-memory ask", () => {
		expect(
			makePausedTask({ isTaskLoopActive: false, activeAsk: undefined }).getExternalMutationCapability(),
		).toEqual({
			allowed: true,
			state: "available",
			reason: "The parent is inactive and safe for review.",
		})
	})

	it("allows the live resume prompt created when an interrupted chat is reopened", () => {
		expect(makePausedTask({ activeAsk: { type: "resume_task" } }).getExternalMutationCapability()).toEqual({
			allowed: true,
			state: "available",
			reason: "The parent is paused for your review.",
		})
	})

	it("still rejects while the next model response is waiting for its first chunk", () => {
		const task = makePausedTask() as Task & { isWaitingForFirstChunk: boolean }
		task.isWaitingForFirstChunk = true

		expect(task.getExternalMutationCapability()).toEqual({
			allowed: false,
			state: "busy",
			reason: "Wait for the parent response to finish.",
		})
	})

	it.each([
		[
			"a command",
			{ commandExecutionEvidence: new Map([["command", { status: "running" }]]) },
			"Wait for the parent command to finish.",
		],
		[
			"queued work",
			{ messageQueueService: { isEmpty: () => false } },
			"The parent has queued work to process first.",
		],
	])("keeps an inactive parent blocked by %s", (_label, overrides, reason) => {
		const task = makePausedTask({ isTaskLoopActive: false, activeAsk: undefined, ...overrides })

		expect(task.getExternalMutationCapability()).toEqual({
			allowed: false,
			state: "busy",
			reason,
		})
	})
})
