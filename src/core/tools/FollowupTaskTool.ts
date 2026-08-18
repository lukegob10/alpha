import type { FollowupTaskParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import {
	recordLifecycleToolError,
	requireAgentTarget,
	requireNonEmptyMessage,
	runAgentLifecycleOperation,
	type AgentLifecycleControlProvider,
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

		const provider = task.providerRef.deref() as Partial<AgentLifecycleControlProvider> | undefined
		if (provider?.requiresExplicitAgentFollowupApproval) {
			try {
				const requiresApproval = await provider.requiresExplicitAgentFollowupApproval(task, target)
				if (requiresApproval) {
					// This approval is also the trusted evidence used to migrate a valid
					// pre-orchestration manifest before relaunch.
					const approved = await callbacks.askApproval(
						"tool",
						JSON.stringify({ tool: "followupTask", target, message }),
						undefined,
						true,
					)
					if (!approved) return
				}
			} catch (error) {
				recordLifecycleToolError(this.name, task, callbacks, error)
				return
			}
		}

		await runAgentLifecycleOperation(this.name, "followupAgentTask", task, callbacks, (provider) =>
			provider.followupAgentTask(task, target, message),
		)
	}
}

export const followupTaskTool = new FollowupTaskTool()
