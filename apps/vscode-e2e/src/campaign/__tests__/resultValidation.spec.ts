import { strict as assert } from "node:assert"
import { test } from "node:test"
import { validateScenarioResult } from "../resultValidation"
import { compareLiveProviderIdentity } from "../../liveProviderIdentity"

const result = () => ({ status: "passed", usage: { requests: 1, inputTokens: 11, outputTokens: 7, cost: null } })

test("a terminal success cannot also claim an assertion, policy or provider failure", () => {
	for (const failureClass of ["assertion", "unsafe_repair", "provider"] as const)
		assert.throws(() =>
			validateScenarioResult({ ...result(), failure: { class: failureClass, fingerprint: "failed" } }),
		)
	assert.throws(() => validateScenarioResult({ ...result(), retentionFailed: true }))
})

test("performance preserves observed fields, unknowns and zero without inventing missing phases", () => {
	const projected = validateScenarioResult({
		...result(),
		performance: {
			firstResponseMs: 0,
			providerMs: 12.5,
			providerRetries: 0,
			inputTokens: 11,
			outputTokens: 7,
			reasoningTokens: 3,
			cacheReadTokens: null,
			privatePayload: "must not persist",
		},
	})
	assert.equal(projected.performance?.toolsMs, undefined)
	assert.deepEqual(projected.performance, {
		firstResponseMs: 0,
		providerMs: 12.5,
		providerRetries: 0,
		inputTokens: 11,
		outputTokens: 7,
		reasoningTokens: 3,
		cacheReadTokens: null,
	})
	assert.equal(projected.usage.outputTokens, 7, "reasoning must not be added to the provider's output total")
	assert.equal(validateScenarioResult(result()).performance, undefined)
	for (const performance of [
		[],
		{ providerMs: -1 },
		{ providerMs: Infinity },
		{ providerRetries: 0.5 },
		{ reasoningTokens: 0.5 },
		{ inputTokens: 12 },
		{ outputTokens: 8 },
	])
		assert.throws(() => validateScenarioResult({ ...result(), performance }))
})

test("provider identity is a bounded copied observation and unknown legacy identity stays absent", () => {
	const snapshot = { id: "github.copilot-chat" as const, version: "1.0.0", entrypointSha256: "a".repeat(64) }
	const providerIdentity = compareLiveProviderIdentity(snapshot, snapshot)
	const projected = validateScenarioResult({ ...result(), providerIdentity })
	assert.deepEqual(projected.providerIdentity, providerIdentity)
	snapshot.version = "2.0.0"
	assert.equal(projected.providerIdentity?.before.version, "1.0.0")
	assert.equal(validateScenarioResult(result()).providerIdentity, undefined)
	assert.throws(() =>
		validateScenarioResult({ ...result(), providerIdentity: { ...providerIdentity, secret: "raw" } }),
	)
})
