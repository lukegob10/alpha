import type { AgentMailboxEntry, ParentVerificationObligation } from "@alpha-code/types"

import { decideParentCompletion } from "../../agent/ParentVerification"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((complete) => (resolve = complete))
	return { promise, resolve }
}

const makePausedTask = (overrides: Record<string, unknown> = {}) =>
	Object.assign(Object.create(Task.prototype), {
		abort: false,
		didComplete: false,
		isTaskLoopActive: true,
		taskCancellationController: new AbortController(),
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

	it.each(["pending_review", "conflicted"] as const)(
		"continues after a %s proposal without requiring human review",
		async (status) => {
			const blocked = deferred<"blocked">()
			const controller = new AbortController()
			const provider = {
				postStateToWebviewWithoutTaskHistory: vi.fn(async () => blocked.resolve("blocked")),
				autoApplyPendingSubagentChangeSets: vi.fn(async () => undefined),
			}
			const task = makePausedTask({
				activeAsk: undefined,
				providerRef: { deref: () => provider },
				alphaMessages: [{ subagentGroup: { agents: [{ changeSet: { status } }] } }],
				beginAgentWait: () => ({ signal: controller.signal, dispose: vi.fn() }),
			})
			const waiting = task["waitForPendingSubagentChangeSetReviews"]()
			try {
				expect(await Promise.race([waiting.then(() => "continued"), blocked.promise])).toBe("continued")
				expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledWith(task.taskId)
				expect(task["isAwaitingSubagentReview"]).toBe(false)
			} finally {
				task.abort = true
				controller.abort()
				await waiting
			}
		},
	)

	it("drains an admitted Worker mutation before the next provider request without waiting for review", async () => {
		const entered = deferred()
		const finishIntegration = deferred()
		const draining = deferred()
		const blocked = deferred<"blocked">()
		const controller = new AbortController()
		let releaseMutation: (() => void) | undefined
		const provider = {
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => blocked.resolve("blocked")),
			autoApplyPendingSubagentChangeSets: vi.fn(async () => {
				const lease = task.acquireExternalMutation("applying Worker changes")
				releaseMutation = lease.release
				entered.resolve()
				await finishIntegration.promise
			}),
		}
		const group = {
			groupId: "nested-group",
			createdAt: Date.now(),
			agents: [{ changeSet: { id: "nested-change", status: "pending_review" } }],
		}
		const task = makePausedTask({
			activeAsk: undefined,
			providerRef: { deref: () => provider },
			alphaMessages: [
				{
					type: "say",
					say: "subagent_group",
					subagentGroup: structuredClone(group),
				},
			],
			isAwaitingSubagentReview: false,
			subagentReviewBarrier: undefined,
			beginAgentWait: () => ({ signal: controller.signal, dispose: vi.fn() }),
		})
		const waitForRequestControl = task["waitForRequestControl"].bind(task)
		Object.assign(task, {
			waitForRequestControl: (...args: Parameters<typeof waitForRequestControl>) => {
				draining.resolve()
				return waitForRequestControl(...args)
			},
		})

		const waiting = task["waitForPendingSubagentChangeSetReviews"]()
		try {
			await entered.promise
			expect(releaseMutation).toBeTypeOf("function")
			expect(task.getExternalMutationCapability()).toEqual({
				allowed: false,
				state: "busy",
				reason: "The parent is already applying Worker changes.",
			})

			let resumed = false
			void waiting.then(() => {
				resumed = true
			})
			finishIntegration.resolve()
			await draining.promise
			expect(resumed).toBe(false)

			releaseMutation!()
			releaseMutation!()
			expect(await Promise.race([waiting.then(() => "continued"), blocked.promise])).toBe("continued")
			expect(resumed).toBe(true)
			expect(task["isAwaitingSubagentReview"]).toBe(false)
			expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledWith(task.taskId)
		} finally {
			task.abort = true
			controller.abort()
			finishIntegration.resolve()
			releaseMutation?.()
			await waiting
		}
	})

	it("integrates authorized Worker proposals at the safe step boundary", async () => {
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
			alphaMessages: [{ type: "say", say: "subagent_group", subagentGroup: group }],
			isAwaitingSubagentReview: false,
			subagentReviewBarrier: undefined,
		})

		await task["waitForPendingSubagentChangeSetReviews"]()

		expect(provider.autoApplyPendingSubagentChangeSets).toHaveBeenCalledWith(task.taskId)
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
		expect(task["isAwaitingSubagentReview"]).toBe(false)
	})

	it("leaves proposals quarantined when newer steering is waiting to be read", async () => {
		const provider = { autoApplyPendingSubagentChangeSets: vi.fn(async () => undefined) }
		const task = makePausedTask({
			providerRef: { deref: () => provider },
			alphaMessages: [{ subagentGroup: { agents: [{ changeSet: { status: "pending_review" } }] } }],
			pendingSteerMessage: { text: "Keep this proposal pending." },
		})

		await task["waitForPendingSubagentChangeSetReviews"]()

		expect(provider.autoApplyPendingSubagentChangeSets).not.toHaveBeenCalled()
		expect(task["isAwaitingSubagentReview"]).not.toBe(true)
	})

	it.each(["pending_review", "conflicted"] as const)(
		"uses the canonical nonblocking obligation for a %s proposal",
		async (status) => {
			const obligation: ParentVerificationObligation = {
				id: "worker-change:proposal",
				rootTaskId: "root",
				parentTaskId: "root",
				workerTaskId: "worker",
				workerNickname: "Worker",
				groupId: "group",
				changeSetId: "proposal",
				changedFiles: ["pending.txt"],
				status: "required",
				createdAt: 1,
				updatedAt: 2,
			}
			const provider = { getParentCompletionDecision: vi.fn(async () => decideParentCompletion([obligation])) }
			const task = makePausedTask({
				providerRef: { deref: () => provider },
				alphaMessages: [{ subagentGroup: { agents: [{ changeSet: { status } }] } }],
				hasPendingAgentMessages: () => false,
				getOpenTodoCompletionDecision: () => undefined,
			})

			expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
			expect(provider.getParentCompletionDecision).toHaveBeenCalledOnce()
		},
	)

	it("keeps an admitted external mutation in the completion gate", async () => {
		const task = makePausedTask({ hasPendingAgentMessages: () => false })
		const lease = task.acquireExternalMutation("applying Worker changes")
		try {
			expect(await task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				classification: "waiting",
				reasonCode: "review_pending",
			})
		} finally {
			lease.release!()
		}
	})

	it("keeps an applied Worker effect without an approved receipt in the canonical completion gate", async () => {
		const obligation: ParentVerificationObligation = {
			id: "worker-change:applied",
			rootTaskId: "root",
			parentTaskId: "root",
			workerTaskId: "worker",
			workerNickname: "Worker",
			groupId: "group",
			changeSetId: "applied",
			changedFiles: ["pending.txt"],
			status: "pending",
			appliedAt: 2,
			createdAt: 1,
			updatedAt: 2,
		}
		const task = makePausedTask({
			providerRef: {
				deref: () => ({ getParentCompletionDecision: async () => decideParentCompletion([obligation]) }),
			},
			alphaMessages: [{ subagentGroup: { agents: [{ changeSet: { status: "applied" } }] } }],
			hasPendingAgentMessages: () => false,
			getOpenTodoCompletionDecision: () => undefined,
		})

		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "repairable",
			reasonCode: "verification_missing",
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

describe("parent completion and automatic agent notifications", () => {
	it.each(["interrupted", "cancelled", "completed", "blocked", "failed", "timed_out"] as const)(
		"uses the automatic notification contract for unread %s results",
		async (status) => {
			const entry: AgentMailboxEntry = {
				eventId: `child:${status}`,
				sequence: 1,
				rootTaskId: "root",
				recipientTaskId: "root",
				recipientPath: "/root",
				kind: "result",
				name: `agent_${status}`,
				payload: { taskId: "child", status },
				createdAt: 1,
			}
			const provider = Object.assign(Object.create(AlphaProvider.prototype), {
				recordParentVerificationEvidence: vi.fn(async () => undefined),
				ensureAgentControlRoot: vi.fn(async () => ({ rootTaskId: "root" })),
				reconcileWaitAgentClaims: vi.fn(async () => undefined),
				agentControlStore: {
					retryPendingMailboxClaimSettlements: vi.fn(async () => undefined),
					getParentCompletionDecision: () => decideParentCompletion([]),
					listDescendants: () => [],
					getUnacknowledgedMailboxEntries: () => [entry],
				},
			}) as AlphaProvider
			const parent = makePausedTask({ taskId: "root" })

			expect((await provider.getParentCompletionDecision(parent)).allowed).toBe(
				status === "interrupted" || status === "cancelled",
			)
			expect(
				await provider.getParentCompletionDecision(parent, { deferResultNotifications: true }),
			).toMatchObject({
				allowed: true,
			})
		},
	)
})
