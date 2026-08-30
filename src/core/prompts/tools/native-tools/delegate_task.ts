import type OpenAI from "openai"

export type ManagedAgentKind = "explore" | "review" | "worker"

const ALL_AGENT_KINDS: readonly ManagedAgentKind[] = ["explore", "review", "worker"]

export function createDelegateTaskTool(agentKinds: readonly ManagedAgentKind[] = ALL_AGENT_KINDS) {
	const readOnlyOnly = !agentKinds.includes("worker")

	return {
		type: "function",
		function: {
			name: "delegate_task",
			description: readOnlyOnly
				? "Run one or two independent bounded Explore or Review sub-agents as one blocking read-only investigation group. The caller waits for one structured result. Set fork_turns for each child and keep every objective non-mutating."
				: "Run one or two independent bounded Alpha sub-agents as one blocking delegation group. The caller waits for one structured group result; any Worker changes are included as a quarantined proposal for explicit review and apply. Set fork_turns for each child. Use worker for file changes and explore or review only for read-only inspection; keep command-only work in the parent.",
			parameters: {
				type: "object",
				properties: {
					tasks: {
						type: "array",
						minItems: 1,
						maxItems: 2,
						description: readOnlyOnly
							? "Independent read-only investigation objectives to run concurrently."
							: "Independent objectives to run concurrently. At most one may be a worker, and every editing objective must be that worker.",
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
									enum: [...agentKinds],
									description: readOnlyOnly
										? "Use explore for repository discovery or review for evidence-focused analysis. Both are read-only and cannot run commands."
										: "Use worker for every objective that creates, modifies, renames, or deletes files. Use explore or review only for read-only inspection without commands.",
								},
								write_scope: readOnlyOnly
									? {
											type: "null",
											description: "Read-only Explore and Review children have no write scope.",
										}
									: {
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
	} satisfies OpenAI.Chat.ChatCompletionFunctionTool
}

export const delegate_task = createDelegateTaskTool()
