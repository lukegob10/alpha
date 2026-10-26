import {
	maxConcurrentSubagentsSchema,
	reasoningEffortExtendedSchema,
	subagentAgentTypesSchema,
} from "@alpha-code/types"
import type { SettingsCachedState } from "./managed-agent-settings"

export interface ManagedAgentSettingsIssue {
	settingId: string
	translationKey: string
}

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
		typeof values.subagentDefaultModel === "string" && values.subagentDefaultModel.trim().length <= 256,
		"agents-default-model",
		"agents:validation.model",
	)
	add(
		values.subagentDefaultReasoningEffort === undefined ||
			reasoningEffortExtendedSchema.safeParse(values.subagentDefaultReasoningEffort).success,
		"agents-default-reasoning",
		"agents:validation.reasoning",
	)
	add(
		subagentAgentTypesSchema.safeParse(values.subagentAgentTypes ?? {}).success,
		"agents-types",
		"agents:validation.agentTypes",
	)
	return issues
}

/** Also used while the Agents tab is unmounted. */
export function getManagedAgentSettingsError(values: SettingsCachedState): string | undefined {
	return getManagedAgentSettingsIssues(values)[0]?.translationKey
}
export function parseManagedAgentNumericInput(rawValue: string): number {
	return rawValue.trim() === "" ? Number.NaN : Number(rawValue)
}
