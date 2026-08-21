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
	/** Narrow child authority used to omit capabilities the child cannot call. */
	subagentRole?: "explore" | "review" | "worker"
	/** Whether the managed child received a frozen, mode-filtered skill catalog. */
	subagentHasInheritedSkills?: boolean
	/** New managed children persist their mutable instruction snapshot in the initial prompt. */
	subagentUsesFrozenContext?: boolean
	/** Whether the child's frozen manifest grants bounded managed-descendant delegation. */
	subagentCanDelegate?: boolean
	/** Frozen effective policy governing any managed-descendant launch. */
	subagentDelegationPolicy?: "explicit-only" | "proactive"
}
