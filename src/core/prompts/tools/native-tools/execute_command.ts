import type OpenAI from "openai"
import { EXEC_COMMAND_DEFAULT_YIELD_TIME_MS, getExecCommandYieldTimeBounds } from "../../../tools/commandTimeouts"

const EXEC_COMMAND_DESCRIPTION = `Runs a concise command in the task's host terminal. Use bounded, workspace-scoped commands for file inspection. For edits, prefer a supplied native editing tool. A complete standalone apply_patch heredoc is routed through the patch tool before shell execution. The command starts in the task workspace unless workdir is supplied. A command that has not yielded within yield_time_ms continues in the background and returns a session_id for write_stdin. Use bounded output when the command may produce a large result. Commands remain subject to the task's approval and execution policy.`

const PLAN_EXEC_COMMAND_DESCRIPTION = `Run one host-classified, source-non-mutating inspection or verification command in strict Plan mode. The host accepts only a conservative single-command allow-list, such as read-only git inspection and installed test, lint-check, or no-emit type-check binaries. Shell chaining, pipes, redirection, substitution, expansion, globs, watchers, update/fix/write flags, package installation, arbitrary scripts, and mutating commands are rejected even when command auto-approval is enabled. Output is bounded in Plan mode; a command that continues in the background cannot be managed from Plan.

Parameters:
- cmd: (required) One allow-listed command with no shell composition or expansion
- workdir: (optional) A workspace-relative working directory that cannot contain '..' or resolve through a symlink outside the task workspace
- yield_time_ms: (optional) A bounded wait before the command continues in the background

Examples:
{ "cmd": "git --no-pager status --short" }
{ "cmd": "pnpm --dir src exec vitest run shared/__tests__/plan-mode.spec.ts" }
{ "cmd": "pnpm exec tsc --noEmit" }`

const CMD_DESCRIPTION = `CLI command to execute`
const WORKDIR_DESCRIPTION = `Optional working directory for the command, relative or absolute`
const PLAN_WORKDIR_DESCRIPTION = `Optional workspace-relative working directory. Absolute paths, '..' traversal, and paths that resolve through a symlink outside the task workspace are rejected`
const MAX_OUTPUT_TOKENS_DESCRIPTION = `Approximate maximum tool result size in tokens. Defaults to 10000. Alpha bounds the returned command text by an approximate four characters per token.`

export function createExecCommandTool(planMode = false): OpenAI.Chat.ChatCompletionTool {
	const yieldTimeBounds = getExecCommandYieldTimeBounds()
	const yieldTimeDescription =
		process.platform === "win32"
			? `Maximum time to wait before returning a session_id for a still-running command. Commands that finish sooner return immediately. Defaults to ${EXEC_COMMAND_DEFAULT_YIELD_TIME_MS} ms; effective range on Windows is ${yieldTimeBounds.minimum}-${yieldTimeBounds.maximum} ms.`
			: `Wait before yielding output. Defaults to ${EXEC_COMMAND_DEFAULT_YIELD_TIME_MS} ms; effective range is ${yieldTimeBounds.minimum}-${yieldTimeBounds.maximum} ms.`
	return {
		type: "function",
		function: {
			name: "exec_command",
			strict: false,
			description: planMode ? PLAN_EXEC_COMMAND_DESCRIPTION : EXEC_COMMAND_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					cmd: {
						type: "string",
						description: CMD_DESCRIPTION,
					},
					workdir: {
						type: "string",
						description: planMode ? PLAN_WORKDIR_DESCRIPTION : WORKDIR_DESCRIPTION,
					},
					yield_time_ms: {
						type: "integer",
						minimum: yieldTimeBounds.minimum,
						maximum: yieldTimeBounds.maximum,
						description: yieldTimeDescription,
					},
					max_output_tokens: {
						type: "integer",
						minimum: 0,
						maximum: 100_000,
						description: MAX_OUTPUT_TOKENS_DESCRIPTION,
					},
				},
				required: ["cmd"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

/** Historical factory spellings retained for saved turns and existing callers. */
export const createShellTool = createExecCommandTool
export const createExecuteCommandTool = createExecCommandTool

export default createExecCommandTool()
