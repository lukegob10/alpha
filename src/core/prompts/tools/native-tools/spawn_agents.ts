import type OpenAI from "openai"

const AGENT_SCHEMA = {
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
} as const

const DESCRIPTION = `Start multiple background parallel agents for concrete, independent subtasks in one approved operation. Prefer this over repeated spawn_agent calls when two or more agents can run at the same time. Do not include dependent subtasks in the same batch. After spawning, continue useful local work and call wait_agent only when blocked on agent results.`

export default {
	type: "function",
	function: {
		name: "spawn_agents",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				agents: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					items: AGENT_SCHEMA,
					description: "Independent agent subtasks to start together.",
				},
			},
			required: ["agents"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
