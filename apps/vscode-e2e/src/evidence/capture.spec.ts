import * as assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"

import { captureRepositoryEvidence, captureRunEvidence } from "./capture"
import { classifyFailure } from "./classification"
import { EVIDENCE_RUN_MARKER, isWithin, prepareEvidenceRun, readBounded } from "./paths"
import { pruneRunEvidence } from "./retention"
import type { CaptureRunEvidenceOptions, EvidenceManifest, RunEvidenceMetadata } from "./types"

let root: string
const metadata = (): RunEvidenceMetadata => ({
	scenarioId: "review-edit-test-commit-followup",
	hostVersion: "1.122.1",
	provider: "live-copilot",
	modelId: "gpt-5.6-luna",
	reasoningEffort: "max",
	taskIds: ["task-1"],
	startedAt: "2026-09-06T13:00:00.000Z",
	finishedAt: "2026-09-06T13:00:01.000Z",
	outcome: "failed",
})
const options = (): CaptureRunEvidenceOptions => ({
	artifactsRoot: path.join(root, "artifacts"),
	runId: "run-1",
	metadata: metadata(),
})

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-evidence-test-")))
})
afterEach(async () => {
	mock.restoreAll()
	await fs.rm(root, { recursive: true, force: true })
})

async function ownedSource(name: string): Promise<string> {
	const directory = path.join(root, name)
	await fs.mkdir(directory)
	await fs.writeFile(path.join(directory, ".fixture-owned"), "test-owned")
	return directory
}

async function assertFixtureOwned(candidate: string): Promise<void> {
	assert.ok(isWithin(root, candidate))
	assert.equal(await fs.readFile(path.join(candidate, ".fixture-owned"), "utf8"), "test-owned")
}

async function manifestOf(manifestPath: string): Promise<EvidenceManifest> {
	return JSON.parse(await fs.readFile(manifestPath, "utf8")) as EvidenceManifest
}

test("captures bounded long task sources beyond the repository file budget without exporting payloads", async () => {
	const storage = await ownedSource("storage")
	const task = path.join(storage, "tasks", "task-1")
	await fs.mkdir(task, { recursive: true })
	const secret = "private-long-task-payload"
	const journal =
		Array.from({ length: 700 }, (_, sequence) =>
			JSON.stringify({
				type: "phase_changed",
				sequence,
				payload: { status: "running", text: secret.repeat(30) },
			}),
		).join("\n") +
		"\n" +
		JSON.stringify({ type: "turn_terminal", payload: { status: "completed" } })
	assert.ok(Buffer.byteLength(journal) > 256 * 1_024)
	for (const name of ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl"]) {
		await fs.writeFile(path.join(task, name), journal)
	}
	const conversation = JSON.stringify([
		{ role: "assistant", content: [{ type: "tool_use", id: "late-call", input: secret.repeat(20_000) }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "late-call", content: secret.repeat(20_000) }] },
	])
	await fs.writeFile(path.join(task, "api_conversation_history.json"), conversation)
	await fs.writeFile(
		path.join(storage, "agent_control.json"),
		JSON.stringify({ agents: [], private: secret.repeat(20_000) }),
	)
	const result = await captureRunEvidence({
		...options(),
		storagePath: storage,
		assertSourceOwned: assertFixtureOwned,
	})
	assert.equal(result.captureComplete, true)
	const manifest = await manifestOf(result.manifestPath)
	assert.deepEqual(
		manifest.taskEvidence.map((entry) => entry.status),
		["captured", "captured", "captured"],
	)
	const projected = JSON.parse(
		await fs.readFile(
			path.join(result.artifactDirectory, "task-1-agent_lifecycle_events.jsonl.projection.json"),
			"utf8",
		),
	)
	assert.equal(projected.sourceBytes, Buffer.byteLength(journal))
	assert.equal(projected.sourceSha256, createHash("sha256").update(journal).digest("hex"))
	assert.equal(projected.projection.events.length, 701)
	assert.deepEqual(projected.projection.events.at(-1), { type: "turn_terminal", status: "completed" })
	const history = JSON.parse(
		await fs.readFile(
			path.join(result.artifactDirectory, "task-1-api_conversation_history.json.projection.json"),
			"utf8",
		),
	)
	assert.equal(history.projection[0].tools[0].idSha256, history.projection[1].tools[0].idSha256)
	for (const artifact of manifest.artifacts) {
		assert.ok(!(await fs.readFile(path.join(result.artifactDirectory, artifact.path), "utf8")).includes(secret))
	}
	assert.equal(await fs.readFile(path.join(task, "api_conversation_history.json"), "utf8"), conversation)
})

test("classifies known failures without publishing arbitrary exception or code text", () => {
	assert.deepEqual(classifyFailure("failed", { phase: "host", code: "ELOCKOWNER" }), {
		category: "persistence",
		code: "ELOCKOWNER",
	})
	assert.deepEqual(classifyFailure("blocked", { phase: "provider", code: "AUTH_REQUIRED" }), {
		category: "provider",
		code: "AUTH_REQUIRED",
	})
	assert.deepEqual(classifyFailure("failed", { phase: "assertion", code: "private bearer secret" }), {
		category: "assertion",
		code: "UNKNOWN",
	})
	assert.deepEqual(classifyFailure("passed", { phase: "tool", code: "TOOL_ERROR" }), { category: "none", code: "OK" })
})

test("reports closed journal budget and parse warnings and never marks rejected sources captured", async () => {
	const storage = await ownedSource("storage")
	const task = path.join(storage, "tasks", "task-1")
	await fs.mkdir(task, { recursive: true })
	const cases = [
		{ content: "{}\n{}", limits: { maxTaskSourceBytes: 4 }, warning: "TASK_SOURCE_LIMIT" },
		{ content: '{"type":"turn_terminal"}', limits: { maxJournalLineBytes: 4 }, warning: "JOURNAL_LINE_LIMIT" },
		{ content: "{}\n{}", limits: { maxJournalEvents: 1 }, warning: "JOURNAL_EVENT_LIMIT" },
		{ content: "{}\nprivate-invalid-record", limits: {}, warning: "JOURNAL_MALFORMED" },
	]
	for (const [index, fixture] of cases.entries()) {
		for (const name of ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl"]) {
			await fs.writeFile(path.join(task, name), fixture.content)
		}
		const result = await captureRunEvidence({
			...options(),
			runId: `limit-${index}`,
			storagePath: storage,
			assertSourceOwned: assertFixtureOwned,
			limits: fixture.limits,
		})
		const manifest = await manifestOf(result.manifestPath)
		assert.equal(result.captureComplete, false)
		assert.ok(manifest.warnings.includes(fixture.warning))
		assert.ok(manifest.warnings.includes("TASK_EVIDENCE_INCOMPLETE"))
		assert.deepEqual(
			manifest.taskEvidence.slice(0, 2).map((entry) => entry.status),
			["incomplete", "incomplete"],
		)
		assert.equal(await fs.readFile(path.join(task, "agent_lifecycle_events.jsonl"), "utf8"), fixture.content)
		assert.ok(!JSON.stringify(manifest).includes("private-invalid-record"))
	}
	await assert.rejects(
		captureRunEvidence({ ...options(), limits: { maxTaskSourceBytes: 64 * 1_024 * 1_024 + 1 } }),
		/Invalid evidence limit/,
	)
	await assert.rejects(
		captureRunEvidence({ ...options(), limits: { maxJournalLineBytes: 4 * 1_024 * 1_024 + 1 } }),
		/Invalid evidence limit/,
	)
})

test("captures empty lock, lifecycle and paired receipt facts but no prompts, outputs or secret settings", async () => {
	const storage = await ownedSource("storage")
	const task = path.join(storage, "tasks", "task-1")
	await fs.mkdir(task, { recursive: true })
	await fs.mkdir(path.join(storage, "agent_control.json.transaction.lock"))
	await fs.writeFile(path.join(storage, "agent_control.json.transaction.lock", "owner.json"), "")
	const secret = "credentials-and-private-prompt-never-publish"
	await fs.writeFile(
		path.join(task, "agent_lifecycle_events.jsonl"),
		JSON.stringify({
			type: "turn_terminal",
			sequence: 3,
			occurredAt: 123,
			payload: { status: "failed", code: "ELOCKOWNER", error: secret },
		}) + "\n",
	)
	await fs.writeFile(
		path.join(task, "agent_turn_events.jsonl"),
		JSON.stringify({
			type: "tool_result",
			callId: "a-call",
			status: "error",
			output: secret,
		}) + "\n",
	)
	await fs.writeFile(
		path.join(task, "api_conversation_history.json"),
		JSON.stringify([
			{ role: "assistant", content: [{ type: "tool_use", id: "a-call", input: { secret } }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a-call", is_error: true, content: secret }],
			},
		]),
	)
	const bundle = path.join(root, "extension.js")
	await fs.writeFile(bundle, "extension bundle")
	const config = { ...metadata(), apiKey: secret }
	const result = await captureRunEvidence({
		...options(),
		metadata: config,
		storagePath: storage,
		bundlePath: bundle,
		assertSourceOwned: assertFixtureOwned,
		failure: { phase: "persistence", code: "ELOCKOWNER" },
	})
	const manifest = await manifestOf(result.manifestPath)
	assert.equal(result.captureComplete, true)
	assert.match(manifest.bundleSha256!, /^[a-f0-9]{64}$/)
	assert.deepEqual(
		manifest.taskEvidence.map((entry) => entry.status),
		["captured", "captured", "captured"],
	)
	const files = await fs.readdir(result.artifactDirectory)
	const captured = (
		await Promise.all(files.map((file) => fs.readFile(path.join(result.artifactDirectory, file), "utf8")))
	).join("\n")
	assert.ok(!captured.includes(secret))
	assert.ok(!captured.includes("a-call"))
	assert.ok(captured.includes("empty-owner"))
	assert.ok(captured.includes('"isError": true'))
	assert.equal(
		await fs.readFile(path.join(task, "api_conversation_history.json"), "utf8"),
		JSON.stringify([
			{ role: "assistant", content: [{ type: "tool_use", id: "a-call", input: { secret } }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a-call", is_error: true, content: secret }],
			},
		]),
	)
})

test("requires caller source ownership before reading even an absolute regular directory", async () => {
	const workspace = await ownedSource("workspace")
	await assert.rejects(captureRunEvidence({ ...options(), workspacePath: workspace }), /ownership validator/)
	await assert.rejects(
		captureRunEvidence({
			...options(),
			workspacePath: workspace,
			assertSourceOwned: async () => {
				throw new Error("unowned")
			},
		}),
		/unowned/,
	)
	await assert.rejects(fs.stat(path.join(options().artifactsRoot, options().runId)), { code: "ENOENT" })
})

test("records missing lifecycle evidence as incomplete and absent pre-provider transcript explicitly", async () => {
	const storage = await ownedSource("storage")
	const result = await captureRunEvidence({
		...options(),
		storagePath: storage,
		assertSourceOwned: assertFixtureOwned,
	})
	const manifest = await manifestOf(result.manifestPath)
	assert.equal(result.captureComplete, false)
	assert.ok(manifest.warnings.includes("TASK_EVIDENCE_INCOMPLETE"))
	assert.equal(manifest.taskEvidence.length, 3)
	assert.ok(manifest.taskEvidence.every((entry) => entry.status === "absent"))
})

test("captures content-free before/after file hashes and retains raw logs in place", async () => {
	const workspace = await ownedSource("workspace")
	const logs = await ownedSource("logs")
	await fs.writeFile(path.join(workspace, "source.ts"), "export const value = 1")
	await fs.writeFile(path.join(workspace, ".env"), "SECRET_VALUE")
	const before = await captureRepositoryEvidence(workspace)
	await fs.writeFile(path.join(workspace, "source.ts"), "export const value = 2")
	await fs.writeFile(path.join(logs, "renderer.log"), "Authorization: Bearer RAW_SECRET_LOG")
	const result = await captureRunEvidence({
		...options(),
		metadata: { ...metadata(), taskIds: [] },
		workspacePath: workspace,
		logsPath: logs,
		repositoryBefore: before,
		assertSourceOwned: assertFixtureOwned,
	})
	const manifest = await manifestOf(result.manifestPath)
	const beforeText = await fs.readFile(path.join(result.artifactDirectory, "repository-before.json"), "utf8")
	const afterText = await fs.readFile(path.join(result.artifactDirectory, "repository-after.json"), "utf8")
	assert.notEqual(beforeText, afterText)
	assert.ok(!afterText.includes("export const"))
	assert.ok(!beforeText.includes(".env"))
	assert.ok(!beforeText.includes("SECRET_VALUE"))
	assert.ok(
		!(await fs.readFile(path.join(result.artifactDirectory, "logs-index.json"), "utf8")).includes("RAW_SECRET_LOG"),
	)
	assert.equal(manifest.retainedSources.find((source) => source.kind === "logs")?.path, logs)
	assert.ok((await fs.readFile(path.join(logs, "renderer.log"), "utf8")).includes("RAW_SECRET_LOG"))
})

test("honors small evidence limits and does not erase original sources when capture is incomplete", async () => {
	const workspace = await ownedSource("workspace")
	await fs.writeFile(path.join(workspace, "large.txt"), "X".repeat(100))
	const result = await captureRunEvidence({
		...options(),
		workspacePath: workspace,
		assertSourceOwned: assertFixtureOwned,
		limits: { maxFileBytes: 10, maxTotalBytes: 50 },
	})
	assert.equal(result.captureComplete, false)
	const manifest = await manifestOf(result.manifestPath)
	assert.ok(manifest.warnings.includes("REPOSITORY_INCOMPLETE"))
	assert.equal((await fs.stat(path.join(workspace, "large.txt"))).size, 100)
})

test("does not label task projections captured when artifact limits prevent writing them", async () => {
	const storage = await ownedSource("storage")
	const task = path.join(storage, "tasks", "task-1")
	await fs.mkdir(task, { recursive: true })
	for (const file of ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl"]) {
		await fs.writeFile(path.join(task, file), JSON.stringify({ type: "turn_terminal", status: "failed" }))
	}
	await fs.writeFile(path.join(task, "api_conversation_history.json"), "[]")
	const result = await captureRunEvidence({
		...options(),
		storagePath: storage,
		assertSourceOwned: assertFixtureOwned,
		limits: { maxTotalBytes: 20 },
	})
	const manifest = await manifestOf(result.manifestPath)
	assert.equal(result.captureComplete, false)
	assert.ok(manifest.warnings.includes("ARTIFACT_LIMIT"))
	assert.equal(manifest.taskEvidence.length, 3)
	assert.ok(manifest.taskEvidence.every((entry) => entry.status === "incomplete"))
	assert.equal(await fs.readFile(path.join(task, "api_conversation_history.json"), "utf8"), "[]")
})

test("never adopts unmarked non-empty artifact directories, overwrites a run, or accepts traversal", async () => {
	await fs.mkdir(options().artifactsRoot)
	await fs.writeFile(path.join(options().artifactsRoot, "sentinel"), "keep")
	await assert.rejects(captureRunEvidence(options()), /non-empty/)
	await assert.rejects(captureRunEvidence({ ...options(), runId: "../escape" }), /run ID/)
	const other = { ...options(), artifactsRoot: path.join(root, "other") }
	await captureRunEvidence(other)
	await assert.rejects(captureRunEvidence(other), { code: "EEXIST" })
	assert.equal(await fs.readFile(path.join(options().artifactsRoot, "sentinel"), "utf8"), "keep")
})

test("accepts a prepared runner directory and preserves runner metadata", async () => {
	const prepared = await prepareEvidenceRun(options())
	await fs.writeFile(path.join(prepared.artifactDirectory, "run-metadata.json"), "runner-owned")
	const result = await captureRunEvidence(options())
	assert.equal(result.artifactDirectory, prepared.artifactDirectory)
	assert.equal(await fs.readFile(path.join(result.artifactDirectory, "run-metadata.json"), "utf8"), "runner-owned")
	assert.ok(await fs.stat(path.join(result.artifactDirectory, EVIDENCE_RUN_MARKER)))
})

test("rejects symlinked sources before capture", async () => {
	const outside = await ownedSource("outside")
	const link = path.join(root, "linked")
	await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
	await assert.rejects(
		captureRunEvidence({ ...options(), workspacePath: link, assertSourceOwned: assertFixtureOwned }),
		/symlink/,
	)
	assert.ok(await fs.stat(outside))
})

test("readBounded handles actual short reads without truncating the source", async () => {
	const file = path.join(root, "input.json")
	await fs.writeFile(file, '{"status":"completed"}')
	// Patch the underlying Node export, which the production namespace import also reads.
	const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
	const open = underlying.open
	mock.method(underlying, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args)
		const read = handle.read.bind(handle)
		handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
			read(buffer, offset, Math.min(length, 2), position)) as typeof handle.read
		return handle
	})
	assert.equal((await readBounded(file, 100)).toString("utf8"), '{"status":"completed"}')
})

test("retention protects finalized failures and partial runs rather than treating finalization as inactivity", async () => {
	const first = await captureRunEvidence(options())
	await captureRunEvidence({
		...options(),
		runId: "run-2",
		metadata: { ...metadata(), finishedAt: "2026-09-06T13:00:02.000Z" },
	})
	const partial = await prepareEvidenceRun({ ...options(), runId: "partial-run" })
	await fs.mkdir(path.join(options().artifactsRoot, "unmarked"))
	await fs.writeFile(path.join(options().artifactsRoot, "unmarked", "sentinel"), "keep")
	const pruned = await pruneRunEvidence({
		artifactsRoot: options().artifactsRoot,
		maxRuns: 1,
		now: Date.parse(metadata().finishedAt),
	})
	assert.deepEqual(pruned.removedRunIds, [])
	assert.deepEqual(pruned.keptRunIds, ["run-1", "run-2", "partial-run"])
	assert.equal(pruned.skippedEntries, 4)
	assert.equal(pruned.overBudget, true)
	assert.equal(pruned.complete, true)
	assert.ok(await fs.stat(first.artifactDirectory))
	assert.ok(await fs.stat(partial.artifactDirectory))
	assert.equal(await fs.readFile(path.join(options().artifactsRoot, "unmarked", "sentinel"), "utf8"), "keep")
})

test("retention leaves symlink-containing run trees untouched", async () => {
	const evidence = await captureRunEvidence(options())
	const outside = await ownedSource("outside")
	await fs.writeFile(path.join(outside, "sentinel"), "keep")
	await fs.symlink(
		outside,
		path.join(evidence.artifactDirectory, "escape"),
		process.platform === "win32" ? "junction" : "dir",
	)
	const result = await pruneRunEvidence({ artifactsRoot: options().artifactsRoot, maxBytes: 1 })
	assert.deepEqual(result.removedRunIds, [])
	assert.equal(result.skippedEntries, 1)
	assert.equal(await fs.readFile(path.join(outside, "sentinel"), "utf8"), "keep")
})
