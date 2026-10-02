import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { lanes } from "./catalog.mjs"
import { admitHarnessReport, buildEvidenceMatrix } from "./matrix.mjs"
import { hostReceipt } from "./fixtures/evidence.mjs"
import { expectedTestFiles, laneExpectedInventories } from "./lane-evidence.mjs"
import { outcomeCampaignVerdict } from "./host-evidence.mjs"
import { proofFixture } from "./fixtures/outcome-proof.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const source = { commit: "a".repeat(40), dirty: false, treeSha256: "a".repeat(64), lockfileSha256: "a".repeat(64) }
const context = { source, node: "24.21.0", pnpm: "11.24.0", now: Date.parse("2026-10-02T11:00:00.000Z"), strict: true }
function report(lane = "static", id = "report-test") {
	return {
		schemaVersion: 2,
		id,
		lane,
		filters: [],
		status: "passed",
		startedAt: "2026-10-02T10:00:00.000Z",
		finishedAt: "2026-10-02T10:01:00.000Z",
		node: context.node,
		pnpm: context.pnpm,
		source,
		sourceAtEnd: source,
		sourceUnchangedAtBoundaries: true,
		steps: lanes[lane].commands.map((baseArgs) => ({
			baseArgs,
			startedAt: "2026-10-02T10:00:00.000Z",
			finishedAt: "2026-10-02T10:01:00.000Z",
			status: "passed",
			exitCode: 0,
			signal: null,
			evidence: { status: "passed", kind: lane === "static" ? "mechanical-command" : "command-only" },
		})),
	}
}
function execution(path) {
	const counts = { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }
	return {
		schemaVersion: 1,
		kind: "alpha-test-execution",
		runner: "vitest",
		complete: true,
		success: true,
		counts,
		files: [{ path, counts }],
	}
}

test("missing kinds, command-only unit results, stale source, skipped steps and expired reports fail closed", () => {
	assert.equal(admitHarnessReport(report(), context).state, "executed-pass")
	assert.equal(admitHarnessReport(report("unit"), context).reason, "test_execution_receipt_unavailable")
	for (const mutate of [
		(value) => (value.steps[0].evidence = { status: "passed" }),
		(value) => (value.sourceAtEnd = { ...source, treeSha256: "b".repeat(64) }),
		(value) => (value.node = "24.15.0"),
		(value) => (value.steps[0].status = "not_started"),
		(value) => (value.steps[0].startedAt = "invalid"),
		(value) => (value.steps[0].finishedAt = "2026-10-02T09:00:00.000Z"),
		(value) => (value.finishedAt = "2026-09-01T10:00:00.000Z"),
	]) {
		const value = report()
		mutate(value)
		assert.notEqual(admitHarnessReport(value, context).state, "executed-pass")
	}
})

test("declared build prerequisites are allowed but exact test inventories remain mandatory", async () => {
	const value = report("offline")
	const expectedInventories = await laneExpectedInventories(root, lanes.offline, "offline")
	for (const [index, step] of value.steps.entries()) {
		if (index === 0) continue
		const files = expectedInventories[index].map((file) => execution(file).files[0])
		const receipt = execution(files[0].path)
		receipt.files = files
		receipt.counts = { ...receipt.counts, total: files.length, passed: files.length }
		step.evidence = { status: "passed", receipt }
	}
	assert.ok(expectedInventories[1].some((file) => file.endsWith("messageLogDeduper.test.ts")))
	assert.equal(admitHarnessReport(value, { ...context, expectedInventories }).state, "executed-pass")
	value.steps[2].evidence = {
		status: "passed",
		receipt: execution("packages/evals/src/grading/__tests__/grading.spec.ts"),
	}
	assert.equal(admitHarnessReport(value, { ...context, expectedInventories }).reason, "incomplete_test_inventory")
	value.steps[2].evidence = { status: "passed" }
	assert.notEqual(admitHarnessReport(value, { ...context, expectedInventories }).state, "executed-pass")
})

test("early process failures and unstarted steps remain diagnosable without test receipts", async () => {
	const value = report("offline")
	value.status = "failed"
	value.steps[0].status = "failed"
	delete value.steps[0].evidence
	for (const step of value.steps.slice(1)) {
		step.status = "not_started"
		delete step.evidence
	}
	const matrix = await buildEvidenceMatrix({ root, ...context, reports: [value], requiredLanes: ["offline"] })
	assert.equal(matrix.gate.status, "failed")
	assert.equal(matrix.executionReports[0].state, "executed-fail")
	const invalid = await buildEvidenceMatrix({ root, ...context, reports: [null, {}], requiredLanes: ["host"] })
	assert.equal(invalid.gate.status, "failed")
	assert.ok(invalid.executionReports.every((report) => report.state === "unavailable"))
})

test("persisted host and outcome summaries are revalidated instead of trusting a passed flag", () => {
	const host = report("confidence")
	host.steps[1].evidence = { status: "passed" }
	assert.equal(admitHarnessReport(host, context).reason, "missing_host_receipts")
	const outcome = report("outcomes", "campaign-test")
	const fixture = proofFixture(outcome.id)
	const evidence = () => ({
		...outcomeCampaignVerdict(fixture.campaign, fixture.receipts, outcome.id),
		proofs: fixture.proofs,
		build: fixture.build,
	})
	const outcomeContext = { ...context, outcomeBuild: fixture.build }
	outcome.steps[2].evidence = evidence()
	assert.equal(admitHarnessReport(outcome, outcomeContext).state, "executed-pass")
	outcome.steps[2].evidence.scenarios[0].state = "skipped"
	assert.equal(admitHarnessReport(outcome, outcomeContext).reason, "tampered_outcome_projection")
	outcome.steps[2].evidence = evidence()
	outcome.steps[2].evidence.receipts[0].failure = "host-failed"
	assert.notEqual(admitHarnessReport(outcome, outcomeContext).state, "executed-pass")
	outcome.steps[2].evidence.receipts[0] = fixture.receipts[0] = hostReceipt("workflow.test")
	assert.notEqual(admitHarnessReport(outcome, outcomeContext).state, "executed-pass")
})

test("matrix discovery is truthful and machinery passes cannot promote production or real-workload replay", async () => {
	const value = report("focused")
	value.filters = ["core/agent/lifecycle/__tests__/AgentLifecycleJournal.spec.ts"]
	value.steps[0].baseArgs = [...lanes.focused.commands[0], ...value.filters]
	value.steps[0].evidence = {
		status: "passed",
		receipt: execution("src/core/agent/lifecycle/__tests__/AgentLifecycleJournal.spec.ts"),
	}
	const matrix = await buildEvidenceMatrix({ root, ...context, reports: [value], requiredLanes: ["focused", "host"] })
	assert.equal(matrix.cells.length, 18)
	assert.equal(matrix.columns.length, 8)
	assert.equal(matrix.layers.length, 15)
	assert.ok(matrix.evidence.every((entry) => entry.references.every((reference) => reference.found)))
	assert.ok(
		matrix.layers
			.filter((layer) => layer.id >= 11)
			.every((layer) => layer.states.includes("unavailable") && !layer.states.includes("executed-pass")),
	)
	assert.equal(matrix.gate.status, "failed")
	assert.equal(matrix.gate.requiredLanes.find((lane) => lane.lane === "host").reason, "required_lane_not_executed")
})

test("a focused hard gate requires the selected source inventory rather than an unrelated passing file", async () => {
	const value = report("focused")
	value.filters = ["core/agent/__tests__/AgentTurnEngine.spec.ts"]
	value.steps[0].baseArgs = [...lanes.focused.commands[0], ...value.filters]
	const expectedInventories = await laneExpectedInventories(
		root,
		{ ...lanes.focused, commands: [value.steps[0].baseArgs] },
		"focused",
	)
	assert.deepEqual(expectedInventories[0], ["src/core/agent/__tests__/AgentTurnEngine.spec.ts"])
	value.steps[0].evidence = { status: "passed", receipt: execution(expectedInventories[0][0]) }
	assert.equal(admitHarnessReport(value, { ...context, expectedInventories }).state, "executed-pass")
	value.steps[0].evidence.receipt.files[0].path = "src/services/ripgrep/__tests__/execution.spec.ts"
	assert.equal(admitHarnessReport(value, { ...context, expectedInventories }).reason, "incomplete_test_inventory")
})

test("focused inventory honors the configured generated and dependency excludes", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-focused-inventory-"))
	try {
		for (const file of [
			"src/core/export.spec.ts",
			"src/node_modules/dependency/export.spec.ts",
			"src/webview-ui/build/archive/export.spec.ts",
		]) {
			const absolute = path.join(directory, file)
			await mkdir(path.dirname(absolute), { recursive: true })
			await writeFile(absolute, "// inventory fixture\n")
		}
		assert.deepEqual(
			await expectedTestFiles(directory, { runner: "vitest" }, [...lanes.focused.commands[0], "export"]),
			["src/core/export.spec.ts"],
		)
		assert.deepEqual(
			await expectedTestFiles(root, { runner: "vitest" }, [...lanes.focused.commands[0], "export"]),
			[
				"src/core/config/__tests__/CustomModesManager.exportImportSlugChange.spec.ts",
				"src/integrations/misc/__tests__/export-markdown.spec.ts",
			],
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test("corrupt saved host and campaign members reject without crashing matrix admission", () => {
	const host = report("confidence")
	host.steps[1].evidence = { status: "passed", kind: "exact-host-suite", receipts: [null] }
	assert.notEqual(admitHarnessReport(host, context).state, "executed-pass")
	const outcome = report("outcomes", "campaign-test")
	const fixture = proofFixture(outcome.id)
	outcome.steps[2].evidence = {
		...outcomeCampaignVerdict(fixture.campaign, fixture.receipts, outcome.id),
		proofs: fixture.proofs,
		build: fixture.build,
	}
	outcome.steps[2].evidence.campaign.attempts[0] = null
	assert.notEqual(admitHarnessReport(outcome, { ...context, outcomeBuild: fixture.build }).state, "executed-pass")
})

test("a later comparable failure remains visible and blocks an earlier passing lane", async () => {
	const before = report("focused", "earlier-pass")
	before.filters = ["core/agent/__tests__/AgentTurnEngine.spec.ts"]
	before.steps[0].baseArgs = [...lanes.focused.commands[0], ...before.filters]
	before.steps[0].evidence = {
		status: "passed",
		receipt: execution("src/core/agent/__tests__/AgentTurnEngine.spec.ts"),
	}
	const after = structuredClone(before)
	after.id = "later-fail"
	after.startedAt = "2026-10-02T10:02:00.000Z"
	after.finishedAt = "2026-10-02T10:03:00.000Z"
	after.status = after.steps[0].status = "failed"
	after.steps[0].exitCode = 1
	after.steps[0].evidence.receipt.success = false
	after.steps[0].evidence.receipt.counts.passed = after.steps[0].evidence.receipt.files[0].counts.passed = 0
	after.steps[0].evidence.receipt.counts.failed = after.steps[0].evidence.receipt.files[0].counts.failed = 1
	const matrix = await buildEvidenceMatrix({ root, ...context, reports: [before, after], requiredLanes: ["focused"] })
	assert.equal(matrix.gate.status, "failed")
	const entry = matrix.evidence.find((entry) => entry.id === "turn-engine")
	assert.equal(entry.state, "executed-fail")
	assert.equal(entry.executions.length, 2)
})

test("overlapping runs select the latest completed observation and preserve conflicting history", async () => {
	const pass = report("focused", "quick-pass")
	pass.filters = ["core/agent/__tests__/AgentTurnEngine.spec.ts"]
	pass.steps[0].baseArgs = [...lanes.focused.commands[0], ...pass.filters]
	pass.steps[0].evidence = {
		status: "passed",
		receipt: execution("src/core/agent/__tests__/AgentTurnEngine.spec.ts"),
	}
	pass.startedAt = pass.steps[0].startedAt = "2026-10-02T10:01:00.000Z"
	pass.finishedAt = pass.steps[0].finishedAt = "2026-10-02T10:02:00.000Z"
	const failure = structuredClone(pass)
	failure.id = "slow-failure"
	failure.startedAt = failure.steps[0].startedAt = "2026-10-02T10:00:00.000Z"
	failure.finishedAt = failure.steps[0].finishedAt = "2026-10-02T10:10:00.000Z"
	failure.status = failure.steps[0].status = "failed"
	failure.steps[0].exitCode = 1
	failure.steps[0].evidence.receipt.success = false
	failure.steps[0].evidence.receipt.counts.passed = failure.steps[0].evidence.receipt.files[0].counts.passed = 0
	failure.steps[0].evidence.receipt.counts.failed = failure.steps[0].evidence.receipt.files[0].counts.failed = 1
	const matrix = await buildEvidenceMatrix({ root, ...context, reports: [failure, pass], requiredLanes: ["focused"] })
	assert.equal(matrix.gate.status, "failed")
	const entry = matrix.evidence.find((entry) => entry.id === "turn-engine")
	assert.equal(entry.currentExecutions[0].reportId, failure.id)
	assert.equal(entry.state, "executed-fail")
	assert.equal(entry.executions.length, 2)
})
