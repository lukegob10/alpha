import type { WaitAgentParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { recordLifecycleToolError, resolveWaitTimeout, runAgentLifecycleOperation } from "./AgentLifecycleTool"

export class WaitAgentTool extends BaseTool<"wait_agent"> {
	readonly name = "wait_agent" as const

	async execute(params: WaitAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let timeoutMs: number
		try {
			timeoutMs = resolveWaitTimeout((params as WaitAgentParams | undefined)?.timeout_ms)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "waitForAgent", task, callbacks, (provider) =>
			provider.waitForAgent(task, timeoutMs),
		)
	}
}

export const waitAgentTool = new WaitAgentTool()
