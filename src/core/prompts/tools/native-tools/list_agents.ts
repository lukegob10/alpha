import type OpenAI from "openai"

import { canonicalAgentPathSchema } from "./agent_lifecycle_schema"

export const list_agents = {
	type: "function",
	function: {
		name: "list_agents",
		description:
			"Inspect the durable agent tree visible to this parent. Returns current and retained terminal agents, including their canonical paths and lifecycle states, plus rootOrchestration with the configured or frozen root limits even when the tree is empty. Use path_prefix to restrict the result to one branch of the tree; use null for the full visible tree.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path_prefix: {
					anyOf: [canonicalAgentPathSchema, { type: "null" }],
					description: "Optional canonical path prefix. Use null to list every visible agent.",
				},
			},
			required: ["path_prefix"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
