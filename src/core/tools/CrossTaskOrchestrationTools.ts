import type {
	CreateTaskParams,
	ListTasksParams,
	SendTaskMessageParams,
	SteerTaskParams,
	StopTaskParams,
	WaitTaskParams,
} from "@alpha-code/types"

import type { Task } from "../task/Task"
import type { CrossTaskOrchestrationProvider, CrossTaskWorkspaceMode } from "../webview/CrossTaskOrchestration"

import { BaseTool, type ToolCallbacks } from "./BaseTool"

const DEFAULT_WAIT_MS = 30_000
const MIN_WAIT_MS = 1_000
const MAX_WAIT_MS = 300_000
const MAX_MESSAGE_LENGTH = 12_000

type CrossTaskToolName = "create_task" | "list_tasks" | "wait_task" | "send_task_message" | "steer_task" | "stop_task"

function fail(name: CrossTaskToolName, task: Task, callbacks: ToolCallbacks, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error)
	task.recordToolError(name, message)
	task.didToolFailInCurrentTurn = true
	callbacks.setResultMetadata?.({ status: "error" })
	callbacks.pushToolResult(JSON.stringify({ status: "error", error: message }))
}

function wasCancelled(error: unknown, callbacks: ToolCallbacks): boolean {
	return (
		callbacks.signal?.aborted === true &&
		(error === callbacks.signal.reason || (error instanceof Error && error.name === "AbortError"))
	)
}

function requireTaskId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) {
		throw new Error("task_id must be a valid task ID")
	}
	return value
}

function requireMessage(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_MESSAGE_LENGTH) {
		throw new Error(`message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`)
	}
	return value.trim()
}

function getProvider(task: Task): CrossTaskOrchestrationProvider {
	const provider = task.providerRef.deref() as (Partial<CrossTaskOrchestrationProvider> & object) | undefined
	if (
		typeof provider?.createIndependentTask !== "function" ||
		typeof provider.listIndependentTasks !== "function" ||
		typeof provider.waitForIndependentTask !== "function" ||
		typeof provider.sendIndependentTaskMessage !== "function" ||
		typeof provider.steerIndependentTask !== "function" ||
		typeof provider.stopIndependentTask !== "function"
	) {
		throw new Error("cross-task orchestration is unavailable")
	}
	return provider as CrossTaskOrchestrationProvider
}

async function approve(
	tool: CrossTaskToolName,
	callbacks: ToolCallbacks,
	details: Record<string, unknown>,
): Promise<boolean> {
	if (callbacks.signal?.aborted) return false
	return callbacks.askApproval("tool", JSON.stringify({ tool, ...details }))
}

function denied(tool: CrossTaskToolName, callbacks: ToolCallbacks): void {
	callbacks.setResultMetadata?.({ status: "denied" })
	callbacks.pushToolResult(JSON.stringify({ status: "denied", tool }))
}

function cancelled(tool: CrossTaskToolName, callbacks: ToolCallbacks): void {
	callbacks.setResultMetadata?.({ status: "cancelled" })
	callbacks.pushToolResult(JSON.stringify({ status: "cancelled", tool }))
}

async function runMutation(
	name: CrossTaskToolName,
	task: Task,
	callbacks: ToolCallbacks,
	details: Record<string, unknown>,
	operation: (provider: CrossTaskOrchestrationProvider) => Promise<unknown>,
): Promise<void> {
	try {
		const provider = getProvider(task)
		if (callbacks.signal?.aborted) {
			cancelled(name, callbacks)
			return
		}
		const approved = await approve(name, callbacks, details)
		if (!approved) {
			if (callbacks.signal?.aborted) cancelled(name, callbacks)
			else denied(name, callbacks)
			return
		}
		if (callbacks.signal?.aborted) {
			cancelled(name, callbacks)
			return
		}
		const result = await operation(provider)
		callbacks.setResultMetadata?.({ status: "success" })
		callbacks.pushToolResult(JSON.stringify(result))
	} catch (error) {
		if (wasCancelled(error, callbacks)) cancelled(name, callbacks)
		else fail(name, task, callbacks, error)
	}
}

export class CreateTaskTool extends BaseTool<"create_task"> {
	readonly name = "create_task" as const

	async execute(params: CreateTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const objective = typeof params?.objective === "string" ? params.objective.trim() : ""
			const workspaceMode = params?.workspace_mode
			if (!objective || objective.length > MAX_MESSAGE_LENGTH) {
				throw new Error(`objective must contain 1 to ${MAX_MESSAGE_LENGTH} characters`)
			}
			if (workspaceMode !== "shared" && workspaceMode !== "worktree") {
				throw new Error("workspace_mode must be shared or worktree")
			}
			await runMutation("create_task", task, callbacks, { objective, workspaceMode }, (provider) =>
				provider.createIndependentTask(
					task,
					objective,
					workspaceMode as CrossTaskWorkspaceMode,
					callbacks.signal,
				),
			)
		} catch (error) {
			fail(this.name, task, callbacks, error)
		}
	}
}

export class ListTasksTool extends BaseTool<"list_tasks"> {
	readonly name = "list_tasks" as const

	async execute(_params: ListTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			if (callbacks.signal?.aborted) return cancelled(this.name, callbacks)
			const result = await getProvider(task).listIndependentTasks(task)
			callbacks.setResultMetadata?.({ status: "success" })
			callbacks.pushToolResult(JSON.stringify({ tasks: result }))
		} catch (error) {
			fail(this.name, task, callbacks, error)
		}
	}
}

export class WaitTaskTool extends BaseTool<"wait_task"> {
	readonly name = "wait_task" as const

	async execute(params: WaitTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const taskId = requireTaskId(params?.task_id)
			const timeoutMs = params?.timeout_ms ?? DEFAULT_WAIT_MS
			if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_WAIT_MS || timeoutMs > MAX_WAIT_MS) {
				throw new Error(`timeout_ms must be an integer from ${MIN_WAIT_MS} to ${MAX_WAIT_MS}`)
			}
			if (callbacks.signal?.aborted) return cancelled(this.name, callbacks)
			const result = await getProvider(task).waitForIndependentTask(task, taskId, timeoutMs, callbacks.signal)
			callbacks.setResultMetadata?.({ status: result.cancelled ? "cancelled" : "success" })
			callbacks.pushToolResult(JSON.stringify(result))
		} catch (error) {
			if (callbacks.signal?.aborted) cancelled(this.name, callbacks)
			else fail(this.name, task, callbacks, error)
		}
	}
}

export class SendTaskMessageTool extends BaseTool<"send_task_message"> {
	readonly name = "send_task_message" as const

	async execute(params: SendTaskMessageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const taskId = requireTaskId(params?.task_id)
			const message = requireMessage(params?.message)
			await runMutation("send_task_message", task, callbacks, { taskId, message }, (provider) =>
				provider.sendIndependentTaskMessage(task, taskId, message),
			)
		} catch (error) {
			fail(this.name, task, callbacks, error)
		}
	}
}

export class SteerTaskTool extends BaseTool<"steer_task"> {
	readonly name = "steer_task" as const

	async execute(params: SteerTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const taskId = requireTaskId(params?.task_id)
			const message = requireMessage(params?.message)
			await runMutation("steer_task", task, callbacks, { taskId, message }, (provider) =>
				provider.steerIndependentTask(task, taskId, message),
			)
		} catch (error) {
			fail(this.name, task, callbacks, error)
		}
	}
}

export class StopTaskTool extends BaseTool<"stop_task"> {
	readonly name = "stop_task" as const

	async execute(params: StopTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const taskId = requireTaskId(params?.task_id)
			const reason = typeof params?.reason === "string" ? params.reason.trim().slice(0, 500) : undefined
			await runMutation("stop_task", task, callbacks, { taskId, reason }, (provider) =>
				provider.stopIndependentTask(task, taskId, reason),
			)
		} catch (error) {
			fail(this.name, task, callbacks, error)
		}
	}
}

export const createTaskTool = new CreateTaskTool()
export const listTasksTool = new ListTasksTool()
export const waitTaskTool = new WaitTaskTool()
export const sendTaskMessageTool = new SendTaskMessageTool()
export const steerTaskTool = new SteerTaskTool()
export const stopTaskTool = new StopTaskTool()
