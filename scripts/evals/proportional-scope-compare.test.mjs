import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { URL } from "node:url"
import { buildReport } from "./proportional-scope-report.mjs"
import {
	compareReports,
	comparePreflightReports,
	compareLiveQualityReports,
	liveQualityComparisonCli,
} from "./proportional-scope-compare.mjs"

const fixtureIds = JSON.parse(
	await fs.readFile(new URL("../../evals/proportional-scope/cases.json", import.meta.url), "utf8"),
).cases.map(({ id }) => id)
const hash = "a".repeat(64)
const contract = { sampleIndexes: [0, 1], measurementKind: "scripted-harness" }

function liveRuns(label = "baseline") {
	return ["provider-a", "provider-b"].map((provider) => ({
		schemaVersion: 1,
		kind: "alpha-live-short-task-quality",
		measurementKind: "real-extension-live",
		label,
		status: "passed",
		declared: { provider, modelId: `${provider}-chosen`, effort: "high" },
		conditions: {
			hostVersion: "1.141.0",
			node: "v24.21.0",
			platform: "win32",
			arch: "x64",
			machineDigest: hash,
			harnessDigest: hash,
			fixtureDigest: hash,
			fixtureIds: ["read", "edit"],
			cacheProtocol: "provider-cache-uncontrolled",
		},
		build: {
			status: "verified",
			sourceTreeState: "clean",
			manifestDigest: label === "baseline" ? hash : "b".repeat(64),
			sourceRevision: label === "baseline" ? "a".repeat(40) : "b".repeat(40),
		},
		samples: 3,
		observations: ["read", "edit"].flatMap((fixtureId) =>
			[0, 1, 2].map((sampleIndex) => ({
				fixtureId,
				sampleIndex,
				correctness: "passed",
				outcome: "completed",
				configurationDigest: hash,
				requestMetric: "adapter-dispatches",
				providerImplementation: null,
				modelCalls: 2,
				toolCalls: 2,
				commandCount: 1,
				repeatedCommands: 0,
				repeatedChecks: 0,
				durationMs: 1000,
			})),
		),
	}))
}

test("real short tasks pair routes and repeated samples while allowing the candidate extension build to differ", () => {
	const reference = liveRuns()
	const candidate = liveRuns("candidate").reverse()
	for (const run of candidate) run.observations.reverse()
	const result = compareLiveQualityReports(reference, candidate)
	assert.equal(result.admitted, true)
	assert.equal(result.passed, true)
	assert.equal(result.comparisons.length, 4)
	assert.equal(result.comparisons[0].samples.length, 3)
	assert.match(result.interpretation, /not statistical proof/)
})

test("portable live comparison CLI requires the release candidate commit and writes no local profile paths", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-quality-compare-"))
	try {
		const args = ["--live-quality"]
		for (const label of ["baseline", "candidate"])
			for (const [index, report] of liveRuns(label).entries()) {
				const file = path.join(directory, `${label}-${index}.json`)
				await fs.writeFile(file, JSON.stringify(report))
				args.push(`--${label}`, file)
			}
		const output = path.join(directory, "comparison.json")
		await assert.rejects(
			liveQualityComparisonCli([...args, "--require-candidate-commit", "c".repeat(40), "--output", output]),
			/candidate captured source commit mismatch/,
		)
		assert.equal(
			await liveQualityComparisonCli([...args, "--require-candidate-commit", "b".repeat(40), "--output", output]),
			0,
		)
		const result = await fs.readFile(output, "utf8")
		assert.equal(JSON.parse(result).sourceRevisions.candidate[0], "b".repeat(40))
		assert.equal(result.includes(directory), false)
		await assert.rejects(
			liveQualityComparisonCli([...args, "--output", output]),
			(error) => error.code === "EEXIST",
		)
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})

test("portable bundle exports discard unknown task contents and enforce both release revisions", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-quality-bundle-"))
	try {
		const bundle = { baseline: liveRuns(), candidate: liveRuns("candidate") }
		bundle.candidate[0].rawAnswer = "private-task-text"
		bundle.candidate[0].conditions.privatePath = "private-task-text"
		bundle.candidate[0].build.rawInput = "private-task-text"
		bundle.candidate[0].observations[0].toolOutput = "private-task-text"
		const input = path.join(directory, "input.json")
		await fs.writeFile(input, JSON.stringify(bundle))
		const output = path.join(directory, "comparison.json")
		const safe = path.join(directory, "bundle.json")
		const dispatch = path.join(directory, "dispatch.json")
		const args = [
			"--live-quality-bundle",
			input,
			"--require-candidate-commit",
			"b".repeat(40),
			"--output",
			output,
			"--validated-bundle",
			safe,
			"--dispatch-input",
			dispatch,
		]
		await assert.rejects(
			liveQualityComparisonCli([...args, "--require-baseline-commit", "c".repeat(40)]),
			/baseline captured source commit mismatch/,
		)
		assert.equal(await liveQualityComparisonCli([...args, "--require-baseline-commit", "a".repeat(40)]), 0)
		for (const file of [output, safe, dispatch])
			assert.equal((await fs.readFile(file, "utf8")).includes("private-task-text"), false)
		assert.deepEqual(
			JSON.parse(JSON.parse(await fs.readFile(dispatch, "utf8")).reports),
			JSON.parse(await fs.readFile(safe, "utf8")),
		)
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})

test("oversized workflow input is rejected before any evidence export", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-quality-dispatch-bound-"))
	try {
		const bundle = { baseline: liveRuns(), candidate: liveRuns("candidate") }
		for (const runs of [bundle.baseline, bundle.candidate])
			for (const run of runs) {
				const originals = run.observations
				run.samples = 20
				run.conditions.fixtureIds = ["read", "edit", "lookup", "absence", "late"]
				run.observations = run.conditions.fixtureIds.flatMap((fixtureId) =>
					Array.from({ length: 20 }, (_, sampleIndex) => ({
						...(originals.find((row) => row.fixtureId === fixtureId) ?? originals[0]),
						fixtureId,
						sampleIndex,
					})),
				)
			}
		const input = path.join(directory, "input.json")
		await fs.writeFile(input, JSON.stringify(bundle))
		const exports = ["comparison.json", "bundle.json", "dispatch.json"].map((file) => path.join(directory, file))
		await assert.rejects(
			liveQualityComparisonCli([
				"--live-quality-bundle",
				input,
				"--output",
				exports[0],
				"--validated-bundle",
				exports[1],
				"--dispatch-input",
				exports[2],
			]),
			/workflow input exceeds 65535 UTF-8 bytes/,
		)
		for (const file of exports) await assert.rejects(fs.stat(file), (error) => error.code === "ENOENT")
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})

test("real short task regression checks retain correctness and expose repeated checks and runaway work", () => {
	const candidate = liveRuns("candidate")
	for (const row of candidate[0].observations)
		Object.assign(row, {
			modelCalls: 20,
			commandCount: 15,
			repeatedChecks: 10,
			repeatedCommands: 10,
			durationMs: 60_000,
		})
	const result = compareLiveQualityReports(liveRuns(), candidate)
	assert.equal(result.passed, false)
	assert.equal(result.comparisons[0].metrics.repeatedChecks.regressed, true)
	assert.equal(result.comparisons[0].metrics.durationMs.regressed, true)
})

for (const [label, mutate] of [
	[
		"one sample",
		(runs) => {
			runs[0].samples = 1
		},
	],
	[
		"one provider",
		(runs) => {
			runs.pop()
		},
	],
	[
		"same provider with another model",
		(runs) => {
			runs[1].declared.provider = runs[0].declared.provider
		},
	],
	[
		"mixed scripted measurements",
		(runs) => {
			runs[0].measurementKind = "scripted-harness"
		},
	],
	[
		"wrong exact host",
		(runs) => {
			runs[0].conditions.hostVersion = "1.125.0"
		},
	],
	[
		"changed oracle",
		(runs) => {
			runs[0].conditions.fixtureDigest = "c".repeat(64)
		},
	],
	[
		"missing source proof",
		(runs) => {
			delete runs[0].build.manifestDigest
		},
	],
	[
		"dirty source proof",
		(runs) => {
			runs[0].build.sourceTreeState = "modified"
		},
	],
	[
		"mixed source builds",
		(runs) => {
			runs[0].build.sourceRevision = "c".repeat(40)
		},
	],
	[
		"failed correctness",
		(runs) => {
			runs[0].observations[0].correctness = "failed"
		},
	],
	[
		"duplicate sample",
		(runs) => {
			runs[0].observations[0] = runs[0].observations[1]
		},
	],
	[
		"missing cells",
		(runs) => {
			runs[0].observations.pop()
		},
	],
	[
		"different settings",
		(runs) => {
			for (const row of runs[0].observations) row.configurationDigest = "c".repeat(64)
		},
	],
	[
		"model fallback",
		(runs) => {
			runs[0].declared.modelId = "fallback"
		},
	],
	[
		"missing timing",
		(runs) => {
			runs[0].observations[0].durationMs = null
		},
	],
])
	test(`real task comparison refuses ${label}`, () => {
		const candidate = liveRuns("candidate")
		mutate(candidate)
		assert.throws(() => compareLiveQualityReports(liveRuns(), candidate), /Comparison not admitted/)
	})

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
		node: "v24.21.0",
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
