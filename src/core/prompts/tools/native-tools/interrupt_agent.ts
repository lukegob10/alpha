import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const interrupt_agent = {
	type: "function",
	function: {
		name: "interrupt_agent",
		description:
			"Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
		strict: true,
		parameters: {
			type: "object",
			properties: { target: agentTargetSchema },
			required: ["target"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
