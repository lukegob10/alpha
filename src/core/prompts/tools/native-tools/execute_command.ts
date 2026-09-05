import type OpenAI from "openai"

const EXECUTE_COMMAND_DESCRIPTION = `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency.

Parameters:
- command: (required) The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.
- cwd: (optional) The working directory to execute the command in
- timeout: (optional) Timeout in seconds. When exceeded, the command keeps running in the background and you receive the output so far. Set this for commands that may run indefinitely, such as dev servers or file watchers, so you can proceed without waiting for them to exit.
- verification: (optional) Associate a check with an applied Worker change set when its review workflow requires scoped evidence. Use null for ordinary commands, including task-directed validation of your own edits. Choose checks appropriate to the request and repository instructions; report the actual outcome.

Example: Executing npm run dev
{ "command": "npm run dev", "cwd": null, "timeout": null, "verification": null }

Example: Executing ls in a specific directory if directed
{ "command": "ls -la", "cwd": "/home/user/projects", "timeout": null, "verification": null }

Example: Using relative paths
{ "command": "touch ./testdata/example.file", "cwd": null, "timeout": null, "verification": null }

Example: Running a build with a timeout
{ "command": "npm run build", "cwd": null, "timeout": 30, "verification": null }

Example: Verifying an applied Worker change set
{ "command": "npm test", "cwd": null, "timeout": null, "verification": { "change_set_ids": ["change-set-id"] } }`

const PLAN_EXECUTE_COMMAND_DESCRIPTION = `Run one host-classified, source-non-mutating inspection or verification command in strict Plan mode. The host accepts only a conservative single-command allow-list, such as read-only git inspection and installed test, lint-check, or no-emit type-check binaries. Verification may execute trusted repository test/config code and create ordinary tool caches; it cannot target output, temp, cache, config, or plugin paths. Shell chaining, pipes, redirection, substitution, expansion, globs, watchers, update/fix/write flags, package installation, arbitrary scripts, and mutating commands are rejected even when command auto-approval is enabled. Use read_command_output for additional output from a backgrounded command.

Parameters:
- command: (required) One allow-listed command with no shell composition or expansion
- cwd: (optional) A workspace-relative working directory that cannot contain '..' or resolve through a symlink outside the task workspace
- timeout: (optional) A bounded timeout; do not start a watcher or server
- verification: must be null because Plan cannot validate applied Worker changes

Examples:
{ "command": "git --no-pager status --short", "cwd": null, "timeout": null, "verification": null }
{ "command": "pnpm --dir src exec vitest run shared/__tests__/plan-mode.spec.ts", "cwd": null, "timeout": null, "verification": null }
{ "command": "pnpm exec tsc --noEmit", "cwd": null, "timeout": null, "verification": null }`

const COMMAND_PARAMETER_DESCRIPTION = `Shell command to execute`

const CWD_PARAMETER_DESCRIPTION = `Optional working directory for the command, relative or absolute`

const PLAN_CWD_PARAMETER_DESCRIPTION = `Optional workspace-relative working directory. Absolute paths, '..' traversal, and paths that resolve through a symlink outside the task workspace are rejected`

const TIMEOUT_PARAMETER_DESCRIPTION = `Timeout in seconds. When exceeded, the command continues running in the background and output collected so far is returned. Use this for long-running processes like dev servers, file watchers, or any command that may not exit on its own`

const VERIFICATION_PARAMETER_DESCRIPTION = `Optional scoped evidence for applied Worker changes. Use null for ordinary commands and validation of your own edits. When Worker review requires verification, provide its change-set IDs and use the correct cwd`

export function createExecuteCommandTool(planMode = false): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: "execute_command",
			description: planMode ? PLAN_EXECUTE_COMMAND_DESCRIPTION : EXECUTE_COMMAND_DESCRIPTION,
			strict: true,
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: COMMAND_PARAMETER_DESCRIPTION,
					},
					cwd: {
						type: ["string", "null"],
						description: planMode ? PLAN_CWD_PARAMETER_DESCRIPTION : CWD_PARAMETER_DESCRIPTION,
					},
					timeout: {
						type: ["number", "null"],
						description: TIMEOUT_PARAMETER_DESCRIPTION,
					},
					verification: planMode
						? {
								type: "null",
								description: "Plan mode cannot verify applied Worker changes; this value must be null",
							}
						: {
								anyOf: [
									{
										type: "object",
										properties: {
											change_set_ids: {
												type: "array",
												items: { type: "string", minLength: 1 },
												minItems: 1,
												description:
													"Current applied primary or Worker change-set IDs validated by this command",
											},
										},
										required: ["change_set_ids"],
										additionalProperties: false,
									},
									{ type: "null" },
								],
								description: VERIFICATION_PARAMETER_DESCRIPTION,
							},
				},
				required: ["command", "cwd", "timeout", "verification"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

export default createExecuteCommandTool()
