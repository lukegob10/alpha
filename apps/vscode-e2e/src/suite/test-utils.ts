import { strict as assert } from "node:assert"

export const DEFAULT_SUITE_TIMEOUT = 120_000

export function setDefaultSuiteTimeout(context: Mocha.Suite) {
	context.timeout(DEFAULT_SUITE_TIMEOUT)
}

export type ExactTestHostVersion = "1.125.0" | "1.138.0"

/** The compatibility minimum never substitutes for an explicitly requested reference host. */
export function assertRequestedHostVersion(
	actualVersion: string,
	expectedVersion: string | undefined,
): ExactTestHostVersion {
	assert.ok(
		expectedVersion === "1.125.0" || expectedVersion === "1.138.0",
		"This contract requires an explicitly requested exact VS Code 1.125.0 or 1.138.0 host",
	)
	assert.equal(actualVersion, expectedVersion, "The actual VS Code host must match the requested exact version")
	return expectedVersion
}
