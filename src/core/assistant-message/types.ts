import type { TextContent, ToolUse, McpToolUse } from "../../shared/tools"

export type AssistantMessageContent = (TextContent & { previewMessageTs?: number }) | ToolUse | McpToolUse
