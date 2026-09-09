export const RELIABILITY_SCENARIO_IDS = [
	"completion-admission",
	"completion-idle",
	"stream-cancel-recovery",
	"provider-error-recovery",
	"provider-empty-recovery",
	"task-cycle-soak",
	"context-compaction",
	"background-isolation",
] as const

export type ReliabilityScenarioId = (typeof RELIABILITY_SCENARIO_IDS)[number]

export const RELIABILITY_ACCEPTANCE_SCENARIO_IDS = [
	...RELIABILITY_SCENARIO_IDS,
	"cancel-resume",
	"long-thread",
	"reload-continuation",
] as const

export function isReliabilityScenario(value: string): value is ReliabilityScenarioId {
	return RELIABILITY_SCENARIO_IDS.some((id) => id === value)
}
