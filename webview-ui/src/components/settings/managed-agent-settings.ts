import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

export type SubagentDelegationPolicy = "explicit-only" | "proactive"
export type ManagedAgentRole = "explore" | "review" | "worker"

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
	maxConcurrentSubagents: { min: 1, max: 16 },
	timeoutMs: { min: 10_000, max: 3_600_000 },
	inputTokens: { min: 1, max: 10_000_000 },
	outputTokens: { min: 1, max: 10_000_000 },
	rootTokens: { min: 1, max: 50_000_000 },
	rootCost: { min: 0.01, max: 100_000 },
	maxDepth: { min: 1, max: 5 },
} as const

export const DEFAULT_MANAGED_AGENT_SETTINGS: ManagedAgentSettings = {
	maxConcurrentSubagents: 2,
	subagentDelegationPolicy: "explicit-only",
	subagentMaxDepth: 1,
	subagentRoleTimeoutsMs: {
		explore: 120_000,
		review: 120_000,
		worker: 900_000,
	},
	subagentMaxInputTokens: 16_000,
	subagentMaxOutputTokens: 4_000,
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

function nullablePositiveNumber(value: unknown, limits: { min: number; max: number }, integer: boolean): number | null {
	if (value === undefined || value === null || value === "") {
		return null
	}

	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(parsed)) {
		return null
	}

	const bounded = Math.min(Math.max(parsed, limits.min), limits.max)
	return integer ? Math.trunc(bounded) : bounded
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
		subagentRootTokenBudget: nullablePositiveNumber(
			source.subagentRootTokenBudget,
			MANAGED_AGENT_SETTING_LIMITS.rootTokens,
			true,
		),
		subagentRootCostBudget: nullablePositiveNumber(
			source.subagentRootCostBudget,
			MANAGED_AGENT_SETTING_LIMITS.rootCost,
			false,
		),
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
