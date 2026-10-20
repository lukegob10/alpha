import { afterEach, describe, expect, it, vi } from "vitest"

import { Task } from "../Task"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"
import { attemptCompletionTool, type AttemptCompletionCallbacks } from "../../tools/AttemptCompletionTool"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture() {
	const entered = deferred()
	const provider = {
		autoApplyPendingSubagentChangeSets: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => entered.resolve()),
		getParentCompletionDecision: vi.fn(async () => ({ allowed: true, blockingObligations: [] })),
	}
	const changeSet = { id: "pending-worker-change", status: "pending_review" }
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "review-steering",
		taskKind: "primary",
		abort: false,
		abandoned: false,
		didComplete: false,
		isTaskLoopActive: true,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		isAwaitingSubagentReview: false,
		taskCancellationController: new AbortController(),
		providerRef: { deref: () => provider },
		clineMessages: [{ type: "say", say: "subagent_group", subagentGroup: { agents: [{ changeSet }] } }],
		messageQueueService: { isEmpty: () => true },
		commandExecutionEvidence: new Map(),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		completionRuntimeRevision: 0,
		getOpenTodoCompletionDecision: () => undefined,
		invalidateGoalContinuation: vi.fn(),
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
	}) as Task
	let resumed = 0
	const wait = (hasHumanInput = false) => {
		const waiting = task["waitForPendingSubagentChangeSetReviews"](hasHumanInput).then(() => {
			resumed++
		})
		cleanups.push(async () => {
			task.abort = true
			task["releaseSubagentReviewBarrierIfSettled"](true)
			await waiting
		})
		return waiting
	}
	return { task, provider, changeSet, entered: entered.promise, wait, resumed: () => resumed }
}

describe("Task pending Worker review and human steering", () => {
	it("incorporates human steering accepted during a pending review without settling the proposal", async () => {
		const { task, provider, changeSet, entered, wait, resumed } = fixture()
		const waiting = wait()
		await entered
		expect(task.getExternalMutationCapability().allowed).toBe(true)
		await task.steerUserMessage("Keep the proposal pending and investigate a different file.")
		await vi.waitFor(() => expect(resumed()).toBe(1))
		await waiting
		expect(task["pendingSteerMessage"]?.inputOrigin).toBe("human")
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
		expect(task["isAwaitingSubagentReview"]).toBe(false)
		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledOnce()
	})

	it("does not admit a review wait over already accepted steering", async () => {
		const { task, provider, changeSet, wait, resumed } = fixture()
		await task.steerUserMessage("Review the new instruction first.")
		const waiting = wait()
		await vi.waitFor(() => expect(resumed()).toBe(1))
		await waiting
		expect(provider.autoApplyPendingSubagentChangeSets).not.toHaveBeenCalled()
		expect(changeSet.status).toBe("pending_review")
	})

	it("lets a fresh human request proceed while an ordinary continuation still waits for review", async () => {
		const { task, provider, changeSet, wait, resumed } = fixture()
		const waiting = wait(true)
		await vi.waitFor(() => expect(resumed()).toBe(1))
		await waiting
		expect(provider.autoApplyPendingSubagentChangeSets).not.toHaveBeenCalled()
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
	})

	it("keeps a pending review paused without new human input", async () => {
		const { task, changeSet, entered, wait, resumed } = fixture()
		const waiting = wait()
		await entered
		expect(resumed()).toBe(0)
		expect(task["isAwaitingSubagentReview"]).toBe(true)
		changeSet.status = "discarded"
		task["releaseSubagentReviewBarrierIfSettled"]()
		await waiting
		expect(resumed()).toBe(1)
	})

	it("does not let steering overtake an in-flight Apply or Discard lease", async () => {
		const { task, changeSet, entered, wait, resumed } = fixture()
		const waiting = wait()
		await entered
		const lease = task.acquireExternalMutation("applying Worker changes")
		expect(lease.release).toBeTypeOf("function")
		await task.steerUserMessage("Keep the pending proposal for later.")
		expect(resumed()).toBe(0)
		lease.release!()
		await vi.waitFor(() => expect(resumed()).toBe(1))
		await waiting
		lease.release!()
		task["releaseSubagentReviewBarrierIfSettled"](true)
		expect(resumed()).toBe(1)
		expect(changeSet.status).toBe("pending_review")
	})

	it("releases the review wait when Stop cancels its lifetime", async () => {
		const { task, changeSet, entered, wait, resumed } = fixture()
		const waiting = wait()
		await entered
		task.abort = true
		task["taskCancellationController"].abort(new Error("User stopped the task"))
		task["releaseSubagentReviewBarrierIfSettled"](true)
		await waiting
		expect(resumed()).toBe(1)
		expect(task["agentWaitAbortController"]).toBeUndefined()
		expect(changeSet.status).toBe("pending_review")
	})

	it("does not readmit a review wait after lifetime cancellation without an abort flag", async () => {
		const { task, changeSet, entered, wait, resumed, provider } = fixture()
		const waiting = wait()
		await entered
		task["taskCancellationController"].abort(new Error("The task owner was disposed"))
		await waiting
		expect(resumed()).toBe(1)
		expect(task.abort).toBe(false)
		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledOnce()
		expect(task["agentWaitAbortController"]).toBeUndefined()
		expect(changeSet.status).toBe("pending_review")
	})

	it.each(["applied", "discarded"])(
		"holds completion until the proposal is %s and the admitted mutation drains",
		async (status) => {
			const { task, changeSet, entered, provider } = fixture()
			let settled = false
			const completing = task.waitForCompletionGateDecision().then((decision) => {
				settled = true
				return decision
			})
			cleanups.push(async () => {
				task.abort = true
				task["releaseSubagentReviewBarrierIfSettled"](true)
				await completing
			})
			await entered
			expect(await task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				reasonCode: "review_pending",
			})
			const lease = task.acquireExternalMutation("settling the Worker proposal")
			expect(lease.release).toBeTypeOf("function")
			changeSet.status = status
			task["releaseSubagentReviewBarrierIfSettled"]()
			expect(settled).toBe(false)
			lease.release!()
			expect(await completing).toMatchObject({ allowed: true })
			expect(provider.getParentCompletionDecision).toHaveBeenCalledOnce()
			expect(task["agentWaitAbortController"]).toBeUndefined()
		},
	)

	it("returns interrupted completion for further steering while leaving the proposal pending", async () => {
		const { task, changeSet, entered } = fixture()
		const completing = task.waitForCompletionGateDecision()
		await entered
		await task.steerUserMessage("Investigate one more approach before review.")
		expect(await completing).toMatchObject({ allowed: false, reasonCode: "interrupted" })
		expect(changeSet.status).toBe("pending_review")
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("rechecks a review created during the durable completion read", async () => {
		const { task, changeSet, entered, provider } = fixture()
		changeSet.status = "discarded"
		const reading = deferred()
		const release = deferred()
		provider.getParentCompletionDecision.mockImplementationOnce(async () => {
			reading.resolve()
			await release.promise
			return { allowed: true, blockingObligations: [] }
		})
		const completing = task.waitForCompletionGateDecision()
		cleanups.push(async () => {
			task.abort = true
			task["releaseSubagentReviewBarrierIfSettled"](true)
			await completing
		})
		await reading.promise
		changeSet.status = "pending_review"
		release.resolve()
		await entered
		expect(task["isAwaitingSubagentReview"]).toBe(true)
		changeSet.status = "discarded"
		task["releaseSubagentReviewBarrierIfSettled"]()
		expect(await completing).toMatchObject({ allowed: true })
		expect(provider.getParentCompletionDecision).toHaveBeenCalledTimes(2)
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("keeps legacy attempt_completion pending and returns one interrupted result for new guidance", async () => {
		const { task, changeSet, entered } = fixture()
		Object.assign(task, { recordCompletionCandidate: vi.fn(), presentCompletionResult: vi.fn() })
		const callbacks: AttemptCompletionCallbacks = {
			askApproval: vi.fn(async () => true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(async () => true),
			toolDescription: () => "Finish",
			toolCallId: "legacy-review-completion",
		}
		const completing = attemptCompletionTool.execute({ result: "The answer is ready." }, task, callbacks)
		await entered
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.presentCompletionResult).not.toHaveBeenCalled()
		await task.steerUserMessage("Keep investigating before review.")
		await completing
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.presentCompletionResult).not.toHaveBeenCalled()
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
	})

	it("holds Goal completion for review without adding usage or a continuation", async () => {
		const { task, changeSet, entered } = fixture()
		let state: TaskGoalEnvelope = { schemaVersion: 1, taskId: task.taskId, usageReceipts: [] }
		const store: GoalStateStore = {
			read: async () => structuredClone(state),
			transact: async (operation) => {
				const working = structuredClone(state)
				const result = operation(working)
				state = working
				return structuredClone(result)
			},
		}
		const controller = new GoalController({ taskId: task.taskId, store })
		await controller.create({ objective: "Integrate the reviewed proposal", tokenBudget: 1_000 }, "user")
		Object.assign(task, {
			goalController: controller,
			_taskMode: "code",
			isCurrentApiConversationHistoryOwner: () => true,
		})
		const completing = task.updateGoalStatus("complete", { source: "tool" })
		await entered
		expect(await controller.get()).toMatchObject({ status: "active", tokensUsed: 0, continuationCount: 0 })
		changeSet.status = "discarded"
		task["releaseSubagentReviewBarrierIfSettled"]()
		expect(await completing).toMatchObject({ status: "complete", tokensUsed: 0, continuationCount: 0 })
		expect(state.usageReceipts).toEqual([])
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})
})
