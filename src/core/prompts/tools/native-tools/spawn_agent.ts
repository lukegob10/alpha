import type OpenAI from "openai"

export const spawn_agent = {
	type: "function",
	function: {
		name: "spawn_agent",
		description:
			"Start one bounded Alpha sub-agent in the background and return its handle immediately. Give it a stable task_name so later lifecycle controls can target it without first listing agents. Explicitly choose which parent conversation turns the child inherits with fork_turns. Use this when the parent can continue useful, non-overlapping work while the child runs. When more than one independent child is needed, emit all spawn_agent calls in the same response so they start without separate model turns. Select authority by role: explore and review are strictly read-only; worker is required for file changes and must receive the complete, narrow write scope. Keep command-only work in the parent. Progress is published asynchronously, and the terminal report is automatically included in the parent's next model request after the child finishes. Do not poll for the result or claim that no retrieval mechanism exists; review and synthesize the injected report before completing when it is relevant.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_name: {
					type: "string",
					minLength: 1,
					maxLength: 32,
					pattern: "^[a-z][a-z0-9_]{0,31}$",
					description:
						"Stable lowercase name for lifecycle controls, using letters, digits, and underscores; for example backend_review.",
				},
				fork_turns: {
					type: "string",
					maxLength: 16,
					pattern: "^(?:none|all|[1-9][0-9]*)$",
					description:
						"Parent conversation inheritance: none, all, or a canonical positive decimal integer string selecting the most recent N user-led turns. Environment, instructions, skills, workspace, model route, and narrowed runtime policy are inherited independently.",
				},
				objective: {
					type: "string",
					minLength: 1,
					description: "One concrete, self-contained objective for the child.",
				},
				agent_kind: {
					type: "string",
					enum: ["explore", "review", "worker"],
					description:
						"Use worker for every objective that creates, modifies, renames, or deletes files. Use explore or review only for read-only repository inspection without commands.",
				},
				write_scope: {
					anyOf: [
						{
							type: "array",
							minItems: 1,
							maxItems: 12,
							items: { type: "string", minLength: 1 },
						},
						{ type: "null" },
					],
					description:
						"For worker, one to twelve workspace-relative files or directories covering every possible edit. For explore or review, use null.",
				},
				expected_output: {
					anyOf: [
						{
							type: "array",
							maxItems: 12,
							items: { type: "string", minLength: 1 },
						},
						{ type: "null" },
					],
					description: "Optional deliverables for the child; use null when none are needed.",
				},
			},
			required: ["task_name", "fork_turns", "objective", "agent_kind", "write_scope", "expected_output"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
