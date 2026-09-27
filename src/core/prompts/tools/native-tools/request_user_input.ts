import type OpenAI from "openai"

const REQUEST_USER_INPUT_DESCRIPTION = `Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode.

Questions:
- id: (required) Stable identifier for mapping answers (snake_case)
- header: (required) Short header label shown in the UI (12 or fewer chars)
- question: (required) Single-sentence prompt shown to the user
- options: (required) Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.

Each option requires:
- label: User-facing label (1-5 words)
- description: One short sentence explaining impact/tradeoff if selected.`

export default {
	type: "function",
	function: {
		name: "request_user_input",
		description: REQUEST_USER_INPUT_DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "Questions to show the user. Prefer 1 and do not exceed 3.",
					minItems: 1,
					maxItems: 3,
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Stable identifier for mapping answers (snake_case).",
							},
							header: {
								type: "string",
								description: "Short header label shown in the UI (12 or fewer chars).",
							},
							question: {
								type: "string",
								description: "Single-sentence prompt shown to the user.",
							},
							options: {
								type: "array",
								description:
									'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
								minItems: 2,
								maxItems: 3,
								items: {
									type: "object",
									properties: {
										label: {
											type: "string",
											description: "User-facing label (1-5 words).",
										},
										description: {
											type: "string",
											description: "One short sentence explaining impact/tradeoff if selected.",
										},
									},
									required: ["label", "description"],
									additionalProperties: false,
								},
							},
						},
						required: ["id", "header", "question", "options"],
						additionalProperties: false,
					},
				},
			},
			required: ["questions"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
