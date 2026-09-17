import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const send_message = {
	type: "function",
	function: {
		name: "send_message",
		description:
			"Deliver or queue a message for a pending or running child agent without starting a separate follow-up turn. Address the child by stable task_name, task ID, or canonical path. For deterministic immediate steering, this may follow spawn_agent for the same task_name in one response.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: agentTargetSchema,
				message: { type: "string", minLength: 1, maxLength: 2_000, description: "The message to deliver." },
			},
			required: ["target", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
