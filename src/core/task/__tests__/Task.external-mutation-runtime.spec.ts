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

	it("pauses between a nested Worker result and the next provider request until review settles", async () => {
		const provider = {
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			autoApplyPendingSubagentChangeSets: vi.fn(async () => undefined),
		}
		const group = {
			groupId: "nested-group",
			createdAt: Date.now(),
			agents: [{ changeSet: { id: "nested-change", status: "pending_review" } }],
		}
		const task = makePausedTask({
			activeAsk: undefined,
			providerRef: { deref: () => provider },
			clineMessages: [
				{
					type: "say",
					say: "subagent_group",
					subagentGroup: structuredClone(group),
				},
			],
			isAwaitingSubagentReview: false,
			subagentReviewBarrier: undefined,
			saveAlphaMessages: vi.fn(async () => true),
			updateAlphaMessage: vi.fn(async () => undefined),
		})

		const waiting = (task as any).waitForPendingSubagentChangeSetReviews() as Promise<void>
		await vi.waitFor(() => expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce())
		expect(task.getExternalMutationCapability()).toEqual({
			allowed: true,
			state: "available",
			reason: "The parent is paused for nested Worker review.",
		})

		const lease = task.acquireExternalMutation("applying Worker changes")
		expect(lease.release).toBeTypeOf("function")
		const reviewedGroup = structuredClone(group)
		reviewedGroup.agents[0].changeSet.status = "applied"
		await task.upsertSubagentGroup(reviewedGroup as any)

		let resumed = false
		void waiting.then(() => {
			resumed = true
		})
		await Promise.resolve()
		expect(resumed).toBe(false)

		lease.release!()
		await waiting
		expect(resumed).toBe(true)
		expect((task as any).isAwaitingSubagentReview).toBe(false)
		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledWith(task.taskId)
	})

	it("settles Auto-approved Worker proposals before opening the review barrier", async () => {
		const group = {
			groupId: "auto-group",
			createdAt: Date.now(),
			agents: [{ changeSet: { id: "auto-change", status: "pending_review" } }],
		}
		const provider = {
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			autoApplyPendingSubagentChangeSets: vi.fn(async () => {
				group.agents[0]!.changeSet.status = "applied"
			}),
		}
		const task = makePausedTask({
			activeAsk: undefined,
			providerRef: { deref: () => provider },
			clineMessages: [{ type: "say", say: "subagent_group", subagentGroup: group }],
			isAwaitingSubagentReview: false,
			subagentReviewBarrier: undefined,
		})

		await (task as any).waitForPendingSubagentChangeSetReviews()

		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledWith(task.taskId)
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
		expect((task as any).isAwaitingSubagentReview).toBe(false)
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
