import type OpenAI from "openai"

const DISCOVER_TOOLS_DESCRIPTION = `Search the permitted optional MCP capability catalog by server name, tool name, or capability keywords. Selected tool definitions become callable on the next model step; they are never callable in this response.`

const QUERY_PARAMETER_DESCRIPTION = `Server name, tool name, or capability keywords to search for`

const LIMIT_PARAMETER_DESCRIPTION = `Maximum number of tool definitions to return (1-5, default 3)`

export const discoverTools = {
	type: "function",
	function: {
		name: "discover_tools",
		description: DISCOVER_TOOLS_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					minLength: 1,
					maxLength: 256,
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 5,
					description: LIMIT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export default discoverTools
