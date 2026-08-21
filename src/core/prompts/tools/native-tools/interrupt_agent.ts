import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const interrupt_agent = {
	type: "function",
	function: {
		name: "interrupt_agent",
		description:
			"Interrupt a child agent's current turn while retaining the agent and its context for a later follow-up.",
		strict: true,
		parameters: {
			type: "object",
			properties: { target: agentTargetSchema },
			required: ["target"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
