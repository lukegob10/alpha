import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { require as tsRequire } from "tsx/cjs/api"

const { readBounded, rejectSymlinkComponents } = tsRequire(
	"../../apps/vscode-e2e/src/evidence/paths.ts",
	import.meta.url,
)
export const benchmarkEntries = [
	"src/core/agent/benchmarks/StepContext.benchmark.ts",
	"scripts/benchmarks/subagent-context-capture.ts",
]
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const digest = (value) => createHash("sha256").update(value).digest("hex")
const fixtureDigest = (entry, measurements) =>
	digest(
		JSON.stringify(
			entry === benchmarkEntries[0]
				? {
						fixtureDigest: measurements.fixtureDigest,
						fixtureBytes: measurements.fixtureBytes,
						warmups: measurements.warmups,
					}
				: {
						benchmark: measurements.benchmark,
						samples: measurements.samples,
						capturesPerSample: measurements.capturesPerSample,
						messageCharacters: measurements.messageCharacters,
						cases: measurements.observations?.map(({ native, turns }) => ({ native, turns })),
					},
		),
	)

/** These existing fixtures own measurement. Admission only checks their declared workload and bounded observations. */
export function benchmarkVerdict(receipt) {
	try {
		if (
			receipt?.schemaVersion !== 1 ||
			receipt.kind !== "alpha-offline-benchmarks" ||
			typeof receipt.node !== "string" ||
			typeof receipt.platform !== "string" ||
			typeof receipt.arch !== "string" ||
			typeof receipt.cpu !== "string" ||
			!Array.isArray(receipt.workloads) ||
			receipt.workloads.length !== benchmarkEntries.length
		)
			throw new Error()
		for (const [index, workload] of receipt.workloads.entries()) {
			if (
				workload.entry !== benchmarkEntries[index] ||
				!hash(workload.entrySha256) ||
				!hash(workload.fixtureSha256) ||
				workload.fixtureSha256 !== fixtureDigest(workload.entry, workload.measurements)
			)
				throw new Error()
		}
		const step = receipt.workloads[0].measurements
		if (
			step?.node !== receipt.node ||
			!hash(step.fixtureDigest) ||
			!hash(step.contextDigest) ||
			!Number.isSafeInteger(step.fixtureBytes) ||
			step.fixtureBytes <= 0 ||
			step.warmups !== 3 ||
			!Array.isArray(step.samplesMs) ||
			step.samplesMs.length !== 10 ||
			!step.samplesMs.every(finite) ||
			!finite(step.medianMs)
		)
			throw new Error()
		const context = receipt.workloads[1].measurements
		if (
			context?.benchmark !== "subagent-none-context-capture" ||
			context.node !== receipt.node ||
			context.provider !== "none" ||
			context.samples !== 5 ||
			context.capturesPerSample !== 2 ||
			context.messageCharacters !== 4096 ||
			!Array.isArray(context.observations) ||
			context.observations.length !== 6
		)
			throw new Error()
		for (const [index, observation] of context.observations.entries()) {
			if (
				observation.native !== index >= 3 ||
				observation.turns !== [0, 100, 1000][index % 3] ||
				observation.messages !== observation.turns * 2 ||
				observation.contentReads !== 0 ||
				observation.captures !== 10 ||
				!finite(observation.meanCaptureMs) ||
				!finite(observation.medianCaptureMs) ||
				!hash(observation.manifestDigest)
			)
				throw new Error()
		}
		return { status: "passed", kind: "offline-benchmark", receipt, timingClaim: "diagnostic-only" }
	} catch {
		return { status: "failed", reason: "invalid_benchmark_receipt" }
	}
}

export async function collectBenchmarks(root, load = (entry) => tsRequire(path.join(root, entry), import.meta.url)) {
	const workloads = []
	for (const entry of benchmarkEntries) {
		const chunks = []
		const previous = console.log
		// Each fixed entry emits one JSON value. This isolated adapter adds persistence, never measurement logic.
		console.log = (...args) => {
			if (
				args.length !== 1 ||
				typeof args[0] !== "string" ||
				Buffer.byteLength(args[0]) > 512 * 1024 ||
				chunks.length
			)
				throw new Error("Benchmark output exceeded its fixed JSON contract")
			chunks.push(args[0])
		}
		try {
			await load(entry)
		} finally {
			console.log = previous
		}
		if (chunks.length !== 1) throw new Error("Benchmark did not emit its measurements")
		const measurements = JSON.parse(chunks[0])
		workloads.push({
			entry,
			entrySha256: digest(await readBounded(path.join(root, entry), 1024 * 1024)),
			fixtureSha256: fixtureDigest(entry, measurements),
			measurements,
		})
	}
	const receipt = {
		schemaVersion: 1,
		kind: "alpha-offline-benchmarks",
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? "unknown",
		workloads,
	}
	if (benchmarkVerdict(receipt).status !== "passed") throw new Error("Benchmark fixture or operation bound failed")
	return receipt
}

export function compareBenchmarks(baseline, candidate) {
	if (
		benchmarkVerdict(baseline).status !== "passed" ||
		benchmarkVerdict(candidate).status !== "passed" ||
		["node", "platform", "arch", "cpu"].some((key) => baseline[key] !== candidate[key]) ||
		baseline.workloads.some(
			(workload, index) => workload.fixtureSha256 !== candidate.workloads[index].fixtureSha256,
		)
	)
		return { status: "unavailable", reason: "unmatched_runtime_or_workload" }
	return {
		status: "diagnostic-comparison",
		claim: "No latency acceptance threshold or live quality claim",
		stepContextMedianMs: {
			baseline: baseline.workloads[0].measurements.medianMs,
			candidate: candidate.workloads[0].measurements.medianMs,
		},
		subagentContextMedianMs: candidate.workloads[1].measurements.observations.map((value, index) => ({
			native: value.native,
			turns: value.turns,
			baseline: baseline.workloads[1].measurements.observations[index].medianCaptureMs,
			candidate: value.medianCaptureMs,
		})),
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = fileURLToPath(new URL("../../", import.meta.url))
	const output = process.env.ALPHA_HARNESS_BENCHMARK_FILE
	const relative = output ? path.relative(path.join(root, "artifacts/harness"), output) : ""
	if (
		!output ||
		!path.isAbsolute(output) ||
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		!relative.endsWith(".json")
	)
		throw new Error("Run through the benchmarks harness lane")
	await rejectSymlinkComponents(output)
	await writeFile(output, JSON.stringify(await collectBenchmarks(root), null, 2) + "\n", { flag: "wx", mode: 0o600 })
}
