import type { Task } from "../task/Task"

export type CrossTaskWorkspaceMode = "shared" | "worktree"
export type CrossTaskLifecycle = "initializing" | "running" | "waiting" | "completed" | "failed" | "closed" | "unknown"

export interface CrossTaskRecord {
	task_id: string
	objective: string
	lifecycle: CrossTaskLifecycle
	workspace_mode: CrossTaskWorkspaceMode
	updated_at: number
	result?: string
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

/** Host boundary for independent task controls; task identity and parent scope are checked by the host. */
export interface CrossTaskOrchestrationProvider {
	createIndependentTask(
		parent: Task,
		objective: string,
		workspaceMode: CrossTaskWorkspaceMode,
		signal?: AbortSignal,
	): Promise<CrossTaskRecord>
	listIndependentTasks(parent: Task): Promise<CrossTaskRecord[]>
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
