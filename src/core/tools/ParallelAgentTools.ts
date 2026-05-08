import { formatResponse } from "../prompts/responses"
import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface SpawnAgentParams {
	task_name: string
	message: string
	mode?: string | null
	agent_type?: string | null
	workspace_strategy?: "auto" | "sameWorktree" | "newWorktree" | null
	write_scope?: string[] | null
}

interface SpawnAgentsParams {
	agents: SpawnAgentParams[]
}

interface WaitAgentParams {
	targets?: string[] | null
	timeout_ms?: number | null
}

interface SendInputParams {
	target: string
	message: string
	interrupt?: boolean | null
}

interface ListAgentsParams {
	status?: string | null
}

interface CloseAgentParams {
	target: string
	cleanup?: boolean | null
}

interface IntegrateAgentResultParams {
	target: string
	strategy?: "apply_patch" | "merge_worktree" | null
}

function getCoordinator(task: Task) {
	const provider = task.providerRef.deref()
	const coordinator = (provider as any)?.getAgentCoordinator?.()
	if (!coordinator) {
		throw new Error("Parallel agent coordinator is not available.")
	}
	return coordinator
}

function formatRecord(record: any): string {
	return JSON.stringify(
		{
			id: record.id,
			status: record.status,
			role: record.agentRole,
			taskName: record.taskName,
			workspaceStrategy: record.workspaceStrategy,
			resolvedWorkspaceStrategy: record.resolvedWorkspaceStrategy,
			workspacePath: record.workspacePath,
			branch: record.branch,
			writeScopes: record.writeScopes,
			result: record.result,
			error: record.error,
		},
		null,
		2,
	)
}

export class SpawnAgentTool extends BaseTool<"spawn_agent"> {
	readonly name = "spawn_agent" as const

	async execute(params: SpawnAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		try {
			if (!params.task_name) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_agent")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_agent", "task_name"))
				return
			}
			if (!params.message) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_agent")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_agent", "message"))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "spawnAgent",
				taskName: params.task_name,
				role: params.agent_type,
				workspaceStrategy: params.workspace_strategy ?? "auto",
				writeScope: params.write_scope ?? [],
				message: params.message,
			})
			if (!(await askApproval("tool", toolMessage))) {
				return
			}

			const coordinator = getCoordinator(task)
			const record = await coordinator.spawn(task, {
				taskName: params.task_name,
				message: params.message,
				mode: params.mode ?? undefined,
				agentRole: params.agent_type ?? undefined,
				workspaceStrategy: params.workspace_strategy ?? "auto",
				writeScopes: params.write_scope ?? [],
			})
			task.consecutiveMistakeCount = 0
			pushToolResult(`Spawned parallel agent:\n${formatRecord(record)}`)
		} catch (error) {
			await handleError("spawning parallel agent", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"spawn_agent">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "spawnAgent",
			taskName: block.params.task_name ?? "",
			role: block.params.agent_type ?? "",
			workspaceStrategy: block.params.workspace_strategy ?? "auto",
			message: block.params.message ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export class SpawnAgentsTool extends BaseTool<"spawn_agents"> {
	readonly name = "spawn_agents" as const

	async execute(params: SpawnAgentsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		try {
			if (!Array.isArray(params.agents) || params.agents.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_agents")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_agents", "agents"))
				return
			}

			const invalidAgent = params.agents.find((agent) => !agent.task_name || !agent.message)
			if (invalidAgent) {
				task.consecutiveMistakeCount++
				task.recordToolError("spawn_agents")
				task.didToolFailInCurrentTurn = true
				const missingParam = !invalidAgent.task_name ? "task_name" : "message"
				pushToolResult(await task.sayAndCreateMissingParamError("spawn_agents", missingParam))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "spawnAgents",
				count: params.agents.length,
				agents: params.agents.map((agent) => ({
					taskName: agent.task_name,
					role: agent.agent_type,
					workspaceStrategy: agent.workspace_strategy ?? "auto",
					writeScope: agent.write_scope ?? [],
				})),
			})
			if (!(await askApproval("tool", toolMessage))) {
				return
			}

			const coordinator = getCoordinator(task)
			const { records, failures } = await coordinator.spawnMany(
				task,
				params.agents.map((agent) => ({
					taskName: agent.task_name,
					message: agent.message,
					mode: agent.mode ?? undefined,
					agentRole: agent.agent_type ?? undefined,
					workspaceStrategy: agent.workspace_strategy ?? "auto",
					writeScopes: agent.write_scope ?? [],
				})),
			)

			if (records.length > 0) {
				task.consecutiveMistakeCount = 0
			}
			if (failures.length > 0) {
				task.didToolFailInCurrentTurn = true
			}

			pushToolResult(
				[
					records.length ? `Spawned parallel agents:\n${records.map(formatRecord).join("\n\n")}` : "",
					failures.length ? `Failed to spawn agents:\n${JSON.stringify(failures, null, 2)}` : "",
				]
					.filter(Boolean)
					.join("\n\n"),
			)
		} catch (error) {
			await handleError("spawning parallel agents", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"spawn_agents">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "spawnAgents",
			count: block.nativeArgs?.agents?.length,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export class WaitAgentTool extends BaseTool<"wait_agent"> {
	readonly name = "wait_agent" as const

	async execute(params: WaitAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks
		try {
			const records = await getCoordinator(task).wait(params.targets, params.timeout_ms)
			if (records.length === 0) {
				pushToolResult("No parallel agents completed before the wait timeout.")
				return
			}
			pushToolResult(`Completed parallel agents:\n${records.map(formatRecord).join("\n\n")}`)
		} catch (error) {
			await handleError("waiting for parallel agents", error as Error)
		}
	}
}

export class SendInputTool extends BaseTool<"send_input"> {
	readonly name = "send_input" as const

	async execute(params: SendInputParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks
		try {
			if (!params.target) {
				task.recordToolError("send_input")
				pushToolResult(await task.sayAndCreateMissingParamError("send_input", "target"))
				return
			}
			if (!params.message) {
				task.recordToolError("send_input")
				pushToolResult(await task.sayAndCreateMissingParamError("send_input", "message"))
				return
			}
			const record = await getCoordinator(task).sendInput(params.target, params.message)
			pushToolResult(`Input sent to parallel agent:\n${formatRecord(record)}`)
		} catch (error) {
			await handleError("sending input to parallel agent", error as Error)
		}
	}
}

export class ListAgentsTool extends BaseTool<"list_agents"> {
	readonly name = "list_agents" as const

	async execute(params: ListAgentsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const records = getCoordinator(task).list(params.status)
		callbacks.pushToolResult(records.length ? records.map(formatRecord).join("\n\n") : "No parallel agents.")
	}
}

export class CloseAgentTool extends BaseTool<"close_agent"> {
	readonly name = "close_agent" as const

	async execute(params: CloseAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		try {
			if (!params.target) {
				task.recordToolError("close_agent")
				pushToolResult(await task.sayAndCreateMissingParamError("close_agent", "target"))
				return
			}
			if (
				!(await askApproval(
					"tool",
					JSON.stringify({ tool: "closeAgent", target: params.target, cleanup: params.cleanup ?? false }),
				))
			) {
				return
			}
			const record = await getCoordinator(task).close(params.target)
			pushToolResult(`Parallel agent closed:\n${formatRecord(record)}`)
		} catch (error) {
			await handleError("closing parallel agent", error as Error)
		}
	}
}

export class IntegrateAgentResultTool extends BaseTool<"integrate_agent_result"> {
	readonly name = "integrate_agent_result" as const

	async execute(params: IntegrateAgentResultParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		try {
			if (!params.target) {
				task.recordToolError("integrate_agent_result")
				pushToolResult(await task.sayAndCreateMissingParamError("integrate_agent_result", "target"))
				return
			}

			const coordinator = getCoordinator(task)
			const preview = await coordinator.getIntegrationPreview(params.target)
			if (!preview.diff.trim()) {
				pushToolResult("No isolated worktree diff to integrate.")
				return
			}

			const didApprove = await askApproval(
				"tool",
				JSON.stringify({
					tool: "integrateAgentResult",
					target: params.target,
					strategy: params.strategy ?? "apply_patch",
					changedFiles: preview.changedFiles,
					stat: preview.stat,
				}),
			)
			if (!didApprove) {
				pushToolResult(formatResponse.toolDenied())
				return
			}

			const record = await coordinator.applyIntegration(params.target, preview.diff)
			pushToolResult(`Integrated parallel agent result:\n${formatRecord(record)}`)
		} catch (error) {
			await handleError("integrating parallel agent result", error as Error)
		}
	}
}

export const spawnAgentTool = new SpawnAgentTool()
export const spawnAgentsTool = new SpawnAgentsTool()
export const waitAgentTool = new WaitAgentTool()
export const sendInputTool = new SendInputTool()
export const listAgentsTool = new ListAgentsTool()
export const closeAgentTool = new CloseAgentTool()
export const integrateAgentResultTool = new IntegrateAgentResultTool()
