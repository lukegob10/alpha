import type OpenAI from "openai"

// Codex 67f0994b, core/src/tools/handlers/plan_spec.rs (2026-10-31).
export default {
	type: "function",
	function: {
		name: "update_plan",
		description: `Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.
`,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				explanation: {
					type: "string",
					description: "Optional explanation for this plan update.",
				},
				plan: {
					type: "array",
					description: "The list of steps",
					items: {
						type: "object",
						properties: {
							step: { type: "string", minLength: 1, description: "Task step text." },
							status: {
								type: "string",
								enum: ["pending", "in_progress", "completed"],
								description: "Step status.",
							},
						},
						required: ["step", "status"],
						additionalProperties: false,
					},
				},
			},
			required: ["plan"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
