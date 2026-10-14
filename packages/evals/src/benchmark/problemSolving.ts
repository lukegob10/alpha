import fs from "node:fs/promises"
import path from "node:path"

import { parse } from "yaml"
import { z } from "zod"

import { assertKeylessCalibrationComplete } from "./calibration"
import { benchmarkSuiteManifestSchema, calibrationReportSchema, type BenchmarkTaskManifest } from "./contracts"
import { digestBenchmarkDirectory } from "./loader"

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const taskId = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/)

export const problemSolvingLanes = ["core", "development", "holdout"] as const
export const problemSolvingSources = ["alpha-task-bank", "terminal-bench", "alpha-native"] as const
export const coreExclusionTags = ["science", "gpu", "hardware", "credentials", "flaky-network"] as const
export const requiredCoreTags = [
	"debugging",
	"javascript",
	"python",
	"web",
	"backend",
	"cli",
	"finance",
	"data",
] as const
export const requiredNativeTaskIds = [
	"alpha-pr-comparison",
	"alpha-change-integration",
	"alpha-cleanup",
	"alpha-skill-workflow",
] as const

const sourceSchema = z.object({
	id: z.enum(problemSolvingSources),
	release: z.string().min(1),
	repository: z.string().min(1).optional(),
	dataset: z.string().min(1).optional(),
	retrievedOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
})

const taskSchema = z.object({
	id: taskId,
	source: z.enum(problemSolvingSources),
	sourceRelease: z.string().min(1),
	version: z.number().int().positive(),
	digest: digest,
	tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
	lane: z.enum(problemSolvingLanes),
	fixture: z.string().min(1).optional(),
	resources: z.object({
		cpus: z.number().positive(),
		memoryMb: z.number().int().positive(),
		wallSeconds: z.number().int().positive(),
		gpus: z.number().int().nonnegative(),
		network: z.enum(["disabled", "local", "required"]),
	}),
})

export const problemSolvingManifestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.literal("problem-solving-v1"),
	version: z.number().int().positive(),
	sources: z.array(sourceSchema).min(1),
	tasks: z.array(taskSchema).min(1),
})

export type ProblemSolvingManifest = z.infer<typeof problemSolvingManifestSchema>
export type ProblemSolvingTask = ProblemSolvingManifest["tasks"][number]

/** Local live measurement set. Holdout is reserved, and Terminal-Bench uses its container verifier. */
export function selectLiveMeasurementTasks(tasks: readonly ProblemSolvingTask[]): ProblemSolvingTask[] {
	return tasks.filter((task) => task.source !== "terminal-bench" && task.lane !== "holdout")
}

export async function loadProblemSolvingSet(root: string): Promise<ProblemSolvingManifest> {
	const manifest = problemSolvingManifestSchema.parse(
		parse(await fs.readFile(path.join(root, "problem-solving", "v1.yaml"), "utf8")),
	)
	await validateProblemSolvingSet(manifest, root)
	return manifest
}

export async function validateProblemSolvingSet(manifest: ProblemSolvingManifest, root: string): Promise<void> {
	const frontierTasks = await loadFrontierTasks(root)
	const releases = new Map<string, string>()
	for (const source of manifest.sources) {
		if (releases.has(source.id)) throw new Error(`Duplicate problem-solving source: ${source.id}`)
		releases.set(source.id, source.release)
	}
	for (const sourceId of problemSolvingSources) {
		if (!releases.has(sourceId)) throw new Error(`Problem-solving set is missing source ${sourceId}`)
	}
	const terminalBench = manifest.sources.find(({ id }) => id === "terminal-bench")
	if (terminalBench?.release !== "v4.0.0" || terminalBench.repository !== "harbor-framework/terminal-bench") {
		throw new Error("Terminal-Bench tasks must be pinned to harbor-framework/terminal-bench v4.0.0")
	}

	const seen = new Set<string>()
	const coreTags = new Set<string>()
	for (const task of manifest.tasks) {
		if (seen.has(task.id)) throw new Error(`Duplicate problem-solving task: ${task.id}`)
		seen.add(task.id)
		if (releases.get(task.source) !== task.sourceRelease) {
			throw new Error(`Task ${task.id} source release does not match ${task.source}`)
		}
		if (task.lane === "core") {
			for (const tag of task.tags) coreTags.add(tag)
			assertCoreTask(task)
		}
		if (task.source === "alpha-task-bank") assertAlphaBankTask(task, frontierTasks)
		if (task.source === "alpha-native") await assertNativeTask(task, root)
		if (task.source === "terminal-bench" && task.fixture)
			throw new Error(`Terminal-Bench task ${task.id} is pinned externally and cannot embed a local fixture`)
	}

	for (const tag of requiredCoreTags) {
		if (!coreTags.has(tag)) throw new Error(`Core lane is missing required coverage tag: ${tag}`)
	}
	for (const id of requiredNativeTaskIds) {
		const task = manifest.tasks.find((candidate) => candidate.id === id)
		if (!task || task.source !== "alpha-native") throw new Error(`Missing Alpha-native task: ${id}`)
	}
	if (!manifest.tasks.some(({ lane }) => lane === "holdout"))
		throw new Error("Problem-solving set has no holdout lane")
}

function assertCoreTask(task: ProblemSolvingTask): void {
	const excluded = task.tags.find((tag) => (coreExclusionTags as readonly string[]).includes(tag))
	if (excluded) throw new Error(`Core task ${task.id} carries excluded tag ${excluded}`)
	if (task.resources.gpus !== 0) throw new Error(`Core task ${task.id} requires a GPU`)
	if (task.resources.network === "required") throw new Error(`Core task ${task.id} requires network access`)
}

function assertAlphaBankTask(
	task: ProblemSolvingTask,
	frontierTasks: ReadonlyMap<string, BenchmarkTaskManifest>,
): void {
	const entry = frontierTasks.get(`${task.id}@${task.version}`)
	if (!entry) throw new Error(`Alpha task bank is missing ${task.id}@${task.version}`)
	if (entry.fixtureDigest !== task.digest) {
		throw new Error(`Alpha task ${task.id} digest does not match the frontier fixture digest`)
	}
	if (entry.validation.network !== "disabled") {
		throw new Error(`Alpha task ${task.id} is not a network-disabled bank task`)
	}
	if (task.lane === "holdout" && entry.partition !== "holdout") {
		throw new Error(`Holdout task ${task.id} is not a frontier holdout`)
	}
	if (task.lane !== "holdout" && entry.partition === "holdout") {
		throw new Error(`Frontier holdout ${task.id} cannot leave the holdout lane`)
	}
}

export async function assertVisibleBankCalibration(root: string, manifest: ProblemSolvingManifest): Promise<void> {
	for (const task of manifest.tasks) {
		if (task.source !== "alpha-task-bank" || task.lane === "holdout") continue
		const report = calibrationReportSchema.parse(
			JSON.parse(await fs.readFile(path.join(root, "calibration", `${task.id}.keyless.json`), "utf8")),
		)
		if (report.taskIdentity !== `${task.id}@${task.version}`) {
			throw new Error(`Keyless calibration identity mismatch for ${task.id}`)
		}
		assertKeylessCalibrationComplete(report)
	}
}

async function loadFrontierTasks(root: string): Promise<Map<string, BenchmarkTaskManifest>> {
	const suite = benchmarkSuiteManifestSchema.parse(
		parse(await fs.readFile(path.join(root, "frontier-v1.yaml"), "utf8"), { merge: true }),
	)
	if (suite.id !== "frontier-v1") throw new Error("Expected the frontier-v1 task bank")
	return new Map(suite.tasks.map((task) => [`${task.id}@${task.version}`, task]))
}

async function assertNativeTask(task: ProblemSolvingTask, root: string): Promise<void> {
	if (!task.fixture) throw new Error(`Alpha-native task ${task.id} requires a fixture path`)
	const fixture = path.resolve(root, task.fixture)
	const rootPath = path.resolve(root)
	if (fixture !== rootPath && !fixture.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error(`Alpha-native fixture escapes the eval root: ${task.fixture}`)
	}
	const actual = await digestBenchmarkDirectory(fixture)
	if (actual !== task.digest) throw new Error(`Alpha-native task ${task.id} fixture digest mismatch`)
}
