import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import pMap from "p-map"

import { canonicalJson, sha256 } from "../evidence/index"
import { createDefaultGraderRegistry, resolveTaskGraderSpecs } from "../grading/index"
import { ExecaHarnessProcessRunner, systemClock, type HarnessProcessRunner } from "../orchestration/index"
import {
	calibrationReportSchema,
	type BenchmarkCatalog,
	type BenchmarkTaskManifest,
	type CalibrationReport,
} from "./contracts"
import { loadPrivateGraderBundle } from "./loader"

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
	const initial = await evaluateWorkspace(task, fixture, privateBundle, runner, [])
	const goldRepetitions = options.goldRepetitions ?? 20
	const brokenRepetitions = options.brokenRepetitions ?? 20
	const determinismRepetitions = options.determinismRepetitions ?? 50
	const goldRuns = await repeat(goldRepetitions, () =>
		withSolution(fixture, path.join(calibrationRoot, "gold"), (workspace, changedPaths) =>
			evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths),
		),
	)
	const brokenIds = (await fs.readdir(path.join(calibrationRoot, "broken"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map(({ name }) => name)
		.sort()
	const broken = await pMap(
		brokenIds,
		async (id) => {
			const runs = await repeat(brokenRepetitions, () =>
				withSolution(fixture, path.join(calibrationRoot, "broken", id), (workspace, changedPaths) =>
					evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths),
				),
			)
			return {
				id,
				repetitions: brokenRepetitions,
				rejected: runs.filter(({ passed }) => !passed).length,
				expectedCode: "command-exit-nonzero",
			}
		},
		{ concurrency: 3 },
	)
	const determinismRuns = await repeat(determinismRepetitions, () =>
		withSolution(fixture, path.join(calibrationRoot, "gold"), (workspace, changedPaths) =>
			evaluateWorkspace(task, workspace, privateBundle, runner, changedPaths),
		),
	)
	return {
		schemaVersion: 1,
		taskIdentity: `${task.id}@${task.version}`,
		fixtureInitiallyFails: !initial.passed,
		restraint: task.restraint,
		gold: { repetitions: goldRepetitions, passed: goldRuns.filter(({ passed }) => passed).length },
		broken,
		determinism: {
			repetitions: determinismRepetitions,
			distinctDigests: new Set(determinismRuns.map(({ digest }) => digest)).size,
		},
		models: [],
		humanReview: { unresolvedFalsePositivePasses: 0, reviewedTrialIds: [], reviewer: "", qualityApproved: false },
		admitted: false,
	}
}

export async function syncVisibleKeylessReports(options: {
	catalog: BenchmarkCatalog
	publicRoot: string
	privateRoot: string
}): Promise<{ taskIds: string[]; outputRoot: string }> {
	const visible = [...options.catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition }) => partition === "development" || partition === "regression")
		.sort((a, b) => a.id.localeCompare(b.id))
	if (visible.length !== 28) throw new Error(`Expected 28 visible frontier tasks; found ${visible.length}`)
	const outputRoot = path.join(options.publicRoot, "calibration")
	await fs.mkdir(outputRoot, { recursive: true })
	for (const task of visible) {
		const source = path.join(options.privateRoot, "reports", `${task.id}.keyless.json`)
		const privateReport = calibrationReportSchema.parse(JSON.parse(await fs.readFile(source, "utf8")))
		if (privateReport.taskIdentity !== `${task.id}@${task.version}`)
			throw new Error(`Calibration report identity mismatch for ${task.id}`)
		assertKeylessCalibrationComplete(privateReport)
		const output = path.join(outputRoot, `${task.id}.keyless.json`)
		let report = privateReport
		try {
			const existing = calibrationReportSchema.parse(JSON.parse(await fs.readFile(output, "utf8")))
			if (existing.taskIdentity !== privateReport.taskIdentity)
				throw new Error(`Existing calibration identity mismatch for ${task.id}`)
			report = {
				...privateReport,
				models: existing.models,
				humanReview: existing.humanReview,
				admitted: existing.admitted,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const temporary = `${output}.tmp`
		await fs.writeFile(temporary, JSON.stringify(report, null, 2) + "\n")
		await fs.rename(temporary, output)
	}
	return { taskIds: visible.map(({ id }) => id), outputRoot }
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
): Promise<{ passed: boolean; digest: string }> {
	const specs = resolveTaskGraderSpecs({
		task,
		privateGraders: privateBundle?.manifest.graders,
	})
	const run = await createDefaultGraderRegistry().execute(specs, {
		workspaceRoot: workspace,
		hiddenRoot: privateBundle?.root,
		changedPaths,
		trace: [
			{ sequence: 1, type: "agent.turn.tool_result", timestamp: "1970-01-01T00:00:00.000Z" },
			{ sequence: 2, type: "agent.turn.verification_result", timestamp: "1970-01-01T00:00:01.000Z" },
		],
		usage: { costUsd: 0 },
		processRunner: runner,
		clock: systemClock,
	})
	const normalized = run.results.map(
		({ graderId, graderVersion, status, hardGate, failureClass, diagnostics, error }) => ({
			graderId,
			graderVersion,
			status,
			hardGate,
			failureClass,
			diagnostics,
			error,
		}),
	)
	return { passed: run.decision === "passed", digest: sha256(canonicalJson(normalized)) }
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
	return pMap(Array.from({ length: count }), run, { concurrency: Math.min(4, count) })
}
