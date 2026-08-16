import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const followup_task = {
	type: "function",
	function: {
		name: "followup_task",
		description:
			"Give a retained child agent a follow-up objective and start its next turn. Use this for an idle, interrupted, or completed agent whose prior context should be preserved.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: agentTargetSchema,
				message: {
					type: "string",
					minLength: 1,
					maxLength: 2_000,
					description: "The follow-up objective or instruction.",
				},
			},
			required: ["target", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
