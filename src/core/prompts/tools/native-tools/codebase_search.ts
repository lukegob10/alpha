import type OpenAI from "openai"

const CODEBASE_SEARCH_DESCRIPTION = `Find relevant code using hybrid search: semantic embeddings, keyword matches, and current workspace evidence. Results include source snippets, paths, enclosing symbols, and coverage diagnostics. Searches the entire workspace unless path narrows the scope. Queries must be in English (translate if needed).

Use this for conceptual discovery when the implementation location or terminology is unknown, such as finding the code responsible for authentication. For a known token, symbol, filename, or error message, use a bounded exec_command with rg or rg --files. Read known files directly through exec_command and reuse evidence already obtained. If this search fails, returns no useful results, or reports partial coverage, continue with bounded command inspection; do not repeatedly retry an unavailable index. Search another area only to resolve a material unanswered question in the requested scope.

Parameters:
- query: (required) Describe the behavior or responsibility you need to locate. Reuse the user's wording when it expresses that intent.
- path: (optional) Limit search to specific subdirectory (relative to the current workspace directory). Leave empty for entire workspace.

Example: Searching for user authentication code
{ "query": "Where are user login and password verification handled?", "path": null }

Example: Searching entire workspace
{ "query": "database connection pooling", "path": null }`

const QUERY_PARAMETER_DESCRIPTION = `Meaning-based search query describing the information you need`

const PATH_PARAMETER_DESCRIPTION = `Optional subdirectory (relative to the workspace) to limit the search scope`

export default {
	type: "function",
	function: {
		name: "codebase_search",
		description: CODEBASE_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				path: {
					type: ["string", "null"],
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
