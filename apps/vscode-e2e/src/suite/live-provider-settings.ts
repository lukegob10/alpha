import { strict as assert } from "node:assert"
import { providerSettingsSchema, type AlphaCodeSettings, type TaskReasoningProjection } from "@alpha-code/types"

interface FixtureSettingsHost {
	getValues(): AlphaCodeSettings
	setValues(values: AlphaCodeSettings): Promise<void>
}

/** Keep credentials in the existing host snapshot; never save a redacted public view over its provider profile. */
export function captureLiveFixtureSettings(host: FixtureSettingsHost, overrides: AlphaCodeSettings) {
	const original = host.getValues()
	const restoreValues = Object.fromEntries(
		Object.keys(overrides).map((key) => [key, original[key as keyof AlphaCodeSettings]]),
	) as AlphaCodeSettings
	return {
		configuration: { ...providerSettingsSchema.parse(original), ...overrides },
		restore: () => host.setValues(restoreValues),
	}
}

/** Alpha's resolved task state is the shared boundary; provider-specific wire options may differ. */
export function assertLiveTaskEffort(state: TaskReasoningProjection, expected: string | undefined): string {
	const effective = (state.current ?? state).effective
	const actual =
		effective.kind === "effort" ? effective.effort : effective.kind === "custom" ? effective.value : effective.kind
	assert.ok(expected, "A declared task reasoning effort is required")
	assert.equal(
		actual,
		expected === "disable" ? "off" : expected,
		"Canonical task reasoning effort does not match the declared capture",
	)
	return expected
}
