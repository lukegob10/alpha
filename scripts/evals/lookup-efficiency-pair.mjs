import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { caseIds, evaluateLookupBar, measurementKinds } from "./lookup-efficiency-report.mjs"

function finiteCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function requireCondition(condition, reason) {
	if (!condition) throw new Error(`Comparison not admitted: ${reason}`)
}

function numeric(metric) {
	return metric?.coverage !== "unavailable" && typeof metric?.value === "number" && Number.isFinite(metric.value)
		? metric.value
		: null
}

function median(values) {
	const present = values.filter((value) => value !== null)
	if (!present.length) return { value: null, coverage: "unavailable", reason: "No paired numeric samples" }
	const sorted = [...present].sort((left, right) => left - right)
	const middle = Math.floor(sorted.length / 2)
	const value = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
	return {
		value,
		coverage: present.length === values.length ? "complete" : "observed",
	}
}

function vector(report) {
	return {
		providerRequests: report.providerRequests,
		providerRetries: report.providerRetries,
		toolResults: report.toolResults,
		toolResultsByName: report.toolResultsByName,
		distinctSearchTools: report.distinctSearchTools,
		firstTool: report.firstTool,
		workflowTools: report.workflowTools,
		completionRejectionCount: report.completionRejections?.rejectionCount,
		barPassed: evaluateLookupBar(report).passed,
	}
}

function indexRun(run, promptIds, declaredSampleCount, role) {
	requireCondition(run && Array.isArray(run.reports), `${role} reports are required`)
	requireCondition(
		finiteCount(run.identity?.declaredSampleCount) && run.identity.declaredSampleCount === declaredSampleCount,
		`${role} declaredSampleCount mismatch`,
	)
	const allowed = new Set(promptIds)
	const indexed = new Map()
	const seenIds = new Set()
	for (const report of run.reports) {
		requireCondition(typeof report?.fixtureId === "string", `${role} fixtureId is required`)
		if (!allowed.has(report.fixtureId)) throw new Error("Comparison not admitted: mismatched prompt sets")
		seenIds.add(report.fixtureId)
		requireCondition(finiteCount(report.sampleIndex), `${role} sampleIndex is required`)
		requireCondition(report.sampleIndex < declaredSampleCount, `${role} sampleIndex exceeds declaredSampleCount`)
		for (const field of ["declaredSampleCount", "modelId", "reasoningPreference", "cacheState"]) {
			requireCondition(report[field] === run.identity[field], `${role} report ${field} mismatch`)
		}
		const key = `${report.fixtureId}:${report.sampleIndex}`
		requireCondition(!indexed.has(key), `duplicate ${role} sample`)
		indexed.set(key, report)
	}
	if (seenIds.size !== allowed.size || [...allowed].some((id) => !seenIds.has(id))) {
		throw new Error("Comparison not admitted: mismatched prompt sets")
	}
	return indexed
}

/**
 * Pair reference and candidate lookup reports on the same prompt ids.
 * Revisions may differ; other known conditions must match or be an explicit treatment.
 * Missing usage stays unavailable and is never treated as zero.
 */
export function pairReports(reference, candidate, contract = {}) {
	const promptIds = contract.promptIds ?? [...caseIds]
	const declaredSampleCount = contract.declaredSampleCount
	requireCondition(
		finiteCount(declaredSampleCount) && declaredSampleCount > 0,
		"declaredSampleCount must be predeclared",
	)
	requireCondition(Array.isArray(promptIds) && promptIds.length > 0, "prompt ids are required")
	requireCondition(
		promptIds.every((id) => caseIds.has(id)) && new Set(promptIds).size === promptIds.length,
		"unknown or duplicate prompt id",
	)
	const before = indexRun(reference, promptIds, declaredSampleCount, "reference")
	const after = indexRun(candidate, promptIds, declaredSampleCount, "candidate")
	const allowedDifferenceFields = contract.allowedDifferenceFields ?? []
	requireCondition(
		Array.isArray(allowedDifferenceFields) &&
			new Set(allowedDifferenceFields).size === allowedDifferenceFields.length &&
			allowedDifferenceFields.every((field) => ["modelId", "reasoningPreference", "cacheState"].includes(field)),
		"unknown or duplicate allowed difference field",
	)
	const nonAdmissionReasons = []
	for (const field of ["modelId", "reasoningPreference", "cacheState"]) {
		const left = reference.identity?.[field]
		const right = candidate.identity?.[field]
		const known = (value) => typeof value === "string" && value.trim().length > 0 && value !== "unknown"
		if (!known(left) || !known(right)) nonAdmissionReasons.push(`${field} is unknown`)
		else if (left !== right && !allowedDifferenceFields.includes(field))
			nonAdmissionReasons.push(`${field} mismatch without a declared treatment`)
	}
	const kinds = new Set([...before.values(), ...after.values()].map((report) => report.measurementKind))
	if (kinds.size !== 1 || [...kinds].some((kind) => !measurementKinds.includes(kind)))
		nonAdmissionReasons.push("measurement kinds are mixed or unknown")
	const admitted = nonAdmissionReasons.length === 0
	const samples = []
	for (const promptId of promptIds) {
		for (let sampleIndex = 0; sampleIndex < declaredSampleCount; sampleIndex++) {
			const key = `${promptId}:${sampleIndex}`
			requireCondition(before.has(key), `missing reference ${key}`)
			if (!after.has(key)) throw new Error("Comparison not admitted: missing candidate")
			const left = before.get(key)
			const right = after.get(key)
			const leftRequests = numeric(left.providerRequests)
			const rightRequests = numeric(right.providerRequests)
			const leftTools = numeric(left.toolResults)
			const rightTools = numeric(right.toolResults)
			samples.push({
				fixtureId: promptId,
				sampleIndex,
				reference: vector(left),
				candidate: vector(right),
				delta: {
					providerRequests:
						!admitted || leftRequests === null || rightRequests === null
							? {
									value: null,
									coverage: "unavailable",
									reason: "Comparable paired request counts are unavailable",
								}
							: {
									reference: leftRequests,
									candidate: rightRequests,
									delta: rightRequests - leftRequests,
								},
					toolResults:
						!admitted || leftTools === null || rightTools === null
							? {
									value: null,
									coverage: "unavailable",
									reason: "Comparable paired tool counts are unavailable",
								}
							: { reference: leftTools, candidate: rightTools, delta: rightTools - leftTools },
				},
			})
		}
	}
	const liveMeasurement =
		admitted && [...kinds].some((kind) => kind === "runtime-observation" || kind === "live-supplemental")
	return {
		schemaVersion: 1,
		benchmark: "lookup-efficiency-v1",
		admitted,
		nonAdmissionReasons,
		allowedDifferenceFields: [...allowedDifferenceFields],
		performanceAcceptance: {
			status: "not-evaluated",
			reasons: ["Counter observations do not establish a performance decision"],
		},
		declaredSampleCount,
		promptIds: [...promptIds],
		medians: {
			referenceProviderRequests: median(samples.map((sample) => numeric(sample.reference.providerRequests))),
			candidateProviderRequests: median(samples.map((sample) => numeric(sample.candidate.providerRequests))),
			referenceToolResults: median(samples.map((sample) => numeric(sample.reference.toolResults))),
			candidateToolResults: median(samples.map((sample) => numeric(sample.candidate.toolResults))),
		},
		samples,
		liveMeasurement,
		interpretation: !admitted
			? "Descriptive observations only; comparison conditions are incomplete or confounded"
			: liveMeasurement
				? "Paired lookup counters from recorded samples; not a general quality or speed improvement"
				: "Paired lookup counters only. Scripted traces prove reporter/contract; NOR-36 scripted 2/1 remains a different measurement",
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	if (process.argv.length !== 4 && process.argv.length !== 5)
		throw new Error(
			"Usage: node scripts/evals/lookup-efficiency-pair.mjs <reference-run.json> <candidate-run.json> [pair.json]",
		)
	const contract = { declaredSampleCount: undefined, promptIds: undefined }
	const reference = JSON.parse(await fs.readFile(process.argv[2], "utf8"))
	const candidate = JSON.parse(await fs.readFile(process.argv[3], "utf8"))
	contract.declaredSampleCount = reference.identity?.declaredSampleCount
	contract.promptIds = reference.identity?.promptIds
	const result = pairReports(reference, candidate, contract)
	const encoded = `${JSON.stringify(result, null, 2)}\n`
	if (process.argv[4]) await fs.writeFile(process.argv[4], encoded)
	else process.stdout.write(encoded)
}
