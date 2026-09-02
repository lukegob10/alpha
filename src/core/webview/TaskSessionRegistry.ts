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
		// Once a canonical snapshot is attached, legacy Task events are only a
		// compatibility signal. They must not overwrite an authoritative terminal
		// state (or make a gap-resynced task appear active again).
		if (session.lifecycleSnapshot && !this.lifecycleDegradedTaskIds.has(taskId)) return

		session.lifecycle = lifecycle
		session.lastActivityAt = Date.now()
		session.waitingReason = waitingReason
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

		const projection = projectAgentLifecycleSnapshot(snapshot, {
			taskAsk: session.task.taskAsk,
			messages: session.task.clineMessages,
		})
		session.lifecycle = projection.lifecycle
		session.waitingReason = projection.waitingReason
		session.lastActivityAt = snapshot.terminalAt ?? Date.now()
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

		const projection = projectAgentLifecycleSnapshot(trustedSnapshot, {
			taskAsk: session.task.taskAsk,
			messages: session.task.clineMessages,
		})
		session.lifecycleSnapshot = trustedSnapshot
		if (!this.lifecycleDegradedTaskIds.has(taskId)) {
			session.lifecycle = projection.lifecycle
			session.waitingReason = projection.waitingReason
			session.lastActivityAt = trustedSnapshot.terminalAt ?? Date.now()
		}
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
		if (session.lifecycleSnapshot && !this.lifecycleDegradedTaskIds.has(session.task.taskId)) {
			return projectAgentLifecycleSnapshot(session.lifecycleSnapshot, {
				taskAsk: session.task.taskAsk,
				messages: session.task.clineMessages,
			}).lifecycle
		}
		if (session.lifecycle === TaskLifecycleState.Waiting && isTerminalAsk(session.task.taskAsk?.ask)) {
			return TaskLifecycleState.Completed
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
			const metadata: LiveTaskMetadata = {
				id: task.taskId,
				status: session.lifecycleSnapshot
					? projection.isTerminal
						? TaskStatus.Idle
						: projection.isWaitingForInput
							? TaskStatus.Interactive
							: TaskStatus.Running
					: (task.taskStatus ?? TaskStatus.None),
				lifecycle,
				isActive: task.taskId === this.activeTaskId,
				isStreaming: task.isStreaming,
				isWaitingForInput:
					!isTerminal && (session.lifecycleSnapshot ? projection.isWaitingForInput : Boolean(taskAsk)),
				lastUpdatedAt:
					session.lifecycleSnapshot?.terminalAt ?? task.clineMessages.at(-1)?.ts ?? session.lastActivityAt,
				waitingReason: isTerminal
					? undefined
					: (session.waitingReason ?? projection.waitingReason ?? taskAsk?.ask),
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
