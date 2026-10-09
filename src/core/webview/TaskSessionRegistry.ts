import {
	type AgentLifecycleSnapshot,
	type AlphaAsk,
	type AlphaMessage,
	type LiveTaskMetadata,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"
import path from "node:path"

import { findLast } from "../../shared/array"
import type { Task } from "../task/Task"
import {
	projectAgentLifecycleSnapshot,
	projectAlphaMessageStatus,
	type AlphaMessageStatusProjection,
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
	owner: TaskSessionRegistry
	lifecycle: TaskLifecycleState
	transcriptRevision: number
	lastActivityAt: number
	waitingReason?: string
	/** Canonical lifecycle state, when the runtime has supplied one. */
	lifecycleSnapshot?: AgentLifecycleSnapshot
}

type SharedTaskSessions = {
	sessions: Map<string, TaskSession>
	views: Set<TaskSessionRegistry>
	lifecycleSnapshots: Map<string, AgentLifecycleSnapshot>
	lifecycleDegradedTaskIds: Set<string>
	nextTranscriptRevision: number
	maxLiveTasks: number
	ownershipOperations: Map<string, Promise<void>>
	slotReservations: Map<string, TaskSlotReservation>
	startupRecovery?: Promise<void>
}

type TaskSlotReservation = {
	owner: TaskSessionRegistry
	rootTaskId: string
	count: number
	taskIds?: readonly string[]
}

const createSharedTaskSessions = (maxLiveTasks: number): SharedTaskSessions => ({
	sessions: new Map(),
	views: new Set(),
	lifecycleSnapshots: new Map(),
	lifecycleDegradedTaskIds: new Set(),
	nextTranscriptRevision: 0,
	maxLiveTasks: normalizeMaxLiveTasks(maxLiveTasks),
	ownershipOperations: new Map(),
	slotReservations: new Map(),
})

const terminalLifecycleStates = new Set<TaskLifecycleState>([
	TaskLifecycleState.Completed,
	TaskLifecycleState.Failed,
	TaskLifecycleState.Closed,
])

// A fresh completion_result is still an open review/follow-up boundary. Only a
// persisted resume_completed_task represents an already-terminal session.
const terminalAskTypes = new Set<AlphaAsk>(["resume_completed_task"])

const isTerminalLifecycle = (lifecycle: TaskLifecycleState) => terminalLifecycleStates.has(lifecycle)

const isTerminalAsk = (ask: AlphaAsk | undefined) => Boolean(ask && terminalAskTypes.has(ask))

const terminalInputAskTypes = new Set<AlphaAsk>(["completion_result", "resume_task", "resume_completed_task"])

const canAcceptTerminalAskInput = (ask: AlphaAsk | undefined) => Boolean(ask && terminalInputAskTypes.has(ask))

export class TaskSessionRegistry {
	private static readonly hosts = new Map<string, SharedTaskSessions>()
	private readonly shared: SharedTaskSessions
	private activeTaskId: string | undefined

	/** Share runtime ownership while retaining a distinct selection for each view. */
	static forGlobalStorage(globalStoragePath: string, maxLiveTasks = DEFAULT_MAX_LIVE_TASKS): TaskSessionRegistry {
		const resolvedPath = path.resolve(globalStoragePath)
		const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
		let shared = this.hosts.get(key)
		if (!shared) {
			shared = createSharedTaskSessions(maxLiveTasks)
			this.hosts.set(key, shared)
		}
		return new TaskSessionRegistry(maxLiveTasks, shared)
	}

	constructor(maxLiveTasks = DEFAULT_MAX_LIVE_TASKS, shared?: SharedTaskSessions) {
		this.shared = shared ?? createSharedTaskSessions(maxLiveTasks)
		this.shared.views.add(this)
	}

	private get sessions(): Map<string, TaskSession> {
		return this.shared.sessions
	}

	private get lifecycleSnapshots(): Map<string, AgentLifecycleSnapshot> {
		return this.shared.lifecycleSnapshots
	}

	private get lifecycleDegradedTaskIds(): Set<string> {
		return this.shared.lifecycleDegradedTaskIds
	}

	private get nextTranscriptRevision(): number {
		return this.shared.nextTranscriptRevision
	}

	private set nextTranscriptRevision(value: number) {
		this.shared.nextTranscriptRevision = value
	}

	private get maxLiveTasks(): number {
		return this.shared.maxLiveTasks
	}

	private set maxLiveTasks(value: number) {
		this.shared.maxLiveTasks = value
	}

	getOwner(taskId: string): TaskSessionRegistry | undefined {
		return this.sessions.get(taskId)?.owner
	}

	sharesHostWith(other: TaskSessionRegistry): boolean {
		return this.shared === other.shared
	}

	ownsTask(taskId: string): boolean {
		return this.getOwner(taskId) === this
	}

	getOwnedTasks(): Task[] {
		return Array.from(this.sessions.values())
			.filter((session) => session.owner === this)
			.map((session) => session.task)
	}

	getReservedTaskSlots(
		rootTaskId: string,
		isRootTaskRegistered: (taskId: string) => boolean,
		excludedReservationId?: string,
	): { total: number; root: number } {
		let total = 0
		let root = 0
		for (const [id, reservation] of this.shared.slotReservations) {
			if (id === excludedReservationId) continue
			const unregistered = reservation.taskIds?.filter((taskId) => !this.sessions.has(taskId))
			total += unregistered ? Math.min(reservation.count, unregistered.length) : reservation.count
			if (reservation.rootTaskId === rootTaskId) {
				root += unregistered
					? Math.min(reservation.count, unregistered.filter((taskId) => !isRootTaskRegistered(taskId)).length)
					: reservation.count
			}
		}
		return { total, root }
	}

	/** Claim prepared-child capacity synchronously, before approval/context preparation can yield. */
	reserveTaskSlots(
		reservationId: string,
		options: {
			rootTaskId: string
			count: number
			maxTotalTasks: number
			maxRootTasks: number
			activeRootTasks: number
			isRootTaskRegistered: (taskId: string) => boolean
		},
	): void {
		if (this.shared.slotReservations.has(reservationId)) {
			throw new Error(`Task capacity reservation ${reservationId} already exists`)
		}
		if (!Number.isSafeInteger(options.count) || options.count < 1) {
			throw new Error("Task capacity reservation must contain a positive task count")
		}
		const reserved = this.getReservedTaskSlots(options.rootTaskId, options.isRootTaskRegistered)
		const totalLimit = Math.min(this.maxLiveTasks, options.maxTotalTasks)
		const availableTotal = Math.max(0, totalLimit - this.getLiveTaskCount() - reserved.total)
		if (options.count > availableTotal) {
			throw new Error(
				`Not enough task capacity for ${options.count} sub-agent${options.count === 1 ? "" : "s"}. ` +
					`Available slots: ${availableTotal}; effective total live-task maximum: ${totalLimit}.`,
			)
		}
		const availableRoot = Math.max(0, options.maxRootTasks - options.activeRootTasks - reserved.root)
		if (options.count > availableRoot) {
			throw new Error(
				`Not enough root-wide child capacity for ${options.count} sub-agent${options.count === 1 ? "" : "s"}. ` +
					`Available slots: ${availableRoot}; effective root child maximum: ${options.maxRootTasks}.`,
			)
		}
		this.shared.slotReservations.set(reservationId, {
			owner: this,
			rootTaskId: options.rootTaskId,
			count: options.count,
		})
	}

	setReservedTaskIds(reservationId: string, taskIds: readonly string[]): void {
		const reservation = this.shared.slotReservations.get(reservationId)
		if (!reservation || reservation.owner !== this) {
			throw new Error(`Task capacity reservation ${reservationId} requires its current owner`)
		}
		if (taskIds.length !== reservation.count || new Set(taskIds).size !== taskIds.length) {
			throw new Error("Task capacity reservation identities must match its reserved count")
		}
		reservation.taskIds = [...taskIds]
	}

	releaseTaskSlots(reservationId: string): void {
		const reservation = this.shared.slotReservations.get(reservationId)
		if (!reservation) return
		if (reservation.owner !== this) {
			throw new Error(`Task capacity reservation ${reservationId} requires its current owner`)
		}
		this.shared.slotReservations.delete(reservationId)
	}

	/** Detach presentation without releasing tasks whose cleanup may still need retrying. */
	disposeView(): void {
		this.clearFocus()
		this.shared.views.delete(this)
	}

	/** Serialize replacement and cleanup for one stable task identity across views. */
	async runOwnershipOperation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.shared.ownershipOperations.get(taskId) ?? Promise.resolve()
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		this.shared.ownershipOperations.set(taskId, pending)
		await previous
		try {
			return await operation()
		} finally {
			release()
			if (this.shared.ownershipOperations.get(taskId) === pending) {
				this.shared.ownershipOperations.delete(taskId)
			}
		}
	}

	/** Recovery is host startup work; later views join it without rerunning it. */
	runStartupRecovery(recover: (hasOwner: (taskId: string) => boolean) => Promise<void>): Promise<void> {
		this.shared.startupRecovery ??= Promise.resolve().then(() => recover((taskId) => this.sessions.has(taskId)))
		return this.shared.startupRecovery
	}

	/** Keep the canonical handle registered until its effect cleanup and termination settle. */
	async releaseAfterCleanup(task: Task, cleanup: () => Promise<void>): Promise<void> {
		await this.runOwnershipOperation(task.taskId, async () => {
			if (this.getTask(task.taskId) !== task || !this.ownsTask(task.taskId)) {
				throw new Error(`Task ${task.taskId} cleanup requires its current session owner`)
			}
			await cleanup()
			this.unregister(task.taskId, task)
		})
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

	/** Registration order stays stable while activity and per-view selection change. */
	getAdjacentTaskId(direction: -1 | 1, needsInputOnly = false): string | undefined {
		const tasks = Array.from(this.sessions.values()).filter(
			({ task }) => task.taskKind !== "subagent" && !task.abandoned && !task.abort,
		)
		const current = tasks.findIndex(({ task }) => task.taskId === this.activeTaskId)
		const metadata = needsInputOnly ? this.getMetadata() : undefined
		for (let offset = 1; offset <= tasks.length; offset++) {
			const index =
				current === -1
					? direction === 1
						? offset - 1
						: tasks.length - offset
					: (current + direction * offset + tasks.length) % tasks.length
			const taskId = tasks[index].task.taskId
			const state = metadata?.[taskId]
			if (
				!needsInputOnly ||
				(state?.isWaitingForInput &&
					state.waitingReason !== "completion" &&
					state.waitingReason !== "completion_result")
			)
				return taskId
		}
		return undefined
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

		return canAcceptTerminalAskInput(this.getCurrentTaskAsk(session.task)?.ask)
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
		return this.getAvailableTaskCapacity() > 0
	}

	getAvailableTaskCapacity(): number {
		const reserved = this.getReservedTaskSlots("", () => false).total
		return Math.max(0, this.maxLiveTasks - this.getLiveTaskCount() - reserved)
	}

	register(task: Task, options: { focus?: boolean; lifecycleSnapshot?: AgentLifecycleSnapshot } = {}): void {
		const existing = this.sessions.get(task.taskId)
		if (existing) {
			if (existing.task !== task) {
				throw new Error(`Task ${task.taskId} already has a registered runtime owner`)
			}
			if (options.focus ?? true) this.activeTaskId = task.taskId
			return
		}
		const transcriptRevision = ++this.nextTranscriptRevision
		const pendingSnapshot = options.lifecycleSnapshot ?? this.lifecycleSnapshots.get(task.taskId)
		const projection = pendingSnapshot
			? projectAgentLifecycleSnapshot(pendingSnapshot, {
					taskAsk: task.taskAsk,
					messages: task.clineMessages,
				})
			: undefined
		this.sessions.set(task.taskId, {
			task,
			owner: this,
			transcriptRevision,
			lifecycle: this.lifecycleDegradedTaskIds.has(task.taskId)
				? projectAlphaMessageStatus({
						messages: task.clineMessages,
						taskAsk: task.taskAsk,
						taskStatus: task.taskStatus,
					}).lifecycle
				: (projection?.lifecycle ?? TaskLifecycleState.Initializing),
			lastActivityAt: Date.now(),
			waitingReason: this.lifecycleDegradedTaskIds.has(task.taskId)
				? projectAlphaMessageStatus({
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

	replaceTask(previous: Task, replacement: Task, options: { focus?: boolean } = {}): void {
		if (previous.taskId !== replacement.taskId || this.getTask(previous.taskId) !== previous) {
			throw new Error("Task replacement requires the current stable task identity")
		}
		if (!this.ownsTask(previous.taskId)) {
			throw new Error(`Task ${previous.taskId} replacement requires its current session owner`)
		}
		this.sessions.delete(previous.taskId)
		this.register(replacement, options)
	}

	unregister(taskId: string, expectedTask?: Task): Task | undefined {
		const session = this.sessions.get(taskId)
		if (!session) {
			return undefined
		}
		if (session.owner !== this || (expectedTask && session.task !== expectedTask)) {
			throw new Error(`Task ${taskId} removal requires its current session owner`)
		}

		this.sessions.delete(taskId)

		for (const view of this.shared.views) {
			if (view.activeTaskId === taskId) view.activeTaskId = view.getFallbackFocusTaskId()
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

	markTranscriptChanged(taskId: string): number | undefined {
		const session = this.sessions.get(taskId)
		if (!session) return undefined
		session.transcriptRevision = ++this.nextTranscriptRevision
		return session.transcriptRevision
	}

	getTranscriptRevision(taskId: string): number | undefined {
		return this.sessions.get(taskId)?.transcriptRevision
	}

	/** Prefer legacy transcript/task status while canonical persistence is unavailable. */
	markLifecycleDegraded(taskId: string): void {
		this.lifecycleDegradedTaskIds.add(taskId)
		const session = this.sessions.get(taskId)
		if (!session) return

		const legacy = projectAlphaMessageStatus({
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

	private getCurrentTaskAsk(task: Task): AlphaMessage | undefined {
		if (typeof task.getActiveAskTimestamp !== "function") return task.taskAsk
		if (task.abort) return undefined
		const askTs = task.getActiveAskTimestamp()
		if (askTs === undefined || (task.lastMessageTs !== undefined && task.lastMessageTs !== askTs)) return undefined

		// Input ownership is installed before publication. The attention fields
		// follow a delayed timer and must not leave an already-published ask running.
		const ask = findLast(task.clineMessages, (message) => message.ts === askTs)
		return ask?.type === "ask" && ask.partial !== true && !ask.isAnswered ? ask : undefined
	}

	private getTaskProjection(session: TaskSession, taskAsk?: AlphaMessage): AlphaMessageStatusProjection {
		const { task } = session
		const snapshot = session.lifecycleSnapshot
		if (snapshot && !this.lifecycleDegradedTaskIds.has(task.taskId)) {
			// A terminal turn can already own its task's next input boundary. Project
			// that exact live ask without converting the containing task into a failure.
			if (snapshot.status !== "in_progress" && taskAsk) return projectAlphaMessageStatus(taskAsk)
			return projectAgentLifecycleSnapshot(snapshot, { taskAsk, messages: task.clineMessages })
		}
		return projectAlphaMessageStatus({ messages: task.clineMessages, taskAsk, taskStatus: task.taskStatus })
	}

	private getEffectiveLifecycle(session: TaskSession): TaskLifecycleState {
		if (isTerminalLifecycle(session.lifecycle)) {
			return session.lifecycle
		}
		const taskAsk = this.getCurrentTaskAsk(session.task)
		if (isTerminalAsk(taskAsk?.ask)) {
			return TaskLifecycleState.Completed
		}
		if (
			taskAsk ||
			(session.lifecycleSnapshot?.status === "in_progress" &&
				!this.lifecycleDegradedTaskIds.has(session.task.taskId))
		) {
			return this.getTaskProjection(session, taskAsk).lifecycle
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
			const taskAsk = this.getCurrentTaskAsk(task)
			const isTerminal = isTerminalLifecycle(lifecycle)
			const projection = this.getTaskProjection(session, taskAsk)
			const isWaitingForInput =
				!isTerminal &&
				(lifecycle === TaskLifecycleState.Waiting || projection.isWaitingForInput || Boolean(taskAsk))
			const waitingReason = isTerminal
				? undefined
				: taskAsk
					? (projection.waitingReason ?? session.waitingReason ?? taskAsk.ask)
					: (session.waitingReason ?? projection.waitingReason)
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
				...(task.orchestrationParentTaskId
					? { orchestrationParentTaskId: task.orchestrationParentTaskId }
					: {}),
				...(task.orchestrationWorkspaceMode
					? { orchestrationWorkspaceMode: task.orchestrationWorkspaceMode }
					: {}),
				...(task.orchestrationParentTaskId
					? { orchestrationObjective: task.metadata.task?.slice(0, 1200) ?? "" }
					: {}),
				transcriptRevision: session.transcriptRevision,
				model: task.api?.getModel(),
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
