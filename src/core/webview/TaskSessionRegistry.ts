import {
	type AgentLifecycleSnapshot,
	type ClineAsk,
	type ClineMessage,
	type LiveTaskMetadata,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import type { Task } from "../task/Task"
import {
	projectAgentLifecycleSnapshot,
	projectClineMessageStatus,
	type ClineMessageStatusProjection,
} from "./AgentLifecycleProjection"

export const DEFAULT_MAX_LIVE_TASKS = 3
export const MIN_MAX_LIVE_TASKS = 1
export const MAX_MAX_LIVE_TASKS = 50

export const normalizeMaxLiveTasks = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_MAX_LIVE_TASKS
	}

	return Math.min(Math.max(Math.trunc(value), MIN_MAX_LIVE_TASKS), MAX_MAX_LIVE_TASKS)
}

type TaskSession = {
	task: Task
	lifecycle: TaskLifecycleState
	lastActivityAt: number
	waitingReason?: string
	/** Canonical lifecycle state, when the runtime has supplied one. */
	lifecycleSnapshot?: AgentLifecycleSnapshot
}

const terminalLifecycleStates = new Set<TaskLifecycleState>([
	TaskLifecycleState.Completed,
	TaskLifecycleState.Failed,
	TaskLifecycleState.Closed,
])

// A fresh completion_result is still an open review/follow-up boundary. Only a
// persisted resume_completed_task represents an already-terminal session.
const terminalAskTypes = new Set<ClineAsk>(["resume_completed_task"])

const isTerminalLifecycle = (lifecycle: TaskLifecycleState) => terminalLifecycleStates.has(lifecycle)

const isTerminalAsk = (ask: ClineAsk | undefined) => Boolean(ask && terminalAskTypes.has(ask))

const terminalInputAskTypes = new Set<ClineAsk>(["completion_result", "resume_task", "resume_completed_task"])

const canAcceptTerminalAskInput = (ask: ClineAsk | undefined) => Boolean(ask && terminalInputAskTypes.has(ask))

export class TaskSessionRegistry {
	private readonly sessions = new Map<string, TaskSession>()
	private activeTaskId: string | undefined

	constructor(private maxLiveTasks = DEFAULT_MAX_LIVE_TASKS) {
		this.maxLiveTasks = normalizeMaxLiveTasks(maxLiveTasks)
	}

	setMaxLiveTasks(maxLiveTasks: number): void {
		this.maxLiveTasks = normalizeMaxLiveTasks(maxLiveTasks)
	}

	getMaxLiveTasks(): number {
		return this.maxLiveTasks
	}

	getActiveTaskId(): string | undefined {
		return this.activeTaskId
	}

	getActiveTask(): Task | undefined {
		return this.activeTaskId ? this.sessions.get(this.activeTaskId)?.task : undefined
	}

	getTask(taskId: string | undefined): Task | undefined {
		return taskId ? this.sessions.get(taskId)?.task : undefined
	}

	canAcceptInput(taskId: string | undefined): boolean {
		if (!taskId) {
			return false
		}

		const session = this.sessions.get(taskId)
		if (!session) {
			return false
		}

		const lifecycle = this.getEffectiveLifecycle(session)
		if (!isTerminalLifecycle(lifecycle)) {
			return true
		}

		return canAcceptTerminalAskInput(session.task.taskAsk?.ask)
	}

	getLiveTaskIds(): string[] {
		return Array.from(this.sessions.entries())
			.filter(([, session]) => this.isLiveSession(session))
			.map(([taskId]) => taskId)
	}

	getLiveTaskCount(): number {
		return Array.from(this.sessions.values()).filter((session) => this.isLiveSession(session)).length
	}

	canCreateTask(): boolean {
		return this.getLiveTaskCount() < this.maxLiveTasks
	}

	getAvailableTaskCapacity(): number {
		return Math.max(0, this.maxLiveTasks - this.getLiveTaskCount())
	}

	register(task: Task, options: { focus?: boolean; lifecycleSnapshot?: AgentLifecycleSnapshot } = {}): void {
		const pendingSnapshot = options.lifecycleSnapshot ?? this.lifecycleSnapshots.get(task.taskId)
		const projection = pendingSnapshot
			? projectAgentLifecycleSnapshot(pendingSnapshot, {
					taskAsk: task.taskAsk,
					messages: task.clineMessages,
				})
			: undefined
		this.sessions.set(task.taskId, {
			task,
			lifecycle: this.lifecycleDegradedTaskIds.has(task.taskId)
				? projectClineMessageStatus({
						messages: task.clineMessages,
						taskAsk: task.taskAsk,
						taskStatus: task.taskStatus,
					}).lifecycle
				: (projection?.lifecycle ?? TaskLifecycleState.Initializing),
			lastActivityAt: Date.now(),
			waitingReason: this.lifecycleDegradedTaskIds.has(task.taskId)
				? projectClineMessageStatus({
						messages: task.clineMessages,
						taskAsk: task.taskAsk,
						taskStatus: task.taskStatus,
					}).waitingReason
				: projection?.waitingReason,
			lifecycleSnapshot: pendingSnapshot ? structuredClone(pendingSnapshot) : undefined,
		})
		if (pendingSnapshot) this.lifecycleSnapshots.set(task.taskId, structuredClone(pendingSnapshot))

		if (options.focus ?? true) {
			this.activeTaskId = task.taskId
		}
	}

	focus(taskId: string | undefined): Task | undefined {
		if (!taskId) {
			this.activeTaskId = undefined
			return undefined
		}

		const session = this.sessions.get(taskId)
		if (!session) {
			return undefined
		}

		this.activeTaskId = taskId
		return session.task
	}

	clearFocus(): void {
		this.activeTaskId = undefined
	}

	unregister(taskId: string): Task | undefined {
		const session = this.sessions.get(taskId)
		if (!session) {
			return undefined
		}

		this.sessions.delete(taskId)

		if (this.activeTaskId === taskId) {
			this.activeTaskId = this.getFallbackFocusTaskId()
		}

		return session.task
	}

	markLifecycle(taskId: string, lifecycle: TaskLifecycleState, waitingReason?: string): void {
		const session = this.sessions.get(taskId)
		if (!session) {
			return
		}

		// Canonical snapshots describe turns. Task events remain authoritative for
		// the containing task's completion, failure, and follow-up boundaries.
		session.lifecycle = lifecycle
		session.lastActivityAt = Date.now()
		session.waitingReason = waitingReason
	}

	markActivity(taskId: string, observedAt = Date.now()): void {
		const session = this.sessions.get(taskId)
		if (!session) return
		session.lastActivityAt = Math.max(observedAt, session.lastActivityAt)
	}

	private readonly lifecycleSnapshots = new Map<string, AgentLifecycleSnapshot>()
	private readonly lifecycleDegradedTaskIds = new Set<string>()

	/** Prefer legacy transcript/task status while canonical persistence is unavailable. */
	markLifecycleDegraded(taskId: string): void {
		this.lifecycleDegradedTaskIds.add(taskId)
		const session = this.sessions.get(taskId)
		if (!session) return

		const legacy = projectClineMessageStatus({
			messages: session.task.clineMessages,
			taskAsk: session.task.taskAsk,
			taskStatus: session.task.taskStatus,
		})
		session.lifecycle = legacy.lifecycle
		session.waitingReason = legacy.waitingReason
		session.lastActivityAt = Date.now()
	}

	/** Re-enable canonical projection after an authoritative replay/resync. */
	clearLifecycleDegraded(taskId: string): void {
		if (!this.lifecycleDegradedTaskIds.delete(taskId)) return
		const session = this.sessions.get(taskId)
		const snapshot = this.lifecycleSnapshots.get(taskId)
		if (!session || !snapshot) return

		this.applyLifecycleSnapshotToSession(taskId, session, snapshot)
	}

	private applyLifecycleSnapshotToSession(
		taskId: string,
		session: TaskSession,
		snapshot: AgentLifecycleSnapshot,
	): void {
		session.lifecycleSnapshot = snapshot
		session.lastActivityAt = snapshot.terminalAt ?? Date.now()
		if (this.lifecycleDegradedTaskIds.has(taskId)) return

		// A turn snapshot may refine an active task, but it cannot overwrite a
		// task-level terminal state or a review boundary published after the turn.
		if (snapshot.status !== "in_progress") {
			if (session.lifecycle === TaskLifecycleState.Initializing) {
				session.lifecycle = TaskLifecycleState.Running
				session.waitingReason = undefined
			}
			return
		}
		if (isTerminalLifecycle(session.lifecycle)) return

		const projection = projectAgentLifecycleSnapshot(snapshot, {
			taskAsk: session.task.taskAsk,
			messages: session.task.clineMessages,
		})
		session.lifecycle = projection.lifecycle
		session.waitingReason = projection.waitingReason
	}

	clearAllLifecycleDegraded(): void {
		for (const taskId of Array.from(this.lifecycleDegradedTaskIds)) this.clearLifecycleDegraded(taskId)
	}

	isLifecycleDegraded(taskId: string | undefined): boolean {
		return taskId !== undefined && this.lifecycleDegradedTaskIds.has(taskId)
	}

	/** Attach a validated canonical snapshot to a task session. */
	markLifecycleSnapshot(taskId: string, snapshot: AgentLifecycleSnapshot): void {
		const trustedSnapshot = structuredClone(snapshot)
		this.lifecycleSnapshots.set(taskId, trustedSnapshot)
		const session = this.sessions.get(taskId)
		if (!session) return

		this.applyLifecycleSnapshotToSession(taskId, session, trustedSnapshot)
	}

	/** Compatibility alias for callers that call this operation `set`. */
	setLifecycleSnapshot(taskId: string, snapshot: AgentLifecycleSnapshot): void {
		this.markLifecycleSnapshot(taskId, snapshot)
	}

	/** Compatibility alias for callers that use an `apply` verb. */
	applyLifecycleSnapshot(taskId: string, snapshot: AgentLifecycleSnapshot): void {
		this.markLifecycleSnapshot(taskId, snapshot)
	}

	getLifecycleSnapshot(taskId: string | undefined): AgentLifecycleSnapshot | undefined {
		if (!taskId) return undefined
		const snapshot = this.lifecycleSnapshots.get(taskId)
		return snapshot ? structuredClone(snapshot) : undefined
	}

	getLifecycleSnapshots(): Record<string, AgentLifecycleSnapshot> {
		return Object.fromEntries(
			Array.from(this.lifecycleSnapshots.entries()).map(([taskId, snapshot]) => [
				taskId,
				structuredClone(snapshot),
			]),
		)
	}

	clearLifecycleSnapshot(taskId?: string): void {
		if (taskId === undefined) {
			this.lifecycleSnapshots.clear()
			for (const session of this.sessions.values()) session.lifecycleSnapshot = undefined
			return
		}

		this.lifecycleSnapshots.delete(taskId)
		const session = this.sessions.get(taskId)
		if (session) session.lifecycleSnapshot = undefined
	}

	private getEffectiveLifecycle(session: TaskSession): TaskLifecycleState {
		if (isTerminalLifecycle(session.lifecycle)) {
			return session.lifecycle
		}
		if (isTerminalAsk(session.task.taskAsk?.ask)) {
			return TaskLifecycleState.Completed
		}
		if (
			session.lifecycleSnapshot?.status === "in_progress" &&
			!this.lifecycleDegradedTaskIds.has(session.task.taskId)
		) {
			return projectAgentLifecycleSnapshot(session.lifecycleSnapshot, {
				taskAsk: session.task.taskAsk,
				messages: session.task.clineMessages,
			}).lifecycle
		}

		return session.lifecycle
	}

	private isLiveSession(session: TaskSession): boolean {
		return !isTerminalLifecycle(this.getEffectiveLifecycle(session))
	}

	private getFallbackFocusTaskId(): string | undefined {
		for (const [taskId, session] of this.sessions) {
			if (this.isLiveSession(session)) {
				return taskId
			}
		}

		return undefined
	}

	getMetadata(): Record<string, LiveTaskMetadata> {
		const entries = Array.from(this.sessions.values()).map((session) => {
			const { task } = session
			const tokenUsage = task.tokenUsage
			const lifecycle = this.getEffectiveLifecycle(session)
			const taskAsk = task.taskAsk
			const isTerminal = isTerminalLifecycle(lifecycle)
			const projection: ClineMessageStatusProjection =
				session.lifecycleSnapshot && !this.lifecycleDegradedTaskIds.has(task.taskId)
					? projectAgentLifecycleSnapshot(session.lifecycleSnapshot, {
							taskAsk,
							messages: task.clineMessages,
						})
					: projectClineMessageStatus({
							messages: task.clineMessages,
							taskAsk,
							taskStatus: task.taskStatus,
						})
			const isWaitingForInput =
				!isTerminal &&
				(lifecycle === TaskLifecycleState.Waiting || projection.isWaitingForInput || Boolean(taskAsk))
			const waitingReason = isTerminal
				? undefined
				: (session.waitingReason ?? projection.waitingReason ?? taskAsk?.ask)
			const status = isTerminal
				? TaskStatus.Idle
				: isWaitingForInput
					? waitingReason === "completion" || waitingReason === "completion_result"
						? TaskStatus.Idle
						: waitingReason === "resumable"
							? TaskStatus.Resumable
							: TaskStatus.Interactive
					: session.lifecycleSnapshot
						? TaskStatus.Running
						: (task.taskStatus ?? TaskStatus.None)
			const isTurnActive =
				typeof task.isTurnActive === "function" ? task.isTurnActive() : Boolean(task.isStreaming)
			const canInterrupt =
				typeof task.canInterruptCurrentTurn === "function"
					? task.canInterruptCurrentTurn()
					: isTurnActive && !isWaitingForInput
			const hasPendingSteer =
				typeof task.hasPendingSteerMessage === "function" ? task.hasPendingSteerMessage() : false
			const metadata: LiveTaskMetadata = {
				id: task.taskId,
				status,
				lifecycle,
				isActive: task.taskId === this.activeTaskId,
				isStreaming: task.isStreaming,
				isTurnActive,
				canInterrupt,
				activityPhase: session.lifecycleSnapshot?.phase,
				hasPendingSteer,
				isWaitingForInput,
				lastUpdatedAt: Math.max(
					session.lastActivityAt,
					session.lifecycleSnapshot?.terminalAt ?? 0,
					task.clineMessages.at(-1)?.ts ?? 0,
				),
				waitingReason,
				queueCount: task.messageQueueService?.messages?.length ?? task.queuedMessages?.length ?? 0,
				tokensIn: tokenUsage?.totalTokensIn ?? 0,
				tokensOut: tokenUsage?.totalTokensOut ?? 0,
				totalCost: tokenUsage?.totalCost ?? 0,
			}

			return [task.taskId, metadata] as const
		})

		return Object.fromEntries(entries)
	}
}
