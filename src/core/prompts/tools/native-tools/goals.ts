import type OpenAI from "openai"

export const goalTools = [
	{
		type: "function",
		function: {
			name: "create_goal",
			description:
				"Create a persistent goal only when the user explicitly requests one. Ordinary tasks do not authorize goals. Human approval is required. An unfinished goal cannot be replaced. Supply token_budget only when the user requests a token budget.",
			strict: false,
			parameters: {
				type: "object",
				properties: {
					objective: { type: "string", description: "The concrete objective to pursue.", minLength: 1 },
					token_budget: {
						type: "integer",
						minimum: 1,
						description: "Optional positive token budget explicitly requested by the user.",
					},
				},
				required: ["objective"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_goal",
			description: "Read this task's persistent goal, status, token budget, usage, and continuation limits.",
			strict: false,
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "update_goal",
			description:
				"Mark the existing goal complete only when every requirement is achieved and verified. Mark blocked only after the same blocker recurs for at least three consecutive goal turns with no meaningful progress possible. A resumed blocked goal starts a fresh audit. Pause only at the user's explicit request, with human approval; budget limits take precedence. Resume, clear, and system limit statuses belong to the host. Report final token usage from completionBudgetReport when provided.",
			strict: false,
			parameters: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["complete", "blocked", "paused"] },
				},
				required: ["status"],
				additionalProperties: false,
			},
		},
	},
] satisfies OpenAI.Chat.ChatCompletionTool[]
