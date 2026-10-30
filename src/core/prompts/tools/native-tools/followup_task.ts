import type OpenAI from "openai"
import { AGENT_MESSAGE_MAX_CHARACTERS } from "@alpha-code/types"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const followup_task = {
	type: "function",
	function: {
		name: "followup_task",
		description:
			"Give a retained child agent a follow-up task using its existing context. An idle agent starts a turn; a running agent receives the instruction at a model-step boundary after its current tools settle.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				target: agentTargetSchema,
				message: {
					type: "string",
					minLength: 1,
					maxLength: AGENT_MESSAGE_MAX_CHARACTERS,
					description: "The follow-up objective or instruction.",
				},
			},
			required: ["target", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
