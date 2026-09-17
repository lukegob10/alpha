import type OpenAI from "openai"
import { WAIT_AGENT_DEFAULT_TIMEOUT_MS } from "../../../tools/AgentLifecycleTool"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait for a managed-agent update, waking as soon as a result or relevant input arrives. Set until_terminal true to ignore progress/control traffic and await an immediate child's terminal result; target optionally selects that child by task ID/canonical path and requires until_terminal true. Results carry durable event IDs, sender task/path provenance, and terminal status; their mailbox claim is consumed once only after this tool result is persisted. Otherwise wait for the next mailbox update, including parent control for managed children. Call this blocking tool alone, after useful local work. Prefer the default long wait to repeated short polls. A timeout with work still active can be followed by another bounded wait. If noActiveAgents or alreadyDelivered is true, use the available results or continue other work. Use null for optional defaults.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				timeout_ms: {
					anyOf: [{ type: "integer", minimum: 10_000, maximum: 300_000 }, { type: "null" }],
					description: `Maximum wait in milliseconds; returns early on activity or cancellation. Use null for ${WAIT_AGENT_DEFAULT_TIMEOUT_MS}.`,
				},
				target: {
					anyOf: [
						{
							type: "string",
							pattern: "^(?:/root(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*|[A-Za-z0-9][A-Za-z0-9._:-]*)$",
						},
						{ type: "null" },
					],
					description:
						"Optional immediate-child task ID or canonical path. Use null for any immediate child. Requires until_terminal true.",
				},
				until_terminal: {
					anyOf: [{ type: "boolean" }, { type: "null" }],
					description:
						"When true, ignore non-terminal mailbox traffic and await a terminal child result. Use null or false for legacy next-update behavior.",
				},
			},
			required: ["timeout_ms", "target", "until_terminal"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
