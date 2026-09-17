import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { afterEach, beforeEach, mock, test } from "node:test"

import { captureRunEvidence } from "./capture"
import { prepareEvidenceRun } from "./paths"
import { EVIDENCE_RETENTION_ELIGIBLE, markRunRetentionEligible, pruneRunEvidence } from "./retention"
import type { EvidenceOutcome } from "./types"

let root: string
let artifactsRoot: string
const now = Date.parse("2026-09-06T13:00:00Z")
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retention-test-")))
	artifactsRoot = path.join(root, "evidence")
})
afterEach(async () => {
	mock.restoreAll()
	await fs.rm(root, { recursive: true, force: true })
})

async function run(runId: string, outcome: EvidenceOutcome = "passed") {
	const capture = await captureRunEvidence({
		artifactsRoot,
		runId,
		metadata: {
			scenarioId: "retention",
			hostVersion: "1.122.1",
			provider: "scripted",
			taskIds: [],
			startedAt: new Date(now - 1_000).toISOString(),
			finishedAt: new Date(now).toISOString(),
			outcome,
		},
	})
	// Synthetic terminal receipts exercise the gate; these are not claimed as real host executions.
	await fs.writeFile(
		path.join(capture.artifactDirectory, "run-result.json"),
		JSON.stringify({
			runId,
			status: outcome,
			exitCode: outcome === "passed" ? 0 : 1,
			execution: "extension-host",
			ownershipGate: "verified",
			hostExitObserved: true,
			captureComplete: true,
			launchedHostPid: 101,
			extensionHostPid: 102,
			extensionHostParentPid: 101,
		}),
	)
	return capture
}

test("prunes only released passed runs while protecting current, failed, active and partial evidence", async () => {
	const old = await run("old")
	const current = await run("current")
	await run("failed", "failed")
	await run("active")
	await prepareEvidenceRun({ artifactsRoot, runId: "partial" })
	await markRunRetentionEligible({ artifactsRoot, runId: "old" })
	await markRunRetentionEligible({ artifactsRoot, runId: "current" })
	const result = await pruneRunEvidence({ artifactsRoot, maxRuns: 1, now, keepRunIds: ["current"] })
	assert.deepEqual(result.removedRunIds, ["old"])
	assert.deepEqual(new Set(result.protectedRunIds), new Set(["current", "failed", "active", "partial"]))
	assert.equal(result.retainedRuns, 4)
	assert.equal(result.complete, true)
	assert.equal(result.overBudget, true)
	assert.ok(result.retainedBytes > 0)
	await assert.rejects(fs.stat(old.artifactDirectory), { code: "ENOENT" })
	assert.ok(await fs.stat(current.manifestPath))
})

test("rejects eligibility for unsuccessful, incomplete, unknown-close and test-seam receipts", async () => {
	for (const status of ["failed", "blocked", "cancelled", "timed_out"] as const) {
		const evidence = await run(status, status)
		await assert.rejects(markRunRetentionEligible({ artifactsRoot, runId: status }))
		await assert.rejects(fs.stat(path.join(evidence.artifactDirectory, EVIDENCE_RETENTION_ELIGIBLE)), {
			code: "ENOENT",
		})
	}
	const evidence = await run("unverified")
	const file = path.join(evidence.artifactDirectory, "run-result.json")
	const original = JSON.parse(await fs.readFile(file, "utf8"))
	for (const change of [
		{ hostExitObserved: false },
		{ execution: "test-seam" },
		{ extensionHostPid: undefined },
		{ captureComplete: false },
	]) {
		await fs.writeFile(file, JSON.stringify({ ...original, ...change }))
		await assert.rejects(markRunRetentionEligible({ artifactsRoot, runId: "unverified" }))
	}
	await fs.writeFile(file, JSON.stringify(original))
	const manifest = JSON.parse(await fs.readFile(evidence.manifestPath, "utf8"))
	await fs.writeFile(evidence.manifestPath, JSON.stringify({ ...manifest, captureComplete: false }))
	await assert.rejects(markRunRetentionEligible({ artifactsRoot, runId: "unverified" }))
})

test("eligibility publication is last, idempotent, and cannot replace conflicting receipts", async () => {
	const evidence = await run("release")
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const link = underlying.link
	let published = false
	const write = underlying.writeFile
	mock.method(underlying, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		assert.equal(published, false, "No producer writes after eligibility publication")
		return write(...args)
	})
	mock.method(underlying, "link", async (...args: Parameters<typeof fs.link>) => {
		await link(...args)
		published = true
	})
	await markRunRetentionEligible({ artifactsRoot, runId: "release" })
	await markRunRetentionEligible({ artifactsRoot, runId: "release" })
	assert.equal(published, true)
	mock.restoreAll()
	await fs.writeFile(path.join(evidence.artifactDirectory, EVIDENCE_RETENTION_ELIGIBLE), "invalid")
	await assert.rejects(markRunRetentionEligible({ artifactsRoot, runId: "release" }))
	const result = await pruneRunEvidence({ artifactsRoot, maxBytes: 1, now })
	assert.deepEqual(result.removedRunIds, [])
})

test("includes protected and unmarked bytes, and reports symlink scans as incomplete without touching raw targets", async () => {
	await run("failed", "failed")
	const raw = path.join(root, "raw-profile")
	await fs.mkdir(raw)
	await fs.writeFile(path.join(raw, "auth.db"), "SECRET_CONTENT_RETAINED")
	await fs.writeFile(path.join(artifactsRoot, "private-notes"), "X".repeat(100))
	await fs.symlink(raw, path.join(artifactsRoot, "unknown-link"), process.platform === "win32" ? "junction" : "dir")
	const result = await pruneRunEvidence({ artifactsRoot, maxBytes: 50, now })
	assert.ok(result.retainedBytes >= 100)
	assert.equal(result.complete, false)
	assert.equal(result.overBudget, true)
	assert.deepEqual(result.removedRunIds, [])
	assert.equal(await fs.readFile(path.join(raw, "auth.db"), "utf8"), "SECRET_CONTENT_RETAINED")
})

test("reports a concurrent candidate move without deleting or retrying a replacement", async () => {
	const evidence = await run("race")
	await markRunRetentionEligible({ artifactsRoot, runId: "race" })
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const rename = underlying.rename
	let calls = 0
	const moved = path.join(root, "retained-race")
	mock.method(underlying, "rename", async (source: string, destination: string) => {
		calls++
		await rename(source, moved)
		return rename(source, destination)
	})
	const result = await pruneRunEvidence({ artifactsRoot, maxBytes: 1, now })
	assert.equal(calls, 1)
	assert.equal(result.complete, false)
	assert.ok(result.warnings.includes("concurrent_change"))
	assert.deepEqual(result.removedRunIds, [])
	assert.ok(await fs.stat(path.join(moved, path.basename(evidence.manifestPath))))
})

test("an expired protected run reports an unmet age target even below the size and count targets", async () => {
	await run("protected")
	const result = await pruneRunEvidence({ artifactsRoot, now: now + 8 * 24 * 60 * 60 * 1_000 })
	assert.equal(result.retainedRuns, 1)
	assert.ok(result.retainedBytes < 100 * 1_024 * 1_024)
	assert.equal(result.overBudget, true)
	assert.equal(result.complete, true)
	assert.deepEqual(result.removedRunIds, [])
})

test("a candidate replaced by a junction during rename cannot redirect deletion into a raw profile", async () => {
	const evidence = await run("replacement")
	await markRunRetentionEligible({ artifactsRoot, runId: "replacement" })
	const raw = path.join(root, "raw-profile")
	await fs.mkdir(raw)
	await fs.writeFile(path.join(raw, "manifest.json"), "RAW_SOURCE_KEEP")
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const rename = underlying.rename
	mock.method(underlying, "rename", async (source: string, destination: string) => {
		await rename(source, path.join(root, "original-evidence"))
		await fs.symlink(raw, source, process.platform === "win32" ? "junction" : "dir")
		await rename(source, destination)
	})
	const result = await pruneRunEvidence({ artifactsRoot, maxBytes: 1, now })
	assert.equal(result.complete, false)
	assert.deepEqual(result.removedRunIds, [])
	assert.equal(await fs.readFile(path.join(raw, "manifest.json"), "utf8"), "RAW_SOURCE_KEEP")
	assert.ok(await fs.stat(path.join(root, "original-evidence", path.basename(evidence.manifestPath))))
})
