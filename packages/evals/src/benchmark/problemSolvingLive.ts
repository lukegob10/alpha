import { execSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { ExecaHarnessProcessRunner } from "../orchestration/index"
import { loadProblemSolvingSet, selectLiveMeasurementTasks } from "./problemSolving"
import {
	defaultExtensionRunnerPath,
	existingExtensionRunnerArguments,
	problemSolvingHostFromReceipts,
	runProblemSolvingAttempt,
	type ProblemSolvingAttemptReport,
	type ProblemSolvingExtensionRequest,
} from "./problemSolvingCampaign"

const HOST_VERSION = "1.136.1"
const MODEL_ID = "gpt-5.6-luna"
const EFFORT = "high"
const REQUEST_LIMIT = 40
const ATTEMPT_TIMEOUT_MS = 1_100_000
const SCENARIO_TIMEOUT_MS = 900_000

const workspaceMarker = {
	schemaVersion: 1,
	purpose: "alpha-vscode-e2e",
	kind: "workspace",
}

async function readRecord(file: string): Promise<Record<string, unknown> | null> {
	try {
		const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
	} catch {
		return null
	}
}

async function launchExtension(
	request: ProblemSolvingExtensionRequest,
	repositoryRoot: string,
	buildIdentity: string,
): Promise<ReturnType<typeof problemSolvingHostFromReceipts>> {
	await fs.writeFile(
		path.join(request.workspace, ".alpha-e2e-owned.json"),
		JSON.stringify(workspaceMarker, null, 2) + "\n",
		{ flag: "wx" },
	)
	const runnerPath = defaultExtensionRunnerPath(repositoryRoot)
	const args = existingExtensionRunnerArguments(request, runnerPath)
	const result = await new ExecaHarnessProcessRunner().run({
		command: process.execPath,
		args,
		cwd: repositoryRoot,
		env: {
			...Object.fromEntries(
				Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			ALPHA_E2E_SCENARIO_TIMEOUT_MS: String(SCENARIO_TIMEOUT_MS),
		},
		timeoutMs: ATTEMPT_TIMEOUT_MS,
		maxOutputBytes: 256_000,
	})
	const receiptDir = path.join(request.artifactsDir, request.runId)
	const workflow = await readRecord(path.join(receiptDir, "workflow-result.json"))
	const runner = await readRecord(path.join(receiptDir, "run-result.json"))
	const failure = workflow?.failure
	return problemSolvingHostFromReceipts({
		buildIdentity,
		tracePath: workflow ? path.join(receiptDir, "workflow-result.json") : null,
		workflow: workflow
			? {
					status: typeof workflow.status === "string" ? workflow.status : undefined,
					requestsUsed: typeof workflow.requestsUsed === "number" ? workflow.requestsUsed : null,
					usage:
						workflow.usage && typeof workflow.usage === "object" && !Array.isArray(workflow.usage)
							? {
									inputTokens:
										typeof (workflow.usage as { inputTokens?: unknown }).inputTokens === "number"
											? (workflow.usage as { inputTokens: number }).inputTokens
											: null,
									outputTokens:
										typeof (workflow.usage as { outputTokens?: unknown }).outputTokens === "number"
											? (workflow.usage as { outputTokens: number }).outputTokens
											: null,
									cost:
										typeof (workflow.usage as { cost?: unknown }).cost === "number"
											? (workflow.usage as { cost: number }).cost
											: null,
								}
							: undefined,
					failure:
						failure && typeof failure === "object" && !Array.isArray(failure)
							? {
									category:
										typeof (failure as { category?: unknown }).category === "string"
											? (failure as { category: string }).category
											: undefined,
									code:
										typeof (failure as { code?: unknown }).code === "string"
											? (failure as { code: string }).code
											: undefined,
								}
							: undefined,
					model:
						workflow.model && typeof workflow.model === "object" && !Array.isArray(workflow.model)
							? {
									id:
										typeof (workflow.model as { id?: unknown }).id === "string"
											? (workflow.model as { id: string }).id
											: undefined,
									reasoningEffort:
										typeof (workflow.model as { reasoningEffort?: unknown }).reasoningEffort ===
										"string"
											? (workflow.model as { reasoningEffort: string }).reasoningEffort
											: undefined,
								}
							: undefined,
				}
			: null,
		runnerFailure:
			typeof runner?.failure === "string" ? runner.failure : result.timedOut ? "scenario_deadline" : null,
	})
}

export async function runLiveProblemSolvingCore(options: {
	evalRoot: string
	repositoryRoot: string
	attemptRoot: string
	profileDir: string
}): Promise<{
	hostVersion: string
	modelId: string
	effort: string
	buildIdentity: string
	attempts: ProblemSolvingAttemptReport[]
}> {
	const manifest = await loadProblemSolvingSet(options.evalRoot)
	const tasks = selectLiveMeasurementTasks(manifest.tasks)
	const selection = {
		requested: 32,
		selected: tasks.length,
		sources: [...new Set(tasks.map((task) => task.source))],
		lanes: [...new Set(tasks.map((task) => task.lane))],
		excluded: ["holdout", "terminal-bench"],
	}
	const buildIdentity = execSync("git rev-parse HEAD", { cwd: options.repositoryRoot, encoding: "utf8" }).trim()
	const attempts: ProblemSolvingAttemptReport[] = []
	for (const task of tasks) {
		const report = await runProblemSolvingAttempt({
			evalRoot: options.evalRoot,
			repositoryRoot: options.repositoryRoot,
			taskId: task.id,
			attemptRoot: options.attemptRoot,
			attemptId: `ps-${task.id}`,
			hostVersion: HOST_VERSION,
			provider: "live-copilot",
			modelId: MODEL_ID,
			effort: EFFORT,
			profileDir: options.profileDir,
			requestLimit: REQUEST_LIMIT,
			runExtension: (request) => launchExtension(request, options.repositoryRoot, buildIdentity),
		})
		attempts.push(report)
		await fs.writeFile(
			path.join(options.attemptRoot, "report.json"),
			JSON.stringify(
				{ hostVersion: HOST_VERSION, modelId: MODEL_ID, effort: EFFORT, buildIdentity, selection, attempts },
				null,
				2,
			) + "\n",
		)
		if (
			report.failureClass === "authentication" ||
			(report.failureClass === "infrastructure" && report.tracePath === null)
		) {
			break
		}
	}
	return { hostVersion: HOST_VERSION, modelId: MODEL_ID, effort: EFFORT, buildIdentity, attempts }
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("problemSolvingLive.ts")
if (isDirectRun) {
	const repositoryRoot = path.resolve(import.meta.dirname, "../../../..")
	const evalRoot = path.join(repositoryRoot, "evals")
	const attemptRoot =
		process.env.PROBLEM_SOLVING_ATTEMPT_ROOT ?? "F:/alpha-vscode-e2e-runs/problem-solving-live-20260921-03"
	const profileDir = process.env.PROBLEM_SOLVING_PROFILE_DIR ?? "F:/alpha-vscode-e2e-runs/20260906/profiles"
	await fs.mkdir(attemptRoot, { recursive: true })
	const report = await runLiveProblemSolvingCore({ evalRoot, repositoryRoot, attemptRoot, profileDir })
	console.log(
		JSON.stringify(
			{
				tasks: report.attempts.length,
				solved: report.attempts.filter((attempt) => attempt.countsAsSolving).length,
			},
			null,
			2,
		),
	)
}
