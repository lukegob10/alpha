import type OpenAI from "openai"
import { WAIT_AGENT_DEFAULT_TIMEOUT_MS } from "../../../tools/AgentLifecycleTool"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		// Codex CLI 5228d94a recommends minute-scale waits to reduce empty parent requests.
		description:
			"Wait for a mailbox update from any live agent, including queued messages and final-status notifications, or for user steering. Returns an update, interruption, or timeout summary. Call alone after useful local work. Prefer a timeout of several minutes (e.g. 180000 ms) to avoid repeated empty waits.",
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
