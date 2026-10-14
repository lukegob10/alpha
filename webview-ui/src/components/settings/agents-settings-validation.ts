import {
	maxConcurrentSubagentsSchema,
	subagentAgentTypesSchema,
	subagentDelegationPolicySchema,
	subagentMaxDepthSchema,
	subagentRoleTimeoutMsSchema,
	subagentRootCostBudgetSchema,
	subagentRootTokenBudgetSchema,
	subagentTokenLimitSchema,
} from "@alpha-code/types"

import type { SettingsCachedState } from "./managed-agent-settings"

export const MANAGED_AGENT_ROLES = ["explore", "review", "worker"] as const

export interface ManagedAgentSettingsIssue {
	settingId: string
	translationKey: string
}

/** Validate the edit buffer without clamping user input or rewriting saved profile references. */
export function getManagedAgentSettingsIssues(values: SettingsCachedState): ManagedAgentSettingsIssue[] {
	const issues: ManagedAgentSettingsIssue[] = []
	const add = (valid: boolean, settingId: string, translationKey: string) => {
		if (!valid) issues.push({ settingId, translationKey })
	}

	add(
		maxConcurrentSubagentsSchema.safeParse(values.maxConcurrentSubagents).success,
		"agents-concurrency",
		"agents:validation.concurrency",
	)
	add(
		subagentDelegationPolicySchema.safeParse(values.subagentDelegationPolicy).success,
		"agents-delegation-policy",
		"agents:validation.delegationPolicy",
	)
	add(subagentMaxDepthSchema.safeParse(values.subagentMaxDepth).success, "agents-depth", "agents:validation.depth")
	for (const role of MANAGED_AGENT_ROLES) {
		add(
			subagentRoleTimeoutMsSchema.safeParse(values.subagentRoleTimeoutsMs?.[role]).success,
			`agents-timeout-${role}`,
			"agents:validation.timeout",
		)
	}
	add(
		subagentTokenLimitSchema.safeParse(values.subagentMaxInputTokens).success,
		"agents-input-tokens",
		"agents:validation.childTokens",
	)
	add(
		subagentTokenLimitSchema.safeParse(values.subagentMaxOutputTokens).success,
		"agents-output-tokens",
		"agents:validation.childTokens",
	)
	add(
		subagentRootTokenBudgetSchema.safeParse(values.subagentRootTokenBudget).success,
		"agents-root-tokens",
		"agents:validation.rootTokens",
	)
	add(
		subagentRootCostBudgetSchema.safeParse(values.subagentRootCostBudget).success,
		"agents-root-cost",
		"agents:validation.rootCost",
	)
	add(
		subagentAgentTypesSchema.safeParse(values.subagentAgentTypes ?? {}).success,
		"agents-types",
		"agents:validation.agentTypes",
	)

	return issues
}

/** SettingsView uses the same validation while the Agents tab is unmounted. */
export function getManagedAgentSettingsError(values: SettingsCachedState): string | undefined {
	return getManagedAgentSettingsIssues(values)[0]?.translationKey
}

export function parseManagedAgentNumericInput(rawValue: string): number {
	return rawValue.trim() === "" ? Number.NaN : Number(rawValue)
}

/** A browser reports an unfinished number as an empty value with badInput set. */
export function parseOptionalManagedAgentNumericInput(rawValue: string, badInput: boolean): number | null {
	return rawValue.trim() === "" && !badInput ? null : parseManagedAgentNumericInput(rawValue)
}

/** Seconds are a display unit; preserve the contract's integer millisecond precision. */
export function parseManagedAgentTimeoutSeconds(rawValue: string): number {
	const seconds = parseManagedAgentNumericInput(rawValue)
	const milliseconds = seconds * 1_000
	const rounded = Math.round(milliseconds)
	return Math.abs(milliseconds - rounded) < 0.000001 ? rounded : milliseconds
}
