import type { CloseAgentParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { recordLifecycleToolError, requireAgentTarget, runAgentLifecycleOperation } from "./AgentLifecycleTool"

export class CloseAgentTool extends BaseTool<"close_agent"> {
	readonly name = "close_agent" as const

	async execute(params: CloseAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let target: string
		try {
			target = requireAgentTarget((params as CloseAgentParams | undefined)?.target)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "closeAgent", task, callbacks, (provider) =>
			provider.closeAgent(task, target),
		)
	}
}

export const closeAgentTool = new CloseAgentTool()
