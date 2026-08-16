import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const close_agent = {
	type: "function",
	function: {
		name: "close_agent",
		description:
			"Explicitly close a retained terminal child agent and release its follow-up lifecycle resources. Inspect or collect its result before closing it.",
		strict: true,
		parameters: {
			type: "object",
			properties: { target: agentTargetSchema },
			required: ["target"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
