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

		const { toolCallId } = callbacks
		const options =
			target || untilTerminal || toolCallId
				? { target, untilTerminal, ...(toolCallId ? { toolCallId } : {}) }
				: undefined
		await runAgentLifecycleOperation(
			this.name,
			"waitForAgent",
			task,
			callbacks,
			(provider) =>
				options ? provider.waitForAgent(task, timeoutMs, options) : provider.waitForAgent(task, timeoutMs),
			(result) => {
				if (typeof result !== "object" || result === null) return
				// Codex MultiAgentV2 wait.rs (retrieved 2026-10-29) treats steering as
				// a successful wake, distinct from cancellation of the tool itself.
				const steered = "reason" in result && result.reason === "steered_input"
				// This is the in-process lifecycle host's envelope, never parsed model/MCP text.
				// Timeout means a bounded blocking wait elapsed; an empty fast path is idle.
				if (
					("cancelled" in result && result.cancelled === true) ||
					("interrupted" in result && result.interrupted === true && !steered)
				) {
					callbacks.setResultMetadata?.({ status: "cancelled" })
					return
				}
				const idle =
					("noActiveAgents" in result && result.noActiveAgents === true) ||
					("alreadyDelivered" in result && result.alreadyDelivered === true)
				const eventCount =
					"eventCount" in result && typeof result.eventCount === "number" ? result.eventCount : 0
				const claimId = "claimId" in result ? result.claimId : undefined
				const hasClaim = typeof claimId === "string" && claimId.length > 0
				// Codex CLI 16280e19 treats typed agent mail as a successful wake. Alpha
				// leaves immediate-parent mail unclaimed for the next model input.
				const parentMail = "mailboxActivity" in result && result.mailboxActivity === true
				const activity = parentMail || (hasClaim && eventCount > 0)
				const timedOut = "timedOut" in result && result.timedOut === true
				callbacks.setResultMetadata?.({
					status: "success",
					waitOutcome: !idle && (timedOut || activity || steered) ? "active" : "idle",
				})
				if (hasClaim && !toolCallId) {
					throw new Error("wait_agent received a mailbox claim without a native tool call ID")
				}
			},
		)
	}
}

export const waitAgentTool = new WaitAgentTool()
