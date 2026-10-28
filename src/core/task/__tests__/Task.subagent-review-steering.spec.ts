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

function fixture({ holdIntegration = false } = {}) {
	const entered = deferred()
	const integration = deferred()
	const draining = deferred()
	const provider = {
		autoApplyPendingSubagentChangeSets: vi.fn(async () => {
			entered.resolve()
			if (holdIntegration) await integration.promise
		}),
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
		alphaMessages: [{ type: "say", say: "subagent_group", subagentGroup: { agents: [{ changeSet }] } }],
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
	const waitForRequestControl = task["waitForRequestControl"].bind(task)
	Object.assign(task, {
		waitForRequestControl: (...args: Parameters<typeof waitForRequestControl>) => {
			if (args[0] === task["subagentReviewBarrier"]?.promise) draining.resolve()
			return waitForRequestControl(...args)
		},
	})
	const releases: Array<() => void> = []
	const acquireMutation = () => {
		// A presented follow-up is an existing public admission boundary for Apply/Discard.
		Object.assign(task, { activeAsk: { type: "followup" } })
		const lease = task.acquireExternalMutation("settling the Worker proposal")
		Object.assign(task, { activeAsk: undefined })
		expect(lease.release).toBeTypeOf("function")
		releases.push(lease.release!)
		return lease
	}
	cleanups.push(async () => {
		task.abort = true
		task["taskCancellationController"].abort(new Error("Fixture stopped"))
		integration.resolve()
		for (const release of releases) release()
		task["releaseSubagentReviewBarrierIfSettled"](true)
	})
	const track = <T>(pending: Promise<T>) => {
		cleanups.push(async () => {
			await pending
		})
		return pending
	}
	let resumed = 0
	const wait = () =>
		track(
			task["waitForPendingSubagentChangeSetReviews"]().then(() => {
				resumed++
			}),
		)
	return {
		task,
		provider,
		changeSet,
		entered: entered.promise,
		draining: draining.promise,
		finishIntegration: integration.resolve,
		acquireMutation,
		track,
		wait,
		resumed: () => resumed,
	}
}

describe("Task quarantined Worker proposals and human steering", () => {
	it("incorporates human steering during an integration offer without settling the proposal", async () => {
		const { task, provider, changeSet, entered, wait, finishIntegration, resumed } = fixture({
			holdIntegration: true,
		})
		const waiting = wait()
		await entered
		expect(task.getExternalMutationCapability().allowed).toBe(true)
		await task.steerUserMessage("Keep the proposal pending and investigate a different file.")
		expect(resumed()).toBe(0)
		finishIntegration()
		await waiting
		expect(resumed()).toBe(1)
		expect(task["pendingSteerMessage"]?.inputOrigin).toBe("human")
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
		expect(task["isAwaitingSubagentReview"]).toBe(false)
		expect(task["agentWaitAbortController"]).toBeUndefined()
		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledOnce()
	})

	it("does not offer integration over already accepted steering", async () => {
		const { task, provider, changeSet, wait, resumed } = fixture()
		await task.steerUserMessage("Review the new instruction first.")
		await wait()
		expect(resumed()).toBe(1)
		expect(provider.autoApplyPendingSubagentChangeSets).not.toHaveBeenCalled()
		expect(changeSet.status).toBe("pending_review")
	})

	it("lets an ordinary continuation proceed with the proposal still quarantined", async () => {
		const { task, provider, changeSet, wait, resumed } = fixture()
		await wait()
		expect(resumed()).toBe(1)
		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledOnce()
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true })
	})

	it("holds an admitted mutation until its lease drains even after proposal disposition", async () => {
		const { task, changeSet, draining, acquireMutation, wait, resumed } = fixture()
		const lease = acquireMutation()
		const waiting = wait()
		await draining
		expect(resumed()).toBe(0)
		expect(task["isAwaitingSubagentReview"]).toBe(true)
		changeSet.status = "discarded"
		task["releaseSubagentReviewBarrierIfSettled"]()
		expect(resumed()).toBe(0)
		lease.release!()
		await waiting
		expect(resumed()).toBe(1)
	})

	it("does not let steering overtake an in-flight Apply or Discard lease", async () => {
		const { task, changeSet, draining, acquireMutation, wait, resumed } = fixture()
		const lease = acquireMutation()
		const waiting = wait()
		await draining
		await task.steerUserMessage("Keep the pending proposal for later.")
		expect(resumed()).toBe(0)
		lease.release!()
		await waiting
		lease.release!()
		task["releaseSubagentReviewBarrierIfSettled"](true)
		expect(resumed()).toBe(1)
		expect(changeSet.status).toBe("pending_review")
	})

	it("releases an admitted mutation wait when Stop cancels its lifetime", async () => {
		const { task, changeSet, draining, acquireMutation, wait, resumed } = fixture()
		acquireMutation()
		const waiting = wait()
		await draining
		task.abort = true
		task["taskCancellationController"].abort(new Error("User stopped the task"))
		task["releaseSubagentReviewBarrierIfSettled"](true)
		await waiting
		expect(resumed()).toBe(1)
		expect(task["agentWaitAbortController"]).toBeUndefined()
		expect(changeSet.status).toBe("pending_review")
	})

	it("does not readmit integration after lifetime cancellation without an abort flag", async () => {
		const { task, changeSet, draining, acquireMutation, wait, resumed, provider } = fixture()
		acquireMutation()
		const waiting = wait()
		await draining
		task["taskCancellationController"].abort(new Error("The task owner was disposed"))
		await waiting
		expect(resumed()).toBe(1)
		expect(task.abort).toBe(false)
		expect(provider.autoApplyPendingSubagentChangeSets).not.toHaveBeenCalled()
		expect(task["agentWaitAbortController"]).toBeUndefined()
		expect(changeSet.status).toBe("pending_review")
	})

	it.each(["applied", "discarded"])(
		"holds completion after a proposal is %s until the admitted mutation drains",
		async (status) => {
			const { task, changeSet, draining, acquireMutation, provider, track } = fixture()
			const lease = acquireMutation()
			let settled = false
			const completing = track(
				task.waitForCompletionGateDecision().then((decision) => {
					settled = true
					return decision
				}),
			)
			await draining
			expect(await task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				reasonCode: "review_pending",
			})
			changeSet.status = status
			task["releaseSubagentReviewBarrierIfSettled"]()
			expect(settled).toBe(false)
			lease.release!()
			expect(await completing).toMatchObject({ allowed: true })
			expect(provider.getParentCompletionDecision).toHaveBeenCalledOnce()
			expect(task["agentWaitAbortController"]).toBeUndefined()
		},
	)

	it("returns interrupted completion for steering after an admitted effect drains", async () => {
		const { task, changeSet, draining, acquireMutation, track } = fixture()
		const lease = acquireMutation()
		const completing = track(task.waitForCompletionGateDecision())
		await draining
		await task.steerUserMessage("Investigate one more approach before review.")
		lease.release!()
		expect(await completing).toMatchObject({ allowed: false, reasonCode: "interrupted" })
		expect(changeSet.status).toBe("pending_review")
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("does not turn a newly quarantined proposal into a late completion barrier", async () => {
		const { task, changeSet, provider, track } = fixture()
		changeSet.status = "discarded"
		const reading = deferred()
		const release = deferred()
		provider.getParentCompletionDecision.mockImplementationOnce(async () => {
			reading.resolve()
			await release.promise
			return { allowed: true, blockingObligations: [] }
		})
		const completing = track(task.waitForCompletionGateDecision())
		await reading.promise
		changeSet.status = "pending_review"
		release.resolve()
		expect(await completing).toMatchObject({ allowed: true })
		expect(provider.getParentCompletionDecision).toHaveBeenCalledOnce()
		expect(changeSet.status).toBe("pending_review")
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("rechecks an admitted mutation created during the durable completion read", async () => {
		const { task, draining, acquireMutation, provider, track } = fixture()
		const reading = deferred()
		const release = deferred()
		provider.getParentCompletionDecision.mockImplementationOnce(async () => {
			reading.resolve()
			await release.promise
			return { allowed: true, blockingObligations: [] }
		})
		const completing = track(task.waitForCompletionGateDecision())
		await reading.promise
		const lease = acquireMutation()
		release.resolve()
		await draining
		expect(task["isAwaitingSubagentReview"]).toBe(true)
		lease.release!()
		expect(await completing).toMatchObject({ allowed: true })
		expect(provider.getParentCompletionDecision).toHaveBeenCalledTimes(2)
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("keeps legacy attempt_completion pending and returns one interrupted result for new guidance", async () => {
		const { task, changeSet, draining, acquireMutation, track } = fixture()
		Object.assign(task, { recordCompletionCandidate: vi.fn(), presentCompletionResult: vi.fn() })
		const lease = acquireMutation()
		const callbacks: AttemptCompletionCallbacks = {
			askApproval: vi.fn(async () => true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(async () => true),
			toolDescription: () => "Finish",
			toolCallId: "legacy-review-completion",
		}
		const completing = track(attemptCompletionTool.execute({ result: "The answer is ready." }, task, callbacks))
		await draining
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(task.presentCompletionResult).not.toHaveBeenCalled()
		await task.steerUserMessage("Keep investigating before review.")
		lease.release!()
		await completing
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.presentCompletionResult).not.toHaveBeenCalled()
		expect(changeSet.status).toBe("pending_review")
		expect(task.isCompleted()).toBe(false)
	})

	it("holds Goal completion for an admitted mutation without adding usage or a continuation", async () => {
		const { task, changeSet, draining, acquireMutation, track } = fixture()
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
		const lease = acquireMutation()
		const completing = track(task.updateGoalStatus("complete", { source: "tool" }))
		await draining
		expect(await controller.get()).toMatchObject({ status: "active", tokensUsed: 0, continuationCount: 0 })
		changeSet.status = "discarded"
		lease.release!()
		expect(await completing).toMatchObject({ status: "complete", tokensUsed: 0, continuationCount: 0 })
		expect(state.usageReceipts).toEqual([])
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})
})
