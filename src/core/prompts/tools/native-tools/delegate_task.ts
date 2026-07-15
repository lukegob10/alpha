import type OpenAI from "openai"
export const delegate_task = {
	type: "function",
	function: {
		name: "delegate_task",
		description: "Run one or two bounded child tasks. The host validates and seals each task before execution.",
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: 2,
					items: {
						type: "object",
						properties: {
							objective: { type: "string", description: "A specific, bounded child-task objective." },
						},
						required: ["objective"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
