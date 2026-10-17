import type { Task } from "../task/Task"
import type { ThreadListOptions, ThreadListResult, ThreadReadOptions, ThreadReadResult } from "@alpha-code/types"

export type CrossTaskWorkspaceMode = "shared" | "worktree"
export type CrossTaskLifecycle = "initializing" | "running" | "waiting" | "completed" | "failed" | "closed" | "unknown"

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
		options?: { title?: string; model?: string; notifyOnCompletion?: boolean },
	): Promise<CrossTaskRecord>
	listIndependentTasks(parent: Task): Promise<CrossTaskRecord[]>
	listIndependentThreads(caller: Task, options?: ThreadListOptions, signal?: AbortSignal): Promise<ThreadListResult>
	readIndependentThread(
		caller: Task,
		taskId: string,
		options?: ThreadReadOptions,
		signal?: AbortSignal,
	): Promise<ThreadReadResult>
	forkIndependentTask(caller: Task, sourceTaskId?: string, signal?: AbortSignal): Promise<CrossTaskRecord>
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
		options?: { model?: string; signal?: AbortSignal },
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
