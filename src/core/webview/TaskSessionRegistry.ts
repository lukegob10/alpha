import { type ClineAsk, type LiveTaskMetadata, TaskLifecycleState, TaskStatus } from "@alpha-code/types"

import type { Task } from "../task/Task"

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
}

const terminalLifecycleStates = new Set<TaskLifecycleState>([
	TaskLifecycleState.Completed,
	TaskLifecycleState.Failed,
	TaskLifecycleState.Closed,
])

const terminalAskTypes = new Set<ClineAsk>(["completion_result", "resume_completed_task"])

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

	register(task: Task, options: { focus?: boolean } = {}): void {
		this.sessions.set(task.taskId, {
			task,
			lifecycle: TaskLifecycleState.Initializing,
			lastActivityAt: Date.now(),
		})

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

		session.lifecycle = lifecycle
		session.lastActivityAt = Date.now()
		session.waitingReason = waitingReason
	}

	private getEffectiveLifecycle(session: TaskSession): TaskLifecycleState {
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
			const metadata: LiveTaskMetadata = {
				id: task.taskId,
				status: task.taskStatus ?? TaskStatus.None,
				lifecycle,
				isActive: task.taskId === this.activeTaskId,
				isStreaming: task.isStreaming,
				isWaitingForInput: !isTerminal && Boolean(taskAsk),
				lastUpdatedAt: task.clineMessages.at(-1)?.ts ?? session.lastActivityAt,
				waitingReason: isTerminal ? undefined : (session.waitingReason ?? taskAsk?.ask),
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
