import fs from "node:fs/promises"
import { URL, pathToFileURL } from "node:url"
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

/** Admit the bounded production preflight experiment, preserving its deliberately unavailable whole-task evidence. */
export function comparePreflightReports(reference, candidate) {
	const catalogs = ["none", "small", "large"]
	const identities = ["node", "harnessDigest", "fixtureDigest", "configuration", "cache", "boundary", "tokenMethod"]
	const unavailable = ["providerTokens", "wholeTaskCompletion", "timeToUsefulAnswerMs"]
	const runs = [reference, candidate].map((report, role) => {
		requireCondition(
			report?.benchmark === "nor36-production-request-preflight" && report.schemaVersion === 1,
			"unsupported preflight report",
		)
		requireCondition(
			report.workingTree === "clean" && digest(report.revision, 40),
			"clean preflight source required",
		)
		for (const field of identities) {
			requireCondition(
				typeof report[field] === "string" && report[field].length > 0,
				`missing preflight ${field}`,
			)
			requireCondition(reference[field] === report[field], `preflight ${field} mismatch`)
		}
		requireCondition(/^v\d+\.\d+\.\d+$/.test(report.node), "invalid Node identity")
		requireCondition(digest(report.harnessDigest) && digest(report.fixtureDigest), "invalid preflight digest")
		for (const field of unavailable)
			requireCondition(report[field] === null, `preflight ${field} must remain unavailable`)
		requireCondition(
			Array.isArray(report.samples) && report.samples.length === 9,
			"exactly nine preflight samples required",
		)
		const samples = new Map()
		for (const sample of report.samples) {
			requireCondition(
				catalogs.includes(sample?.catalog) && [0, 1, 2].includes(sample.sampleIndex),
				"invalid preflight sample",
			)
			const key = `${sample.catalog}:${sample.sampleIndex}`
			const left =
				role === 0 ? sample : reference.samples.find((row) => `${row.catalog}:${row.sampleIndex}` === key)
			requireCondition(!samples.has(key), "duplicate preflight sample")
			requireCondition(sample.quality === "request-and-response-parity-passed", "preflight quality failed")
			requireCondition(sample.providerTokens === null, "preflight sample provider usage must remain unavailable")
			for (const [field, expected] of Object.entries({
				providerRequests: 1,
				emittedToolCalls: 0,
				commandsExecuted: 0,
				catalogBuildCalls: role === 0 ? 2 : 1,
				nativeSchemaFactoryCalls: role === 0 ? 2 : 1,
			})) {
				requireCondition(sample[field] === expected, `preflight ${field} acceptance failed`)
			}
			for (const field of ["requestDigest", "toolSchemaDigest"]) {
				requireCondition(digest(sample[field]), `invalid preflight ${field}`)
				requireCondition(left?.[field] === sample[field], `preflight ${field} parity failed`)
			}
			for (const field of ["inputBytes", "localInputTokenEstimates"]) {
				for (const part of ["system", "messages", "schemas"]) {
					requireCondition(
						integer(sample[field]?.[part]) && sample[field][part] === left?.[field]?.[part],
						`preflight ${field}.${part} parity failed`,
					)
				}
			}
			requireCondition(
				integer(sample.outputTextBytes) && sample.outputTextBytes === left?.outputTextBytes,
				"preflight output parity failed",
			)
			samples.set(key, sample)
		}
		return samples
	})
	return {
		schemaVersion: 1,
		benchmark: "nor36-production-request-preflight",
		admitted: true,
		acceptedSamples: runs[0].size,
		catalogs: catalogs.length,
		referenceRevision: reference.revision,
		candidateRevision: candidate.revision,
		harnessDigest: reference.harnessDigest,
		fixtureDigest: reference.fixtureDigest,
		catalogBuildCalls: { reference: 18, candidate: 9 },
		nativeSchemaFactoryCalls: { reference: 18, candidate: 9 },
		providerTokens: null,
		wholeTaskCompletion: null,
		timeToUsefulAnswerMs: null,
		interpretation:
			"Request/response parity and local operation counts only; no speed, model-strategy or provider-token claim",
	}
}

const liveMetrics = ["modelCalls", "toolCalls", "commandCount", "repeatedCommands", "repeatedChecks", "durationMs"]
const median = (values) => {
	const sorted = [...values].sort((left, right) => left - right)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const canonical = (value) => {
	if (Array.isArray(value)) return value.map(canonical)
	if (!value || typeof value !== "object") return value
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonical(child)]),
	)
}
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const pick = (value, fields) =>
	Object.fromEntries(fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]))

/** Portable evidence contains identities and counters only, never unknown fields or task contents. */
export function projectLiveQualityBundle(value) {
	requireCondition(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).every((key) => ["baseline", "candidate"].includes(key)),
		"expected baseline/candidate bundle",
	)
	const project = (runs) => {
		requireCondition(
			Array.isArray(runs) && runs.length >= 2 && runs.length <= 32,
			"two to 32 captures per role required",
		)
		return runs.map((run) => ({
			...pick(run, ["schemaVersion", "kind", "measurementKind", "label", "status", "samples"]),
			declared: pick(run?.declared, ["provider", "modelId", "effort"]),
			conditions: pick(run?.conditions, [
				"hostVersion",
				"node",
				"platform",
				"arch",
				"machineDigest",
				"harnessDigest",
				"fixtureDigest",
				"fixtureIds",
				"cacheProtocol",
			]),
			build: pick(run?.build, [
				"status",
				"sourceTreeState",
				"manifestDigest",
				"sourceRevision",
				"sourceTreeDigest",
				"artifactTreeDigest",
				"recordedSourceTreeState",
				"sourceValidation",
			]),
			observations: Array.isArray(run?.observations)
				? run.observations.map((row) => ({
						...pick(row, [
							"fixtureId",
							"sampleIndex",
							"correctness",
							"outcome",
							"configurationDigest",
							"requestMetric",
							...liveMetrics,
						]),
						providerImplementation:
							row?.providerImplementation == null
								? null
								: pick(row.providerImplementation, ["id", "version", "entrypointSha256"]),
					}))
				: null,
		}))
	}
	return { baseline: project(value.baseline), candidate: project(value.candidate) }
}

/** Admit repeated real extension tasks only; different routes are paired, never pooled as interchangeable samples. */
export function compareLiveQualityReports(referenceRuns, candidateRuns) {
	const portable = projectLiveQualityBundle({ baseline: referenceRuns, candidate: candidateRuns })
	referenceRuns = portable.baseline
	candidateRuns = portable.candidate
	const admit = (runs, label) => {
		requireCondition(
			Array.isArray(runs) && runs.length >= 2 && runs.length <= 32,
			"at least two declared live provider captures are required",
		)
		const routes = new Map()
		let build
		let conditions
		for (const run of runs) {
			requireCondition(
				run?.schemaVersion === 1 &&
					run.kind === "alpha-live-short-task-quality" &&
					run.measurementKind === "real-extension-live",
				"real extension live quality capture required",
			)
			requireCondition(run.label === label && run.status === "passed", `${label} capture did not pass`)
			requireCondition(
				integer(run.samples) && run.samples >= 3 && run.samples <= 20,
				"at least three repeated samples are required",
			)
			requireCondition(
				run.build?.status === "verified" &&
					run.build.sourceTreeState === "clean" &&
					digest(run.build.manifestDigest) &&
					digest(run.build.sourceRevision, 40),
				"verified clean build/source identity required",
			)
			for (const field of ["sourceTreeDigest", "artifactTreeDigest"])
				requireCondition(run.build[field] === undefined || digest(run.build[field]), "invalid build identity")
			requireCondition(
				run.build.recordedSourceTreeState === undefined ||
					["clean", "modified", "unknown"].includes(run.build.recordedSourceTreeState),
				"invalid recorded source state",
			)
			requireCondition(
				run.build.sourceValidation === undefined ||
					["current-checkout", "build-receipt"].includes(run.build.sourceValidation),
				"invalid source validation",
			)
			build ??= run.build
			requireCondition(same(build, run.build), "mixed builds within one comparison role")
			const identity = run.conditions
			requireCondition(
				identity?.hostVersion === "1.141.0" &&
					digest(identity.harnessDigest) &&
					digest(identity.fixtureDigest) &&
					digest(identity.machineDigest),
				"exact host and harness/fixture identities required",
			)
			requireCondition(
				["node", "platform", "arch", "cacheProtocol"].every(
					(field) => typeof identity[field] === "string" && identity[field],
				),
				"complete run conditions required",
			)
			requireCondition(
				Array.isArray(identity.fixtureIds) &&
					identity.fixtureIds.length > 0 &&
					new Set(identity.fixtureIds).size === identity.fixtureIds.length &&
					identity.fixtureIds.every((id) => typeof id === "string" && id),
				"declared unique fixture identities required",
			)
			conditions ??= identity
			requireCondition(same(conditions, identity), "mixed workloads or host/cache conditions")
			const declared = run.declared
			requireCondition(
				["provider", "modelId", "effort"].every(
					(field) => typeof declared?.[field] === "string" && declared[field].trim(),
				),
				"exact provider/model/effort required",
			)
			requireCondition(
				!["fake-ai", "scripted", "vscode-lm-fixture"].includes(declared.provider),
				"scripted providers cannot establish live quality",
			)
			const route = JSON.stringify([declared.provider, declared.modelId, declared.effort])
			requireCondition(!routes.has(route), "duplicate provider/model capture")
			requireCondition(
				Array.isArray(run.observations) && run.observations.length === identity.fixtureIds.length * run.samples,
				"complete fixture/sample matrix required",
			)
			const cells = new Map()
			let settings
			let requestMetric
			let implementation
			for (const row of run.observations) {
				requireCondition(
					identity.fixtureIds.includes(row?.fixtureId) &&
						integer(row.sampleIndex) &&
						row.sampleIndex < run.samples,
					"unknown fixture or sample",
				)
				const key = `${row.fixtureId}:${row.sampleIndex}`
				requireCondition(!cells.has(key), "duplicate fixture/sample")
				requireCondition(
					row.correctness === "passed" && row.outcome === "completed",
					"quality failed or unavailable",
				)
				requireCondition(digest(row.configurationDigest), "nonsecret configuration identity required")
				requireCondition(
					["adapter-dispatches", "host-send-requests"].includes(row.requestMetric),
					"request measurement boundary required",
				)
				settings ??= row.configurationDigest
				requestMetric ??= row.requestMetric
				implementation ??= row.providerImplementation
				requireCondition(
					settings === row.configurationDigest &&
						requestMetric === row.requestMetric &&
						same(implementation, row.providerImplementation),
					"provider conditions changed during capture",
				)
				if (declared.provider === "vscode-lm")
					requireCondition(
						row.providerImplementation?.id === "github.copilot-chat" &&
							typeof row.providerImplementation.version === "string" &&
							digest(row.providerImplementation.entrypointSha256),
						"Copilot implementation identity required",
					)
				else
					requireCondition(
						row.providerImplementation === null,
						"unexpected external provider implementation data",
					)
				for (const field of liveMetrics)
					requireCondition(integer(row[field]), `missing or invalid live ${field}`)
				requireCondition(
					row.modelCalls > 0 && row.durationMs > 0,
					"real task dispatch and elapsed time required",
				)
				cells.set(key, row)
			}
			routes.set(route, { run, cells, settings, requestMetric, implementation })
		}
		requireCondition(
			new Set(runs.map((run) => run.declared.provider)).size >= 2,
			"at least two distinct declared providers are required",
		)
		return { routes, conditions }
	}
	const before = admit(referenceRuns, "baseline")
	const after = admit(candidateRuns, "candidate")
	requireCondition(
		same(before.conditions, after.conditions),
		"baseline/candidate workload or host/cache conditions mismatch",
	)
	requireCondition(before.routes.size === after.routes.size, "provider coverage mismatch")
	const comparisons = []
	for (const [route, reference] of before.routes) {
		const candidate = after.routes.get(route)
		requireCondition(
			candidate && reference.run.samples === candidate.run.samples,
			"matching provider/model samples required",
		)
		requireCondition(
			reference.settings === candidate.settings &&
				reference.requestMetric === candidate.requestMetric &&
				same(reference.implementation, candidate.implementation),
			"provider/model configuration or implementation mismatch",
		)
		for (const fixtureId of before.conditions.fixtureIds) {
			const samples = Array.from({ length: reference.run.samples }, (_, index) => ({
				sampleIndex: index,
				...Object.fromEntries(
					liveMetrics.map((metric) => {
						const left = reference.cells.get(`${fixtureId}:${index}`)[metric]
						const right = candidate.cells.get(`${fixtureId}:${index}`)[metric]
						return [metric, { reference: left, candidate: right, delta: right - left }]
					}),
				),
			}))
			const metrics = Object.fromEntries(
				liveMetrics.map((metric) => {
					const left = median(samples.map((sample) => sample[metric].reference))
					const right = median(samples.map((sample) => sample[metric].candidate))
					const allowance =
						metric === "durationMs"
							? Math.max(10_000, left * 0.5)
							: metric.startsWith("repeated")
								? 0
								: Math.max(1, left * 0.25)
					return [
						metric,
						{
							referenceMedian: left,
							candidateMedian: right,
							delta: right - left,
							allowance,
							regressed: right - left > allowance,
						},
					]
				}),
			)
			comparisons.push({
				provider: reference.run.declared,
				fixtureId,
				requestMetric: reference.requestMetric,
				samples,
				metrics,
			})
		}
	}
	return {
		schemaVersion: 1,
		kind: "alpha-live-short-task-quality-comparison",
		admitted: true,
		sourceRevisions: {
			baseline: [...new Set(referenceRuns.map((run) => run.build.sourceRevision))],
			candidate: [...new Set(candidateRuns.map((run) => run.build.sourceRevision))],
		},
		conditions: before.conditions,
		passed: comparisons.every(({ metrics }) => Object.values(metrics).every(({ regressed }) => !regressed)),
		providers: [...new Set(referenceRuns.map((run) => run.declared.provider))],
		comparisons,
		interpretation:
			"Repeated paired observations, not statistical proof or a general speed claim. Logical adapter dispatches exclude hidden SDK/service retries. Repeated checks are exact recognized validation commands reissued without an intervening successful native edit. Provider caching remains uncontrolled. Provider tokens are unavailable.",
	}
}

/** Existing comparer entry point also accepts the live short-task bundles, without launching models. */
export async function liveQualityComparisonCli(args) {
	const bundleFile = args[0] === "--live-quality-bundle" ? args[1] : undefined
	requireCondition(
		args[0] === "--live-quality" || bundleFile,
		"expected --live-quality or --live-quality-bundle <file>",
	)
	const baseline = []
	const candidate = []
	let output
	let candidateCommit
	let baselineCommit
	let validatedBundle
	let dispatchInput
	for (let index = bundleFile ? 2 : 1; index < args.length; index += 2) {
		const value = args[index + 1]
		requireCondition(typeof value === "string" && !value.startsWith("--"), "missing comparison argument")
		if (args[index] === "--baseline") baseline.push(value)
		else if (args[index] === "--candidate") candidate.push(value)
		else if (args[index] === "--output" && !output) output = value
		else if (args[index] === "--require-candidate-commit" && !candidateCommit) candidateCommit = value
		else if (args[index] === "--require-baseline-commit" && !baselineCommit) baselineCommit = value
		else if (args[index] === "--validated-bundle" && !validatedBundle) validatedBundle = value
		else if (args[index] === "--dispatch-input" && !dispatchInput) dispatchInput = value
		else requireCondition(false, "unknown or duplicate comparison option")
	}
	requireCondition(output, "comparison output required")
	requireCondition(candidateCommit === undefined || digest(candidateCommit, 40), "exact candidate commit required")
	requireCondition(baselineCommit === undefined || digest(baselineCommit, 40), "exact baseline commit required")
	requireCondition(!bundleFile || baseline.length + candidate.length === 0, "choose bundle or individual captures")
	if (!bundleFile)
		requireCondition(
			baseline.length >= 2 && baseline.length <= 32 && candidate.length >= 2 && candidate.length <= 32,
			"two to 32 captures per role required",
		)
	const read = async (file) => {
		requireCondition((await fs.stat(file)).size <= 16 * 1024 * 1024, "comparison input exceeds bound")
		return JSON.parse(await fs.readFile(file, "utf8"))
	}
	const bundle = projectLiveQualityBundle(
		bundleFile
			? await read(bundleFile)
			: { baseline: await Promise.all(baseline.map(read)), candidate: await Promise.all(candidate.map(read)) },
	)
	const { baseline: references, candidate: candidates } = bundle
	if (candidateCommit)
		requireCondition(
			candidates.every((run) => run.build?.sourceRevision === candidateCommit),
			"candidate captured source commit mismatch",
		)
	if (baselineCommit)
		requireCondition(
			references.every((run) => run.build?.sourceRevision === baselineCommit),
			"baseline captured source commit mismatch",
		)
	const result = compareLiveQualityReports(references, candidates)
	const dispatchPayload = dispatchInput ? JSON.stringify({ reports: JSON.stringify(bundle) }) : undefined
	requireCondition(
		dispatchPayload === undefined || Buffer.byteLength(dispatchPayload, "utf8") <= 65_535,
		"serialized workflow input exceeds 65535 UTF-8 bytes",
	)
	await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
	if (result.passed) {
		if (validatedBundle)
			await fs.writeFile(validatedBundle, JSON.stringify(bundle) + "\n", { flag: "wx", mode: 0o600 })
		if (dispatchInput)
			await fs.writeFile(dispatchInput, dispatchPayload + "\n", {
				flag: "wx",
				mode: 0o600,
			})
	}
	return result.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	liveQualityComparisonCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code
		})
		.catch((error) => {
			console.error(error.message)
			process.exitCode = 2
		})
