import type OpenAI from "openai"
import { TOOL_SEARCH_MAX_LIMIT } from "@alpha-code/types"

const TOOL_SEARCH_DESCRIPTION = `# Tool discovery

Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call.

Some of the tools may not have been provided to you upfront, and you should use this tool (\`tool_search\`) to search for the required tools. For MCP tool discovery, always use \`tool_search\` instead of \`list_mcp_resources\` or \`list_mcp_resource_templates\`.`

const DISCOVER_TOOLS_DESCRIPTION = `Search the permitted optional MCP capability catalog by server name, tool name, or capability keywords. Selected tool definitions become callable on the next model step; they are never callable in this response.`

const QUERY_PARAMETER_DESCRIPTION = `Server name, tool name, or capability keywords to search for`

const LIMIT_PARAMETER_DESCRIPTION = `Maximum number of tool definitions to return (1-5, default 3)`

const TOOL_SEARCH_LIMIT_PARAMETER_DESCRIPTION = `Maximum number of tools to return. Defaults to 8.`
const TOOL_SEARCH_QUERY_PARAMETER_DESCRIPTION = `Search query for deferred tools.`

function createDiscoverySchema(
	name: string,
	description: string,
	maxLimit: number,
	limitDescription: string,
	queryDescription = QUERY_PARAMETER_DESCRIPTION,
) {
	return {
		type: "function" as const,
		function: {
			name,
			description,
			parameters: {
				type: "object" as const,
				properties: {
					query: {
						type: "string" as const,
						minLength: 1,
						maxLength: 256,
						description: queryDescription,
					},
					limit: {
						type: "integer" as const,
						minimum: 1,
						maximum: maxLimit,
						description: limitDescription,
					},
				},
				required: ["query"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

export const toolSearch = createDiscoverySchema(
	"tool_search",
	TOOL_SEARCH_DESCRIPTION,
	TOOL_SEARCH_MAX_LIMIT,
	TOOL_SEARCH_LIMIT_PARAMETER_DESCRIPTION,
	TOOL_SEARCH_QUERY_PARAMETER_DESCRIPTION,
)

/** Retained for persisted provider histories written before the Codex tool name. */
export const discoverTools = createDiscoverySchema(
	"discover_tools",
	DISCOVER_TOOLS_DESCRIPTION,
	5,
	LIMIT_PARAMETER_DESCRIPTION,
)

export default discoverTools
