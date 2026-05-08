import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "close_agent",
		description:
			"Cancel or close a parallel agent. Worktrees are left intact; cleanup is reserved for a future explicit cleanup operation.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "Target agent id.",
				},
				cleanup: {
					type: ["boolean", "null"],
					description: "Reserved for future worktree cleanup. Current implementation leaves worktrees intact.",
				},
			},
			required: ["target", "cleanup"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
