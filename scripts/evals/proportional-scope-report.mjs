import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

export const phases = ["discovery", "implementation", "validation", "finalization", "unattributed"]
export const categories = ["read", "search", "mutation", "validation", "terminal", "delegation", "other"]
const caseFile = new URL("../../evals/proportional-scope/cases.json", import.meta.url)
const caseIds = new Set(JSON.parse(await fs.readFile(caseFile, "utf8")).cases.map(({ id }) => id))
const numericFields = ["modelCalls", "tokensIn", "tokensOut", "cacheReads", "cacheWrites", "durationMs"]
const toolCategories = new Map([
	["read_file", "read"],
	["list_files", "read"],
	["search_files", "search"],
	["codebase_search", "search"],
	["apply_diff", "mutation"],
	["write_to_file", "mutation"],
	["edit_file", "mutation"],
	["execute_command", "terminal"],
	["new_task", "delegation"],
])

function count(value, coverage = "complete") {
	return { value, coverage }
}

function unavailable(reason) {
	return { value: null, coverage: "unavailable", reason }
}

function finiteCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function outputBytes(output) {
	if (output === undefined) return null
	return Buffer.byteLength(typeof output === "string" ? output : JSON.stringify(output), "utf8")
}

/**
 * Consumes the EvalTraceEvent shape from packages/evals/src/grading/types.ts and
 * usage fields emitted by packages/evals/src/cli/processTask.ts. No raw payload,
 * tool argument, command, path, fingerprint, or response is copied to the report.
 */
export function buildReport(input) {
	if (!caseIds.has(input.fixtureId)) throw new Error("Unknown proportional-scope fixture")
	if (!["runtime-observation", "scripted-harness", "reporter-contract-test"].includes(input.measurementKind)) {
		throw new Error("Explicit measurementKind is required")
	}
	if (!["complete", "partial", "unavailable"].includes(input.traceCoverage)) {
		throw new Error("Explicit traceCoverage is required")
	}
	if (!Array.isArray(input.trace) || input.trace.length > 100_000) throw new Error("Invalid or oversized trace")
	if (input.traceCoverage === "unavailable" && input.trace.length) throw new Error("Unavailable trace has events")
	const annotations = new Map()
	for (const annotation of input.annotations ?? []) {
		if (!finiteCount(annotation.sequence) || annotations.has(annotation.sequence)) {
			throw new Error("Duplicate or invalid annotation sequence")
		}
		if (!phases.includes(annotation.phase)) throw new Error("Invalid phase")
		if (annotation.category !== undefined && !categories.includes(annotation.category)) {
			throw new Error("Invalid tool category")
		}
		if (annotation.purpose !== undefined && !["polling", "recovery", "ordinary"].includes(annotation.purpose)) {
			throw new Error("Invalid tool purpose")
		}
		if (annotation.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(annotation.fingerprint)) {
			throw new Error("Fingerprint must be a run-local keyed digest")
		}
		annotations.set(annotation.sequence, annotation)
	}
	const sequences = new Set()
	const groups = Object.fromEntries(phases.map((phase) => [phase, []]))
	for (const event of input.trace) {
		if (!finiteCount(event.sequence) || sequences.has(event.sequence) || typeof event.type !== "string") {
			throw new Error("Duplicate or invalid trace sequence/type")
		}
		sequences.add(event.sequence)
		groups[annotations.get(event.sequence)?.phase ?? "unattributed"].push(event)
	}
	for (const sequence of annotations.keys()) {
		if (!sequences.has(sequence)) throw new Error("Annotation references missing event")
	}
	const coverage = input.traceCoverage === "complete" ? "complete" : "observed"
	const phaseCoverage = groups.unattributed.length ? "observed" : coverage
	const summarize = (events, metricCoverage) => {
		const tools = events.filter(({ type }) => type === "agent.turn.tool_result")
		const requests = events.filter(({ type }) => type === "agent.turn.model_request_started")
		const assistants = events.filter(({ type }) => type === "agent.turn.assistant_committed")
		const usages = events.filter(({ type }) => type === "agent.turn.request_usage")
		// The canonical start event has no request identity. Only a trusted observer
		// can supply its mapping; equal row counts cannot establish usage coverage.
		const requestIndexes = requests.map((event) => annotations.get(event.sequence)?.requestIndex)
		const usageIndexes = usages.map((event) => record(event.payload).requestIndex)
		const requestIdentities = new Set(requestIndexes)
		const matchedUsage =
			requestIndexes.every(finiteCount) &&
			usageIndexes.every(finiteCount) &&
			requestIdentities.size === requests.length &&
			new Set(usageIndexes).size === usages.length &&
			requests.length === usages.length &&
			usageIndexes.every((index) => requestIdentities.has(index))
		const categoryCounts = Object.fromEntries(categories.map((category) => [category, 0]))
		let bytes = 0
		let missingOutput = false
		let missingFingerprint = false
		let repetitions = 0
		let checkReruns = 0
		const fingerprints = new Set()
		for (const event of tools) {
			const payload = record(event.payload)
			const annotation = annotations.get(event.sequence)
			const category = annotation?.category ?? toolCategories.get(payload.name ?? payload.tool) ?? "other"
			categoryCounts[category]++
			const size = outputBytes(payload.output)
			if (size === null) missingOutput = true
			else bytes += size
			if (!annotation?.fingerprint) missingFingerprint = true
			else {
				const key = `${category}:${annotation.fingerprint}`
				if (fingerprints.has(key)) {
					repetitions++
					if (category === "validation") checkReruns++
				}
				fingerprints.add(key)
			}
		}
		const usageMetric = (field) => {
			if (!matchedUsage || usages.some((event) => !finiteCount(record(event.payload)[field]))) {
				return unavailable("Request usage does not cover every observed model request")
			}
			return count(
				usages.reduce((sum, event) => sum + record(event.payload)[field], 0),
				metricCoverage,
			)
		}
		const result = {
			modelCalls: count(requests.length, metricCoverage),
			assistantTextBytes:
				assistants.length !== requests.length ||
				assistants.some((event) => typeof record(record(event.payload).response).text !== "string")
					? unavailable("Assistant text does not cover every observed model request")
					: count(
							assistants.reduce(
								(sum, event) =>
									sum + Buffer.byteLength(record(record(event.payload).response).text, "utf8"),
								0,
							),
							metricCoverage,
						),
			toolResults: count(tools.length, metricCoverage),
			commandCount: count(
				tools.filter((event) => {
					const payload = record(event.payload)
					return (payload.name ?? payload.tool) === "execute_command"
				}).length,
				metricCoverage,
			),
			pollingToolResults: tools.some((event) => annotations.get(event.sequence)?.purpose === undefined)
				? unavailable("Tool-purpose attribution is incomplete")
				: count(
						tools.filter((event) => annotations.get(event.sequence)?.purpose === "polling").length,
						metricCoverage,
					),
			recoveryToolResults: tools.some((event) => annotations.get(event.sequence)?.purpose === undefined)
				? unavailable("Tool-purpose attribution is incomplete")
				: count(
						tools.filter((event) => annotations.get(event.sequence)?.purpose === "recovery").length,
						metricCoverage,
					),
			toolCategories: Object.fromEntries(
				categories.map((key) => [key, count(categoryCounts[key], metricCoverage)]),
			),
			tokensIn: usageMetric("inputTokens"),
			tokensOut: usageMetric("outputTokens"),
			cacheReads: usageMetric("cacheReadTokens"),
			cacheWrites: unavailable("Canonical request_usage does not expose cache-write tokens"),
			toolOutputBytes: missingOutput
				? unavailable("Tool output is missing from trace")
				: count(bytes, metricCoverage),
			repetitions: missingFingerprint
				? unavailable("Operation fingerprints are incomplete")
				: count(repetitions, metricCoverage),
			checkReruns: missingFingerprint
				? unavailable("Operation fingerprints are incomplete")
				: count(checkReruns, metricCoverage),
			compactions: count(
				events.filter(
					({ type, payload }) =>
						type === "agent.turn.compaction_completed" &&
						["summary", "truncation"].includes(record(payload).action),
				).length,
				metricCoverage,
			),
			durationMs: unavailable("Trace events do not establish exclusive phase durations"),
		}
		if (input.traceCoverage === "unavailable") {
			for (const key of Object.keys(result)) {
				result[key] =
					key === "toolCategories"
						? Object.fromEntries(categories.map((category) => [category, unavailable("Trace unavailable")]))
						: unavailable("Trace unavailable")
			}
		}
		return result
	}
	const aggregateUsage = Object.fromEntries(
		numericFields.map((field) => [
			field,
			finiteCount(input.usage?.[field]) ? count(input.usage[field]) : unavailable("Aggregate usage not supplied"),
		]),
	)
	const decisions = ["passed", "outcome_failed", "safety_failed", "grader_error"]
	const outcomes = ["completed", "blocked", "failed", "cancelled"]
	const completionFields = ["candidateCount", "rejectionCount", "repairToolCount", "runtimeWaitMs"]
	return {
		schemaVersion: 1,
		fixtureId: input.fixtureId,
		measurementKind: input.measurementKind,
		traceCoverage: input.traceCoverage,
		sampleIndex: finiteCount(input.sampleIndex) ? input.sampleIndex : null,
		cacheState: ["cold", "warm"].includes(input.cacheState) ? input.cacheState : "unknown",
		revision: /^[a-f0-9]{40}$/.test(input.revision ?? "") ? input.revision : null,
		workingTree: ["clean", "modified"].includes(input.workingTree) ? input.workingTree : "unknown",
		fixtureDigest: /^[a-f0-9]{64}$/.test(input.fixtureDigest ?? "") ? input.fixtureDigest : null,
		modelConfigurationDigest: /^[a-f0-9]{64}$/.test(input.modelConfigurationDigest ?? "")
			? input.modelConfigurationDigest
			: null,
		correctness: decisions.includes(input.graderDecision) ? input.graderDecision : "unavailable",
		outcome: outcomes.includes(input.outcome) ? input.outcome : "unavailable",
		aggregateUsage,
		observedTotal: summarize(input.trace, coverage),
		phases: Object.fromEntries(phases.map((phase) => [phase, summarize(groups[phase], phaseCoverage)])),
		completionStage: Object.fromEntries(
			completionFields.map((field) => [
				field,
				finiteCount(input.completionStage?.[field])
					? count(input.completionStage[field])
					: unavailable("Completion-stage observer not supplied"),
			]),
		),
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	if (process.argv.length !== 4)
		throw new Error("Usage: node scripts/evals/proportional-scope-report.mjs <observations.json> <report.json>")
	const source = await fs.readFile(process.argv[2], "utf8")
	if (Buffer.byteLength(source) > 64 * 1024 * 1024) throw new Error("Observation file exceeds 64 MiB")
	await fs.writeFile(process.argv[3], `${JSON.stringify(buildReport(JSON.parse(source)), null, 2)}\n`)
}
