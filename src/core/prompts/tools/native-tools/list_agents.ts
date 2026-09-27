import type OpenAI from "openai"

import { canonicalAgentPathSchema } from "./agent_lifecycle_schema"

export const list_agents = {
	type: "function",
	function: {
		name: "list_agents",
		description: "List live agents in the current root task tree. Optionally filter by task-path prefix.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				path_prefix: canonicalAgentPathSchema,
			},
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
