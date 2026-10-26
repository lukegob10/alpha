import assert from "node:assert/strict"
import { test } from "node:test"

import { observeHostCaptureClosure, type CaptureProcessSnapshot } from "./hostCaptureClosure"

const input = {
	hostExitObserved: true,
	launchedHostPid: 100,
	extensionHostPid: 200,
	extensionHostParentPid: 150,
	userDataDir: "C:\\Owned Profile\\user-data",
	platform: "win32" as const,
}

const unrelated: CaptureProcessSnapshot[] = [
	{ pid: 4, ppid: 0, commandLine: null },
	{ pid: 500, ppid: 1, commandLine: "unrelated.exe --credential NEVER_RETAIN_RAW_COMMAND" },
]

test("a closed owned family with no exact profile match yields a scoped positive observation", async () => {
	const receipt = await observeHostCaptureClosure(input, async () => unrelated)
	assert.equal(receipt.cleanupVerified, true)
	assert.equal(receipt.scope, "observed-owned-host-process-family")
	assert.equal(receipt.source, "process-snapshot")
	assert.deepEqual(receipt.ownedPids, [100, 200, 150])
	assert.deepEqual(receipt.matchingProcessIds, [])
	assert.equal(receipt.unavailableCommandLines, 1)
	assert.equal(JSON.stringify(receipt).includes("NEVER_RETAIN_RAW_COMMAND"), false)
})

test("remaining recorded root, extension host, parent or descendants reject raw capture even without command visibility", async () => {
	for (const pid of [100, 200, 150]) {
		const receipt = await observeHostCaptureClosure(input, async () => [
			...unrelated,
			{ pid, ppid: 1, commandLine: null },
		])
		assert.equal(receipt.cleanupVerified, false)
		assert.equal(receipt.failure, "owned-process-remains")
		assert.deepEqual(receipt.matchingProcessIds, [pid])
	}
	const descendants = await observeHostCaptureClosure(input, async () => [
		...unrelated,
		{ pid: 400, ppid: 300, commandLine: "worker.exe" },
		{ pid: 300, ppid: 100, commandLine: null },
	])
	assert.equal(descendants.cleanupVerified, false)
	assert.deepEqual(descendants.matchingProcessIds, [300, 400])
})

test("exact owned profile arguments match Windows quoting, separate tokens, case and separator variants", async () => {
	for (const argument of [
		'"--user-data-dir=C:\\Owned Profile\\user-data"',
		'--user-data-dir="C:\\Owned Profile\\user-data"',
		'--user-data-dir "C:\\Owned Profile\\user-data"',
		'--USER-DATA-DIR="c:/owned profile/user-data/"',
	]) {
		const receipt = await observeHostCaptureClosure(input, async () => [
			...unrelated,
			{ pid: 700, ppid: 1, commandLine: `Code.exe ${argument}` },
		])
		assert.equal(receipt.cleanupVerified, false, argument)
		assert.deepEqual(receipt.matchingProcessIds, [700])
	}
	const other = await observeHostCaptureClosure(input, async () => [
		...unrelated,
		{ pid: 700, ppid: 1, commandLine: 'Code.exe --user-data-dir="C:\\Owned Profile\\user-data-sibling"' },
	])
	assert.equal(other.cleanupVerified, true)
	const unicode = await observeHostCaptureClosure(
		{ ...input, userDataDir: "C:\\Owned É\\配置\\user-data" },
		async () => [{ pid: 700, ppid: 1, commandLine: 'Code.exe --user-data-dir="c:/owned é/配置/user-data"' }],
	)
	assert.equal(unicode.cleanupVerified, false)
	assert.deepEqual(unicode.matchingProcessIds, [700])
})

test("missing identities, unknown probes and malformed or truncated snapshots cannot establish closure", async () => {
	const broken: CaptureProcessSnapshot[][] = [
		[],
		[...unrelated, unrelated[0]!],
		[{ pid: 500, ppid: NaN, commandLine: "other.exe" }],
		[{ pid: 500, ppid: 1, commandLine: 'Code.exe --user-data-dir="unterminated' }],
		[{ pid: 500, ppid: 1, commandLine: "x".repeat(65_537) }],
	]
	for (const snapshot of broken) {
		const receipt = await observeHostCaptureClosure(input, async () => snapshot)
		assert.equal(receipt.cleanupVerified, false)
		assert.equal(receipt.failure, "process-proof-unavailable")
	}
	const rejected = await observeHostCaptureClosure(input, async () => {
		throw new Error("CIM access denied with sensitive details")
	})
	assert.equal(rejected.failure, "process-proof-unavailable")
	assert.equal(JSON.stringify(rejected).includes("sensitive"), false)
	let probes = 0
	const missing = await observeHostCaptureClosure({ ...input, extensionHostPid: undefined }, async () => {
		probes++
		return unrelated
	})
	assert.equal(missing.cleanupVerified, false)
	assert.equal(probes, 0)
})

test("numeric close never upgrades failed cleanup, while an existing verified owned-tree proof is reusable", async () => {
	for (const [change, expected, failure] of [
		[{ hostExitObserved: false }, false, "host-not-closed"],
		[{ previousCleanupVerified: false }, false, "prior-cleanup-unverified"],
		[{ previousCleanupVerified: true }, true, undefined],
	] as const) {
		let probes = 0
		const receipt = await observeHostCaptureClosure({ ...input, ...change }, async () => {
			probes++
			return unrelated
		})
		assert.equal(receipt.cleanupVerified, expected)
		assert.equal(receipt.failure, failure)
		assert.equal(probes, 0)
	}
})

test("POSIX process groups catch an orphan in the owned group after parent IDs have disappeared", async () => {
	const receipt = await observeHostCaptureClosure(
		{ ...input, platform: "linux", userDataDir: "/owned/profile/user-data" },
		async () => [{ pid: 900, ppid: 1, processGroupId: 100, commandLine: "worker" }],
	)
	assert.equal(receipt.cleanupVerified, false)
	assert.deepEqual(receipt.matchingProcessIds, [900])
})
