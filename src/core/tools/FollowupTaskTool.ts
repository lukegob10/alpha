import type { FollowupTaskParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import {
	recordLifecycleToolError,
	requireAgentTarget,
	requireNonEmptyMessage,
	runAgentLifecycleOperation,
} from "./AgentLifecycleTool"

export class FollowupTaskTool extends BaseTool<"followup_task"> {
	readonly name = "followup_task" as const

	async execute(params: FollowupTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let target: string
		let message: string
		try {
			target = requireAgentTarget((params as FollowupTaskParams | undefined)?.target)
			message = requireNonEmptyMessage((params as FollowupTaskParams | undefined)?.message)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "followupAgentTask", task, callbacks, (provider) =>
			provider.followupAgentTask(task, target, message),
		)
	}
}

export const followupTaskTool = new FollowupTaskTool()
