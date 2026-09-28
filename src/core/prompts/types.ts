import type { ApprovalMode } from "@alpha-code/types"

/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .alpha/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
	/** Effective approval mode captured for this model step. */
	approvalMode?: ApprovalMode
	/** Shell selected by exec_command for this model step. */
	commandShell?: string
	/** Whether the captured primary tool surface exposes spawn_agent to this prompt. */
	codexRootDelegationAvailable?: boolean
	/** Narrow child authority used to omit capabilities the child cannot call. */
	subagentRole?: "explore" | "review" | "worker"
	/** Whether the managed child received a frozen, mode-filtered skill catalog. */
	subagentHasInheritedSkills?: boolean
	/** Whether this managed child uses a frozen parent context package. */
	subagentUsesFrozenContext?: boolean
	/** Exact frozen parent instruction body, loaded from private task storage and never from current live settings. */
	subagentFrozenInstructions?: string
	/** Whether the child's frozen manifest grants bounded managed-descendant delegation. */
	subagentCanDelegate?: boolean
	/** Frozen effective policy governing any managed-descendant launch. */
	subagentDelegationPolicy?: "explicit-only" | "proactive"
}
