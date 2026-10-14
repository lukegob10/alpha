import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "update_plan",
		description:
			"Updates the task plan. Provide the complete plan with each step's current status. At most one step may be in_progress.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				explanation: {
					type: "string",
					description: "Optional brief explanation of the plan update.",
				},
				plan: {
					type: "array",
					description: "The full task plan in execution order.",
					items: {
						type: "object",
						properties: {
							step: { type: "string", minLength: 1 },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] },
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
