import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "navigate_code",
		description:
			"Find a symbol's definition or references with the VS Code language provider. Supply a workspace file and a position on the symbol. Returns workspace locations. Use a text search when the language has no result.",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: ["definition", "references"] },
				path: { type: "string", minLength: 1 },
				line: { type: "integer", minimum: 1, description: "One-based line." },
				column: { type: "integer", minimum: 1, description: "One-based UTF-16 column." },
			},
			required: ["operation", "path", "line", "column"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
