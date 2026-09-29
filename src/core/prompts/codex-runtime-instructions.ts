import type { CodexModelPromptSlug } from "./codex-model-instructions"

/**
 * Runtime-gated model_messages from openai/codex at the pinned catalog commit.
 * Source fields: collaboration_modes.default/plan and multi_agent.role/mode.
 */
export const CODEX_RUNTIME_PROMPT_SOURCE_COMMIT = "4994306e9f80448bde85e770a0b0c93d3fee5665" as const
export const CODEX_RUNTIME_PROMPT_SOURCE_PATH = "codex-rs/models-manager/models.json" as const
export const CODEX_RUNTIME_PROMPT_SOURCE_RETRIEVED_AT = "2026-09-29" as const

const GPT_6_MODEL_PROMPTS = new Set<CodexModelPromptSlug>(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])

const DEFAULT_COLLABORATION_MODE =
	"# Collaboration Mode: Default\n\nYou are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.\n\nYour active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.\n\n## request_user_input availability\n\nUse the `request_user_input` tool only when it is listed in the available tools for this turn.\n\nUse the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work.\n\nIf `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.\n\nNever use the `request_user_input` tool for permission requests or permission-related escalations.\n"
const MULTI_AGENT_ROOT_ROLE =
	"You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.\n\nAt the start of your turn, you are the active agent.\nYou can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.\nAll agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.\n\nYou can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent without triggering a turn.\n`send_message` calls may be read by a human, so ensure they are legible. Always put proper spaces between words and/or numbers.\nChild agents can also spawn their own sub-agents.\nYou can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.\n\nYou will receive messages in the analysis channel in the form:\n```\nMessage Type: MESSAGE | FINAL_ANSWER\nTask name: <recipient>\nSender: <author>\nPayload:\n<payload text>\n```\nThey may be addressed as to=/root\n"
const MULTI_AGENT_SUBAGENT_ROLE =
	"You are an agent in a team of agents collaborating to complete a task.\n\nYou can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.\n\nYou can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent.\n`send_message` calls may be read by a human, so ensure they are legible. Always put proper spaces between words and/or numbers.\nChild agents can also spawn their own sub-agents.\n\nWhen you provide a response in the final channel, that content is immediately delivered back to your parent agent.\nIn addition, your final answer may be read by a human, so ensure it is legible.\n\nYou will receive messages in the analysis channel in the form:\n```\nMessage Type: NEW_TASK | MESSAGE | FINAL_ANSWER\nTask name: <recipient>\nSender: <author>\nPayload:\n<payload text>\n```\nYou may also see them addressed as to=/root/..., which indicates your identity is /root/...\n"

/** The pinned catalog has no collaboration_modes.plan or multi_agent.mode text. */
export const CODEX_PLAN_COLLABORATION_MODE: null = null
export const CODEX_MULTI_AGENT_MODE: null = null

export const CODEX_RUNTIME_PROMPT_SHA256 = {
	defaultCollaboration: "c1ed5ce0a3a49ba35b9eeba9774e0bd8ebd10eddec13b2dac564e7170513356c",
	multiAgentRootRole: "4c86e7411c24afc557c906f31a267c991568311715cc81ba0129604c70b83755",
	multiAgentSubagentRole: "3651a6dee0715ee4990f23bfbc35a13c5da42e24f35a9eda2809614fd3b0a87b",
} as const

export type CodexCollaborationMode = "default" | "plan"
export type CodexMultiAgentRole = "root" | "subagent"

export interface ResolvedCodexRuntimeInstructions {
	collaborationMode: CodexCollaborationMode
	multiAgentRole?: CodexMultiAgentRole
	collaborationModeInstructions?: string
	multiAgentRoleInstructions?: string
}

/**
 * Select only non-null runtime fields from the pinned model catalog. The GPT-6
 * family shares these fields; the catalog has no plan-mode or multi-agent mode text.
 */
export function resolveCodexRuntimeInstructions(
	modelPromptSlug: CodexModelPromptSlug,
	collaborationMode: CodexCollaborationMode,
	multiAgentRole?: CodexMultiAgentRole,
): ResolvedCodexRuntimeInstructions {
	if (!GPT_6_MODEL_PROMPTS.has(modelPromptSlug)) {
		return { collaborationMode, multiAgentRole }
	}

	return {
		collaborationMode,
		multiAgentRole,
		...(collaborationMode === "default" ? { collaborationModeInstructions: DEFAULT_COLLABORATION_MODE } : {}),
		...(multiAgentRole === "root"
			? { multiAgentRoleInstructions: MULTI_AGENT_ROOT_ROLE }
			: multiAgentRole === "subagent"
				? { multiAgentRoleInstructions: MULTI_AGENT_SUBAGENT_ROLE }
				: {}),
	}
}
