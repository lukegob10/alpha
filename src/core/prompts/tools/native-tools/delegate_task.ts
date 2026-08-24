import type OpenAI from "openai"
export const delegate_task = {
	type: "function",
	function: {
		name: "delegate_task",
		description:
			"Launch one or two independent Alpha sub-agents and wait for their structured results. Each child must explicitly select parent conversation inheritance with fork_turns. Select roles by required authority: use worker for every objective that needs file changes; a worker may use commands for implementation or verification. Explore and review are strictly read-only and cannot edit or execute. Keep command-only work in the parent. Worker changes stay quarantined for explicit review and apply; after capture, the temporary worktree is removed and the change set remains as the reviewable proposal.",
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: 2,
					description:
						"Independent objectives to run concurrently. At most one may be a worker, and every editing objective must be that worker.",
					items: {
						type: "object",
						description:
							"A self-contained child task. The host validates the selected role, applies the requested bounded parent-turn inheritance, and derives the narrowest allowed authority from the parent.",
						properties: {
							objective: { type: "string", minLength: 1 },
							fork_turns: {
								type: "string",
								maxLength: 16,
								pattern: "^(?:none|all|[1-9][0-9]*)$",
								description:
									"Parent conversation inheritance for this child after host sanitization and within its context bound: none, all available turns, or a canonical positive decimal integer string selecting the most recent N available user-led turns. Environment, instructions, skills, workspace, model route, and narrowed runtime policy are inherited independently.",
							},
							agent_kind: {
								type: "string",
								enum: ["explore", "review", "worker"],
								description:
									"Use worker for every objective that creates, modifies, renames, or deletes files. Use explore or review only for read-only inspection without commands.",
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
									"For worker, provide one to twelve workspace-relative files or directories covering every possible edit. For explore or review, use null or omit this field when the provider permits omission.",
							},
							expected_output: {
								type: "array",
								maxItems: 12,
								items: { type: "string", minLength: 1 },
								description: "Optional deliverables; omit or use null when not needed.",
							},
						},
						required: ["objective", "fork_turns", "agent_kind"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
