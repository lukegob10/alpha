import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@alpha-code/types"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	CUSTOM_TOOLS: "customTools",
} as const satisfies Record<string, ExperimentId>

type _AssertExperimentIds = AssertEqual<Equals<ExperimentId, Values<typeof EXPERIMENT_IDS>>>

type ExperimentKey = Keys<typeof EXPERIMENT_IDS>

interface ExperimentConfig {
	enabled: boolean
}

export const experimentConfigsMap: Record<ExperimentKey, ExperimentConfig> = {
	PREVENT_FOCUS_DISRUPTION: { enabled: true },
	CUSTOM_TOOLS: { enabled: false },
}

export const experimentDefault = Object.fromEntries(
	Object.entries(experimentConfigsMap).map(([_, config]) => [
		EXPERIMENT_IDS[_ as keyof typeof EXPERIMENT_IDS] as ExperimentId,
		config.enabled,
	]),
) as Record<ExperimentId, boolean>

export const experiments = {
	get: (id: ExperimentKey): ExperimentConfig | undefined => experimentConfigsMap[id],
	// Background editing is unconditional. Keep the retired flag readable without
	// allowing an old saved false value to reopen automatic editor previews.
	isEnabled: (experimentsConfig: Experiments, id: ExperimentId) =>
		id === EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION || (experimentsConfig[id] ?? experimentDefault[id]),
} as const
