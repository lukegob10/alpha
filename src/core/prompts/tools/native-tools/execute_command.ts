import type OpenAI from "openai"

const SHELL_DESCRIPTION = `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency. For GitHub operations, use gh with CLI-owned authentication and never pass tokens as command arguments.

Parameters:
- command: (required) The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.
- cwd: (optional) The working directory to execute the command in
- timeout: (optional) Timeout in seconds. When exceeded, the command keeps running in the background and you receive the output so far. Set this for commands that may run indefinitely, such as dev servers or file watchers, so you can proceed without waiting for them to exit.

Example: Executing npm run dev
{ "command": "npm run dev" }

Example: Executing ls in a specific directory if directed
{ "command": "ls -la", "cwd": "/home/user/projects" }

Example: Using relative paths
{ "command": "touch ./testdata/example.file" }

Example: Running a build with a timeout
{ "command": "npm run build", "timeout": 30 }`

const PLAN_SHELL_DESCRIPTION = `Run one host-classified, source-non-mutating inspection or verification command in strict Plan mode. The host accepts only a conservative single-command allow-list, such as read-only git inspection and installed test, lint-check, or no-emit type-check binaries. The command may execute trusted repository test/config code and create ordinary tool caches; it cannot target output, temp, cache, config, or plugin paths. Shell chaining, pipes, redirection, substitution, expansion, globs, watchers, update/fix/write flags, package installation, arbitrary scripts, and mutating commands are rejected even when command auto-approval is enabled. Output is bounded in Plan mode; a command that continues in the background cannot be managed from Plan.

Parameters:
- command: (required) One allow-listed command with no shell composition or expansion
- cwd: (optional) A workspace-relative working directory that cannot contain '..' or resolve through a symlink outside the task workspace
- timeout: (optional) A bounded timeout; do not start a watcher or server

Examples:
{ "command": "git --no-pager status --short" }
{ "command": "pnpm --dir src exec vitest run shared/__tests__/plan-mode.spec.ts" }
{ "command": "pnpm exec tsc --noEmit" }`

const COMMAND_PARAMETER_DESCRIPTION = `Shell command to execute`

const CWD_PARAMETER_DESCRIPTION = `Optional working directory for the command, relative or absolute`

const PLAN_CWD_PARAMETER_DESCRIPTION = `Optional workspace-relative working directory. Absolute paths, '..' traversal, and paths that resolve through a symlink outside the task workspace are rejected`

const TIMEOUT_PARAMETER_DESCRIPTION = `Timeout in seconds. When exceeded, the command continues running in the background and output collected so far is returned. Use this for long-running processes like dev servers, file watchers, or any command that may not exit on its own`

export function createShellTool(planMode = false): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: "shell",
			strict: false,
			description: planMode ? PLAN_SHELL_DESCRIPTION : SHELL_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: COMMAND_PARAMETER_DESCRIPTION,
					},
					cwd: {
						type: "string",
						description: planMode ? PLAN_CWD_PARAMETER_DESCRIPTION : CWD_PARAMETER_DESCRIPTION,
					},
					timeout: {
						type: "number",
						description: TIMEOUT_PARAMETER_DESCRIPTION,
					},
				},
				required: ["command"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

/** Historical factory spelling retained for internal callers and replay fixtures. */
export const createExecuteCommandTool = createShellTool

export default createShellTool()
