import { EVALS_SETTINGS, GLOBAL_STATE_KEYS, alphaCodeSettingsSchema, globalSettingsSchema } from "../global-settings.js"
import * as publicTypes from "../index.js"

describe("retired settings", () => {
	it.each(["unset", "enabled", "disabled", null, 123, { enabled: true }])(
		"discards retired anonymous reporting preference %j without losing other settings",
		(telemetrySetting) => {
			const preferences = {
				customInstructions: "Keep my instructions",
				soundEnabled: false,
				soundVolume: 0,
				autoSteer: true,
			}
			const saved = { ...preferences, apiProvider: "anthropic", telemetrySetting }
			expect(GLOBAL_STATE_KEYS).not.toContain("telemetrySetting")
			expect(globalSettingsSchema.parse(saved)).toEqual(preferences)
			expect(alphaCodeSettingsSchema.parse(saved)).toEqual({ ...preferences, apiProvider: "anthropic" })
		},
	)

	it.each(["small", "medium", "large", null, 123, { enabled: true }])(
		"discards the retired terminal preview preference %j while retaining shell compatibility settings",
		(terminalOutputPreviewSize) => {
			const retained = {
				soundEnabled: false,
				soundVolume: 0,
				terminalShellIntegrationDisabled: false,
				terminalShellIntegrationTimeout: 23000,
				terminalCommandDelay: 350,
				terminalPowershellCounter: true,
				terminalZshClearEolMark: false,
				terminalZshOhMy: true,
				terminalZshP10k: true,
				terminalZdotdir: true,
			}
			const saved = { ...retained, terminalOutputPreviewSize }
			expect(GLOBAL_STATE_KEYS).not.toContain("terminalOutputPreviewSize")
			expect(EVALS_SETTINGS).not.toHaveProperty("terminalOutputPreviewSize")
			expect(globalSettingsSchema.parse(saved)).toEqual(retained)
			expect(alphaCodeSettingsSchema.parse(saved)).toEqual(retained)
		},
	)

	it("does not include reporting in defaults or public runtime exports", () => {
		expect(EVALS_SETTINGS).not.toHaveProperty("telemetrySetting")
		for (const name of [
			"telemetrySettings",
			"telemetrySettingsSchema",
			"TelemetryEventName",
			"telemetryPropertiesSchema",
			"alphaCodeTelemetryEventSchema",
			"shouldReportApiErrorToTelemetry",
			"ApiProviderError",
			"ConsecutiveMistakeError",
		]) {
			expect(publicTypes).not.toHaveProperty(name)
		}
	})

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
