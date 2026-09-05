import assert from "node:assert/strict"
import test from "node:test"
import {
	parseContextRunMetadata,
	withFixtureCleanup,
} from "../../apps/vscode-e2e/src/suite/proportional-context-support"

test("cleanup failures never skip task cache eviction or fixture unlink and preserve the primary failure", async () => {
	const primary = new Error("assertion failed")
	const clearFailure = new Error("clear failed")
	const restoreFailure = new Error("restore failed")
	const seen: string[] = []
	await assert.rejects(
		withFixtureCleanup(async () => {
			throw primary
		}, [
			() => {
				seen.push("clear")
				throw clearFailure
			},
			() => {
				seen.push("cache")
			},
			async () => {
				seen.push("restore")
				throw restoreFailure
			},
			async () => {
				seen.push("unlink")
			},
		]),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.equal(error.cause, primary)
			assert.deepEqual(error.errors, [primary, clearFailure, restoreFailure])
			return true
		},
	)
	assert.deepEqual(seen, ["clear", "cache", "restore", "unlink"])
})

test("successful fixture fails when cleanup fails and does not skip later cleanup", async () => {
	let unlinked = false
	await assert.rejects(
		withFixtureCleanup(
			async () => "success",
			[
				async () => {
					throw new Error("restore failed")
				},
				() => {
					unlinked = true
				},
			],
		),
		AggregateError,
	)
	assert.equal(unlinked, true)
	assert.equal(await withFixtureCleanup(async () => 42, []), 42)
})

test("a thrown undefined remains a primary failure", async () => {
	let settled = false
	await withFixtureCleanup(async () => {
		throw undefined
	}, []).then(
		() => assert.fail("must reject"),
		(error) => {
			assert.equal(error, undefined)
			settled = true
		},
	)
	assert.equal(settled, true)
})

test("outer fixture cleanup runs after inner task cleanup fails", async () => {
	const primary = new Error("primary assertion")
	const seen: string[] = []
	await assert.rejects(
		withFixtureCleanup(
			() =>
				withFixtureCleanup(async () => {
					throw primary
				}, [
					() => {
						seen.push("clear")
						throw new Error("clear failed")
					},
					() => {
						seen.push("cache")
					},
				]),
			[
				() => {
					seen.push("restore")
					throw new Error("restore failed")
				},
				() => {
					seen.push("unlink")
				},
			],
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.ok(error.cause instanceof AggregateError)
			assert.equal(error.cause.cause, primary)
			return true
		},
	)
	assert.deepEqual(seen, ["clear", "cache", "restore", "unlink"])
})

const metadata = {
	sourceRevision: "a".repeat(40),
	sourceTreeState: "clean",
	buildSha256: "b".repeat(64),
	configurationId: "default-scripted-context-v1",
	hostAtSuiteStart: "fresh",
}

test("metadata records declared build/config identities and shared-host cache conditions without settings", () => {
	const result = parseContextRunMetadata(JSON.stringify({ ...metadata, settings: { apiKey: "secret" } }))
	assert.equal(result.sourceRevision, metadata.sourceRevision)
	assert.equal(result.buildSha256, metadata.buildSha256)
	assert.equal(result.configurationId, metadata.configurationId)
	assert.equal(result.sourceDiffSha256, null)
	assert.match(result.cacheState.sampling, /one host shared/)
	assert.doesNotMatch(JSON.stringify(result), /settings|apiKey|secret/)
	assert.equal(
		parseContextRunMetadata(
			JSON.stringify({
				...metadata,
				sourceTreeState: "modified",
				sourceDiffSha256: "c".repeat(64),
			}),
		).sourceDiffSha256,
		"c".repeat(64),
	)
})

test("reproducible runs reject missing or invalid provenance", () => {
	assert.throws(() => parseContextRunMetadata(undefined), /ALPHA_SCOPE_RUN_METADATA/)
	for (const [field, value] of Object.entries({
		sourceRevision: "unknown",
		buildSha256: "unknown",
		configurationId: "",
		sourceTreeState: "unknown",
		hostAtSuiteStart: "cold-tasks",
	})) {
		assert.throws(() => parseContextRunMetadata(JSON.stringify({ ...metadata, [field]: value })), /Invalid/)
	}
	assert.throws(
		() => parseContextRunMetadata(JSON.stringify({ ...metadata, sourceTreeState: "modified" })),
		/sourceDiffSha256/,
	)
})
