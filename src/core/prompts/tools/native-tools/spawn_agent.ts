import type OpenAI from "openai"

const DESCRIPTION = `Start one background parallel agent for a concrete, independent subtask. When two or more independent agents are useful, prefer spawn_agents so they launch in one turn. Use this only when the work can proceed without blocking your next local step. Do not spawn vague research tasks or duplicate your own immediate work. Parallel implementation agents that may edit files should normally use newWorktree unless their write scope is explicitly disjoint.`

export default {
	type: "function",
	function: {
		name: "spawn_agent",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_name: {
					type: "string",
					description: "Short stable name for the subtask; used in branch and worktree names.",
				},
				message: {
					type: "string",
					description: "Self-contained instructions for the agent.",
				},
				mode: {
					type: ["string", "null"],
					description: "Optional mode slug for the agent. Omit to use the current mode.",
				},
				agent_type: {
					type: ["string", "null"],
					description: "Optional role label such as explorer, worker, reviewer, or verifier.",
				},
				workspace_strategy: {
					type: ["string", "null"],
					enum: ["auto", "sameWorktree", "newWorktree", null],
					description: "Workspace isolation policy. Use auto unless you have a clear reason.",
				},
				write_scope: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Relative paths the agent may edit. Leave empty/null for read-only work.",
				},
			},
			required: ["task_name", "message", "mode", "agent_type", "workspace_strategy", "write_scope"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
