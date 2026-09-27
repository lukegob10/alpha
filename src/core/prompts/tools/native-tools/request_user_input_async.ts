import type OpenAI from "openai"

const DESCRIPTION = `Ask the user one or more questions while the task is in progress. This tool returns immediately without waiting for a reply or ending the turn; any reply arrives later as ordinary user input. Keep each question concise and self-contained. Suggested options are optional, and the user can always answer in free text. A displayed choice is not submitted automatically.`

export default {
	type: "function",
	function: {
		name: "request_user_input_async",
		description: DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "One or more questions to present together, in display order.",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							title: {
								type: "string",
								description: "The complete question shown to the user, including any needed context.",
							},
							options: {
								type: "array",
								items: { type: "string" },
								minItems: 1,
								description: "Optional suggested answers, in display order.",
							},
						},
						required: ["title"],
						additionalProperties: false,
					},
				},
			},
			required: ["questions"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
