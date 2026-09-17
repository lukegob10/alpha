import type { CancelAgentParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import {
	optionalReason,
	recordLifecycleToolError,
	requireAgentTarget,
	runAgentLifecycleOperation,
} from "./AgentLifecycleTool"

export class CancelAgentTool extends BaseTool<"cancel_agent"> {
	readonly name = "cancel_agent" as const

	async execute(params: CancelAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let target: string
		let reason: string | undefined
		try {
			target = requireAgentTarget((params as CancelAgentParams | undefined)?.target)
			reason = optionalReason((params as CancelAgentParams | undefined)?.reason)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "cancelAgent", task, callbacks, (provider) =>
			provider.cancelAgent(task, target, reason),
		)
	}
}

export const cancelAgentTool = new CancelAgentTool()
