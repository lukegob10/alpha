import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { buildReport, phases, categories } from "./proportional-scope-report.mjs"

const executeFile = promisify(execFile)
const childEnvironment = { ...process.env }
delete childEnvironment.NODE_TEST_CONTEXT
const fixtureRoot = fileURLToPath(new URL("../../evals/proportional-scope/", import.meta.url))
const fixtures = JSON.parse(await fs.readFile(path.join(fixtureRoot, "cases.json"), "utf8"))
const input = (overrides = {}) => ({
	fixtureId: "small-edit",
	measurementKind: "reporter-contract-test",
	traceCoverage: "complete",
	trace: [],
	...overrides,
})
const event = (sequence, type, payload = {}) => ({
	sequence,
	type: `agent.turn.${type}`,
	timestamp: new Date(0).toISOString(),
	payload,
})

test("attributes all four phases without inferring phase from tool names", () => {
	const trace = [
		event(1, "tool_result", { name: "read_file", output: "é" }),
		event(2, "tool_result", { name: "edit_file", output: "ok" }),
		event(3, "tool_result", { name: "execute_command", output: "pass" }),
		event(4, "model_request_started"),
		event(5, "request_usage", { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 }),
	]
	const report = buildReport(
		input({
			trace,
			annotations: [
				{ sequence: 1, phase: "discovery" },
				{ sequence: 2, phase: "implementation" },
				{ sequence: 3, phase: "validation", category: "validation" },
				{ sequence: 4, phase: "finalization" },
				{ sequence: 5, phase: "finalization" },
			],
		}),
	)
	assert.deepEqual(Object.keys(report.phases), phases)
	assert.deepEqual(Object.keys(report.observedTotal.toolCategories), categories)
	assert.equal(report.phases.discovery.toolOutputBytes.value, 2)
	assert.equal(report.phases.implementation.toolCategories.mutation.value, 1)
	assert.equal(report.phases.validation.toolCategories.validation.value, 1)
	assert.equal(report.phases.finalization.tokensIn.value, 12)
	assert.equal(report.phases.finalization.cacheReads.value, 4)
	assert.equal(report.phases.finalization.cacheWrites.value, null)
	assert.equal(report.observedTotal.tokensOut.value, 3)
	assert.equal(report.observedTotal.repetitions.value, null)
})

test("does not count verification evidence as a second tool call", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "tool_result", { name: "execute_command", output: "pass" }),
				event(2, "verification_result", { commandCategory: "test", status: "success" }),
			],
		}),
	)
	assert.equal(report.observedTotal.toolResults.value, 1)
	assert.equal(report.phases.unattributed.toolResults.value, 1)
	assert.equal(report.phases.discovery.toolResults.coverage, "observed")
})

test("missing and partial evidence never becomes a complete zero", () => {
	const unavailable = buildReport(input({ traceCoverage: "unavailable" }))
	assert.equal(unavailable.observedTotal.modelCalls.value, null)
	assert.equal(unavailable.phases.finalization.tokensIn.value, null)
	assert.equal(unavailable.completionStage.candidateCount.value, null)
	assert.equal(unavailable.correctness, "unavailable")
	assert.equal(unavailable.outcome, "unavailable")
	const partial = buildReport(input({ traceCoverage: "partial", trace: [event(1, "model_request_started")] }))
	assert.deepEqual(partial.observedTotal.modelCalls, { value: 1, coverage: "observed" })
	assert.equal(partial.observedTotal.tokensIn.value, null)
})

test("keeps aggregate usage separate from phase usage and rejects invalid numeric metrics", () => {
	const report = buildReport(
		input({
			usage: { modelCalls: 5, tokensIn: 99, cacheWrites: 12, tokensOut: -1 },
			completionStage: { candidateCount: 2, repairToolCount: 3, runtimeWaitMs: 10 },
		}),
	)
	assert.equal(report.aggregateUsage.tokensIn.value, 99)
	assert.equal(report.aggregateUsage.cacheWrites.value, 12)
	assert.equal(report.aggregateUsage.tokensOut.value, null)
	assert.equal(report.completionStage.candidateCount.value, 2)
	assert.equal(report.completionStage.rejectionCount.value, null)
	assert.equal(report.phases.finalization.cacheWrites.value, null)
})

test("counts observed repetitions and check reruns only with explicit fingerprints", () => {
	const trace = [1, 2, 3].map((sequence) =>
		event(sequence, "tool_result", { name: "execute_command", output: "pass" }),
	)
	const annotations = trace.map(({ sequence }) => ({
		sequence,
		phase: "validation",
		category: "validation",
		fingerprint: "a".repeat(64),
	}))
	const report = buildReport(input({ trace, annotations }))
	assert.equal(report.observedTotal.repetitions.value, 2)
	assert.equal(report.phases.validation.checkReruns.value, 2)
})

test("counts only completed compaction actions", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "compaction_completed", { action: "none" }),
				event(2, "compaction_completed", { action: "summary" }),
				event(3, "compaction_completed", { action: "truncation" }),
			],
		}),
	)
	assert.equal(report.observedTotal.compactions.value, 2)
})

test("duplicate request indexes cannot replace missing usage", () => {
	const usage = { requestIndex: 0, inputTokens: 2, outputTokens: 1, cacheReadTokens: 0 }
	const report = buildReport(
		input({
			trace: [
				event(1, "model_request_started"),
				event(2, "model_request_started"),
				event(3, "request_usage", usage),
				event(4, "request_usage", usage),
			],
		}),
	)
	assert.equal(report.observedTotal.tokensIn.value, null)
})

test("attributes committed assistant text bytes without retaining text", () => {
	const report = buildReport(
		input({
			trace: [event(1, "model_request_started"), event(2, "assistant_committed", { response: { text: "é" } })],
			annotations: [
				{ sequence: 1, phase: "finalization" },
				{ sequence: 2, phase: "finalization" },
			],
		}),
	)
	assert.equal(report.phases.finalization.assistantTextBytes.value, 2)
	assert.doesNotMatch(JSON.stringify(report), /é/)
})

test("counts commands independently from explicit polling and recovery purpose", () => {
	const trace = [
		event(1, "tool_result", { name: "execute_command", output: "done" }),
		event(2, "tool_result", { name: "read_file", output: "fresh" }),
	]
	const annotations = [
		{ sequence: 1, phase: "validation", category: "validation", purpose: "polling" },
		{ sequence: 2, phase: "discovery", purpose: "recovery" },
	]
	const report = buildReport(input({ trace, annotations }))
	assert.equal(report.observedTotal.commandCount.value, 1)
	assert.equal(report.observedTotal.pollingToolResults.value, 1)
	assert.equal(report.observedTotal.recoveryToolResults.value, 1)
	assert.equal(buildReport(input({ trace })).observedTotal.pollingToolResults.value, null)
})

test("report is an allowlist projection that never retains raw trace, identifiers, paths, or secrets", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "tool_result", {
					name: "private-tool-secret",
					callId: "private-id-secret",
					output: "sensitive-output-secret",
					arguments: { path: "/private-path-secret" },
				}),
			],
			outcome: "private-status-secret",
			revision: "private-revision-secret",
			completionStage: { lastReasonCode: "private-code-secret" },
		}),
	)
	assert.doesNotMatch(JSON.stringify(report), /secret|private/)
	assert.equal(report.observedTotal.toolCategories.other.value, 1)
	assert.equal(report.observedTotal.toolOutputBytes.value, Buffer.byteLength("sensitive-output-secret"))
})

test("fails closed on duplicate sequences and dangling or invalid attribution", () => {
	assert.throws(() => buildReport(input({ trace: [event(1, "tool_result"), event(1, "tool_result")] })), /Duplicate/)
	assert.throws(() => buildReport(input({ annotations: [{ sequence: 1, phase: "discovery" }] })), /missing event/)
	assert.throws(
		() =>
			buildReport(input({ trace: [event(1, "tool_result")], annotations: [{ sequence: 1, phase: "invented" }] })),
		/Invalid phase/,
	)
	assert.throws(() => buildReport(input({ measurementKind: undefined })), /measurementKind/)
})

test("all seven fixture workspaces and validation entrypoints exist", async () => {
	assert.equal(new Set(fixtures.cases.map(({ id }) => id)).size, 7)
	for (const fixture of fixtures.cases) {
		assert.ok(fixture.prompt.length > 20)
		assert.ok(fixture.quality.length >= 2)
		if (fixture.workspace) {
			const root = path.resolve(fixtureRoot, fixture.workspace)
			assert.ok((await fs.stat(root)).isDirectory())
			for (const validation of fixture.validation)
				assert.ok((await fs.stat(path.join(root, validation))).isFile())
		}
	}
})

test("each mutation fixture starts with a failing quality oracle", async () => {
	for (const fixture of fixtures.cases.filter(({ validation }) => validation.length)) {
		const root = path.resolve(fixtureRoot, fixture.workspace)
		await assert.rejects(
			executeFile(process.execPath, ["--test", ...fixture.validation], {
				cwd: root,
				timeout: 10_000,
				env: childEnvironment,
			}),
			(error) => error.code === 1,
			fixture.id,
		)
	}
})
