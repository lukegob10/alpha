import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "send_input",
		description: "Send an additional user message to a running parallel agent.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "Target agent id.",
				},
				message: {
					type: "string",
					description: "Message to send to the agent.",
				},
				interrupt: {
					type: ["boolean", "null"],
					description: "Reserved for future interruption support. Null/false queues the message.",
				},
			},
			required: ["target", "message", "interrupt"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
