import type { HarnessClock, HarnessProcessRunner } from "../orchestration/index"
import { ExecaHarnessProcessRunner, systemClock } from "../orchestration/index"

import {
	findBenchmarkTask,
	loadPrivateGraderBundle,
	submitGraderRequest,
	type BenchmarkTaskManifest,
} from "../benchmark/index"
import { persistGraderResults, type Task } from "../db/index"
import { EVALS_REPO_PATH, type ExerciseLanguage, getTaskWorkspacePath } from "../exercises/index"
import { canonicalJson, sha256 } from "../evidence/index"
import {
	createDefaultGraderRegistry,
	resolveTaskGraderSpecs,
	type EvalTraceEvent,
	type GraderEvidence,
	type GraderResult,
	type GraderRunResult,
} from "../grading/index"

import type { Logger } from "./utils"

const visibleCommands: Record<ExerciseLanguage, Array<{ command: string; args: string[] }>> = {
	go: [{ command: "go", args: ["test", "./..."] }],
	java: [{ command: "./gradlew", args: ["test"] }],
	javascript: [
		{ command: "pnpm", args: ["install"] },
		{ command: "pnpm", args: ["test"] },
	],
	python: [{ command: "uv", args: ["run", "python3", "-m", "pytest", "-o", "markers=task"] }],
	rust: [{ command: "cargo", args: ["test"] }],
}

export type RunUnitTestOptions = {
	task: Task
	attemptId: number
	logger: Logger
	workspaceRoot?: string
	changedPaths: string[]
	trace?: EvalTraceEvent[]
	usage?: unknown
	environment?: Record<string, unknown>
	processRunner?: HarnessProcessRunner
	clock?: HarnessClock
	evidenceSink?: (
		id: string,
		kind: GraderEvidence["kind"],
		value: string,
		mediaType: string,
	) => Promise<GraderEvidence>
	persist?: (attemptId: number, results: GraderResult[]) => Promise<unknown>
	brokerRoot?: string | false
}

export async function runUnitTest({
	task,
	attemptId,
	logger,
	workspaceRoot = getTaskWorkspacePath(task),
	changedPaths,
	trace = [],
	usage,
	environment,
	processRunner = new ExecaHarnessProcessRunner(),
	clock = systemClock,
	evidenceSink,
	persist = persistGraderResults,
	brokerRoot = process.env.EVALS_GRADER_BROKER_ROOT || false,
}: RunUnitTestOptions): Promise<GraderRunResult> {
	const manifest = await resolveTaskManifest(task)
	if (brokerRoot && manifest.graders.some(({ bundleId }) => bundleId)) {
		const response = await submitGraderRequest(
			brokerRoot,
			{
				schemaVersion: 1,
				attemptId,
				workspaceRoot,
				changedPaths,
				trace,
				usage,
				environment: environment ?? {},
			},
			120_000,
		)
		await persist(attemptId, response.run.results)
		return response.run
	}
	const privateBundle = await loadPrivateGraderBundle(manifest)
	const specs = resolveTaskGraderSpecs({
		task: manifest,
		visibleCommands: visibleCommands[task.language],
		privateGraders: privateBundle?.manifest.graders,
	})

	logger.info(`running ${specs.length} manifest grader(s) for ${manifest.id}@${manifest.version}`)
	const result = await createDefaultGraderRegistry().execute(specs, {
		workspaceRoot,
		hiddenRoot: privateBundle?.root,
		changedPaths,
		trace,
		usage,
		environment,
		processRunner,
		clock,
		evidenceSink,
	})
	await persist(attemptId, result.results)
	return result
}

async function resolveTaskManifest(task: Task): Promise<BenchmarkTaskManifest> {
	try {
		return (await findBenchmarkTask(EVALS_REPO_PATH, `${task.language}/${task.exercise}`)).task
	} catch (error) {
		if (task.benchmarkTaskIdentity) throw error
		const graders = [{ id: "visible-tests", version: 1, alias: "visible_tests" }]
		const validation = { commands: visibleCommands[task.language], network: "disabled" as const }
		return {
			id: `${task.language}-${task.exercise}`.replaceAll("/", "-"),
			version: 1,
			partition: "smoke",
			admission: "draft",
			fixture: `${task.language}/${task.exercise}`,
			prompt: "prompt.md",
			repository: { upstream: "legacy-evals", commit: "unversioned" },
			family: "legacy",
			capabilities: ["validation"],
			risk: "low",
			difficulty: "foundation",
			contextBand: "compact",
			editTopology: { kind: "single-file", minFiles: 1, maxFiles: 2, allowedRoots: ["src", "test"] },
			validation,
			evidenceRequirements: ["final_workspace", "changed_paths", "usage", "environment", "grader_evidence"],
			graderReferenceDigest: sha256(canonicalJson(graders)),
			environmentDigest: sha256(canonicalJson(validation)),
			restraint: false,
			budgets: { wallSeconds: 120, modelCalls: 1, toolCalls: 1, costUsd: 0 },
			repetitions: { smoke: 1, scored: 1 },
			graders,
		}
	}
}
