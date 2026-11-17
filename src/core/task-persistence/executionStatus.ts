import { safeJsonParse } from "@alpha-code/core"
import type { AlphaMessage, AlphaSayTool, CommandExecutionStatus, McpExecutionStatus } from "@alpha-code/types"
import { commandExecutionStatusSchema, mcpExecutionStatusSchema } from "@alpha-code/types"

const MAX_PREVIEW_CHARS = 100_000
const TRUNCATED = "\n[Output preview truncated]"

function preview(text: string): string {
	if (text.length <= MAX_PREVIEW_CHARS) return text
	let end = MAX_PREVIEW_CHARS - TRUNCATED.length
	if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
	return text.slice(0, end) + TRUNCATED
}

function owns(message: AlphaMessage, status: CommandExecutionStatus | McpExecutionStatus, taskId: string): boolean {
	return (
		message.ts.toString() === status.executionId &&
		(!status.taskId || status.taskId === taskId) &&
		(!status.toolCallId || !message.toolCallId || status.toolCallId === message.toolCallId)
	)
}

export function projectCommandExecutionStatus(
	message: AlphaMessage,
	incoming: CommandExecutionStatus,
	taskId: string,
	confirmedPrelaunchFallback = false,
): AlphaMessage | undefined {
	const parsed = commandExecutionStatusSchema.safeParse(incoming)
	if (!parsed.success || message.type !== "ask" || message.ask !== "command" || !owns(message, parsed.data, taskId))
		return
	const status = parsed.data
	const previous = message.commandExecutionStatus
	if (previous?.toolCallId && status.toolCallId && previous.toolCallId !== status.toolCallId) return
	const terminal = previous && ["exited", "error", "cancelled", "timeout"].includes(previous.status)
	if (status.status === "output") return { ...message, commandExecutionOutput: preview(status.output) }
	// Only the producer's positive no-submission proof may reopen a failed transport.
	if (terminal && !(confirmedPrelaunchFallback && status.status === "fallback" && previous.status === "error")) return
	if (status.status === "started") status.command = preview(status.command)
	else if (status.status === "error" && status.error !== undefined) status.error = preview(status.error)
	return { ...message, commandExecutionStatus: status, toolCallId: message.toolCallId ?? status.toolCallId }
}

export function projectMcpExecutionStatus(
	message: AlphaMessage,
	incoming: McpExecutionStatus,
	taskId: string,
): AlphaMessage | undefined {
	const parsed = mcpExecutionStatusSchema.safeParse(incoming)
	if (
		!parsed.success ||
		message.type !== "ask" ||
		message.ask !== "use_mcp_server" ||
		!owns(message, parsed.data, taskId)
	)
		return
	const status = parsed.data
	const previous = message.mcpExecutionStatus
	if (previous?.toolCallId && status.toolCallId && previous.toolCallId !== status.toolCallId) return
	if (previous && ["completed", "error", "cancelled"].includes(previous.status)) return
	if (status.status === "output")
		return {
			...message,
			mcpExecutionResponse: preview((message.mcpExecutionResponse ?? "") + preview(status.response)),
		}
	// Keep one bounded preview; the existing response transcript owns the full output.
	let response: string | undefined
	if (status.status === "completed") {
		response = status.response
		status.response = undefined
	} else if (status.status === "error" && status.error !== undefined) {
		status.error = preview(status.error)
	}
	return {
		...message,
		mcpExecutionStatus: status,
		toolCallId: message.toolCallId ?? status.toolCallId,
		...(response !== undefined ? { mcpExecutionResponse: preview(response) } : {}),
	}
}

/** Codex d4a341b replay.rs replays typed outcomes; a cold Alpha host cannot revive prior processes. */
export function reconcileExecutionStatuses(
	messages: AlphaMessage[],
	isLive: (message: AlphaMessage, kind: "command" | "mcp" | "browser") => boolean,
): AlphaMessage[] {
	return messages.map((message) => {
		const command = commandExecutionStatusSchema.safeParse(message.commandExecutionStatus)
		const mcp = mcpExecutionStatusSchema.safeParse(message.mcpExecutionStatus)
		let result = message
		if (
			command.success &&
			["started", "output", "fallback"].includes(command.data.status) &&
			!isLive(message, "command")
		) {
			result = {
				...result,
				commandExecutionStatus: {
					executionId: command.data.executionId,
					taskId: command.data.taskId,
					toolCallId: command.data.toolCallId,
					status: "cancelled",
				},
			}
		}
		if (mcp.success && ["started", "output"].includes(mcp.data.status) && !isLive(message, "mcp")) {
			result = {
				...result,
				mcpExecutionStatus: {
					executionId: mcp.data.executionId,
					taskId: mcp.data.taskId,
					toolCallId: mcp.data.toolCallId,
					status: "cancelled",
				},
			}
		}
		if (message.type === "say" && message.say === "tool") {
			const browser = safeJsonParse<AlphaSayTool>(message.text)
			if (browser?.tool === "browserAction" && browser.status === "running" && !isLive(message, "browser")) {
				result = {
					...result,
					text: JSON.stringify({ ...browser, status: "cancelled" }),
					partial: false,
				}
			}
		}
		return result
	})
}
