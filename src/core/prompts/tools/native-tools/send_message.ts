import type OpenAI from "openai"

import { agentTargetSchema } from "./agent_lifecycle_schema"

export const send_message = {
	type: "function",
	function: {
		name: "send_message",
		description:
			"Send a passive message to another agent in this task's managed tree, including your parent, /root, or a peer. It is delivered at the next model-step boundary, after current tools settle, and wakes an idle mailbox wait without interrupting work or answering human approval. It never starts a recipient turn. Address the agent by stable task_name, task ID, or canonical path. Use followup_task to restart a stopped child.",
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
