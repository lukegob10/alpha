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
			"Wait for new output or completion, stop, send input to, or read truncated output from a command started by this task. Use the execution_id returned by shell for wait, stop, or input. Use action read with the artifact_id returned by shell when output was persisted. Wait inside the host instead of repeatedly polling unchanged output. A running server is not ready merely because it has a process: inspect its output and verify its observed URL before browser interaction. Input is supported only by interactive terminal providers. A stop request is not proof of exit; inspect the returned status. Never relaunch an existing server just to obtain its output.",
		parameters: {
			type: "object",
			properties: {
				execution_id: {
					type: "string",
					description: "Execution ID returned by shell; required for wait, stop, and input.",
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
