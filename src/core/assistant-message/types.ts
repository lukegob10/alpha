import type { TextContent, ToolUse, McpToolUse } from "../../shared/tools"

export type AssistantMessageContent =
	| ((TextContent | { type: "reasoning"; content: string; partial: boolean }) & { previewMessageTs?: number })
	| ToolUse
	| McpToolUse
