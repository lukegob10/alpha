import type OpenAI from "openai"
import type { McpServer } from "@alpha-code/types"
import type { McpHub } from "../../../../services/mcp/McpHub"
import { buildMcpToolName, normalizeMcpToolName } from "../../../../utils/mcp-name"
import { normalizeToolSchema, type JsonSchema } from "../../../../utils/json-schema"

/**
 * Dynamically generates native tool definitions for all enabled tools across connected MCP servers.
 * Tools are deduplicated by name to prevent API errors. When the same server exists in both
 * global and project configs, project servers take priority (handled by McpHub.getServers()).
 *
 * @param mcpHub The McpHub instance containing connected servers.
 * @returns An array of OpenAI.Chat.ChatCompletionTool definitions.
 */
export function getMcpServerTools(mcpHub?: McpHub): OpenAI.Chat.ChatCompletionTool[] {
	return buildMcpServerTools(mcpHub?.getServers() ?? [])
}

/** Build from one synchronous connection snapshot; historical provider supersets may retain disconnected schemas. */
export function buildMcpServerTools(
	servers: readonly McpServer[],
	includeDisconnected = false,
): OpenAI.Chat.ChatCompletionTool[] {
	const tools: OpenAI.Chat.ChatCompletionTool[] = []
	// Track seen tool names to prevent duplicates (e.g., when same server exists in both global and project configs)
	const seenToolNames = new Set<string>()

	// Historical schemas cannot shadow a connected tool with the same canonical function name.
	const orderedServers = includeDisconnected
		? [...servers].sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"))
		: servers
	for (const server of orderedServers) {
		if (!server.tools || server.disabled || (!includeDisconnected && server.status !== "connected")) {
			continue
		}
		// Resolve sanitized-name collisions deterministically before capturing an executable target.
		for (const tool of [...server.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			// Filter tools where tool.enabledForPrompt is not explicitly false
			if (tool.enabledForPrompt === false) {
				continue
			}

			// Build sanitized tool name for API compliance
			// The name is sanitized to conform to API requirements (e.g., Gemini's function name restrictions)
			const toolName = normalizeMcpToolName(buildMcpToolName(server.name, tool.name))

			// Skip duplicate tool names - first occurrence wins (project servers come before global servers)
			if (seenToolNames.has(toolName)) {
				continue
			}
			seenToolNames.add(toolName)

			const originalSchema = tool.inputSchema as Record<string, unknown> | undefined

			// Normalize schema for JSON Schema 2020-12 compliance (type arrays → anyOf)
			let parameters: JsonSchema
			if (originalSchema) {
				parameters = normalizeToolSchema(originalSchema) as JsonSchema
			} else {
				// No schema provided - create a minimal valid schema
				parameters = { type: "object", additionalProperties: false } as JsonSchema
			}

			const toolDefinition: OpenAI.Chat.ChatCompletionTool = {
				type: "function",
				function: {
					name: toolName,
					description: tool.description,
					parameters: parameters as OpenAI.FunctionParameters,
				},
			}

			tools.push(toolDefinition)
		}
	}

	return tools.sort((left, right) => {
		const a = (left as OpenAI.Chat.ChatCompletionFunctionTool).function.name
		const b = (right as OpenAI.Chat.ChatCompletionFunctionTool).function.name
		return a < b ? -1 : a > b ? 1 : 0
	})
}
