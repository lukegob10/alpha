import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "list_agents",
		description: "List parallel agents tracked by the current root task.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				status: {
					type: ["string", "null"],
					enum: ["running", "completed", "failed", "cancelled", "closed", null],
					description: "Optional status filter.",
				},
			},
			required: ["status"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
