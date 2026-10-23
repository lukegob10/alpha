import type { SubagentSpawnHandle } from "@alpha-code/types"

import {
	normalizeSpawnAgentRequest,
	type PreparedSubagentGroup,
	type SpawnAgentRequest,
} from "../agent/SubagentDelegation"
import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"

/** Minimal host surface required by the model-facing asynchronous spawn tool. */
export interface BoundedSubagentSpawnProvider {
	prepareSubagentGroup(parent: Task, drafts: unknown, toolCallId?: string): Promise<PreparedSubagentGroup>
	launchPreparedSubagentGroup(
		parent: Task,
		prepared: PreparedSubagentGroup,
		parentSignal: AbortSignal,
		/** Admission only; an accepted child retains the parent task's lifetime. */
		requestSignal?: AbortSignal,
	): Promise<SubagentSpawnHandle>
	cancelPreparedSubagentGroup(parent: Task, prepared: PreparedSubagentGroup, reason: string): Promise<void>
}

export class SpawnAgentTool extends BaseTool<"spawn_agent"> {
	readonly name = "spawn_agent" as const

	async execute(params: unknown, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const cancelled = () => {
			callbacks.setResultMetadata?.({ status: "cancelled" })
			callbacks.pushToolResult(JSON.stringify({ status: "cancelled", tool: "spawn_agent" }))
		}
		if (callbacks.signal?.aborted) {
			cancelled()
			return
		}
		const reject = (message: string) => {
			task.recordToolError("spawn_agent", message)
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult(`Error: ${message}`)
		}
		const provider = task.providerRef.deref() as (BoundedSubagentSpawnProvider & object) | undefined
		if (
			typeof provider?.prepareSubagentGroup !== "function" ||
			typeof provider.launchPreparedSubagentGroup !== "function" ||
			typeof provider.cancelPreparedSubagentGroup !== "function"
		) {
			reject("bounded asynchronous sub-agent launcher is unavailable")
			return
		}

		let request: SpawnAgentRequest
		try {
			request = normalizeSpawnAgentRequest(params)
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}

		let prepared: PreparedSubagentGroup
		try {
			prepared = await provider.prepareSubagentGroup(task, params, callbacks.toolCallId)
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}
		if (prepared.group.agents.length !== 1 || prepared.envelopes.length !== 1) {
			try {
				await provider.cancelPreparedSubagentGroup(task, prepared, "The prepared sub-agent group was invalid.")
			} catch (error) {
				await callbacks.handleError("cancelling an invalid sub-agent preparation", error as Error)
				return
			}
			reject("spawn_agent must prepare exactly one child")
			return
		}
		const cancelInterruptedPreparation = async (): Promise<void> => {
			try {
				await provider.cancelPreparedSubagentGroup(
					task,
					prepared,
					"Sub-agent spawn was cancelled before launch.",
				)
			} catch (error) {
				await callbacks.handleError("cancelling a prepared sub-agent", error as Error)
				return
			}
			cancelled()
		}
		if (callbacks.signal?.aborted) {
			await cancelInterruptedPreparation()
			return
		}

		let approved: boolean
		try {
			approved =
				prepared.inheritsParentPermissions === true && request.source === "codex-v2"
					? true
					: await callbacks.askApproval(
							"tool",
							JSON.stringify({
								tool: "spawnAgent",
								groupId: prepared.group.groupId,
								agent: {
									nickname: prepared.group.agents[0].nickname,
									role: prepared.group.agents[0].role,
									objective: prepared.group.agents[0].objective,
									writeScope: prepared.group.agents[0].writeScope,
								},
							}),
							undefined,
							undefined,
							prepared.requiresExplicitApproval === true,
						)
		} catch (error) {
			try {
				await provider.cancelPreparedSubagentGroup(task, prepared, "Sub-agent approval was interrupted.")
			} catch {
				// Preserve the approval error; cancellation is best-effort cleanup.
			}
			await callbacks.handleError("approving a sub-agent", error as Error)
			return
		}

		if (callbacks.signal?.aborted) {
			await cancelInterruptedPreparation()
			return
		}
		if (!approved) {
			await provider.cancelPreparedSubagentGroup(task, prepared, "The user denied this sub-agent spawn.")
			return
		}

		try {
			const handle = await provider.launchPreparedSubagentGroup(
				task,
				prepared,
				task.getTaskLifetimeCancellationSignal(),
				callbacks.signal,
			)
			callbacks.pushToolResult(
				JSON.stringify({ ...handle, target: handle.taskId, taskName: request.task_name ?? handle.nickname }),
			)
		} catch (error) {
			try {
				await provider.cancelPreparedSubagentGroup(task, prepared, "The sub-agent failed to launch.")
			} catch {
				// The launch error is the actionable failure; cancellation is best-effort cleanup.
			}
			await callbacks.handleError("launching a sub-agent", error as Error)
		}
	}

	override async handlePartial(): Promise<void> {}
}

export const spawnAgentTool = new SpawnAgentTool()
