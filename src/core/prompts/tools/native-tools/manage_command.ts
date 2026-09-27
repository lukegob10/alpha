import type OpenAI from "openai"
import { MANAGE_COMMAND_MAX_TIMEOUT_MS } from "../../../tools/commandTimeouts"
import {
	READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN,
	READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH,
	READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_OFFSET,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH,
	READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
} from "../../../tools/commandOutputContract"

export default {
	type: "function",
	function: {
		name: "manage_command",
		strict: false,
		description:
			"Wait for new output or completion, stop, send input to, or read truncated output from a command started by this task. Use the execution_id returned by exec_command or by historical shell calls for wait, stop, or input. Use action read with the artifact_id returned by exec_command when output was persisted. Wait inside the host instead of repeatedly polling unchanged output. A running server is not ready merely because it has a process: inspect its output and verify its observed URL before browser interaction. Input is supported only by interactive terminal providers. A stop request is not proof of exit; inspect the returned status. Never relaunch an existing server just to obtain its output.",
		parameters: {
			type: "object",
			properties: {
				execution_id: {
					type: "string",
					description:
						"Execution ID returned by exec_command or a historical shell call; required for wait, stop, and input.",
				},
				action: { type: "string", enum: ["wait", "stop", "input", "read"] },
				input: {
					type: "string",
					description: "Literal terminal input, including a newline when intended. Required only for input.",
				},
				timeout_ms: {
					type: "integer",
					minimum: 0,
					maximum: MANAGE_COMMAND_MAX_TIMEOUT_MS,
					description:
						"Maximum wait in milliseconds; returns early on output, completion, or cancellation. Default 10000.",
				},
				artifact_id: {
					type: "string",
					description:
						"Artifact filename returned by shell when output was truncated; required for action read.",
					minLength: 1,
					maxLength: READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH,
					pattern: READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN,
				},
				search: {
					type: "string",
					description: `Optional regex or literal pattern to filter lines (case-insensitive). 1-${READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH} characters. Omit when not searching.`,
					minLength: 1,
					maxLength: READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH,
				},
				offset: {
					type: "integer",
					description: `Byte offset to start reading from (default 0; range 0-${READ_COMMAND_OUTPUT_MAX_OFFSET}).`,
					minimum: 0,
					maximum: READ_COMMAND_OUTPUT_MAX_OFFSET,
				},
				limit: {
					type: "integer",
					description: `Maximum UTF-8 bytes in the complete response (default ${READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES}; range ${READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES}-${READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES}).`,
					minimum: READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
					maximum: READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES,
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export function createWriteStdinTool(): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: "write_stdin",
			strict: false,
			description:
				"Write characters to an existing task command session and return recent output. Use the numeric session_id returned by exec_command. Omit chars or pass an empty string to poll; non-empty input is supported only by interactive terminal providers. A session belongs to the current task and cannot control another task's command.",
			parameters: {
				type: "object",
				properties: {
					session_id: {
						type: "integer",
						minimum: 1,
						description: "Numeric session identifier returned by exec_command.",
					},
					chars: {
						type: "string",
						maxLength: 16_384,
						description: "Literal terminal input. Defaults to empty, which polls without writing.",
					},
					yield_time_ms: {
						type: "integer",
						minimum: 0,
						maximum: MANAGE_COMMAND_MAX_TIMEOUT_MS,
						description:
							"Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default. Returns early on new output, completion, or cancellation.",
					},
					max_output_tokens: {
						type: "integer",
						minimum: 0,
						maximum: 100_000,
						description: "Approximate maximum tool result size in tokens. Defaults to 10000.",
					},
				},
				required: ["session_id"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}
