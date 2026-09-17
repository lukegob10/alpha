import type { ListAgentsParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { optionalCanonicalPath, recordLifecycleToolError, runAgentLifecycleOperation } from "./AgentLifecycleTool"

export class ListAgentsTool extends BaseTool<"list_agents"> {
	readonly name = "list_agents" as const

	async execute(params: ListAgentsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let pathPrefix: string | undefined
		try {
			pathPrefix = optionalCanonicalPath((params as ListAgentsParams | undefined)?.path_prefix)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "listAgents", task, callbacks, (provider) =>
			provider.listAgents(task, pathPrefix),
		)
	}
}

export const listAgentsTool = new ListAgentsTool()
