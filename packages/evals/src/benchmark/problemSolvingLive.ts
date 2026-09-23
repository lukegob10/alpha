import { createHash, randomUUID } from "node:crypto"
import { execFileSync, execSync } from "node:child_process"
import * as fsSync from "node:fs"
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

const DEFAULT_HOST_VERSION = "1.136.1"
const DEFAULT_MODEL_ID = "gpt-5.6-luna"
const DEFAULT_EFFORT = "high"
const DEFAULT_REQUEST_LIMIT = 40
const ATTEMPT_TIMEOUT_MS = 1_100_000
const SCENARIO_TIMEOUT_MS = 900_000

const workspaceMarker = {
	schemaVersion: 1,
	purpose: "alpha-vscode-e2e",
	kind: "workspace",
}

const BUILD_INPUT_PATHS = [
	"src",
	"webview-ui",
	"packages/types",
	"packages/core",
	"packages/ipc",
	"packages/evals",
	"apps/vscode-e2e",
	"evals/problem-solving",
	"scripts/evals",
	"package.json",
	"pnpm-lock.yaml",
]

function workingTreeIdentity(repositoryRoot: string): { clean: boolean; digest: string } {
	const fullStatus = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: repositoryRoot,
		maxBuffer: 8 * 1_024 * 1_024,
	})
	const inputStatus = execFileSync(
		"git",
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...BUILD_INPUT_PATHS],
		{ cwd: repositoryRoot, maxBuffer: 8 * 1_024 * 1_024 },
	)
	const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--", ...BUILD_INPUT_PATHS], {
		cwd: repositoryRoot,
		maxBuffer: 64 * 1_024 * 1_024,
	})
	const untracked = execFileSync(
		"git",
		["ls-files", "--others", "--exclude-standard", "-z", "--", ...BUILD_INPUT_PATHS],
		{ cwd: repositoryRoot, maxBuffer: 8 * 1_024 * 1_024 },
	)
	const hash = createHash("sha256").update(inputStatus).update(trackedDiff)
	for (const relativePath of untracked.toString("utf8").split("\0").filter(Boolean)) {
		const filePath = path.join(repositoryRoot, relativePath)
		hash.update(relativePath)
		try {
			const stat = fsSync.lstatSync(filePath)
			if (stat.isFile()) hash.update(fsSync.readFileSync(filePath))
			else hash.update("non-file")
		} catch {
			hash.update("unreadable")
		}
	}
	return { clean: fullStatus.length === 0, digest: hash.digest("hex") }
}

export async function extensionBundleDigest(repositoryRoot: string): Promise<string> {
	const bundlePath = path.join(repositoryRoot, "src", "dist", "extension.js")
	const before = await fs.lstat(bundlePath)
	if (!before.isFile() || before.size <= 0 || before.size > 512 * 1_024 * 1_024) {
		throw new Error("Built VS Code extension bundle is unavailable for live evaluation")
	}
	const hash = createHash("sha256")
	for await (const chunk of fsSync.createReadStream(bundlePath)) hash.update(chunk)
	const after = await fs.lstat(bundlePath)
	if (
		!after.isFile() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs
	) {
		throw new Error("Built VS Code extension bundle changed while fingerprinting")
	}
	return hash.digest("hex")
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
	runId?: string
	hostVersion?: string
	modelId?: string
	effort?: string
	requestLimit?: number
	taskIds?: string[]
	repetitions?: number
}): Promise<{
	runId: string
	hostVersion: string
	modelId: string
	effort: string
	buildIdentity: string
	extensionBundleSha256: string
	taskSetSha256: string
	attempts: ProblemSolvingAttemptReport[]
}> {
	const manifest = await loadProblemSolvingSet(options.evalRoot)
	const availableTasks = selectLiveMeasurementTasks(manifest.tasks)
	const requestedIds = options.taskIds
	if (requestedIds && (new Set(requestedIds).size !== requestedIds.length || requestedIds.length === 0)) {
		throw new Error("Live problem-solving task selection must contain unique task IDs")
	}
	const tasks = requestedIds
		? requestedIds.map((taskId) => {
				const task = availableTasks.find((candidate) => candidate.id === taskId)
				if (!task) throw new Error(`Task is not eligible for live local grading: ${taskId}`)
				return task
			})
		: availableTasks
	const repetitions = options.repetitions ?? 1
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3)
		throw new Error("Live problem-solving repetitions must be from 1 to 3")
	const requestLimit = options.requestLimit ?? DEFAULT_REQUEST_LIMIT
	if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 200)
		throw new Error("Live problem-solving request limit must be from 1 to 200")
	const hostVersion = options.hostVersion ?? DEFAULT_HOST_VERSION
	const modelId = options.modelId ?? DEFAULT_MODEL_ID
	const effort = options.effort ?? DEFAULT_EFFORT
	if (!hostVersion || !modelId || !effort)
		throw new Error("Live problem-solving host, model, and effort are required")
	const runId =
		options.runId ??
		`problem-solving-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid live problem-solving run ID")
	const startedAt = new Date().toISOString()
	const selection = {
		requested: requestedIds?.length ?? availableTasks.length,
		selected: tasks.length,
		repetitions,
		taskIds: tasks.map(({ id }) => id),
		sources: [...new Set(tasks.map((task) => task.source))],
		lanes: [...new Set(tasks.map((task) => task.lane))],
		excluded: ["holdout", "terminal-bench"],
	}
	const taskSetSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
	const buildIdentity = execSync("git rev-parse HEAD", { cwd: options.repositoryRoot, encoding: "utf8" }).trim()
	const workingTree = workingTreeIdentity(options.repositoryRoot)
	const extensionBundleSha256 = await extensionBundleDigest(options.repositoryRoot)
	await fs.mkdir(path.dirname(options.attemptRoot), { recursive: true })
	await fs.mkdir(options.attemptRoot, { recursive: false })
	const attempts: ProblemSolvingAttemptReport[] = []
	for (const task of tasks) {
		for (let repetition = 1; repetition <= repetitions; repetition++) {
			const report = await runProblemSolvingAttempt({
				evalRoot: options.evalRoot,
				repositoryRoot: options.repositoryRoot,
				taskId: task.id,
				attemptRoot: options.attemptRoot,
				attemptId: `ps-${task.id}-r${repetition}`,
				hostVersion,
				provider: "live-copilot",
				modelId,
				effort,
				profileDir: options.profileDir,
				requestLimit,
				runExtension: (request) => launchExtension(request, options.repositoryRoot, buildIdentity),
			})
			attempts.push(report)
			await fs.writeFile(
				path.join(options.attemptRoot, "report.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						runId,
						startedAt,
						generatedAt: new Date().toISOString(),
						hostVersion,
						modelId,
						effort,
						buildIdentity,
						extensionBundleSha256,
						taskSetSha256,
						workingTreeClean: workingTree.clean,
						workingTreeDigest: workingTree.digest,
						selection,
						attempts,
					},
					null,
					2,
				) + "\n",
			)
			if (
				report.failureClass === "authentication" ||
				report.failureClass === "profile_busy" ||
				(report.failureClass === "infrastructure" && report.tracePath === null)
			) {
				return {
					runId,
					hostVersion,
					modelId,
					effort,
					buildIdentity,
					extensionBundleSha256,
					taskSetSha256,
					attempts,
				}
			}
		}
	}
	return { runId, hostVersion, modelId, effort, buildIdentity, extensionBundleSha256, taskSetSha256, attempts }
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("problemSolvingLive.ts")
if (isDirectRun) {
	const repositoryRoot = path.resolve(import.meta.dirname, "../../../..")
	const evalRoot = path.join(repositoryRoot, "evals")
	const runId =
		process.env.PROBLEM_SOLVING_RUN_ID ??
		`problem-solving-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
	const attemptRoot = process.env.PROBLEM_SOLVING_ATTEMPT_ROOT ?? `F:/alpha-vscode-e2e-runs/${runId}`
	const profileDir = process.env.PROBLEM_SOLVING_PROFILE_DIR ?? "F:/alpha-vscode-e2e-runs/20260906/profiles"
	const taskIds = process.env.PROBLEM_SOLVING_TASK_IDS?.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
	const repetitions = Number(process.env.PROBLEM_SOLVING_REPETITIONS ?? "1")
	const requestLimit = Number(process.env.PROBLEM_SOLVING_REQUEST_LIMIT ?? String(DEFAULT_REQUEST_LIMIT))
	const report = await runLiveProblemSolvingCore({
		evalRoot,
		repositoryRoot,
		attemptRoot,
		profileDir,
		runId,
		hostVersion: process.env.PROBLEM_SOLVING_HOST_VERSION ?? DEFAULT_HOST_VERSION,
		modelId: process.env.PROBLEM_SOLVING_MODEL_ID ?? DEFAULT_MODEL_ID,
		effort: process.env.PROBLEM_SOLVING_EFFORT ?? DEFAULT_EFFORT,
		requestLimit,
		taskIds,
		repetitions,
	})
	console.log(
		JSON.stringify(
			{
				runId: report.runId,
				tasks: report.attempts.length,
				solved: report.attempts.filter((attempt) => attempt.countsAsSolving).length,
			},
			null,
			2,
		),
	)
}
