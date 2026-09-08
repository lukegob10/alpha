import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

// Run from a quiet checkout: pnpm exec node scripts/benchmarks/nor38-failure-overhead.mjs
// This measures extension detector code in-process, not the CLI, scheduler, tools, or a model.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const detectorRelativePath = "src/core/tools/ToolRepetitionDetector.ts"
const failureRelativePath = "src/core/tools/ToolFailure.ts"
const outputPath = path.join(root, "docs/benchmarks/nor38-runtime-overhead-20260907.json")
const requireFromExtension = createRequire(path.join(root, "src/package.json"))
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trimEnd()
const baselineCommit = git(["rev-parse", "HEAD"])
const baselineSource = git(["show", `${baselineCommit}:${detectorRelativePath}`])
const currentSource = await fs.readFile(path.join(root, detectorRelativePath), "utf8")
const failureSource = await fs.readFile(path.join(root, failureRelativePath), "utf8")
const warmupPairs = 2
const timedPairs = 12
const observationsPerDetector = 16
const pendingFailures = 32
const startedAt = new Date().toISOString()
const started = performance.now()

async function loadSource(source, relativePath) {
	const compiled = await build({
		stdin: {
			contents: source,
			resolveDir: path.dirname(path.join(root, relativePath)),
			sourcefile: path.join(root, relativePath),
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
		logLevel: "silent",
		external: ["safe-stable-stringify", "zod"],
		plugins: [
			{
				name: "detector-i18n-only",
				setup(plugin) {
					plugin.onResolve({ filter: /^\.\.\/\.\.\/i18n$/ }, () => ({ path: "i18n", namespace: "fixture" }))
					plugin.onLoad({ filter: /^i18n$/, namespace: "fixture" }, () => ({
						contents: "export const t = (key) => key",
						loader: "js",
					}))
				},
			},
		],
	})
	const module = { exports: {} }
	new Function("require", "module", "exports", compiled.outputFiles[0].text)(
		requireFromExtension,
		module,
		module.exports,
	)
	return module.exports
}

const baselineModule = await loadSource(baselineSource, detectorRelativePath)
const currentModule = await loadSource(currentSource, detectorRelativePath)
const failureModule = await loadSource(failureSource, failureRelativePath)
const variants = {
	baseline: { Detector: baselineModule.ToolRepetitionDetector, normalize: () => undefined },
	stage1: { Detector: currentModule.ToolRepetitionDetector, normalize: failureModule.normalizeToolFailure },
}
assert.equal(typeof variants.baseline.Detector.prototype.getRetryBlock, "undefined")
assert.equal(typeof variants.stage1.Detector.prototype.getRetryBlock, "function")

function fixtureArguments(bytes, index, polling) {
	const args = polling
		? { agent_id: "fixture-agent", cursor: "" }
		: { path: `src/fixture-${String(index).padStart(2, "0")}.txt`, content: "" }
	const payloadKey = polling ? "cursor" : "content"
	args[payloadKey] = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(args)))
	assert.equal(Buffer.byteLength(JSON.stringify(args)), bytes)
	return Object.freeze(args)
}

const seeds = Array.from({ length: pendingFailures }, (_, index) => ({
	failure: {
		toolName: `fixture_capability_${index}`,
		args: { operation: "optional" },
		status: "error",
		kind: "other",
		failure: {
			reason: "pre_launch_rejected",
			affectedScope: { kind: "capability", fingerprint: sha256(`public-fixture-${index}`) },
			effectsStarted: "no",
			outcome: "known",
			recovery: { kind: "repair" },
		},
	},
	read: {
		toolName: "read_file",
		args: { path: `seed-${index}.txt` },
		status: "success",
		kind: "read",
		scope: "/public-fixture/seed",
	},
}))

function makeDetector(variant, seeded) {
	const detector = new variant.Detector()
	if (seeded) {
		for (const seed of seeds) {
			assert.equal(detector.recordOutcome(seed.failure).action, "continue")
			assert.equal(detector.recordOutcome(seed.read).action, "continue")
		}
	}
	return detector
}

// Verify retained blockers using public behavior, outside timing and on disposable instances.
for (const [name, variant] of Object.entries(variants)) {
	const probe = makeDetector(variant, true)
	for (let attempt = 0; attempt < 11; attempt++) probe.recordOutcome(seeds[0].failure)
	const block = probe.getRetryBlock?.(seeds[0].failure.toolName, seeds[0].failure.args)
	assert.equal(block?.reason, name === "stage1" ? "pre_launch_rejected" : undefined)
}

const workloads = []
for (const seeded of [false, true]) {
	for (const argumentBytes of [128, 8 * 1024, 128 * 1024]) {
		workloads.push({
			name: `successful-mutation-${argumentBytes}B-${seeded ? "32-pending" : "empty"}`,
			argumentBytes,
			seeded,
			polling: false,
			detectorsPerBatch: argumentBytes === 128 ? 64 : argumentBytes === 8192 ? 32 : 4,
		})
	}
	workloads.push({
		name: `unchanged-successful-poll-128B-${seeded ? "32-pending" : "empty"}`,
		argumentBytes: 128,
		seeded,
		polling: true,
		detectorsPerBatch: 64,
	})
}

let consumedOutputs = 0
function summarize(samples, operations) {
	const durations = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
	const middle = Math.floor(durations.length / 2)
	const medianMs = (durations[middle - 1] + durations[middle]) / 2
	return { medianMs, medianMicrosecondsPerOperation: (medianMs * 1000) / operations }
}

function measureBatch(variantName, workload, observations) {
	const variant = variants[variantName]
	const detectors = Array.from({ length: workload.detectorsPerBatch }, () => makeDetector(variant, workload.seeded))
	const results = new Array(detectors.length * observations.length)
	let resultIndex = 0
	let unexpectedBlocks = 0
	const start = performance.now()
	for (const detector of detectors) {
		for (const observation of observations) {
			// Model the two serial Scheduler retry checks and the Task outcome observation.
			// Baseline has no retry API or failure validation: its adapters return undefined.
			const firstBlock = variant.normalize(detector.getRetryBlock?.(observation.toolName, observation.args))
			const secondBlock = variant.normalize(detector.getRetryBlock?.(observation.toolName, observation.args))
			unexpectedBlocks += Number(firstBlock !== undefined) + Number(secondBlock !== undefined)
			results[resultIndex++] = detector.recordOutcome(observation)
		}
	}
	const elapsedMs = performance.now() - start
	assert.equal(unexpectedBlocks, 0)
	for (let index = 0; index < results.length; index++) {
		const decision = results[index]
		assert.equal(decision.action, "continue")
		assert.equal(decision.failure, undefined)
		assert.equal(decision.stagnantCalls, !workload.polling && index % observations.length === 0 ? 1 : 0)
		consumedOutputs += decision.retainedOutcomes + decision.stagnantCalls + 1
	}
	return { elapsedMs, operations: resultIndex }
}

function checkDeadline() {
	if (performance.now() - started > 110_000) throw new Error("Benchmark exceeded its 110-second work budget")
}

async function compare(name, operations, measure) {
	const rawSamples = []
	for (let pair = -warmupPairs; pair < timedPairs; pair++) {
		checkDeadline()
		const order = Math.abs(pair) % 2 === 0 ? ["baseline", "stage1"] : ["stage1", "baseline"]
		for (let position = 0; position < order.length; position++) {
			const variant = order[position]
			const sample = measure(variant)
			if (pair >= 0) rawSamples.push({ pair, position, variant, ...sample })
		}
		// Give the host an event-loop boundary without adding a timed delay.
		await new Promise((resolve) => setImmediate(resolve))
	}
	const baseline = summarize(
		rawSamples.filter((sample) => sample.variant === "baseline"),
		operations,
	)
	const stage1 = summarize(
		rawSamples.filter((sample) => sample.variant === "stage1"),
		operations,
	)
	return {
		name,
		operationsPerBatch: operations,
		baseline,
		stage1,
		deltaMicrosecondsPerOperation: stage1.medianMicrosecondsPerOperation - baseline.medianMicrosecondsPerOperation,
		ratioOfMedians: stage1.medianMs / baseline.medianMs,
		rawSamples,
	}
}

const results = []
for (const workload of workloads) {
	const observations = Array.from({ length: observationsPerDetector }, (_, index) => ({
		toolName: workload.polling ? "wait_agent" : "write_to_file",
		args: fixtureArguments(workload.argumentBytes, index, workload.polling),
		status: "success",
		kind: workload.polling ? "poll" : "mutation",
		scope: "/public-fixture/workspace",
		...(workload.polling ? {} : { stateFingerprint: `fixture-state-${index}` }),
	}))
	const measured = await compare(workload.name, workload.detectorsPerBatch * observations.length, (variant) =>
		measureBatch(variant, workload, observations),
	)
	results.push({ ...measured, workload })
}

const normalizationOperations = 25_000
const absentMetadata = await compare("normalize-absent-failure-metadata", normalizationOperations, (variantName) => {
	const normalize = variants[variantName].normalize
	let undefinedCount = 0
	const start = performance.now()
	for (let index = 0; index < normalizationOperations; index++)
		undefinedCount += Number(normalize(undefined) === undefined)
	const elapsedMs = performance.now() - start
	assert.equal(undefinedCount, normalizationOperations)
	consumedOutputs += undefinedCount
	return { elapsedMs, operations: normalizationOperations }
})

const report = {
	schemaVersion: 1,
	startedAt,
	completedAt: new Date().toISOString(),
	wallTimeMs: performance.now() - started,
	command: "pnpm exec node scripts/benchmarks/nor38-failure-overhead.mjs",
	baselineCommit,
	sources: {
		baselineDetectorSha256: sha256(baselineSource),
		stage1DetectorSha256: sha256(currentSource),
		stage1FailureSha256: sha256(failureSource),
	},
	environment: {
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
		cpu: os.cpus()[0]?.model,
		logicalCpus: os.cpus().length,
	},
	method: {
		warmupPairs,
		timedPairs,
		order: "AB/BA alternates by pair, with separately reported raw samples and ratios of medians",
		compiledInMemory: "Installed esbuild; original detector source from git-show HEAD and current working tree",
		dependencies: "Both variants use the same installed extension safe-stable-stringify and zod packages",
		stub: "Only detector ../../i18n is stubbed to return its key; this benchmark never calls legacy check()",
		adapter: "Two optional getRetryBlock calls, each normalized, followed by recordOutcome per serial tool call",
		baselineAdapter: "Baseline has no getRetryBlock or failure normalizer; missing features return undefined",
		argumentBytes:
			"Exact UTF-8 byte length of the JSON arguments; public ASCII payload; same objects for both variants",
		state: "Fresh default-config detectors per batch; 16 healthy observations each prevent novelty-window exhaustion",
		pendingState:
			"32 distinct known pre-launch failures, each followed by the same fresh read in both variants; seeded outside timing",
		intentionalSemanticDifference:
			"Stage 1 retains scoped failure allowances; baseline ignores failure metadata. Healthy measured decisions agree",
		setupExcluded: "Compilation, fixtures, detector creation, failure-state seeding, and output assertions",
		outputs:
			"Every gate output counted; every decision checked for continue, absent failure, and expected stagnation; values consumed",
		modelRequests: 0,
		toolExecutions: 0,
		limitations: [
			"Local synchronous microbenchmark, not full ToolScheduler or Task execution; canonical-name lookup and collector metadata handling are excluded",
			"No provider, VS Code host, network, filesystem tool work, prompt/token effects, tool round-trip savings, or end-to-end quality is measured",
			"Default repetition policy is enabled; pending state has 32 blockers, not every possible saturation pattern",
			"Absent-metadata baseline is an adapter no-op and may be JIT-optimized; its ratio does not represent whole-call slowdown",
			"Timing includes natural garbage collection but does not measure allocation volume or retained heap bytes",
			"One process on one machine; medians and raw samples are evidence for this workload, not a general task-speed claim",
		],
	},
	consumedOutputs,
	results,
	absentMetadata,
}
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(
	JSON.stringify({
		output: path.relative(root, outputPath),
		wallTimeMs: report.wallTimeMs,
		cases: results.length + 1,
	}),
)
