import type OpenAI from "openai"

import type { ManagedAgentKind } from "./delegate_task"

const ALL_AGENT_KINDS: readonly ManagedAgentKind[] = ["explore", "review", "worker"]

export function createSpawnAgentTool(agentKinds: readonly ManagedAgentKind[] = ALL_AGENT_KINDS) {
	const readOnlyOnly = !agentKinds.includes("worker")

	return {
		type: "function",
		function: {
			name: "spawn_agent",
			description: readOnlyOnly
				? "Start one bounded managed Explore or Review sub-agent asynchronously and return its handle immediately. Keep the objective read-only, batch independent spawns when capacity permits, and collect terminal results through wait_agent without polling."
				: "Start one bounded managed Alpha sub-agent asynchronously and return its handle immediately so the caller can continue. Set task_name and fork_turns. Use worker with a complete, narrow write_scope for file changes and explore or review for read-only inspection. Batch independent spawns when capacity permits. Collect terminal results through wait_agent as native tool results before completing; do not poll.",
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
							"Parent conversation inheritance after host sanitization and within its context bound: none, all available turns, or a canonical positive decimal integer string selecting the most recent N available user-led turns. Environment, instructions, skills, workspace, model route, and narrowed runtime policy are inherited independently.",
					},
					objective: {
						type: "string",
						minLength: 1,
						description: "One concrete, self-contained objective for the child.",
					},
					agent_kind: {
						type: "string",
						enum: [...agentKinds],
						description: readOnlyOnly
							? "Use explore for repository discovery or review for evidence-focused analysis. Both are read-only and cannot run commands."
							: "Use worker for every objective that creates, modifies, renames, or deletes files. Use explore or review only for read-only repository inspection without commands.",
					},
					write_scope: readOnlyOnly
						? {
								type: "null",
								description: "Read-only Explore and Review children have no write scope; use null.",
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
	} satisfies OpenAI.Chat.ChatCompletionFunctionTool
}

export const spawn_agent = createSpawnAgentTool()
