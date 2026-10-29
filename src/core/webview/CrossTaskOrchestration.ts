import type { Task } from "../task/Task"
import type {
	ProviderName,
	ReasoningEffortExtended,
	ThreadListOptions,
	ThreadListResult,
	ThreadReadOptions,
	ThreadReadResult,
} from "@alpha-code/types"

export type CrossTaskWorkspaceMode = "shared" | "worktree"
export type CrossTaskLifecycle = "initializing" | "running" | "waiting" | "completed" | "failed" | "closed" | "unknown"

/** Task-local inference selection; the saved profile owns credentials, independently of execution authority. */
export interface IndependentTaskModelSelection {
	provider?: ProviderName
	profile?: string
	model?: string
	reasoningEffort?: ReasoningEffortExtended
}

export interface CrossTaskRecord {
	task_id: string
	objective: string
	lifecycle: CrossTaskLifecycle
	workspace_mode: CrossTaskWorkspaceMode
	updated_at: number
	result?: string
	title?: string
	archived?: boolean
	forked_from_id?: string
}

export interface CrossTaskWaitResult {
	task_id: string
	lifecycle: CrossTaskLifecycle
	timed_out?: true
	cancelled?: true
	result?: string
	/** Stable completion identity acknowledged only by the saved successful wait tool result. */
	completion_receipt_id?: string
}

/** Host boundary for independent conversations; identity, workspace scope, and task authority are checked here. */
export interface CrossTaskOrchestrationProvider {
	createIndependentTask(
		parent: Task,
		objective: string,
		workspaceMode: CrossTaskWorkspaceMode,
		signal?: AbortSignal,
		options?: IndependentTaskModelSelection & { title?: string; notifyOnCompletion?: boolean },
	): Promise<CrossTaskRecord>
	listIndependentTasks(parent: Task): Promise<CrossTaskRecord[]>
	listIndependentThreads(caller: Task, options?: ThreadListOptions, signal?: AbortSignal): Promise<ThreadListResult>
	readIndependentThread(
		caller: Task,
		taskId: string,
		options?: ThreadReadOptions,
		signal?: AbortSignal,
	): Promise<ThreadReadResult>
	forkIndependentTask(
		caller: Task,
		sourceTaskId?: string,
		signal?: AbortSignal,
		options?: IndependentTaskModelSelection,
	): Promise<CrossTaskRecord>
	setIndependentTaskTitle(
		caller: Task,
		taskId: string | undefined,
		title: string,
		signal?: AbortSignal,
	): Promise<CrossTaskRecord>
	setIndependentTaskArchived(
		caller: Task,
		taskId: string | undefined,
		archived: boolean,
		signal?: AbortSignal,
	): Promise<CrossTaskRecord>
	waitForIndependentTask(
		parent: Task,
		taskId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<CrossTaskWaitResult>
	sendIndependentTaskMessage(
		sender: Task,
		targetTaskId: string,
		message: string,
		options?: IndependentTaskModelSelection & { signal?: AbortSignal },
	): Promise<{ task_id: string; status: string }>
	steerIndependentTask(
		parent: Task,
		targetTaskId: string,
		message: string,
	): Promise<{ task_id: string; status: string }>
	stopIndependentTask(
		parent: Task,
		targetTaskId: string,
		reason?: string,
	): Promise<{ task_id: string; status: string }>
}
