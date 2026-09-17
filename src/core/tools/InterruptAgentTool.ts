import type { InterruptAgentParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { recordLifecycleToolError, requireAgentTarget, runAgentLifecycleOperation } from "./AgentLifecycleTool"

export class InterruptAgentTool extends BaseTool<"interrupt_agent"> {
	readonly name = "interrupt_agent" as const

	async execute(params: InterruptAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let target: string
		try {
			target = requireAgentTarget((params as InterruptAgentParams | undefined)?.target)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "interruptAgent", task, callbacks, (provider) =>
			provider.interruptAgent(task, target),
		)
	}
}

export const interruptAgentTool = new InterruptAgentTool()
