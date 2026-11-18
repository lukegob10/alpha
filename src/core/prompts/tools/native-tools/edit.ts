import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "edit",
		description:
			"Prefer this tool for a targeted change in an existing file. Match the original text and indentation exactly. Include enough context for one match, or set replace_all to change every occurrence.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Existing file path, relative to the task workspace or absolute.",
				},
				old_string: { type: "string", minLength: 1, description: "Exact text to replace." },
				new_string: { type: "string", description: "Literal replacement, which may be empty." },
				replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
