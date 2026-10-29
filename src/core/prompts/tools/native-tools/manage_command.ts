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

const manageCommand = {
	type: "function",
	function: {
		name: "manage_command",
		strict: false,
		description:
			"Collect command output until the wait deadline or completion, stop, send input to, or read truncated output from a command started by this task. Use the execution_id returned by exec_command or by historical shell calls for wait, stop, or input. Use action read with the artifact_id returned by exec_command when output was persisted. Wait inside the host instead of repeatedly polling unchanged output. A running server is not ready merely because it has a process: inspect its output and verify its observed URL before browser interaction. Input is supported only by interactive terminal providers. A stop request is not proof of exit; inspect the returned status. Never relaunch an existing server just to obtain its output.",
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
						"Maximum wait in milliseconds; collects output throughout the wait and returns early on completion, failure, or cancellation. Default 10000.",
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

export default manageCommand

export function createWriteStdinTool(artifactOnly = false): OpenAI.Chat.ChatCompletionTool {
	const artifactProperties = {
		artifact_id: {
			...manageCommand.function.parameters.properties.artifact_id,
			description:
				"Persisted output artifact returned by exec_command. Supply this instead of session_id to read output.",
		},
		search: manageCommand.function.parameters.properties.search,
		offset: manageCommand.function.parameters.properties.offset,
		limit: manageCommand.function.parameters.properties.limit,
	}
	const sessionProperties = {
		session_id: {
			type: "integer",
			minimum: 1,
			description: "Numeric session identifier returned by exec_command. Supply this instead of artifact_id.",
		},
		chars: {
			type: "string",
			maxLength: 16_384,
			description: "Literal terminal input. Defaults to empty, which polls without writing. Session calls only.",
		},
		yield_time_ms: {
			type: "integer",
			minimum: 0,
			maximum: MANAGE_COMMAND_MAX_TIMEOUT_MS,
			description:
				"Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default. Collects output throughout the wait and returns early on completion, failure, or cancellation. Session calls only.",
		},
		max_output_tokens: {
			type: "integer",
			minimum: 0,
			maximum: 100_000,
			description:
				"Approximate maximum session result size in tokens. Defaults to 10000. Use limit for artifacts.",
		},
	}
	return {
		type: "function",
		function: {
			name: "write_stdin",
			strict: false,
			description: artifactOnly
				? "Read persisted command output belonging to this task using the artifact_id returned by exec_command. Supports bounded search and pagination. Plan mode permits artifact reads only."
				: "Write characters to an existing task command session and return recent output, or read persisted output belonging to this task. Supply exactly one target: numeric session_id for session controls, or artifact_id with optional search, offset, and limit for an artifact read. For sessions, omit chars or pass an empty string to poll; non-empty input requires an interactive terminal provider. Sessions and artifacts belong to the current task.",
			parameters: {
				type: "object",
				properties: {
					...(!artifactOnly ? sessionProperties : {}),
					...artifactProperties,
				},
				required: artifactOnly ? ["artifact_id"] : [],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}
