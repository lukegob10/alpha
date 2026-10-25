import { GLOBAL_STATE_KEYS, alphaCodeSettingsSchema, globalSettingsSchema } from "../global-settings.js"

describe("retired settings", () => {
	it.each(["default", "friendly", "pragmatic", "none"])(
		"ignores the legacy personality value %s when reading older settings",
		(personality) => {
			expect(GLOBAL_STATE_KEYS).not.toContain("personality")
			const saved = { personality, customInstructions: "Keep my instructions", autoSteer: true }
			const expected = { customInstructions: "Keep my instructions", autoSteer: true }
			expect(globalSettingsSchema.parse(saved)).toEqual(expected)
			expect(alphaCodeSettingsSchema.parse(saved)).toEqual(expected)
		},
	)
})
