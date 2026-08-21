import type OpenAI from "openai"

const SEARCH_FILES_DESCRIPTION = `Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context.

Craft your regex patterns carefully to balance specificity and flexibility. Use this tool to find code patterns, TODO comments, function definitions, or any text-based information across the project. The results include surrounding context, so analyze the surrounding code to better understand the matches. Leverage this tool in combination with other tools for more comprehensive analysis.

Use path/regex for one search. When several independent searches are already known, use one bounded queries batch with 1 to 8 entries. Never concatenate multiple root JSON objects.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory). This directory will be recursively searched.
- regex: (required) The regular expression pattern to search for. Uses Rust regex syntax.
- file_pattern: (optional) Glob pattern to filter files (e.g., '*.ts' for TypeScript files). If not provided, it will search all files (*).
- queries: (optional) Batch of 1 to 8 search objects. Use this instead of the top-level path/regex fields for multiple independent searches.

Example: Searching for all .ts files in the current directory
{ "path": ".", "regex": ".*", "file_pattern": "*.ts" }

Example: Searching for function definitions in JavaScript files
{ "path": "src", "regex": "function\\s+\\w+", "file_pattern": "*.js" }

Example: Searching frontend and backend in one model turn
{ "queries": [{ "path": "frontend/src", "regex": "fetch|submit", "file_pattern": "*.tsx" }, { "path": "backend/app", "regex": "@router|def ", "file_pattern": "*.py" }] }`

const PATH_PARAMETER_DESCRIPTION = `Directory to search recursively, relative to the workspace`

const REGEX_PARAMETER_DESCRIPTION = `Rust-compatible regular expression pattern to match`

const FILE_PATTERN_PARAMETER_DESCRIPTION = `Optional glob to limit which files are searched (e.g., *.ts)`

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
					description: "Batch of 1 to 8 independent regex searches. Use instead of path/regex.",
					minItems: 1,
					maxItems: 8,
					items: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: PATH_PARAMETER_DESCRIPTION,
							},
							regex: {
								type: "string",
								description: REGEX_PARAMETER_DESCRIPTION,
							},
							file_pattern: {
								type: ["string", "null"],
								description: FILE_PATTERN_PARAMETER_DESCRIPTION,
							},
						},
						required: ["path", "regex"],
						additionalProperties: false,
					},
				},
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				regex: {
					type: "string",
					description: REGEX_PARAMETER_DESCRIPTION,
				},
				file_pattern: {
					type: ["string", "null"],
					description: FILE_PATTERN_PARAMETER_DESCRIPTION,
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
