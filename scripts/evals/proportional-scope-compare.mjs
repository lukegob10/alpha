import fs from "node:fs/promises"
import { URL } from "node:url"
import { phases } from "./proportional-scope-report.mjs"

const fixtureIds = JSON.parse(
	await fs.readFile(new URL("../../evals/proportional-scope/cases.json", import.meta.url), "utf8"),
).cases.map(({ id }) => id)
const metrics = ["modelCalls", "toolResults", "commandCount", "toolOutputBytes"]
const identityFields = ["harnessDigest", "oracleDigest", "configurationDigest", "cacheDigest"]
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const complete = (metric) => metric?.coverage === "complete" && integer(metric.value)

function requireCondition(condition, reason) {
	if (!condition) throw new Error(`Comparison not admitted: ${reason}`)
}

function admitRun(run, contract) {
	requireCondition(run && Array.isArray(run.reports), "reports are required")
	for (const field of identityFields) requireCondition(digest(run.identity?.[field]), `missing ${field}`)
	requireCondition(
		["provider", "unavailable"].includes(run.identity?.tokenEvidence),
		"explicit token evidence source is required",
	)
	const admitted = new Map()
	let revision
	for (const report of run.reports) {
		requireCondition(report?.schemaVersion === 1, "unsupported report schema")
		requireCondition(fixtureIds.includes(report.fixtureId), "unknown fixture")
		requireCondition(contract.sampleIndexes.includes(report.sampleIndex), "undeclared sample ordinal")
		const key = `${report.fixtureId}:${report.sampleIndex}`
		requireCondition(!admitted.has(key), "duplicate fixture/sample")
		requireCondition(report.measurementKind === contract.measurementKind, "measurement kind mismatch")
		requireCondition(
			report.correctness === "passed" && report.outcome === "completed",
			"quality failed or unavailable",
		)
		requireCondition(
			report.workingTree === "clean" && digest(report.revision, 40),
			"clean source revision required",
		)
		revision ??= report.revision
		requireCondition(revision === report.revision, "mixed source revisions within run")
		requireCondition(report.traceCoverage === "complete", "incomplete trace")
		requireCondition(["cold", "warm"].includes(report.cacheState), "unknown report cache state")
		requireCondition(
			digest(report.fixtureDigest) && digest(report.modelConfigurationDigest),
			"missing report identity",
		)
		for (const group of [report.observedTotal, ...phases.map((phase) => report.phases?.[phase])]) {
			for (const metric of metrics) {
				requireCondition(complete(group?.[metric]), `incomplete ${metric} or phase attribution`)
			}
		}
		for (const metric of metrics) {
			requireCondition(report.phases.unattributed[metric].value === 0, "unattributed work")
			const phaseTotal = phases.reduce((total, phase) => total + report.phases[phase][metric].value, 0)
			requireCondition(
				integer(phaseTotal) && phaseTotal === report.observedTotal[metric].value,
				"phase totals disagree",
			)
		}
		admitted.set(key, report)
	}
	for (const fixtureId of fixtureIds) {
		for (const sample of contract.sampleIndexes) {
			requireCondition(admitted.has(`${fixtureId}:${sample}`), "missing fixture/sample")
		}
	}
	return admitted
}

/**
 * Run identities are external declarations: the caller must hash the full loaded
 * harness (including scripts/repairs), independent oracle, configuration and cache
 * protocol. This gate validates comparability, not the truth of those declarations.
 * Provider evidence must originate in canonical request usage, never request bytes
 * or synthetic/local tokenizer counts. No strategy or performance claim is inferred.
 */
export function compareReports(reference, candidate, contract) {
	requireCondition(
		Array.isArray(contract?.sampleIndexes) &&
			contract.sampleIndexes.length > 0 &&
			contract.sampleIndexes.every(integer) &&
			new Set(contract.sampleIndexes).size === contract.sampleIndexes.length,
		"unique declared sample ordinals are required",
	)
	requireCondition(
		["runtime-observation", "scripted-harness"].includes(contract.measurementKind),
		"runtime or scripted measurement kind is required",
	)
	const before = admitRun(reference, contract)
	const after = admitRun(candidate, contract)
	for (const field of [...identityFields, "tokenEvidence"]) {
		requireCondition(reference.identity[field] === candidate.identity[field], `${field} mismatch`)
	}
	const delta = (left, right) => ({ reference: left, candidate: right, delta: right - left })
	const samples = []
	for (const fixtureId of fixtureIds) {
		for (const sampleIndex of [...contract.sampleIndexes].sort((left, right) => left - right)) {
			const key = `${fixtureId}:${sampleIndex}`
			const left = before.get(key)
			const right = after.get(key)
			for (const field of ["fixtureDigest", "modelConfigurationDigest", "cacheState"]) {
				requireCondition(left[field] === right[field], `${field} mismatch`)
			}
			const providerTokens = {}
			for (const field of ["tokensIn", "tokensOut", "cacheReads", "cacheWrites"]) {
				const available =
					contract.measurementKind === "runtime-observation" &&
					reference.identity.tokenEvidence === "provider" &&
					complete(left.observedTotal[field]) &&
					complete(right.observedTotal[field])
				providerTokens[field] = available
					? {
							...delta(left.observedTotal[field].value, right.observedTotal[field].value),
							coverage: "complete",
						}
					: { value: null, coverage: "unavailable", reason: "Complete provider request usage is unavailable" }
			}
			samples.push({
				fixtureId,
				sampleIndex,
				...Object.fromEntries(
					metrics.map((field) => [
						field,
						delta(left.observedTotal[field].value, right.observedTotal[field].value),
					]),
				),
				providerTokens,
			})
		}
	}
	return {
		schemaVersion: 1,
		admitted: true,
		measurementKind: contract.measurementKind,
		interpretation: "Observed paired counters only; no model-strategy, token-saving or latency claim is inferred",
		samples,
	}
}
