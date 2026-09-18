import type OpenAI from "openai"
import { MANAGE_COMMAND_MAX_TIMEOUT_MS } from "../../../tools/commandTimeouts"

export default {
	type: "function",
	function: {
		name: "manage_command",
		description:
			"Wait for new output or completion, stop, or send input to a command started by this task. Use the execution_id returned by execute_command. Wait inside the host instead of repeatedly polling unchanged output. A running server is not ready merely because it has a process: inspect its output and verify its observed URL before browser interaction. Input is supported only by interactive terminal providers. A stop request is not proof of exit; inspect the returned status. Never relaunch an existing server just to obtain its output.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				execution_id: { type: "string" },
				action: { type: "string", enum: ["wait", "stop", "input"] },
				input: {
					type: ["string", "null"],
					description: "Literal terminal input, including a newline when intended. Required only for input.",
				},
				timeout_ms: {
					type: ["integer", "null"],
					minimum: 0,
					maximum: MANAGE_COMMAND_MAX_TIMEOUT_MS,
					description:
						"Maximum wait in milliseconds; returns early on output, completion, or cancellation. Default 10000.",
				},
			},
			required: ["execution_id", "action", "input", "timeout_ms"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
