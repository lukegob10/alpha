import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const cancel_agent = {
	type: "function",
	function: {
		name: "cancel_agent",
		description:
			"Cancel a child agent's active run. Cancellation is terminal for that run, but the retained agent record remains available until it is explicitly closed.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: agentTargetSchema,
				reason: {
					anyOf: [{ type: "string", minLength: 1, maxLength: 2_000 }, { type: "null" }],
					description: "Optional cancellation reason. Use null when no additional reason is needed.",
				},
			},
			required: ["target", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
