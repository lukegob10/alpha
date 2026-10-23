import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	MAX_MAX_CONCURRENT_SUBAGENTS,
	MIN_MAX_CONCURRENT_SUBAGENTS,
	reasoningEffortExtendedSchema,
	type ReasoningEffortExtended,
} from "@alpha-code/types"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

export interface ManagedAgentSettings {
	subagentsEnabled: boolean
	maxConcurrentSubagents: number
	subagentDefaultModel: string
	subagentDefaultReasoningEffort?: ReasoningEffortExtended
	subagentInterruptMessage: boolean
}

export type SettingsCachedState = ExtensionStateContextType &
	ManagedAgentSettings & {
		/** Buffered until Settings Save. */
		terminalInheritEnv?: boolean
	}
export type SetSettingsCachedStateField = <K extends keyof SettingsCachedState>(
	field: K,
	value: SettingsCachedState[K],
) => void

export const MANAGED_AGENT_SETTING_LIMITS = {
	maxConcurrentSubagents: { min: MIN_MAX_CONCURRENT_SUBAGENTS, max: MAX_MAX_CONCURRENT_SUBAGENTS },
} as const

export const DEFAULT_MANAGED_AGENT_SETTINGS: ManagedAgentSettings = {
	subagentsEnabled: true,
	maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	subagentDefaultModel: "",
	subagentDefaultReasoningEffort: undefined,
	subagentInterruptMessage: true,
}

export function clampManagedAgentNumber(
	value: unknown,
	fallback: number,
	limits: { min: number; max: number },
): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), limits.min), limits.max) : fallback
}

/** Initialize the edit buffer without reviving retired agent settings. */
export function withManagedAgentSettingsDefaults(state: ExtensionStateContextType): SettingsCachedState {
	const effort = reasoningEffortExtendedSchema.safeParse(state.subagentDefaultReasoningEffort)
	return {
		...state,
		subagentsEnabled: state.subagentsEnabled ?? true,
		maxConcurrentSubagents: clampManagedAgentNumber(
			state.maxConcurrentSubagents,
			DEFAULT_MAX_CONCURRENT_SUBAGENTS,
			MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents,
		),
		subagentDefaultModel: state.subagentDefaultModel ?? "",
		subagentDefaultReasoningEffort: effort.success ? effort.data : undefined,
		subagentInterruptMessage: state.subagentInterruptMessage ?? true,
	}
}

export function toManagedAgentSettingsSavePayload(state: SettingsCachedState) {
	return {
		subagentsEnabled: state.subagentsEnabled,
		maxConcurrentSubagents: state.maxConcurrentSubagents,
		subagentDefaultModel: state.subagentDefaultModel.trim(),
		// An explicit empty value survives JSON serialization so Save can clear inheritance overrides.
		subagentDefaultReasoningEffort: state.subagentDefaultReasoningEffort ?? null,
		subagentInterruptMessage: state.subagentInterruptMessage,
	}
}
