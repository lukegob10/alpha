import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "integrate_agent_result",
		description:
			"Review and apply the diff from a completed isolated-worktree agent. This always requires approval before applying changes to the parent worktree.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "Target agent id.",
				},
				strategy: {
					type: ["string", "null"],
					enum: ["apply_patch", "merge_worktree", null],
					description: "Integration strategy. apply_patch is the v1 implementation.",
				},
			},
			required: ["target", "strategy"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
