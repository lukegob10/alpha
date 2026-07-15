import type OpenAI from "openai"
export const delegate_task = {
	type: "function",
	function: {
		name: "delegate_task",
		description: "Run one bounded internal task from a validated envelope.",
		parameters: {
			type: "object",
			properties: { envelope: { type: "object", description: "A validated InternalTaskEnvelope." } },
			required: ["envelope"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
