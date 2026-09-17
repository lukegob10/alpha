import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import { URL } from "node:url"
import { buildReport } from "./proportional-scope-report.mjs"
import { compareReports, comparePreflightReports } from "./proportional-scope-compare.mjs"

const fixtureIds = JSON.parse(
	await fs.readFile(new URL("../../evals/proportional-scope/cases.json", import.meta.url), "utf8"),
).cases.map(({ id }) => id)
const hash = "a".repeat(64)
const contract = { sampleIndexes: [0, 1], measurementKind: "scripted-harness" }

function run(kind = "scripted-harness") {
	return {
		identity: {
			harnessDigest: hash,
			oracleDigest: hash,
			configurationDigest: hash,
			cacheDigest: hash,
			tokenEvidence: "unavailable",
		},
		reports: fixtureIds.flatMap((fixtureId) =>
			contract.sampleIndexes.map((sampleIndex) =>
				buildReport({
					fixtureId,
					sampleIndex,
					measurementKind: kind,
					traceCoverage: "complete",
					trace: [{ sequence: 0, type: "agent.turn.model_request_started", payload: {} }],
					annotations: [{ sequence: 0, phase: "finalization", requestIndex: 0 }],
					graderDecision: "passed",
					outcome: "completed",
					revision: "a".repeat(40),
					workingTree: "clean",
					cacheState: "warm",
					fixtureDigest: hash,
					modelConfigurationDigest: hash,
				}),
			),
		),
	}
}

test("admits all seven classes and declared samples independent of delivery order", () => {
	const candidate = run()
	candidate.reports.reverse()
	for (const report of candidate.reports) report.revision = "b".repeat(40)
	const result = compareReports(run(), candidate, contract)
	assert.equal(result.samples.length, 14)
	assert.equal(result.admitted, true)
	assert.deepEqual(result.samples[0].modelCalls, { reference: 1, candidate: 1, delta: 0 })
	assert.equal(result.samples[0].providerTokens.tokensIn.value, null)
	assert.doesNotMatch(JSON.stringify(result), /harnessDigest|oracleDigest|revision|annotations/)
})

for (const [label, mutate] of [
	["changed full script", (value) => (value.identity.harnessDigest = "b".repeat(64))],
	["missing oracle identity", (value) => delete value.identity.oracleDigest],
	["configuration mismatch", (value) => (value.identity.configurationDigest = "b".repeat(64))],
	["cache protocol mismatch", (value) => (value.identity.cacheDigest = "b".repeat(64))],
	["changed fixture", (value) => (value.reports[0].fixtureDigest = "b".repeat(64))],
	["changed script actions", (value) => (value.reports[0].modelConfigurationDigest = "b".repeat(64))],
	["missing sample", (value) => value.reports.pop()],
	["duplicate sample", (value) => value.reports.push(value.reports[0])],
	["undeclared sample", (value) => (value.reports[0].sampleIndex = 2)],
	["failed quality", (value) => (value.reports[0].correctness = "outcome_failed")],
	["incomplete task", (value) => (value.reports[0].outcome = "blocked")],
	["dirty source", (value) => (value.reports[0].workingTree = "modified")],
	["mixed revisions", (value) => (value.reports[0].revision = "b".repeat(40))],
	["partial trace", (value) => (value.reports[0].traceCoverage = "partial")],
	["partial phase", (value) => (value.reports[0].phases.discovery.modelCalls.coverage = "observed")],
	["inconsistent totals", (value) => (value.reports[0].observedTotal.modelCalls.value = 2)],
	["unknown cache state", (value) => (value.reports[0].cacheState = "unknown")],
	["mixed kind", (value) => (value.reports[0].measurementKind = "runtime-observation")],
	["bytes as tokens", (value) => (value.identity.tokenEvidence = "request-bytes")],
	["local tokenizer as provider usage", (value) => (value.identity.tokenEvidence = "local-tokenizer")],
	["unknown fixture", (value) => (value.reports[0].fixtureId = "unknown")],
	["missing report identity", (value) => (value.reports[0].fixtureDigest = null)],
	["negative metric", (value) => (value.reports[0].observedTotal.toolResults.value = -1)],
	["missing phase", (value) => delete value.reports[0].phases.discovery],
	[
		"unattributed work",
		(value) => {
			value.reports[0].phases.finalization.modelCalls.value = 0
			value.reports[0].phases.unattributed.modelCalls.value = 1
		},
	],
]) {
	test(`rejects ${label} in either run`, () => {
		const invalid = run()
		mutate(invalid)
		assert.throws(() => compareReports(invalid, run(), contract), /not admitted/)
		assert.throws(() => compareReports(run(), invalid, contract), /not admitted/)
	})
}

test("requires explicit unique nonempty sample ordinals", () => {
	for (const sampleIndexes of [[], [0, 0], [-1], [0.5], undefined]) {
		assert.throws(() => compareReports(run(), run(), { ...contract, sampleIndexes }), /not admitted/)
	}
})

test("returns observed byte deltas without distributing aggregate tokens or accepting extra output fields", () => {
	const reference = run()
	const candidate = run()
	for (const [value, bytes] of [
		[reference, 30],
		[candidate, 20],
	]) {
		for (const report of value.reports) {
			report.observedTotal.toolOutputBytes.value = bytes
			report.phases.discovery.toolOutputBytes.value = bytes
			report.aggregateUsage.tokensIn = { value: 800, coverage: "complete" }
			report.rawPrompt = "private-fixture-input"
		}
	}
	const result = compareReports(reference, candidate, contract)
	assert.deepEqual(result.samples[0].toolOutputBytes, { reference: 30, candidate: 20, delta: -10 })
	assert.equal(result.samples[0].providerTokens.tokensIn.value, null)
	assert.doesNotMatch(JSON.stringify(result), /private-fixture-input|rawPrompt|aggregateUsage/)
})

test("does not convert scripted synthetic zero usage or bytes into provider tokens", () => {
	const value = run()
	value.identity.tokenEvidence = "provider"
	for (const report of value.reports) {
		report.observedTotal.tokensIn = { value: 0, coverage: "complete" }
	}
	const result = compareReports(value, value, contract)
	assert.equal(result.samples[0].providerTokens.tokensIn.coverage, "unavailable")
	assert.equal(result.samples[0].providerTokens.tokensIn.value, null)
})

test("compares only completely observed canonical provider usage, leaving partial usage unavailable", () => {
	const reference = run("runtime-observation")
	const candidate = run("runtime-observation")
	for (const [value, tokens] of [
		[reference, 12],
		[candidate, 10],
	]) {
		value.identity.tokenEvidence = "provider"
		for (const report of value.reports) {
			report.observedTotal.tokensIn = { value: tokens, coverage: "complete" }
			report.observedTotal.tokensOut = { value: 1, coverage: "observed" }
		}
	}
	const result = compareReports(reference, candidate, { ...contract, measurementKind: "runtime-observation" })
	assert.deepEqual(result.samples[0].providerTokens.tokensIn, {
		reference: 12,
		candidate: 10,
		delta: -2,
		coverage: "complete",
	})
	assert.equal(result.samples[0].providerTokens.tokensOut.value, null)
	assert.equal(result.samples[0].providerTokens.cacheWrites.value, null)
})

function preflight(candidate = false) {
	return {
		schemaVersion: 1,
		benchmark: "nor36-production-request-preflight",
		revision: (candidate ? "b" : "a").repeat(40),
		workingTree: "clean",
		node: "v20.19.2",
		harnessDigest: hash,
		fixtureDigest: hash,
		configuration: "fixture-profile",
		cache: "fresh task; shared tokenizer; disabled provider cache",
		boundary: "production request preflight with injected provider",
		tokenMethod: "local estimator, not provider usage",
		providerTokens: null,
		wholeTaskCompletion: null,
		timeToUsefulAnswerMs: null,
		samples: ["none", "small", "large"].flatMap((catalog) =>
			[0, 1, 2].map((sampleIndex) => ({
				catalog,
				sampleIndex,
				catalogBuildCalls: candidate ? 1 : 2,
				nativeSchemaFactoryCalls: candidate ? 1 : 2,
				providerRequests: 1,
				emittedToolCalls: 0,
				commandsExecuted: 0,
				inputBytes: { system: 10, messages: 20, schemas: 30 },
				localInputTokenEstimates: { system: 4, messages: 8, schemas: 12 },
				outputTextBytes: 40,
				requestDigest: hash,
				toolSchemaDigest: hash,
				quality: "request-and-response-parity-passed",
				providerTokens: null,
			})),
		),
	}
}

test("admits the exact nine paired preflight samples, independent of delivery order", () => {
	const candidate = preflight(true)
	candidate.samples.reverse()
	const result = comparePreflightReports(preflight(), candidate)
	assert.equal(result.acceptedSamples, 9)
	assert.deepEqual(result.catalogBuildCalls, { reference: 18, candidate: 9 })
	assert.deepEqual(result.nativeSchemaFactoryCalls, { reference: 18, candidate: 9 })
	assert.equal(result.providerTokens, null)
	assert.equal(result.wholeTaskCompletion, null)
	assert.equal(result.timeToUsefulAnswerMs, null)
	assert.doesNotMatch(JSON.stringify(result), /localInputTokenEstimates|inputBytes|fixture-profile/)
})

for (const field of ["node", "harnessDigest", "fixtureDigest", "configuration", "cache", "boundary", "tokenMethod"]) {
	test(`preflight rejects changed or missing ${field}`, () => {
		const candidate = preflight(true)
		candidate[field] = "changed"
		assert.throws(() => comparePreflightReports(preflight(), candidate), /not admitted/)
		delete candidate[field]
		assert.throws(() => comparePreflightReports(preflight(), candidate), /not admitted/)
	})
}

for (const [label, mutate] of [
	["dirty source", (value) => (value.workingTree = "modified")],
	["invalid revision", (value) => (value.revision = "unknown")],
	["wrong schema", (value) => (value.schemaVersion = 2)],
	["wrong benchmark", (value) => (value.benchmark = "other")],
	["missing sample", (value) => value.samples.pop()],
	["duplicate sample", (value) => (value.samples[0] = value.samples[1])],
	["invalid sample ordinal", (value) => (value.samples[0].sampleIndex = 3)],
	["invalid catalog", (value) => (value.samples[0].catalog = "unknown")],
	["quality failure", (value) => (value.samples[0].quality = "failed")],
	["provider usage claim", (value) => (value.providerTokens = 0)],
	["sample provider usage claim", (value) => (value.samples[0].providerTokens = 0)],
	["whole task claim", (value) => (value.wholeTaskCompletion = true)],
	["time claim", (value) => (value.timeToUsefulAnswerMs = 0)],
	["request digest mismatch", (value) => (value.samples[0].requestDigest = "b".repeat(64))],
	["schema digest mismatch", (value) => (value.samples[0].toolSchemaDigest = "b".repeat(64))],
	["byte mismatch", (value) => value.samples[0].inputBytes.schemas++],
	["local token mismatch", (value) => value.samples[0].localInputTokenEstimates.messages++],
	["invalid byte count", (value) => (value.samples[0].inputBytes.system = -1)],
	["invalid token count", (value) => (value.samples[0].localInputTokenEstimates.system = 0.5)],
	["output mismatch", (value) => value.samples[0].outputTextBytes++],
	["provider continuation", (value) => value.samples[0].providerRequests++],
	["emitted tool", (value) => value.samples[0].emittedToolCalls++],
	["physical command", (value) => value.samples[0].commandsExecuted++],
	["build count", (value) => value.samples[0].catalogBuildCalls++],
	["schema factory count", (value) => value.samples[0].nativeSchemaFactoryCalls++],
]) {
	test(`preflight rejects ${label} in either run`, () => {
		const reference = preflight()
		mutate(reference)
		assert.throws(() => comparePreflightReports(reference, preflight(true)), /not admitted/)
		const candidate = preflight(true)
		mutate(candidate)
		assert.throws(() => comparePreflightReports(preflight(), candidate), /not admitted/)
	})
}
