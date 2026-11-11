import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"

export const DEFAULT_SUITE_TIMEOUT = 120_000

export function setDefaultSuiteTimeout(context: Mocha.Suite) {
	context.timeout(DEFAULT_SUITE_TIMEOUT)
}

/** Check actual prompt bytes from Codex 2889d8e1, not a special summary system instruction. */
export function isDefaultCompactionRequest(messages: readonly unknown[]): boolean {
	const message = messages.at(-1)
	if (
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "user" ||
		!("content" in message) ||
		typeof message.content !== "string"
	)
		return false
	return (
		createHash("sha256").update(message.content, "utf8").digest("hex") ===
		"ab0c334d4faca17e3afbb9b16967c1b2fdcc7242a9a0880af57949fa236d6d07"
	)
}

export type ExactTestHostVersion = "1.125.0" | "1.138.0" | "1.141.0"

/** The compatibility minimum never substitutes for an explicitly requested reference host. */
export function assertRequestedHostVersion(
	actualVersion: string,
	expectedVersion: string | undefined,
): ExactTestHostVersion {
	assert.ok(
		expectedVersion === "1.125.0" || expectedVersion === "1.138.0" || expectedVersion === "1.141.0",
		"This contract requires an explicitly requested exact VS Code 1.125.0, 1.138.0 or 1.141.0 host",
	)
	assert.equal(actualVersion, expectedVersion, "The actual VS Code host must match the requested exact version")
	return expectedVersion
}
