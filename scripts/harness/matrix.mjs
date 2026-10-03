import { access, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { lanes, selectLane } from "./catalog.mjs"
import { columns, evidenceInventory, layerGaps, layers, surfaces } from "./inventory.mjs"
import { executionState, readExecutionJson, testEvidenceVerdict } from "./execution-evidence.mjs"
import { comparableSource } from "./source.mjs"
import { hostSuiteVerdict, outcomeCampaignVerdict } from "./host-evidence.mjs"
import { laneExpectedInventories } from "./lane-evidence.mjs"
import { collectOutcomeBuild, outcomeProofVerdict } from "./outcome-proof.mjs"
import { require as tsRequire } from "tsx/cjs/api"

const { rejectSymlinkComponents } = tsRequire("../../apps/vscode-e2e/src/evidence/paths.ts", import.meta.url)

const MAX_AGE_MS = 24 * 60 * 60 * 1000
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const unavailableLayers = new Set([9, 10, 11, 12, 13, 14])

export function admitHarnessReport(
	report,
	{ source, node, pnpm, now = Date.now(), strict = false, expectedInventories, outcomeBuild },
) {
	const safeId =
		typeof report?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(report.id) ? report.id : null
	const invalid = (reason, state = "unavailable") => ({ state, reason, reportId: safeId })
	if (report?.schemaVersion !== 2 || !Object.hasOwn(lanes, report?.lane ?? "") || !safeId)
		return invalid("unsupported_or_invalid_report")
	const started = Date.parse(report.startedAt)
	const finished = Date.parse(report.finishedAt)
	if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished > now + 60_000)
		return invalid("incomplete_or_invalid_execution_time")
	if (now - finished > MAX_AGE_MS) return invalid("expired_execution_receipt", "stale")
	if (report.node !== node || report.pnpm !== pnpm) return invalid("noncomparable_toolchain", "stale")
	if (
		!/^[a-f0-9]{40}$/.test(report.source?.commit ?? "") ||
		!digest(report.source?.treeSha256) ||
		!digest(report.source?.lockfileSha256) ||
		report.sourceUnchangedAtBoundaries !== true ||
		!comparableSource(report.source, report.sourceAtEnd) ||
		!comparableSource(report.source, source)
	)
		return invalid("stale_or_noncomparable_source", "stale")
	let lane
	try {
		lane = selectLane(report.lane, report.filters ?? [])
	} catch {
		return invalid("invalid_lane_filters")
	}
	if (!Array.isArray(report.steps) || report.steps.length !== lane.commands.length)
		return invalid("missing_required_steps")
	if (report.status !== "passed")
		return invalid(report.status === "cancelled" ? "cancelled_execution" : "failed_execution", "executed-fail")
	for (const [index, step] of report.steps.entries()) {
		if (!step || typeof step !== "object") return invalid("invalid_step")
		const stepStarted = Date.parse(step.startedAt)
		const stepFinished = Date.parse(step.finishedAt)
		if (
			!Number.isFinite(stepStarted) ||
			!Number.isFinite(stepFinished) ||
			stepFinished < stepStarted ||
			stepStarted < started ||
			stepFinished > finished
		)
			return invalid("invalid_step_execution_time")
		if (step.status !== "passed" || step.exitCode !== 0 || step.signal !== null)
			return invalid(
				"failed_or_skipped_required_step",
				step.status === "not_started" ? "skipped" : "executed-fail",
			)
		if (
			JSON.stringify(step.baseArgs) !== JSON.stringify(lane.commands[index]) ||
			step.evidence?.status !== "passed"
		)
			return invalid("missing_or_invalid_step_evidence")
		const descriptor = lane.receipts?.[index] ?? (report.lane === "focused" ? { runner: "vitest" } : null)
		if (descriptor && ["node", "vitest"].includes(descriptor.runner)) {
			if (!step.evidence.receipt) return invalid("test_execution_receipt_unavailable")
			const verdict = testEvidenceVerdict(step.evidence.receipt, strict || descriptor.requireAllTests)
			if (step.evidence.receipt?.runner !== descriptor.runner) return invalid("wrong_test_runner")
			if (verdict.status !== "passed")
				return invalid(verdict.reason, verdict.reason === "skipped_hard_gate" ? "skipped" : "executed-fail")
			{
				const expected = expectedInventories?.[index]
				const observed = verdict.receipt.files.map((file) => file.path).sort()
				if (!expected?.length || JSON.stringify(expected) !== JSON.stringify(observed))
					return invalid("incomplete_test_inventory")
			}
		} else if (descriptor) {
			if (!Array.isArray(step.evidence.receipts)) return invalid("missing_host_receipts")
			const verdict =
				descriptor.runner === "extension-host"
					? hostSuiteVerdict(step.evidence.receipts, descriptor.suite)
					: outcomeCampaignVerdict(step.evidence.campaign, step.evidence.receipts, report.id)
			if (verdict.status !== "passed" || step.evidence.kind !== verdict.kind)
				return invalid(verdict.reason ?? "invalid_host_evidence")
			if (
				verdict.receipts.some(
					(receipt) =>
						Date.parse(receipt.startedAt) < Date.parse(step.startedAt) ||
						Date.parse(receipt.completedAt) > Date.parse(step.finishedAt),
				)
			)
				return invalid("host_receipts_outside_step")
			if (
				descriptor.runner === "task-outcomes" &&
				JSON.stringify(step.evidence.scenarios) !== JSON.stringify(verdict.scenarios)
			)
				return invalid("tampered_outcome_projection")
			if (
				descriptor.runner === "task-outcomes" &&
				(verdict.evaluationIdentity.extensionCommit !== source.commit ||
					verdict.evaluationIdentity.workingTreeDigest !== source.treeSha256)
			)
				return invalid("noncomparable_outcome_source", "stale")
			if (descriptor.runner === "task-outcomes") {
				if (!outcomeBuild || JSON.stringify(outcomeBuild) !== JSON.stringify(step.evidence.build))
					return invalid("noncomparable_outcome_build", "stale")
				const capture = outcomeProofVerdict(
					step.evidence.proofs,
					verdict.campaign,
					verdict.receipts,
					outcomeBuild,
				)
				if (capture.status !== "passed") return invalid(capture.reason)
			}
		} else {
			const mechanical = report.lane === "static"
			if (step.evidence.kind !== (mechanical ? "mechanical-command" : "command-only"))
				return invalid("unknown_step_evidence")
			const declaredPrerequisite = Array.isArray(lane.receipts) && lane.receipts[index] === null
			if (strict && !mechanical && !declaredPrerequisite) return invalid("test_execution_receipt_unavailable")
		}
	}
	const skipped = report.steps.some(
		(step) => step.evidence.receipt && executionState(step.evidence.receipt.counts) === "skipped",
	)
	return {
		state: skipped ? "skipped" : "executed-pass",
		reason: skipped ? "supplemental_tests_skipped" : null,
		reportId: report.id,
	}
}

export async function readHarnessReports(directory) {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (error.code === "ENOENT") return []
		throw error
	}
	const reports = []
	const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
	if (directories.length > 1000) throw new Error("Harness report inventory exceeds its bound")
	for (const entry of directories) {
		try {
			reports.push(await readExecutionJson(path.join(directory, entry.name, "result.json")))
		} catch {
			reports.push({ id: entry.name, status: "invalid", schemaVersion: null })
		}
	}
	return reports
}

const exists = async (root, file) => {
	try {
		await access(path.join(root, file))
		return true
	} catch {
		return false
	}
}

export async function buildEvidenceMatrix({
	root,
	source,
	node,
	pnpm,
	reports = [],
	requiredLanes = [],
	now = Date.now(),
}) {
	for (const lane of requiredLanes) if (!Object.hasOwn(lanes, lane)) throw new Error("Unknown required evidence lane")
	const inventoryByLane = new Map()
	for (const report of reports) {
		if (!Object.hasOwn(lanes, report?.lane ?? "")) continue
		const key = JSON.stringify([report.lane, report.filters ?? []])
		if (!inventoryByLane.has(key)) {
			try {
				inventoryByLane.set(
					key,
					await laneExpectedInventories(root, selectLane(report.lane, report.filters ?? []), report.lane),
				)
			} catch {
				inventoryByLane.set(key, [])
			}
		}
	}
	const inventoryFor = (report) => inventoryByLane.get(JSON.stringify([report?.lane, report?.filters ?? []]))
	let outcomeBuild
	if (reports.some((report) => report?.lane === "outcomes")) {
		try {
			outcomeBuild = await collectOutcomeBuild(root)
		} catch {
			/* Missing current build makes outcome receipts unavailable. */
		}
	}
	const executionReports = reports.map((report) => ({
		report,
		admission: admitHarnessReport(report, {
			source,
			node,
			pnpm,
			now,
			expectedInventories: inventoryFor(report),
			outcomeBuild,
		}),
	}))
	const evidence = []
	for (const definition of evidenceInventory) {
		const references = []
		for (const file of [...definition.source, ...definition.tests])
			references.push({ path: file, found: await exists(root, file) })
		const executions = []
		for (const { report, admission } of executionReports) {
			const failedExecution = admission.state === "executed-fail" && admission.reason === "failed_execution"
			if (admission.state !== "executed-pass" && admission.state !== "skipped" && !failedExecution) continue
			for (const step of report.steps) {
				if (!step || typeof step !== "object") continue
				if (definition.kind === "mechanical-command" && report.lane === "static")
					executions.push({
						reportId: report.id,
						startedAt: report.startedAt,
						completedAt: report.finishedAt,
						state: admission.state,
						scope: "command",
						command: step.baseArgs,
					})
				const testVerdict = testEvidenceVerdict(step.evidence?.receipt)
				for (const file of testVerdict.receipt?.files ?? []) {
					if (definition.tests.includes(file.path))
						executions.push({
							reportId: report.id,
							startedAt: report.startedAt,
							completedAt: report.finishedAt,
							path: file.path,
							state: executionState(file.counts),
							runState: admission.state,
							counts: file.counts,
						})
				}
				for (const receipt of !failedExecution && Array.isArray(step.evidence?.receipts)
					? step.evidence.receipts
					: []) {
					const file = `apps/vscode-e2e/src/suite/${receipt.testFile}.ts`
					if (!failedExecution && definition.kind === "scripted-host-test" && definition.tests.includes(file))
						executions.push({
							reportId: report.id,
							startedAt: report.startedAt,
							completedAt: report.finishedAt,
							path: file,
							state: "executed-pass",
							host: receipt.actualHostVersion,
							provider: receipt.providerMode,
							counts: receipt.testCounts,
						})
				}
				if (
					!failedExecution &&
					definition.kind === "scripted-outcome-test" &&
					step.evidence?.kind === "scripted-task-outcomes"
				)
					executions.push(
						...step.evidence.scenarios.map((scenario) => ({
							reportId: report.id,
							startedAt: report.startedAt,
							completedAt: report.finishedAt,
							scenarioId: scenario.id,
							state: scenario.state,
							scope: "independently-asserted-scripted-task",
						})),
					)
			}
		}
		const discovery =
			references.length && references.every((reference) => reference.found) ? "discovered" : "defined"
		const latestByIdentity = new Map()
		const severity = (execution) =>
			execution.runState === "executed-fail" || execution.state !== "executed-pass" ? 1 : 0
		for (const execution of executions.sort(
			(a, b) =>
				Date.parse(a.completedAt) - Date.parse(b.completedAt) ||
				severity(a) - severity(b) ||
				a.reportId.localeCompare(b.reportId),
		))
			latestByIdentity.set(execution.path ?? execution.scenarioId ?? JSON.stringify(execution.command), execution)
		const currentExecutions = [...latestByIdentity.values()]
		const observedStates = [...new Set(currentExecutions.map((execution) => execution.state))]
		const covered = new Set(currentExecutions.map((execution) => execution.path))
		const completeScope =
			definition.kind === "mechanical-command" || definition.kind === "scripted-outcome-test"
				? executions.length > 0
				: definition.tests.every((file) => covered.has(file))
		const state =
			definition.promotion === "unavailable"
				? "unavailable"
				: currentExecutions.some((execution) => execution.runState === "executed-fail")
					? "executed-fail"
					: observedStates.includes("executed-fail")
						? "executed-fail"
						: observedStates.includes("skipped")
							? "skipped"
							: completeScope && executions.length
								? "executed-pass"
								: discovery
		evidence.push({
			...definition,
			discovery,
			state,
			references,
			currentExecutions,
			executions,
			unexecutedTests: definition.tests.filter((file) => !covered.has(file)),
		})
	}
	const cells = surfaces.map((surface) => ({
		surface,
		columns: Object.fromEntries(
			columns.map((column) => {
				const matches = evidence.filter(
					(entry) => entry.surfaces.includes(surface) && entry.columns.includes(column),
				)
				return [
					column,
					{
						evidenceIds: matches.map((entry) => entry.id),
						states: matches.length ? [...new Set(matches.map((entry) => entry.state))] : ["coverage-gap"],
					},
				]
			}),
		),
	}))
	const layerMatrix = layers.map((layer) => {
		const matches = evidence.filter((entry) => entry.layers.includes(layer.id))
		return {
			...layer,
			evidenceIds: matches.map((entry) => entry.id),
			states: unavailableLayers.has(layer.id)
				? ["unavailable"]
				: matches.length
					? [...new Set(matches.map((entry) => entry.state))]
					: ["coverage-gap"],
			gap: layerGaps[layer.id] ?? null,
		}
	})
	const gates = [...new Set(requiredLanes)].map((lane) => {
		const candidates = reports
			.filter((report) => report?.lane === lane)
			.map((report) => ({
				report,
				admission: admitHarnessReport(report, {
					source,
					node,
					pnpm,
					now,
					strict: true,
					expectedInventories: inventoryFor(report),
					outcomeBuild,
				}),
			}))
			.sort(
				(a, b) =>
					(Date.parse(b.report.finishedAt) || Infinity) - (Date.parse(a.report.finishedAt) || Infinity) ||
					Number(a.admission.state === "executed-pass") - Number(b.admission.state === "executed-pass") ||
					String(a.report.id ?? "").localeCompare(String(b.report.id ?? "")),
			)
		const admission = candidates.length
			? candidates[0].admission
			: { state: "unavailable", reason: "required_lane_not_executed", reportId: null }
		return { lane, ...admission }
	})
	return {
		schemaVersion: 1,
		kind: "alpha-harness-evidence-matrix",
		generatedAt: new Date(now).toISOString(),
		source,
		toolchain: { node, pnpm, referenceHost: "1.125.0" },
		interpretation:
			"Inventory is distinct from execution. Cells retain missing, skipped and unavailable scope; machinery tests do not establish live quality or production evidence.",
		columns,
		cells,
		evidence,
		layers: layerMatrix,
		executionReports: executionReports.map(({ report, admission }) => ({
			lane: Object.hasOwn(lanes, report?.lane ?? "") ? report.lane : null,
			...admission,
		})),
		ci:
			process.env.GITHUB_ACTIONS === "true"
				? {
						runId: process.env.GITHUB_RUN_ID,
						runAttempt: process.env.GITHUB_RUN_ATTEMPT,
						job: process.env.GITHUB_JOB,
					}
				: null,
		gate: {
			status: !gates.length
				? "not-requested"
				: gates.every((gate) => gate.state === "executed-pass")
					? "passed"
					: "failed",
			requiredLanes: gates,
		},
	}
}

export function parseMatrixArgs(args) {
	const options = { output: null, requiredLanes: [] }
	for (let index = 0; index < args.length; index += 2) {
		const value = args[index + 1]
		if (!value || value.startsWith("--")) throw new Error("Matrix option requires a value")
		if (args[index] === "--output" && !options.output) options.output = value
		else if (args[index] === "--require") options.requiredLanes.push(value)
		else throw new Error("Unknown or duplicate matrix option")
	}
	return options
}

export async function writeEvidenceMatrix(root, output, matrix) {
	const absolute = path.resolve(root, output)
	const relative = path.relative(path.join(root, "artifacts", "harness"), absolute)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(absolute) !== ".json")
		throw new Error("Matrix output must be a JSON file inside artifacts/harness")
	await rejectSymlinkComponents(absolute)
	await mkdir(path.dirname(absolute), { recursive: true })
	await rejectSymlinkComponents(absolute)
	await writeFile(absolute, JSON.stringify(matrix, null, 2) + "\n", { mode: 0o600 })
	return absolute
}
