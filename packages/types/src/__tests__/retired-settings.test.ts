import { GLOBAL_STATE_KEYS, alphaCodeSettingsSchema, globalSettingsSchema } from "../global-settings.js"

describe("retired settings", () => {
	it.each([
		{ ttsEnabled: true, ttsSpeed: 1.5 },
		{ ttsEnabled: "invalid", ttsSpeed: null },
	])("ignores legacy speech settings %j while preserving notification sounds", (speechSettings) => {
		const expected = { soundEnabled: true, soundVolume: 0.4, customInstructions: "Keep my instructions" }
		const saved = { ...expected, ...speechSettings }
		expect(GLOBAL_STATE_KEYS).not.toContain("ttsEnabled")
		expect(GLOBAL_STATE_KEYS).not.toContain("ttsSpeed")
		expect(globalSettingsSchema.parse(saved)).toEqual(expected)
		expect(alphaCodeSettingsSchema.parse(saved)).toEqual(expected)
	})

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
