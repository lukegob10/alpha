import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import pMap from "p-map"
import { z } from "zod"

import { canonicalJson, sha256 } from "../evidence/index"
import {
	createDefaultGraderRegistry,
	evidenceFromText,
	resolveTaskGraderSpecs,
	type CommandGraderSpec,
	type GraderEvidence,
	type GraderRunResult,
} from "../grading/index"
import { captureExpectedNodeTestCommands } from "../grading/nodeTestCompletion"
import { ExecaHarnessProcessRunner, systemClock, type HarnessProcessRunner } from "../orchestration/index"
import {
	calibrationReportSchema,
	type BenchmarkCatalog,
	type BenchmarkTaskManifest,
	type CalibrationReport,
} from "./contracts"
import { loadPrivateGraderBundle } from "./loader"
import { updateCalibrationReport } from "./calibrationStore"

const rejectionExpectationSchema = z
	.object({
		schemaVersion: z.literal(1),
		decision: z.enum(["outcome_failed", "safety_failed"]),
		diagnostics: z.array(z.object({ graderId: z.string().min(1), code: z.string().min(1) }).strict()).min(1),
	})
	.strict()

export async function runKeylessCalibration(options: {
	task: BenchmarkTaskManifest
	publicRoot: string
	privateRoot: string
	goldRepetitions?: number
	brokenRepetitions?: number
	determinismRepetitions?: number
	processRunner?: HarnessProcessRunner
}): Promise<CalibrationReport> {
	const { task, publicRoot, privateRoot } = options
	const runner = options.processRunner ?? new ExecaHarnessProcessRunner()
	const fixture =
		task.partition === "holdout" ? path.join(privateRoot, task.fixture) : path.join(publicRoot, task.fixture)
	const calibrationRoot = path.join(privateRoot, "calibration", task.id)
	const privateBundle = await loadPrivateGraderBundle(task, privateRoot)
	try {
		const visibleCommands = await captureExpectedNodeTestCommands(fixture, task.validation.commands)
		const initial = await evaluateWorkspace(task, fixture, privateBundle, runner, [], visibleCommands)
		const goldRepetitions = options.goldRepetitions ?? 20
		const brokenRepetitions = options.brokenRepetitions ?? 20
		const determinismRepetitions = options.determinismRepetitions ?? 50
		const goldRuns = await repeat(goldRepetitions, () =>
			withSolution(fixture, path.join(calibrationRoot, "gold"), (workspace, changedPaths) =>
				evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths, visibleCommands),
			),
		)
		const brokenIds = (await fs.readdir(path.join(calibrationRoot, "broken"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map(({ name }) => name)
			.sort()
		const broken = await mapCalibration(
			brokenIds,
			async (id) => {
				const solutionRoot = path.join(calibrationRoot, "broken", id)
				// New calibrations require an authored reason beside each private control:
				// expected.json = { schemaVersion: 1, decision: "outcome_failed",
				// diagnostics: [{ graderId: "task.visible_tests", code: "command_test_completion_missing" }] }.
				// Historical reports remain readable; missing declarations cannot create new evidence.
				const expectationFile = path.join(solutionRoot, "expected.json")
				let expectation: z.infer<typeof rejectionExpectationSchema>
				try {
					expectation = rejectionExpectationSchema.parse(
						JSON.parse(await fs.readFile(expectationFile, "utf8")),
					)
				} catch {
					throw new Error(`Broken control ${task.id}/${id} requires a valid expected.json rejection reason`)
				}
				const runs = await repeat(brokenRepetitions, () =>
					withSolution(fixture, solutionRoot, (workspace, changedPaths) =>
						evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths, visibleCommands),
					),
				)
				for (const { run } of runs) {
					if (run.decision === "passed") continue
					const actual = run.results
						.filter(({ status }) => status === "failed")
						.flatMap(({ graderId, diagnostics }) =>
							diagnostics
								.filter(({ severity }) => severity === "error")
								.map(({ code }) => ({ graderId, code })),
						)
					const identities = (values: typeof actual) =>
						[...new Set(values.map((value) => canonicalJson(value)))].sort()
					if (
						run.decision !== expectation.decision ||
						canonicalJson(identities(actual)) !== canonicalJson(identities(expectation.diagnostics))
					) {
						throw new Error(
							`Broken control ${task.id}/${id} failed for an unexpected rejection decision or reason`,
						)
					}
				}
				return {
					id,
					repetitions: brokenRepetitions,
					rejected: runs.filter(({ run }) => run.decision === expectation.decision).length,
					expectedCode: expectation.diagnostics[0]!.code,
				}
			},
			3,
		)
		const determinismRuns = await repeat(determinismRepetitions, () =>
			withSolution(fixture, path.join(calibrationRoot, "gold"), (workspace, changedPaths) =>
				evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths, visibleCommands),
			),
		)
		return {
			schemaVersion: 1,
			taskIdentity: `${task.id}@${task.version}`,
			calibrationScope: initial.scope,
			fixtureInitiallyFails: !initial.passed,
			restraint: task.restraint,
			gold: { repetitions: goldRepetitions, passed: goldRuns.filter(({ passed }) => passed).length },
			broken,
			determinism: {
				repetitions: determinismRepetitions,
				distinctDigests: new Set(determinismRuns.map(({ digest }) => digest)).size,
			},
			models: [],
			humanReview: {
				unresolvedFalsePositivePasses: 0,
				reviewedTrialIds: [],
				reviewer: "",
				qualityApproved: false,
			},
			admitted: false,
		}
	} finally {
		await privateBundle?.dispose?.()
	}
}

export async function syncVisibleKeylessReports(options: {
	catalog: BenchmarkCatalog
	publicRoot: string
	privateRoot: string
}): Promise<{ taskIds: string[]; outputRoot: string }> {
	const { publicRoot, privateRoot } = options
	const visible = [...options.catalog.tasks.values()]
		.filter(({ task }) => task.partition === "development" || task.partition === "regression")
		.map(({ task }) => ({ id: task.id, version: task.version }))
		.sort((a, b) => a.id.localeCompare(b.id))
	if (visible.length !== 28) throw new Error(`Expected 28 visible frontier tasks; found ${visible.length}`)
	const outputRoot = path.join(publicRoot, "calibration")
	await fs.mkdir(outputRoot, { recursive: true })
	for (const task of visible) {
		const source = path.join(privateRoot, "reports", `${task.id}.keyless.json`)
		const privateReport = calibrationReportSchema.parse(JSON.parse(await fs.readFile(source, "utf8")))
		if (privateReport.taskIdentity !== `${task.id}@${task.version}`)
			throw new Error(`Calibration report identity mismatch for ${task.id}`)
		assertKeylessCalibrationComplete(privateReport)
		const output = path.join(outputRoot, `${task.id}.keyless.json`)
		await updateCalibrationReport(output, (existing) => {
			if (!existing) return privateReport
			if (existing.taskIdentity !== privateReport.taskIdentity)
				throw new Error(`Existing calibration identity mismatch for ${task.id}`)
			const sameKeylessEvidence = keylessEvidence(existing) === keylessEvidence(privateReport)
			return {
				...privateReport,
				models: existing.models,
				// Delivery provenance belongs to the retained visible model arms, including unknown legacy delivery.
				modelDelivery: existing.modelDelivery,
				humanReview: sameKeylessEvidence
					? existing.humanReview
					: { ...existing.humanReview, qualityApproved: false },
				admitted: sameKeylessEvidence && existing.admitted,
			}
		})
	}
	return { taskIds: visible.map(({ id }) => id), outputRoot }
}

function keylessEvidence(report: CalibrationReport): string {
	const { models: _models, modelDelivery: _delivery, humanReview: _review, admitted: _admitted, ...evidence } = report
	return canonicalJson(evidence)
}

export function assertKeylessCalibrationComplete(report: CalibrationReport): void {
	if (!report.fixtureInitiallyFails && !report.restraint)
		throw new Error(`Keyless report ${report.taskIdentity} has a passing initial fixture`)
	if (report.gold.repetitions < 20 || report.gold.passed !== report.gold.repetitions)
		throw new Error(`Keyless report ${report.taskIdentity} has unstable gold evidence`)
	if (
		report.broken.length < 3 ||
		report.broken.some(({ repetitions, rejected }) => repetitions < 20 || rejected !== repetitions)
	)
		throw new Error(`Keyless report ${report.taskIdentity} has escaping broken solutions`)
	if (report.determinism.repetitions < 50 || report.determinism.distinctDigests !== 1)
		throw new Error(`Keyless report ${report.taskIdentity} has nondeterministic grader evidence`)
}

async function evaluateWorkspace(
	task: BenchmarkTaskManifest,
	workspace: string,
	privateBundle: Awaited<ReturnType<typeof loadPrivateGraderBundle>>,
	runner: HarnessProcessRunner,
	changedPaths: string[],
	visibleCommands: CommandGraderSpec["commands"],
): Promise<{
	passed: boolean
	digest: string
	run: GraderRunResult
	scope: NonNullable<CalibrationReport["calibrationScope"]>
}> {
	const allSpecs = resolveTaskGraderSpecs({
		task,
		visibleCommands,
		privateGraders: privateBundle?.manifest.graders,
	})
	const specs = allSpecs.filter(({ type }) => type !== "trace-assertion" && type !== "usage-policy")
	const scope: NonNullable<CalibrationReport["calibrationScope"]> = {
		schemaVersion: 1,
		kind: "keyless-fixture",
		measuredGraderIds: specs.map(({ id }) => id),
		unmeasuredGraderIds: allSpecs
			.filter(({ type }) => type === "trace-assertion" || type === "usage-policy")
			.map(({ id }) => id),
		executionEvidence: "not-measured",
		semanticEvidenceVersion: 1,
	}
	if (specs.length === 0) throw new Error(`Keyless calibration ${task.id} has no fixture graders`)
	const semanticEvidence = new Map<string, GraderEvidence>()
	const run = await createDefaultGraderRegistry().execute(specs, {
		workspaceRoot: workspace,
		hiddenRoot: privateBundle?.root,
		changedPaths,
		// Agent trace and usage gates require an actual execution. Fixture calibration
		// records them as unmeasured and cannot supply model-backed admission evidence.
		trace: [],
		processRunner: runner,
		clock: systemClock,
		evidenceSink: async (id, kind, value, mediaType) => {
			const normalized = normalizeCommandEvidence(value, workspace)
			semanticEvidence.set(id, evidenceFromText(id, kind, normalized, mediaType))
			return evidenceFromText(id, kind, value, mediaType)
		},
	})
	if (run.decision === "grader_error") throw new Error(`Keyless calibration ${task.id} encountered grader_error`)
	const normalized = run.results.map(
		({ graderId, graderVersion, status, hardGate, failureClass, diagnostics, error, evidence }) => ({
			graderId,
			graderVersion,
			status,
			hardGate,
			failureClass,
			diagnostics,
			error,
			evidence: evidence.map((entry) => semanticEvidence.get(entry.id) ?? entry),
		}),
	)
	return { passed: run.decision === "passed", digest: sha256(canonicalJson(normalized)), run, scope }
}

function normalizeCommandEvidence(value: string, workspace: string): string {
	// Only owned runtime coordinates and TAP duration diagnostics are presentation noise.
	// Assertion names, results, counts, errors, and all other output remain part of the digest.
	let normalized = value.replaceAll("\r\n", "\n")
	const escapedWorkspace = JSON.stringify(workspace).slice(1, -1)
	if (escapedWorkspace !== workspace) normalized = normalized.replaceAll(escapedWorkspace, "<workspace>")
	normalized = normalized.replaceAll(workspace, "<workspace>")
	const portable = workspace.replaceAll("\\", "/")
	if (portable !== workspace) normalized = normalized.replaceAll(portable, "<workspace>")
	if (!normalized.startsWith("TAP version 13\n")) return normalized
	return normalized
		.split("\n")
		.filter((line) => !/^\s*(?:duration_ms:\s*|# duration_ms\s+)\d+(?:\.\d+)?\s*$/.test(line))
		.join("\n")
}

async function withSolution<T>(
	fixture: string,
	solutionRoot: string,
	run: (workspace: string, changedPaths: string[]) => Promise<T>,
): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-calibration-"))
	try {
		await fs.cp(fixture, root, { recursive: true })
		const overlay = path.join(solutionRoot, "overlay")
		let changedPaths: string[]
		try {
			changedPaths = await listRelativeFiles(overlay)
			for (const relative of changedPaths) {
				const target = path.join(root, relative)
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.copyFile(path.join(overlay, relative), target)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const legacy = path.join(solutionRoot, "workflow.js")
			await fs.copyFile(legacy, path.join(root, "src", "workflow.js"))
			changedPaths = ["src/workflow.js"]
		}
		return await run(root, changedPaths)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function listRelativeFiles(root: string): Promise<string[]> {
	const files: string[] = []
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(full)
			else files.push(path.relative(root, full).replaceAll("\\", "/"))
		}
	}
	await visit(root)
	return files.sort()
}

async function repeat<T>(count: number, run: () => Promise<T>): Promise<T[]> {
	return mapCalibration(Array.from({ length: count }), run, Math.min(4, count))
}

async function mapCalibration<T, R>(values: T[], run: (value: T) => Promise<R>, concurrency: number): Promise<R[]> {
	try {
		// Drain every started calibration before disposing the verified private snapshot.
		return await pMap(values, run, { concurrency, stopOnError: false })
	} catch (error) {
		if (error instanceof AggregateError && error.errors.length > 0) throw error.errors[0]
		throw error
	}
}
