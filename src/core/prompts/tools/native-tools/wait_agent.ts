import type OpenAI from "openai"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait once for a bounded period for the next agent mailbox or completion update visible to this parent. Use this after continuing useful local work when you need to collect an update. Do not call it repeatedly as a polling loop. Use null for the 30000 ms default.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				timeout_ms: {
					anyOf: [{ type: "integer", minimum: 10_000, maximum: 300_000 }, { type: "null" }],
					description: "Bounded wait in milliseconds. Use null for 30000.",
				},
			},
			required: ["timeout_ms"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
