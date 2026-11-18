import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "edit",
		description:
			"Replace exact text in one existing UTF-8 file. The editor preserves the BOM and line-ending style. Include enough context for one match, or use replace_all. For changes spanning files, prefer one multi-file patch when available.",
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
