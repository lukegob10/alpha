import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const send_message = {
	type: "function",
	function: {
		name: "send_message",
		description:
			"Deliver a message to a running child agent without starting a separate follow-up turn. Address the child by task ID or canonical path.",
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
