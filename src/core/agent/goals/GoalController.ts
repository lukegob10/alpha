import { randomUUID } from "node:crypto"
import { z } from "zod"

import {
	DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
	taskGoalCreateInputSchema,
	taskGoalResumeInputSchema,
	type TaskGoal,
	type TaskGoalCreateInput,
	type TaskGoalCreateExpectation,
	type TaskGoalExpectation,
	type TaskGoalResumeInput,
} from "@alpha-code/types"

import {
	MAX_TASK_GOAL_USAGE_RECEIPTS,
	type GoalStateStore,
	type TaskGoalEnvelope,
} from "../../task-persistence/TaskGoalStore"

export type GoalCreateAuthority = "user" | "tool-approved"
export type GoalToolStatus = "complete" | "blocked" | "paused"
export type GoalSystemStopStatus = "paused" | "blocked" | "usage_limited"

export interface GoalIdleBoundary {
	isIdle: boolean
	hasPendingInput: boolean
	isPaused: boolean
	isCancelled: boolean
	mode?: "code" | "architect"
	signal?: AbortSignal
	/** The Task's synchronous steering/cancellation fence is rechecked after every await. */
	isStillAdmissible?: () => boolean
}

export interface GoalContinuationReservation {
	taskId: string
	goalId: string
	controlVersion: number
	continuationCount: number
	steeringGeneration: number
	reservationId: string
}

const usageSchema = z.object({
	eventId: z.string().min(1).max(256),
	tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	timeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	goalId: z.string().min(1).max(256),
})

/**
 * Owns one task's explicit objective, accounting and idle admission. Turn execution
 * remains in AgentTurnEngine/Task: this controller has no loop, timer or tool policy.
 */
export class GoalController {
	private lane: Promise<void> = Promise.resolve()
	private steeringGeneration = 0
	private pendingReservation: GoalContinuationReservation | undefined
	private authorizedGoalId: string | undefined
	private requestGeneration = 0
	private pendingControlMutations = 0
	private requestGoal: Pick<TaskGoal, "goalId" | "controlVersion" | "status"> | undefined
	private readonly now: () => number
	private readonly newId: () => string
	private readonly maxUsageReceipts: number

	constructor(
		private readonly options: {
			taskId: string
			store: GoalStateStore
			now?: () => number
			newId?: () => string
			maxUsageReceipts?: number
		},
	) {
		this.now = options.now ?? Date.now
		this.newId = options.newId ?? randomUUID
		this.maxUsageReceipts = z
			.number()
			.int()
			.positive()
			.max(MAX_TASK_GOAL_USAGE_RECEIPTS)
			.parse(options.maxUsageReceipts ?? MAX_TASK_GOAL_USAGE_RECEIPTS / 2)
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lane.then(operation, operation)
		this.lane = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private serializeControl<T>(operation: () => Promise<T>): Promise<T> {
		// Pending intent fences sampling synchronously. Only a committed state
		// change revokes captured bindings; rejected stale controls grant no change.
		this.pendingControlMutations++
		return this.serialize(operation).finally(() => {
			this.pendingControlMutations--
		})
	}

	private observeGoal(goal: TaskGoal | undefined, establishAuthority = false): void {
		const previous = this.requestGoal
		if (
			previous &&
			(!goal ||
				goal.goalId !== previous.goalId ||
				goal.controlVersion !== previous.controlVersion ||
				(previous.status === "active" && goal.status !== "active"))
		) {
			this.invalidateContinuation()
			this.requestGeneration++
			if (
				!establishAuthority &&
				(!goal || goal.goalId !== previous.goalId || goal.controlVersion !== previous.controlVersion)
			) {
				this.authorizedGoalId = undefined
			}
		}
		this.requestGoal = goal
			? { goalId: goal.goalId, controlVersion: goal.controlVersion, status: goal.status }
			: undefined
	}

	private stopRequestAdmission(goal: TaskGoal): void {
		this.invalidateContinuation()
		this.requestGeneration++
		if (this.requestGoal?.goalId === goal.goalId) {
			this.requestGoal = { goalId: goal.goalId, controlVersion: goal.controlVersion, status: goal.status }
		}
	}

	/** Capture with the goal binding; admission steering does not revoke independently running child work. */
	getRequestGeneration(): number {
		return this.requestGeneration
	}

	/** Stop/dispose can revoke captured child bindings before awaiting its durable goal snapshot. */
	invalidateRequests(): void {
		this.requestGeneration++
	}

	/** Recheck synchronously immediately before sampling; an awaited goal read alone cannot fence a pending pause. */
	isRequestCurrent(goalId: string, generation: number): boolean {
		return (
			this.pendingControlMutations === 0 &&
			this.requestGeneration === generation &&
			this.authorizedGoalId === goalId &&
			this.requestGoal?.goalId === goalId &&
			this.requestGoal.status === "active"
		)
	}

	private project(goal: TaskGoal | undefined): TaskGoal | undefined {
		this.observeGoal(goal)
		return goal
			? {
					...goal,
					recoveryDeferred:
						goal.status === "active" && (goal.recoveryDeferred || this.authorizedGoalId !== goal.goalId),
				}
			: undefined
	}

	private touch(goal: TaskGoal): void {
		if (goal.version === Number.MAX_SAFE_INTEGER) throw new Error("Goal version limit reached")
		goal.version++
		goal.updatedAt = this.now()
	}

	private touchControl(goal: TaskGoal): void {
		if (goal.controlVersion === Number.MAX_SAFE_INTEGER) throw new Error("Goal control version limit reached")
		goal.controlVersion++
		this.touch(goal)
	}

	private requireGoal(state: TaskGoalEnvelope, expected?: TaskGoalExpectation): TaskGoal {
		const goal = state.goal
		if (!goal) throw new Error("This task has no goal")
		if (
			expected &&
			(goal.goalId !== expected.goalId ||
				(expected.version !== undefined && goal.version !== expected.version) ||
				(expected.controlVersion !== undefined && goal.controlVersion !== expected.controlVersion))
		) {
			throw new Error("Goal changed before the requested action could be applied")
		}
		return goal
	}

	get(): Promise<TaskGoal | undefined> {
		return this.serialize(async () => this.project((await this.options.store.read()).goal))
	}

	create(
		input: TaskGoalCreateInput,
		authority: GoalCreateAuthority,
		expected?: TaskGoalCreateExpectation,
		isStillAuthorized?: () => boolean,
	): Promise<TaskGoal> {
		if (authority !== "user" && authority !== "tool-approved") {
			return Promise.reject(new Error("Goal creation requires explicit user authorization"))
		}
		const parsed = taskGoalCreateInputSchema.parse(input)
		return this.serializeControl(async () => {
			const goal = await this.options.store.transact((state) => {
				if (isStillAuthorized && !isStillAuthorized()) throw new Error("Goal creation authorization changed")
				if (
					expected &&
					(state.goal?.goalId !== (expected.goalId ?? undefined) ||
						(expected.version !== undefined && state.goal?.version !== expected.version) ||
						(expected.controlVersion !== undefined &&
							state.goal?.controlVersion !== expected.controlVersion))
				) {
					throw new Error("Goal changed before the requested action could be applied")
				}
				if (state.goal && state.goal.status !== "complete") {
					throw new Error("Cannot create a goal while this task has an unfinished goal")
				}
				const now = this.now()
				const created: TaskGoal = {
					goalId: this.newId(),
					taskId: this.options.taskId,
					objective: parsed.objective,
					status: "active",
					...(parsed.tokenBudget === undefined ? {} : { tokenBudget: parsed.tokenBudget }),
					tokensUsed: 0,
					timeUsedMs: 0,
					version: 1,
					controlVersion: 1,
					createdAt: now,
					updatedAt: now,
					maxContinuations: parsed.maxContinuations ?? DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
					continuationCount: 0,
					recoveryDeferred: false,
				}
				state.goal = created
				state.usageReceipts = []
				return created
			})
			this.observeGoal(goal, true)
			this.authorizedGoalId = goal.goalId
			return { ...goal }
		})
	}

	updateStatus(
		status: GoalToolStatus,
		expected?: TaskGoalExpectation,
		isStillAuthorized?: () => boolean,
	): Promise<TaskGoal> {
		if (status !== "complete" && status !== "blocked" && status !== "paused") {
			return Promise.reject(new Error("Tools cannot resume goals or change system limit statuses"))
		}
		return this.serializeControl(async () => {
			const goal = await this.options.store.transact((state) => {
				if (isStillAuthorized && !isStillAuthorized()) throw new Error("Goal update authorization changed")
				const current = this.requireGoal(state, expected)
				if (current.status === "complete" && status !== "complete") {
					throw new Error("A completed goal cannot be paused or blocked")
				}
				// In-flight usage can exhaust a budget while a pause is being approved.
				const next = current.status === "budget_limited" && status !== "complete" ? current.status : status
				if (next !== current.status) {
					current.status = next
					current.recoveryDeferred = false
					this.touchControl(current)
				}
				return current
			})
			this.authorizedGoalId = undefined
			this.observeGoal(goal)
			return { ...goal }
		})
	}

	/** Cancellation stops admission immediately; its durable status update joins the same mutation lane. */
	pause(
		_reason?: string,
		expected?: TaskGoalExpectation,
		isStillAuthorized?: () => boolean,
	): Promise<TaskGoal | undefined> {
		return this.systemStop("paused", expected, isStillAuthorized)
	}

	resume(
		input: TaskGoalResumeInput = {},
		expected?: TaskGoalExpectation,
		isStillAuthorized?: () => boolean,
	): Promise<TaskGoal> {
		const parsed = taskGoalResumeInputSchema.parse(input)
		return this.serializeControl(async () => {
			const goal = await this.options.store.transact((state) => {
				if (isStillAuthorized && !isStillAuthorized()) throw new Error("Goal resume authorization changed")
				const current = this.requireGoal(state, expected)
				if (current.status === "complete")
					throw new Error("Create a new goal after completing the existing goal")
				if (state.usageReceipts.length >= this.maxUsageReceipts) {
					throw new Error(
						"Goal accounting capacity reached; complete or clear this goal before creating another",
					)
				}
				if (parsed.tokenBudget === null) delete current.tokenBudget
				else if (parsed.tokenBudget !== undefined) current.tokenBudget = parsed.tokenBudget
				if (parsed.maxContinuations !== undefined) current.maxContinuations = parsed.maxContinuations
				current.status =
					current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget
						? "budget_limited"
						: "active"
				current.continuationCount = 0
				current.recoveryDeferred = false
				this.touchControl(current)
				return current
			})
			this.observeGoal(goal, true)
			this.authorizedGoalId = goal.status === "active" ? goal.goalId : undefined
			return { ...goal }
		})
	}

	clear(expected?: TaskGoalExpectation, isStillAuthorized?: () => boolean): Promise<void> {
		return this.serializeControl(async () => {
			await this.options.store.transact((state) => {
				if (isStillAuthorized && !isStillAuthorized()) throw new Error("Goal clear authorization changed")
				if (expected) this.requireGoal(state, expected)
				delete state.goal
				state.usageReceipts = []
			})
			this.authorizedGoalId = undefined
			this.observeGoal(undefined)
		})
	}

	/** The captured goal ID, not the live task objective, owns late provider and descendant usage. */
	recordUsage(
		eventId: string,
		tokens: number,
		timeMs: number,
		expectedGoalId: string,
		mode: "code" | "architect" = "code",
	): Promise<TaskGoal | undefined> {
		const receipt = usageSchema.parse({ eventId, tokens, timeMs, goalId: expectedGoalId })
		return this.serialize(async () => {
			const goal = await this.options.store.transact((state) => {
				const current = state.goal
				if (!current || current.goalId !== receipt.goalId || mode === "architect") return current
				const existing = state.usageReceipts.find((entry) => entry.eventId === receipt.eventId)
				if (existing) {
					if (existing.tokens !== tokens || existing.timeMs !== timeMs) {
						throw new Error("Goal usage event ID conflicts with previously accounted usage")
					}
					return current
				}
				if (state.usageReceipts.length >= MAX_TASK_GOAL_USAGE_RECEIPTS) {
					throw new Error("Goal accounting capacity reached")
				}
				state.usageReceipts.push({ eventId, tokens, timeMs })
				const previousStatus = current.status
				current.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, current.tokensUsed + tokens)
				current.timeUsedMs = Math.min(Number.MAX_SAFE_INTEGER, current.timeUsedMs + timeMs)
				if (
					current.status !== "complete" &&
					current.tokenBudget !== undefined &&
					current.tokensUsed >= current.tokenBudget
				) {
					current.status = "budget_limited"
				} else if (current.status === "active" && state.usageReceipts.length >= this.maxUsageReceipts) {
					current.status = "usage_limited"
				}
				if (previousStatus === "active" && current.status !== "active") this.stopRequestAdmission(current)
				this.touch(current)
				return current
			})
			return this.project(goal)
		})
	}

	systemStop(
		status: GoalSystemStopStatus,
		expected?: string | TaskGoalExpectation,
		isStillAuthorized?: () => boolean,
	): Promise<TaskGoal | undefined> {
		return this.serializeControl(async () => {
			const goal = await this.options.store.transact((state) => {
				if (isStillAuthorized && !isStillAuthorized()) throw new Error("Goal stop authorization changed")
				const current = state.goal
				const expectation = typeof expected === "string" ? { goalId: expected } : expected
				if (
					!current ||
					(expectation &&
						(current.goalId !== expectation.goalId ||
							(expectation.version !== undefined && current.version !== expectation.version) ||
							(expectation.controlVersion !== undefined &&
								current.controlVersion !== expectation.controlVersion)))
				) {
					return current
				}
				if (
					current.status === "active" ||
					(current.status === "budget_limited" && status === "usage_limited")
				) {
					current.status = status
					current.recoveryDeferred = false
					this.touchControl(current)
				}
				return current
			})
			if (!goal || goal.status !== "active") this.authorizedGoalId = undefined
			return this.project(goal)
		})
	}

	/** Synchronous fencing gives human input priority over an admission waiting on storage. */
	invalidateContinuation(): void {
		this.steeringGeneration++
		this.pendingReservation = undefined
	}

	private boundaryAllows(boundary: GoalIdleBoundary): boolean {
		return (
			boundary.isIdle &&
			!boundary.hasPendingInput &&
			!boundary.isPaused &&
			!boundary.isCancelled &&
			!boundary.signal?.aborted &&
			boundary.mode !== "architect" &&
			(boundary.isStillAdmissible?.() ?? true)
		)
	}

	private canContinue(goal: TaskGoal | undefined, boundary: GoalIdleBoundary): goal is TaskGoal {
		return (
			!!goal && goal.status === "active" && !this.project(goal)?.recoveryDeferred && this.boundaryAllows(boundary)
		)
	}

	reserveContinuation(boundary: GoalIdleBoundary): Promise<GoalContinuationReservation | undefined> {
		const generation = this.steeringGeneration
		return this.serialize(async () => {
			if (!this.boundaryAllows(boundary) || this.pendingReservation) return undefined
			const reservation = await this.options.store.transact((state) => {
				const goal = state.goal
				if (generation !== this.steeringGeneration || !this.canContinue(goal, boundary)) return undefined
				if (goal.continuationCount >= goal.maxContinuations) {
					goal.status = "usage_limited"
					this.stopRequestAdmission(goal)
					this.touch(goal)
					return undefined
				}
				return {
					taskId: this.options.taskId,
					goalId: goal.goalId,
					controlVersion: goal.controlVersion,
					continuationCount: goal.continuationCount,
					steeringGeneration: generation,
					reservationId: this.newId(),
				}
			})
			if (generation !== this.steeringGeneration || !this.boundaryAllows(boundary)) return undefined
			this.pendingReservation = reservation
			return reservation
		})
	}

	consumeContinuation(
		reservation: GoalContinuationReservation,
		boundary: GoalIdleBoundary,
	): Promise<TaskGoal | undefined> {
		return this.serialize(async () => {
			if (
				!this.pendingReservation ||
				this.pendingReservation.reservationId !== reservation.reservationId ||
				reservation.taskId !== this.options.taskId ||
				reservation.steeringGeneration !== this.steeringGeneration ||
				!this.boundaryAllows(boundary)
			) {
				return undefined
			}
			const admitted = await this.options.store.transact((state) => {
				const goal = state.goal
				if (
					reservation.steeringGeneration !== this.steeringGeneration ||
					!this.canContinue(goal, boundary) ||
					goal.goalId !== reservation.goalId ||
					goal.controlVersion !== reservation.controlVersion ||
					goal.continuationCount !== reservation.continuationCount ||
					goal.continuationCount >= goal.maxContinuations
				) {
					return undefined
				}
				goal.continuationCount++
				this.touch(goal)
				return goal
			})
			if (this.pendingReservation?.reservationId === reservation.reservationId)
				this.pendingReservation = undefined
			if (reservation.steeringGeneration !== this.steeringGeneration || !this.boundaryAllows(boundary)) {
				return undefined
			}
			return this.project(admitted)
		})
	}
}
