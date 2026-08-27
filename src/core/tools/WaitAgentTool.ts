import type { WaitAgentParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import {
	optionalAgentTarget,
	recordLifecycleToolError,
	resolveUntilTerminal,
	resolveWaitTimeout,
	runAgentLifecycleOperation,
} from "./AgentLifecycleTool"

export class WaitAgentTool extends BaseTool<"wait_agent"> {
	readonly name = "wait_agent" as const

	async execute(params: WaitAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let timeoutMs: number
		let target: string | undefined
		let untilTerminal: boolean
		try {
			timeoutMs = resolveWaitTimeout((params as WaitAgentParams | undefined)?.timeout_ms)
			target = optionalAgentTarget((params as WaitAgentParams | undefined)?.target)
			untilTerminal = resolveUntilTerminal((params as WaitAgentParams | undefined)?.until_terminal)
			if (target && !untilTerminal) {
				throw new Error("target requires until_terminal to be true")
			}
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(
			this.name,
			"waitForAgent",
			task,
			callbacks,
			(provider) =>
				target || untilTerminal
					? provider.waitForAgent(task, timeoutMs, { target, untilTerminal })
					: provider.waitForAgent(task, timeoutMs),
			(result) => {
				if (typeof result !== "object" || result === null || !("claimId" in result)) return
				const claimId = (result as { claimId?: unknown }).claimId
				if (typeof claimId !== "string" || claimId.length === 0) return
				if (!callbacks.toolCallId) {
					throw new Error("wait_agent received a mailbox claim without a native tool call ID")
				}
				task.retainWaitAgentResultClaim(callbacks.toolCallId, claimId)
			},
		)
	}
}

export const waitAgentTool = new WaitAgentTool()
