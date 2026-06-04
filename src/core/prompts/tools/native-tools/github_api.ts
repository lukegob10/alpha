import type OpenAI from "openai"

const GITHUB_API_DESCRIPTION = `Use the native GitHub API integration for pull request workflow actions. Use this for GitHub API operations after local git work is done in the terminal. Do not use this tool for clone, pull, commit, or push; use execute_command for local git operations.

The GitHub token is supplied by Alpha from secure settings or environment variables. Never include a token in tool arguments.

Actions:
- create_pull_request: Create a pull request after a branch has been pushed.
- get_pull_request: Read pull request metadata.
- list_checks: List check runs for a commit SHA.
- merge_pull_request: Merge an approved pull request.
- comment: Add a comment to a pull request or issue thread.

Parameters:
- action: One of create_pull_request, get_pull_request, list_checks, merge_pull_request, comment.
- owner: Repository owner or organization.
- repo: Repository name.
- pull_number: Pull request number for get_pull_request or merge_pull_request.
- issue_number: Issue or pull request number for comment.
- head: Source branch for create_pull_request.
- base: Target branch for create_pull_request.
- title: Pull request title, or optional merge commit title.
- body: Pull request body or comment body.
- sha: Commit SHA for list_checks.
- merge_method: Optional merge method: merge, squash, or rebase.`

export default {
	type: "function",
	function: {
		name: "github_api",
		description: GITHUB_API_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["create_pull_request", "get_pull_request", "list_checks", "merge_pull_request", "comment"],
				},
				owner: { type: "string" },
				repo: { type: "string" },
				pull_number: { type: ["number", "null"] },
				issue_number: { type: ["number", "null"] },
				head: { type: ["string", "null"] },
				base: { type: ["string", "null"] },
				title: { type: ["string", "null"] },
				body: { type: ["string", "null"] },
				sha: { type: ["string", "null"] },
				merge_method: { type: ["string", "null"], enum: ["merge", "squash", "rebase", null] },
			},
			required: [
				"action",
				"owner",
				"repo",
				"pull_number",
				"issue_number",
				"head",
				"base",
				"title",
				"body",
				"sha",
				"merge_method",
			],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
