import type { SubagentSpawnHandle } from "@alpha-code/types"

import {
	normalizeSubagentTaskDrafts,
	type PreparedSubagentGroup,
	type SubagentTaskDraft,
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
	): Promise<SubagentSpawnHandle>
	cancelPreparedSubagentGroup(parent: Task, prepared: PreparedSubagentGroup, reason: string): Promise<void>
}

export class SpawnAgentTool extends BaseTool<"spawn_agent"> {
	readonly name = "spawn_agent" as const

	async execute(params: unknown, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const reject = (message: string) => {
			task.recordToolError("spawn_agent", message)
			task.didToolFailInCurrentTurn = true
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

		let draft: SubagentTaskDraft
		try {
			const drafts = normalizeSubagentTaskDrafts([params])
			draft = drafts[0]
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}

		let prepared: PreparedSubagentGroup
		try {
			prepared = await provider.prepareSubagentGroup(task, [draft], callbacks.toolCallId)
			if (prepared.group.agents.length !== 1 || prepared.envelopes.length !== 1) {
				throw new Error("spawn_agent must prepare exactly one child")
			}
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}

		const approved = await callbacks.askApproval(
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
		)

		if (!approved) {
			await provider.cancelPreparedSubagentGroup(task, prepared, "The user denied this sub-agent spawn.")
			return
		}

		try {
			const handle = await provider.launchPreparedSubagentGroup(
				task,
				prepared,
				task.getTaskLifetimeCancellationSignal(),
			)
			callbacks.pushToolResult(JSON.stringify({ ...handle, taskName: draft.task_name ?? handle.nickname }))
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
