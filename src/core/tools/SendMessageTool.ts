import type { SendMessageParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import {
	recordLifecycleToolError,
	requireAgentTarget,
	requireNonEmptyMessage,
	runAgentLifecycleOperation,
} from "./AgentLifecycleTool"

export class SendMessageTool extends BaseTool<"send_message"> {
	readonly name = "send_message" as const

	async execute(params: SendMessageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let target: string
		let message: string
		try {
			target = requireAgentTarget((params as SendMessageParams | undefined)?.target)
			message = requireNonEmptyMessage((params as SendMessageParams | undefined)?.message)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "sendMessageToAgent", task, callbacks, (provider) =>
			provider.sendMessageToAgent(task, target, message),
		)
	}
}

export const sendMessageTool = new SendMessageTool()
