import { experimentsSchema, type Experiments } from "@alpha-code/types"

import { EXPERIMENT_IDS, experiments } from "../experiments"

describe("background editing legacy settings compatibility", () => {
	it.each<Experiments>([{}, { preventFocusDisruption: false }, { preventFocusDisruption: true }])(
		"always enables background editing for saved configuration %j without rewriting it",
		(legacyConfig) => {
			const parsed = Object.freeze(experimentsSchema.parse(legacyConfig))

			expect(experiments.isEnabled(parsed, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)
			expect(parsed).toEqual(legacyConfig)
		},
	)
})
