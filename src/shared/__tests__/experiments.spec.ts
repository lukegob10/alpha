import { experimentsSchema } from "@alpha-code/types"

import { EXPERIMENT_IDS, experimentDefault, experiments } from "../experiments"

describe("experiments", () => {
	it("accepts saved custom-command flags while discarding their retired authority", () => {
		expect(experimentsSchema.parse({ runSlashCommand: true, customTools: true })).toEqual({ customTools: true })
	})

	it("defaults to background editing while keeping executable custom tools opt-in", () => {
		expect(experimentDefault).toEqual({ preventFocusDisruption: true, customTools: false })
		expect(experiments.get("PREVENT_FOCUS_DISRUPTION")).toEqual({ enabled: true })
		expect(experiments.get("CUSTOM_TOOLS")).toEqual({ enabled: false })
	})

	it.each([
		{ config: {}, expected: false },
		{ config: { customTools: false }, expected: false },
		{ config: { customTools: true }, expected: true },
		{ config: { preventFocusDisruption: false, customTools: true }, expected: true },
		{ config: { preventFocusDisruption: true, customTools: false }, expected: false },
	])("preserves custom-tool enablement for $config", ({ config, expected }) => {
		expect(experiments.isEnabled(experimentsSchema.parse(config), EXPERIMENT_IDS.CUSTOM_TOOLS)).toBe(expected)
	})
})
