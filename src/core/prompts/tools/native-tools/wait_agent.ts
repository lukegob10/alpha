import type OpenAI from "openai"
import { WAIT_AGENT_DEFAULT_TIMEOUT_MS } from "../../../tools/AgentLifecycleTool"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Returns a summary of which agents have updates, an interruption summary for steered input, or a timeout summary. Call this blocking tool alone after useful local work.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				timeout_ms: {
					type: "integer",
					minimum: 10_000,
					maximum: 3_600_000,
					description: `Timeout in milliseconds. Defaults to ${WAIT_AGENT_DEFAULT_TIMEOUT_MS}, min 10000, max 3600000.`,
				},
			},
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
