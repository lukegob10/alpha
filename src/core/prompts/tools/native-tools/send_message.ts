import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const send_message = {
	type: "function",
	function: {
		name: "send_message",
		description:
			"Send an agent message to a pending or running child. It is delivered automatically at the next model-step boundary, after current tools settle, without interrupting work or entering the human message queue. Address the child by stable task_name, task ID, or canonical path. Use followup_task to restart a stopped child.",
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
