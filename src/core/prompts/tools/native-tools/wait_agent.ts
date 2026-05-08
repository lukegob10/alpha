import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait for one or more running parallel agents. Use this only when your next step is blocked on their result.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				targets: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Agent ids to wait for. Null waits for any running agent.",
				},
				timeout_ms: {
					type: ["number", "null"],
					description: "Maximum wait time in milliseconds. Null defaults to 30000.",
				},
			},
			required: ["targets", "timeout_ms"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
