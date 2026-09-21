import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
	ALLOWED_FIRST_TOOLS,
	buildReport,
	evaluateLookupBar,
	SEARCH_TOOLS,
	traceFromPersistedAgentTurns,
} from "./lookup-efficiency-report.mjs"
import { pairReports } from "./lookup-efficiency-pair.mjs"

const executeFile = promisify(execFile)
const fixtureRoot = fileURLToPath(new URL("../../evals/lookup-efficiency/", import.meta.url))
const fixtures = JSON.parse(await fs.readFile(path.join(fixtureRoot, "cases.json"), "utf8"))
const promptIds = fixtures.cases.map(({ id }) => id)

const input = (overrides = {}) => ({
	fixtureId: "symbol-definition",
	measurementKind: "reporter-contract-test",
	traceCoverage: "complete",
	declaredSampleCount: 1,
	sampleIndex: 0,
	trace: [],
	...overrides,
})

const event = (sequence, type, payload = {}) => ({
	sequence,
	type: `agent.turn.${type}`,
	timestamp: new Date(0).toISOString(),
	payload,
})

const groundedLookupTrace = () => [
	event(1, "model_request_started", { attempt: 0 }),
	event(2, "tool_result", { name: "search_files", output: "secret-body", arguments: { path: "/secret-path" } }),
	event(3, "model_request_started", { attempt: 0 }),
	event(4, "tool_result", { name: "read_file", output: "secret-file-body" }),
	event(5, "model_request_started", { attempt: 0 }),
	event(6, "assistant_committed", { response: { text: "defined in catalog" } }),
	event(7, "task_completed", { status: "completed" }),
]

function goldenObservations(overrides = {}) {
	return input({
		trace: groundedLookupTrace(),
		completionStage: { candidateCount: 1, rejectionCount: 0, lastReasonCode: "ready" },
		timing: {
			firstGroundedAnswerMs: 1_200,
			durableCompletionMs: 2_400,
			backgroundedCommandsAtFirstAnswer: 0,
		},
		graderDecision: "passed",
		outcome: "completed",
		revision: "a".repeat(40),
		workingTree: "clean",
		modelId: "fixture-model",
		reasoningPreference: "high",
		cacheState: "cold",
		...overrides,
	})
}

test("golden lookup trace projects allowlisted counters without copying payloads", () => {
	const report = buildReport(goldenObservations())
	assert.equal(report.benchmark, "lookup-efficiency-v1")
	assert.equal(report.providerRequests.value, 3)
	assert.equal(report.providerRetries.value, 0)
	assert.equal(report.toolResults.value, 2)
	assert.equal(report.toolResultsByName.search_files.value, 1)
	assert.equal(report.toolResultsByName.read_file.value, 1)
	assert.deepEqual(report.distinctSearchTools.value, ["search_files"])
	assert.equal(report.firstTool.value, "search_files")
	assert.equal(report.workflowTools.skill.value, 0)
	assert.equal(report.workflowTools.ticket.value, 0)
	assert.equal(report.workflowTools.spawn.value, 0)
	assert.equal(report.workflowTools.todo.value, 0)
	assert.equal(report.workflowTools.attemptCompletion.value, 0)
	assert.equal(report.completionRejections.rejectionCount.value, 0)
	assert.equal(report.completionRejections.lastReasonCode.value, "ready")
	assert.equal(report.timing.firstGroundedAnswerMs.value, 1_200)
	assert.equal(report.timing.durableCompletionMs.value, 2_400)
	assert.equal(report.completionRejections.backgroundedCommandsAtFirstAnswer.value, 0)
	assert.equal(report.reasoningTokens.value, null)
	assert.equal(report.reasoningTokens.coverage, "unavailable")
	assert.equal(evaluateLookupBar(report).passed, true)
	assert.equal(evaluateLookupBar(report).liveMeasurement, false)
	assert.match(evaluateLookupBar(report).interpretation, /not a live measurement/)
	assert.doesNotMatch(JSON.stringify(report), /secret|defined in catalog|Select-String/)
	assert.deepEqual(SEARCH_TOOLS, ["codebase_search", "search_files", "list_files", "shell"])
	assert.ok(ALLOWED_FIRST_TOOLS.includes("search_files"))
})

test("read_file or a single codebase_search is an allowed first tool", () => {
	const readFirst = buildReport(
		goldenObservations({
			trace: [
				event(1, "model_request_started", { attempt: 0 }),
				event(2, "tool_result", { name: "read_file" }),
				event(3, "model_request_started", { attempt: 0 }),
				event(4, "assistant_committed", { response: { text: "ok" } }),
			],
		}),
	)
	assert.equal(readFirst.firstTool.value, "read_file")
	assert.equal(evaluateLookupBar(readFirst).passed, true)
	const searchFirst = buildReport(
		goldenObservations({
			trace: [
				event(1, "model_request_started", { attempt: 0 }),
				event(2, "tool_result", { name: "codebase_search" }),
				event(3, "model_request_started", { attempt: 0 }),
				event(4, "tool_result", { name: "read_file" }),
				event(5, "model_request_started", { attempt: 0 }),
				event(6, "assistant_committed", { response: { text: "ok" } }),
			],
		}),
	)
	assert.equal(searchFirst.firstTool.value, "codebase_search")
	assert.deepEqual(searchFirst.distinctSearchTools.value, ["codebase_search"])
	assert.equal(evaluateLookupBar(searchFirst).passed, true)
})

test("missing usage and timing remain unavailable rather than zero", () => {
	const report = buildReport(input({ trace: [event(1, "model_request_started", { attempt: 0 })] }))
	assert.equal(report.providerRequests.value, 1)
	assert.equal(report.reasoningTokens.value, null)
	assert.equal(report.reasoningTokens.coverage, "unavailable")
	assert.doesNotMatch(report.reasoningTokens.reason ?? "", /0/)
	assert.equal(report.localReasoningTokenEstimate.value, null)
	assert.equal(report.aggregateUsage.tokensIn.value, null)
	assert.equal(report.aggregateUsage.tokensIn.coverage, "unavailable")
	assert.equal(report.timing.firstGroundedAnswerMs.value, null)
	assert.equal(report.timing.durableCompletionMs.value, null)
	assert.equal(report.completionRejections.rejectionCount.value, null)
	assert.equal(report.completionRejections.backgroundedCommandsAtFirstAnswer.value, null)
	const unavailableTrace = buildReport(input({ traceCoverage: "unavailable" }))
	assert.equal(unavailableTrace.providerRequests.value, null)
	assert.equal(unavailableTrace.toolResults.value, null)
	assert.equal(unavailableTrace.firstTool.value, null)
	assert.equal(unavailableTrace.distinctSearchTools.value, null)
	assert.notEqual(unavailableTrace.providerRequests.value, 0)
	assert.notEqual(unavailableTrace.toolResults.value, 0)
})

test("local reasoning estimates are labeled separately from adapter-reported tokens", () => {
	const report = buildReport(
		input({
			trace: [event(1, "model_request_started", { attempt: 0 })],
			usage: { localReasoningTokenEstimate: 17, tokensIn: 40 },
		}),
	)
	assert.equal(report.reasoningTokens.value, null)
	assert.equal(report.reasoningTokens.coverage, "unavailable")
	assert.deepEqual(report.localReasoningTokenEstimate, {
		value: 17,
		coverage: "complete",
		source: "local-estimator",
	})
	assert.equal(report.aggregateUsage.tokensIn.value, 40)
	const adapter = buildReport(
		input({
			trace: [event(1, "model_request_started", { attempt: 0 })],
			usage: { reasoningTokens: 9, localReasoningTokenEstimate: 17 },
		}),
	)
	assert.equal(adapter.reasoningTokens.value, 9)
	assert.equal(adapter.localReasoningTokenEstimate.value, 17)
	assert.equal(adapter.localReasoningTokenEstimate.source, "local-estimator")
})

test("partial request-usage reasoning does not become a zero", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "model_request_started", { attempt: 0 }),
				event(2, "request_usage", { requestIndex: 0, inputTokens: 2, outputTokens: 1, cacheReadTokens: 0 }),
			],
			annotations: [{ sequence: 1, requestIndex: 0 }],
			usage: { requestUsage: [{ inputTokens: 2, outputTokens: 1 }] },
		}),
	)
	assert.equal(report.reasoningTokens.value, null)
	assert.equal(report.reasoningTokens.coverage, "unavailable")
})

test("retries count from request attempts and never inspect command text", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "model_request_started", { attempt: 0 }),
				event(2, "retry", { attempt: 1, reason: "rate-limit-secret" }),
				event(3, "model_request_started", { attempt: 1 }),
			],
		}),
	)
	assert.equal(report.providerRequests.value, 2)
	assert.equal(report.providerRetries.value, 1)
	assert.doesNotMatch(JSON.stringify(report), /rate-limit-secret/)
	const missingAttempt = buildReport(
		input({
			trace: [event(1, "model_request_started"), event(2, "model_request_started")],
		}),
	)
	assert.equal(missingAttempt.providerRetries.value, null)
	assert.equal(missingAttempt.providerRetries.coverage, "unavailable")
})

test("canonical shell and execute_command count as shell search without copying commands", () => {
	const report = buildReport(
		input({
			trace: [
				event(1, "tool_result", {
					name: "shell",
					arguments: { command: "Select-String -Pattern secret-symbol" },
				}),
				event(2, "tool_result", { tool: "execute_command", arguments: { command: "rg secret" } }),
			],
		}),
	)
	assert.equal(report.toolResultsByName.shell.value, 2)
	assert.equal(report.toolResultsByName.execute_command, undefined)
	assert.deepEqual(report.distinctSearchTools.value, ["shell"])
	assert.equal(report.firstTool.value, "shell")
	assert.doesNotMatch(JSON.stringify(report), /Select-String|secret-symbol|\brg\b/)
})

test("unknown tools collapse to other and never leak their names", () => {
	const report = buildReport(
		input({
			trace: [event(1, "tool_result", { name: "private-tool-secret", callId: "private-id-secret" })],
		}),
	)
	assert.equal(report.toolResultsByName.other.value, 1)
	assert.equal(report.firstTool.value, "other")
	assert.doesNotMatch(JSON.stringify(report), /private|secret/)
})

test("failure-mode trace is flagged against the predeclared bar and is not a live measurement", () => {
	const report = buildReport(
		input({
			measurementKind: "reporter-contract-test",
			trace: [
				event(1, "model_request_started", { attempt: 0 }),
				event(2, "tool_result", { name: "skill" }),
				event(3, "model_request_started", { attempt: 0 }),
				event(4, "tool_result", { name: "spawn_agent" }),
				event(5, "model_request_started", { attempt: 0 }),
				event(6, "tool_result", { name: "update_todo_list" }),
				event(7, "model_request_started", { attempt: 0 }),
				event(8, "tool_result", { name: "list_tickets" }),
				event(9, "model_request_started", { attempt: 0 }),
				event(10, "tool_result", {
					name: "shell",
					arguments: { command: "Select-String -Path * -Pattern computeReorderPoint" },
				}),
				event(11, "model_request_started", { attempt: 0 }),
				event(12, "tool_result", { name: "list_files" }),
				event(13, "model_request_started", { attempt: 0 }),
				event(14, "tool_result", { name: "attempt_completion" }),
				event(15, "model_request_started", { attempt: 0 }),
			],
			completionStage: {
				candidateCount: 2,
				rejectionCount: 1,
				lastReasonCode: "command_running",
				backgroundedCommandsAtFirstAnswer: 1,
			},
		}),
	)
	assert.equal(report.providerRequests.value, 8)
	assert.equal(report.toolResults.value, 7)
	assert.equal(report.workflowTools.skill.value, 1)
	assert.equal(report.workflowTools.spawn.value, 1)
	assert.equal(report.workflowTools.todo.value, 1)
	assert.equal(report.workflowTools.ticket.value, 1)
	assert.equal(report.workflowTools.attemptCompletion.value, 1)
	assert.ok(report.distinctSearchTools.value.includes("shell"))
	assert.ok(report.distinctSearchTools.value.includes("list_files"))
	assert.equal(report.firstTool.value, "skill")
	assert.equal(report.completionRejections.rejectionCount.value, 1)
	assert.equal(report.completionRejections.lastReasonCode.value, "command_running")
	const acceptance = evaluateLookupBar(report)
	assert.equal(acceptance.passed, false)
	assert.equal(acceptance.liveMeasurement, false)
	assert.equal(acceptance.criteria.providerRequests.passed, false)
	assert.equal(acceptance.criteria.toolResults.passed, false)
	assert.equal(acceptance.criteria.firstTool.passed, false)
	assert.equal(acceptance.criteria.workflowTools.passed, false)
	assert.equal(acceptance.criteria.completionRejections.passed, false)
	assert.match(acceptance.interpretation, /not a live measurement/)
	assert.doesNotMatch(JSON.stringify({ report, acceptance }), /Select-String|live Copilot|general quality/)
})

test("flattens persisted agent-turn JSONL the same way processTask does", () => {
	const trace = traceFromPersistedAgentTurns([
		{
			sequence: 4,
			timestamp: 1_750_000_000_000,
			event: { type: "tool_result", name: "search_files", output: "secret-hit" },
		},
	])
	assert.equal(trace[0].type, "agent.turn.tool_result")
	assert.equal(trace[0].payload.name, "search_files")
	const report = buildReport(input({ trace }))
	assert.equal(report.firstTool.value, "search_files")
	assert.doesNotMatch(JSON.stringify(report), /secret-hit/)
})

function sampleReport(fixtureId, sampleIndex, extras = {}) {
	return buildReport(
		goldenObservations({
			fixtureId,
			sampleIndex,
			declaredSampleCount: extras.declaredSampleCount ?? 1,
			...extras,
		}),
	)
}

function runEnvelope(reports, identity = {}) {
	return {
		identity: {
			declaredSampleCount: 1,
			modelId: "fixture-model",
			reasoningPreference: "high",
			cacheState: "cold",
			promptIds,
			...identity,
		},
		reports,
	}
}

test("pairing reports medians and per-sample request/tool vectors", () => {
	const reference = runEnvelope(promptIds.map((id) => sampleReport(id, 0)))
	const candidate = runEnvelope(
		promptIds.map((id) =>
			sampleReport(id, 0, {
				revision: "b".repeat(40),
			}),
		),
	)
	const paired = pairReports(reference, candidate, { declaredSampleCount: 1, promptIds })
	assert.equal(paired.admitted, true)
	assert.equal(paired.samples.length, 4)
	assert.equal(paired.medians.referenceProviderRequests.value, 3)
	assert.equal(paired.medians.candidateToolResults.value, 2)
	assert.equal(paired.samples[0].delta.providerRequests.delta, 0)
	assert.equal(paired.samples[0].reference.barPassed, true)
	assert.equal(paired.liveMeasurement, false)
	assert.match(paired.interpretation, /NOR-36 scripted 2\/1/)
})

test("pairing helper rejects mismatched prompt sets", () => {
	const reference = runEnvelope(promptIds.map((id) => sampleReport(id, 0)))
	const candidate = runEnvelope(promptIds.slice(1).map((id) => sampleReport(id, 0)))
	assert.throws(
		() => pairReports(reference, candidate, { declaredSampleCount: 1, promptIds }),
		/mismatched prompt sets/,
	)
})

test("pairing helper rejects a missing candidate sample", () => {
	const reference = runEnvelope(
		promptIds.flatMap((id) => [
			sampleReport(id, 0, { declaredSampleCount: 2 }),
			sampleReport(id, 1, { declaredSampleCount: 2 }),
		]),
		{ declaredSampleCount: 2 },
	)
	const candidate = runEnvelope(
		promptIds.map((id) => sampleReport(id, 0, { declaredSampleCount: 2 })),
		{ declaredSampleCount: 2 },
	)
	assert.throws(
		() => pairReports(reference, candidate, { declaredSampleCount: 2, promptIds }),
		/missing candidate/,
	)
})

test("pairing keeps unavailable usage unavailable rather than inventing a zero delta", () => {
	const reference = runEnvelope(
		promptIds.map((id) =>
			sampleReport(id, 0, {
				traceCoverage: "unavailable",
				trace: [],
			}),
		),
	)
	const candidate = runEnvelope(promptIds.map((id) => sampleReport(id, 0)))
	const paired = pairReports(reference, candidate, { declaredSampleCount: 1, promptIds })
	assert.equal(paired.samples[0].delta.providerRequests.value, null)
	assert.equal(paired.samples[0].delta.providerRequests.coverage, "unavailable")
	assert.equal(paired.medians.referenceProviderRequests.value, null)
})

test("frozen cases, subset, and decoy workspaces exist", async () => {
	assert.equal(fixtures.schemaVersion, 1)
	assert.equal(fixtures.status, "unadmitted")
	assert.equal(promptIds.length, 4)
	assert.ok(promptIds.every((id, index) => promptIds.indexOf(id) === index))
	const subset = JSON.parse(
		await fs.readFile(new URL("../../evals/subsets/lookup-efficiency-v1.json", import.meta.url), "utf8"),
	)
	assert.deepEqual(subset, promptIds)
	for (const fixture of fixtures.cases) {
		assert.equal(fixture.class, "lookup")
		assert.ok(fixture.prompt.length > 20)
		assert.ok(fixture.quality.length >= 2)
		assert.ok(typeof fixture.expectedAnswerKey === "string" && fixture.expectedAnswerKey.length > 0)
		const root = path.resolve(fixtureRoot, fixture.workspace)
		assert.ok((await fs.stat(root)).isDirectory())
	}
	const catalog = path.join(fixtureRoot, "workspaces/catalog/src")
	const recorder = path.join(fixtureRoot, "workspaces/recorder/src")
	assert.ok((await fs.readFile(path.join(catalog, "catalog.js"), "utf8")).includes("computeReorderPoint"))
	assert.ok((await fs.readFile(path.join(catalog, "catalogLimit.js"), "utf8")).includes("computeReorderLimit"))
	assert.ok((await fs.readFile(path.join(catalog, "settings.js"), "utf8")).includes("50"))
	assert.ok((await fs.readFile(path.join(catalog, "settings.defaults.js"), "utf8")).includes("100"))
	assert.ok((await fs.readFile(path.join(recorder, "eventRecorder.js"), "utf8")).includes("events.ndjson"))
	assert.ok((await fs.readFile(path.join(recorder, "eventRecorderPath.js"), "utf8")).includes("events.ndjson"))
	assert.ok((await fs.readFile(path.join(recorder, "reportWriter.js"), "utf8")).includes("reports.json"))
	assert.doesNotMatch(JSON.stringify(fixtures), /ToolScheduler|Alpha-Code|where are the logs/)
})

test("report CLI writes a privacy-safe acceptance document", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-efficiency-"))
	try {
		const observations = path.join(directory, "observations.json")
		const reportFile = path.join(directory, "report.json")
		await fs.writeFile(observations, `${JSON.stringify(goldenObservations())}\n`)
		await executeFile(
			process.execPath,
			[fileURLToPath(new URL("./lookup-efficiency-report.mjs", import.meta.url)), observations, reportFile],
			{ timeout: 10_000 },
		)
		const report = JSON.parse(await fs.readFile(reportFile, "utf8"))
		assert.equal(report.acceptance.passed, true)
		assert.equal(report.acceptance.liveMeasurement, false)
		assert.doesNotMatch(JSON.stringify(report), /secret/)
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})
