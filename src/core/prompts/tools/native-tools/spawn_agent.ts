import type OpenAI from "openai"

import { reasoningEffortsExtended } from "@alpha-code/types"

import type { ManagedAgentKind } from "./delegate_task"

const ALL_AGENT_KINDS: readonly ManagedAgentKind[] = ["explore", "review", "worker"]

export function createSpawnAgentTool(
	agentKinds: readonly ManagedAgentKind[] = ALL_AGENT_KINDS,
	namedAgentTypes: readonly { name: string; description: string }[] = [],
) {
	const readOnlyOnly = !agentKinds.includes("worker")
	const namedTypesDescription = namedAgentTypes.length
		? ` Available named types: ${namedAgentTypes
				.map(({ name, description }) => `${name} (${description.slice(0, 120)})`)
				.join(", ")}.`
		: ""
	const agentTypeDescription = readOnlyOnly
		? "Optional agent type override. Omit unless the user explicitly requests a role. Built-ins are default and explorer; configured named types may also be selected when read-only in Plan. The host enforces the selected type within parent authority and workspace limits."
		: "Optional agent type override. Omit unless the user explicitly requests a role. Built-ins are default, explorer, and worker; configured named types may also be selected. The host enforces the selected type within parent authority and workspace limits."

	return {
		type: "function",
		function: {
			name: "spawn_agent",
			description: readOnlyOnly
				? "Start one bounded managed Explore or Review sub-agent asynchronously and return its handle immediately. Set a self-contained message; omit agent_type to let the host resolve the narrowest role. Omitted fork_turns defaults to all available turns. The requested role never grants authority. Set model or reasoning_effort only when explicitly requested by the user. Collect the terminal result through wait_agent before completing."
				: "Start one bounded managed Alpha sub-agent asynchronously and return its handle immediately. Set a self-contained message; omit agent_type so the host selects a role within parent authority. Omitted fork_turns defaults to all available turns. The host derives or rejects Worker scope from trusted parent authority. Set model or reasoning_effort only when explicitly requested by the user. Collect the terminal result through wait_agent before completing.",
			strict: false,
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
					message: {
						type: "string",
						minLength: 1,
						description: "Initial plain-text task for the new agent.",
					},
					agent_type: {
						type: "string",
						description: `${agentTypeDescription}${namedTypesDescription}`,
					},
					fork_turns: {
						type: "string",
						maxLength: 16,
						pattern: "^(?:none|all|[1-9][0-9]*)$",
						default: "all",
						description:
							"Parent conversation inheritance after host sanitization and within its context bound. Omit for all available turns, or use none or a canonical positive decimal integer string for the most recent N turns. Workspace, instructions, skills, model route, and narrowed runtime policy are inherited independently.",
					},
					model: {
						type: "string",
						minLength: 1,
						maxLength: 256,
						description:
							"Optional model override. Omit unless the user explicitly requested a different model.",
					},
					reasoning_effort: {
						type: "string",
						enum: [...reasoningEffortsExtended],
						description:
							"Optional reasoning effort override. Omit unless the user explicitly requested a different effort; the host validates support for the selected model.",
					},
				},
				required: ["task_name", "message"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionFunctionTool
}

export const spawn_agent = createSpawnAgentTool()
