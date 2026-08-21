import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_SUBAGENT_DELEGATION_POLICY,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
	DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
	DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS,
	MAX_MAX_CONCURRENT_SUBAGENTS,
	MAX_SUBAGENT_MAX_DEPTH,
	MAX_SUBAGENT_ROLE_TIMEOUT_MS,
	MAX_SUBAGENT_TOKEN_LIMIT,
	MIN_MAX_CONCURRENT_SUBAGENTS,
	MIN_SUBAGENT_MAX_DEPTH,
	MIN_SUBAGENT_ROLE_TIMEOUT_MS,
	MIN_SUBAGENT_TOKEN_LIMIT,
	subagentRootCostBudgetSchema,
	subagentRootTokenBudgetSchema,
	type SubagentDelegationPolicy,
	type SubagentRole,
} from "@alpha-code/types"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

export type ManagedAgentRole = SubagentRole

/** Stable extension-host settings contract, isolated locally until shared types expose it. */
export interface ManagedAgentSettings {
	maxConcurrentSubagents: number
	subagentDelegationPolicy: SubagentDelegationPolicy
	subagentMaxDepth: number
	subagentRoleTimeoutsMs: Record<ManagedAgentRole, number>
	subagentMaxInputTokens: number
	subagentMaxOutputTokens: number
	subagentRootTokenBudget: number | null
	subagentRootCostBudget: number | null
}

export type SettingsCachedState = ExtensionStateContextType & ManagedAgentSettings

export type SetSettingsCachedStateField = <K extends keyof SettingsCachedState>(
	field: K,
	value: SettingsCachedState[K],
) => void

export const MANAGED_AGENT_SETTING_LIMITS = {
	maxConcurrentSubagents: { min: MIN_MAX_CONCURRENT_SUBAGENTS, max: MAX_MAX_CONCURRENT_SUBAGENTS },
	timeoutMs: { min: MIN_SUBAGENT_ROLE_TIMEOUT_MS, max: MAX_SUBAGENT_ROLE_TIMEOUT_MS },
	inputTokens: { min: MIN_SUBAGENT_TOKEN_LIMIT, max: MAX_SUBAGENT_TOKEN_LIMIT },
	outputTokens: { min: MIN_SUBAGENT_TOKEN_LIMIT, max: MAX_SUBAGENT_TOKEN_LIMIT },
	rootTokens: { min: MIN_SUBAGENT_TOKEN_LIMIT, max: MAX_SUBAGENT_TOKEN_LIMIT },
	maxDepth: { min: MIN_SUBAGENT_MAX_DEPTH, max: MAX_SUBAGENT_MAX_DEPTH },
} as const

export const DEFAULT_MANAGED_AGENT_SETTINGS: ManagedAgentSettings = {
	maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	subagentDelegationPolicy: DEFAULT_SUBAGENT_DELEGATION_POLICY,
	subagentMaxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
	subagentRoleTimeoutsMs: { ...DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS },
	subagentMaxInputTokens: DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
	subagentMaxOutputTokens: DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
	subagentRootTokenBudget: null,
	subagentRootCostBudget: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export function clampManagedAgentNumber(
	value: unknown,
	fallback: number,
	limits: { min: number; max: number },
): number {
	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(parsed)) {
		return fallback
	}

	return Math.min(Math.max(Math.trunc(parsed), limits.min), limits.max)
}

function nullableRootCost(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null
	const parsed = typeof value === "number" ? value : Number(value)
	const result = subagentRootCostBudgetSchema.safeParse(parsed)
	return result.success ? result.data : null
}

function nullableRootTokens(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null
	const parsed = typeof value === "number" ? value : Number(value)
	const result = subagentRootTokenBudgetSchema.safeParse(parsed)
	return result.success ? result.data : null
}

/** Reads runtime-provided fields when available and otherwise applies contract defaults. */
export function withManagedAgentSettingsDefaults(state: ExtensionStateContextType): SettingsCachedState {
	const source = state as ExtensionStateContextType & Partial<ManagedAgentSettings>
	const rawTimeouts: Record<string, unknown> = isRecord(source.subagentRoleTimeoutsMs)
		? source.subagentRoleTimeoutsMs
		: {}

	return {
		...state,
		maxConcurrentSubagents: clampManagedAgentNumber(
			source.maxConcurrentSubagents,
			DEFAULT_MANAGED_AGENT_SETTINGS.maxConcurrentSubagents,
			MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents,
		),
		subagentDelegationPolicy: source.subagentDelegationPolicy === "proactive" ? "proactive" : "explicit-only",
		subagentMaxDepth: clampManagedAgentNumber(
			source.subagentMaxDepth,
			DEFAULT_MANAGED_AGENT_SETTINGS.subagentMaxDepth,
			MANAGED_AGENT_SETTING_LIMITS.maxDepth,
		),
		subagentRoleTimeoutsMs: {
			explore: clampManagedAgentNumber(
				rawTimeouts.explore,
				DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.explore,
				MANAGED_AGENT_SETTING_LIMITS.timeoutMs,
			),
			review: clampManagedAgentNumber(
				rawTimeouts.review,
				DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.review,
				MANAGED_AGENT_SETTING_LIMITS.timeoutMs,
			),
			worker: clampManagedAgentNumber(
				rawTimeouts.worker,
				DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.worker,
				MANAGED_AGENT_SETTING_LIMITS.timeoutMs,
			),
		},
		subagentMaxInputTokens: clampManagedAgentNumber(
			source.subagentMaxInputTokens,
			DEFAULT_MANAGED_AGENT_SETTINGS.subagentMaxInputTokens,
			MANAGED_AGENT_SETTING_LIMITS.inputTokens,
		),
		subagentMaxOutputTokens: clampManagedAgentNumber(
			source.subagentMaxOutputTokens,
			DEFAULT_MANAGED_AGENT_SETTINGS.subagentMaxOutputTokens,
			MANAGED_AGENT_SETTING_LIMITS.outputTokens,
		),
		subagentRootTokenBudget: nullableRootTokens(source.subagentRootTokenBudget),
		subagentRootCostBudget: nullableRootCost(source.subagentRootCostBudget),
	}
}

export function toManagedAgentSettingsSavePayload(state: SettingsCachedState): ManagedAgentSettings {
	const normalized = withManagedAgentSettingsDefaults(state)

	return {
		maxConcurrentSubagents: normalized.maxConcurrentSubagents,
		subagentDelegationPolicy: normalized.subagentDelegationPolicy,
		subagentMaxDepth: normalized.subagentMaxDepth,
		subagentRoleTimeoutsMs: normalized.subagentRoleTimeoutsMs,
		subagentMaxInputTokens: normalized.subagentMaxInputTokens,
		subagentMaxOutputTokens: normalized.subagentMaxOutputTokens,
		subagentRootTokenBudget: normalized.subagentRootTokenBudget,
		subagentRootCostBudget: normalized.subagentRootCostBudget,
	}
}
