import type OpenAI from "openai"

const SEARCH_FILES_DESCRIPTION = `Search file contents recursively with Rust regex syntax, or literal text when literal=true. Regex searches are line-oriented; explicit newline matches automatically enable multiline search.

Choose output_mode="content" (default) for numbered snippets with context, "files" for unique matching paths, or "count" for per-file match counts without snippets. Counts are occurrences, not matching lines; truncated counts are partial lower bounds. Ignore rules and output limits apply in every mode.

Use path/regex for one search, or queries for 1 to 8 independent searches with their own options. Batch results retain each query's success or error; one failed query does not discard successful searches. Never concatenate root JSON objects.

Example: { "queries": [{ "path": "src", "regex": "foo(.bar", "literal": true, "output_mode": "files" }, { "path": "tests", "regex": "TODO|FIXME", "output_mode": "count" }] }`

const PATH_PARAMETER_DESCRIPTION = `Absolute directory path or path relative to the task workspace, searched recursively`

const REGEX_PARAMETER_DESCRIPTION = `Rust regex, or exact text when literal=true`

const FILE_PATTERN_PARAMETER_DESCRIPTION = `Optional glob to limit which files are searched (e.g., *.ts)`

const OUTPUT_MODE_PARAMETER = {
	type: ["string", "null"],
	enum: ["content", "files", "count", null],
	description: "content: snippets (default); files: unique paths; count: per-file occurrences. Null uses content.",
}

const LITERAL_PARAMETER = {
	type: ["boolean", "null"],
	description: "Treat regex as fixed text when true. False, null, or omitted uses regex.",
}

const SEARCH_FILES_INPUT_LIMITS = {
	path: 4_096,
	regex: 8_192,
	filePattern: 2_048,
} as const

export default {
	type: "function",
	function: {
		name: "search_files",
		description: SEARCH_FILES_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				queries: {
					type: "array",
					description: "Batch of 1 to 8 independent searches. Use instead of path/regex.",
					minItems: 1,
					maxItems: 8,
					items: {
						type: "object",
						properties: {
							output_mode: OUTPUT_MODE_PARAMETER,
							literal: LITERAL_PARAMETER,
							path: {
								type: "string",
								maxLength: SEARCH_FILES_INPUT_LIMITS.path,
								description: PATH_PARAMETER_DESCRIPTION,
							},
							regex: {
								type: "string",
								maxLength: SEARCH_FILES_INPUT_LIMITS.regex,
								description: REGEX_PARAMETER_DESCRIPTION,
							},
							file_pattern: {
								type: ["string", "null"],
								maxLength: SEARCH_FILES_INPUT_LIMITS.filePattern,
								description: FILE_PATTERN_PARAMETER_DESCRIPTION,
							},
						},
						required: ["path", "regex"],
						additionalProperties: false,
					},
				},
				output_mode: OUTPUT_MODE_PARAMETER,
				literal: LITERAL_PARAMETER,
				path: {
					type: "string",
					maxLength: SEARCH_FILES_INPUT_LIMITS.path,
					description: PATH_PARAMETER_DESCRIPTION,
				},
				regex: {
					type: "string",
					maxLength: SEARCH_FILES_INPUT_LIMITS.regex,
					description: REGEX_PARAMETER_DESCRIPTION,
				},
				file_pattern: {
					type: ["string", "null"],
					maxLength: SEARCH_FILES_INPUT_LIMITS.filePattern,
					description: FILE_PATTERN_PARAMETER_DESCRIPTION,
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
