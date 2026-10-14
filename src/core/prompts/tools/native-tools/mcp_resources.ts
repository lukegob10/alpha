import type OpenAI from "openai"

function schema(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): OpenAI.Chat.ChatCompletionFunctionTool {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: { type: "object", properties, required, additionalProperties: false },
		},
	}
}

const server = { type: "string", description: "Configured MCP server name. Omit to list across connected servers." }
const cursor = { type: "string", description: "Cursor returned by an earlier page for the selected server." }

export const mcpResourceTools = [
	schema("list_mcp_resources", "List resources available from connected MCP servers.", { server, cursor }),
	schema("list_mcp_resource_templates", "List parameterized resource templates from connected MCP servers.", {
		server,
		cursor,
	}),
	schema(
		"read_mcp_resource",
		"Read a resource from a connected MCP server by its configured name and URI.",
		{
			server: { type: "string", description: "Configured MCP server name." },
			uri: { type: "string", description: "URI of the resource to read." },
		},
		["server", "uri"],
	),
] satisfies OpenAI.Chat.ChatCompletionTool[]
