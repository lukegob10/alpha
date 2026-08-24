import type OpenAI from "openai"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait once for a bounded period for the next managed-agent mailbox update visible to this task. Terminal child results return here as native tool results with durable event IDs, sender task/path provenance, and terminal status; their mailbox claim is consumed exactly once only after this tool result is persisted. A primary/root task with no active descendants or unconsumed updates returns immediately. A registered managed child may block for immediate-parent control even when it has no descendants. This blocking tool must be called alone, never alongside another tool in the same response. Use it after continuing useful local work when you need to collect an update. Do not call it repeatedly as a polling loop. Use null for the 30000 ms default.",
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
