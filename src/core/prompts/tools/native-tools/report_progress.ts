import type OpenAI from "openai"

export const report_progress = {
	type: "function",
	function: {
		name: "report_progress",
		description:
			"Send a bounded progress update to this managed sub-agent's immediate parent. The parent is resolved automatically; this cannot address ancestors, siblings, or other agents.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				message: {
					type: "string",
					minLength: 1,
					maxLength: 2_000,
					description: "The progress update to deliver to the immediate parent.",
				},
			},
			required: ["message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
