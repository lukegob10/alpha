import type OpenAI from "openai"
export const delegate_task = {
	type: "function",
	function: {
		name: "delegate_task",
		description: "Run one bounded internal task, or up to two independent tasks concurrently.",
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 1,
					maxItems: 2,
					description: "Child-task drafts to execute in dependency order, concurrently when independent.",
					items: {
						type: "object",
						description: "A child-task draft. The host validates it and derives authority from the parent.",
						properties: {
							objective: { type: "string" },
							agent_kind: { type: "string", enum: ["general", "explore", "review"] },
							expected_output: { type: "array", items: { type: "string" } },
							allowed_paths: { type: "array", items: { type: "string" } },
							context_refs: { type: "array", items: { type: "string" } },
							skills: { type: "array", items: { type: "string" } },
							model_route: { type: "string", enum: ["fast", "balanced", "deep", "user-configured"] },
							provider: { type: "string" },
							model: { type: "string" },
							reasoning: { type: "string" },
							execute: { type: "boolean" },
							mutate: { type: "boolean" },
							network: { type: "boolean" },
							external_side_effects: { type: "boolean" },
							require_approval: { type: "boolean" },
							max_input_tokens: { type: "number" },
							max_output_tokens: { type: "number" },
							timeout_ms: { type: "number" },
							dependencies: { type: "array", items: { type: "string" } },
						},
						required: ["objective"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
