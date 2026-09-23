import * as fs from "node:fs/promises"
import * as path from "node:path"

import { parse } from "yaml"

import { createDefaultGraderRegistry, type CommandGraderSpec, type GraderRunResult } from "../grading/index"
import { ExecaHarnessProcessRunner, systemClock, type HarnessProcessRunner } from "../orchestration/index"
import { benchmarkSuiteManifestSchema, type BenchmarkTaskManifest } from "./contracts"
import { loadProblemSolvingSet, type ProblemSolvingTask } from "./problemSolving"

export const problemSolvingFailureClasses = [
	"provider",
	"infrastructure",
	"cancellation",
	"budget",
	"task",
	"authentication",
	"profile_busy",
] as const
export type ProblemSolvingFailureClass = (typeof problemSolvingFailureClasses)[number]

export const problemSolvingDiagnosticFailureCategories = [
	"configuration",
	"provider",
	"policy",
	"tool",
	"persistence",
	"lifecycle",
	"assertion",
	"timeout",
	"harness",
	"runner",
] as const
export type ProblemSolvingDiagnosticFailureCategory = (typeof problemSolvingDiagnosticFailureCategories)[number]

export const problemSolvingDiagnosticFailureCodes = [
	"unexpected_command",
	"unexpected_command_empty_command",
	"unexpected_command_shell_operator",
	"unexpected_command_denied_prefix",
	"unexpected_command_outside_workspace_argument",
	"unexpected_command_outside_workspace_cwd",
	"unexpected_read_approval",
	"unexpected_write_approval",
	"unexpected_tool_approval",
	"unexpected_resume_task",
	"unexpected_resume_completed_task",
	"unexpected_recovery_or_approval",
	"unexpected_completed_verification",
	"request_limit_reached",
	"scenario_deadline",
	"actual_model_mismatch",
	"model-unavailable",
	"discovery-unavailable",
	"profile_busy",
	"runner_timeout",
	"runner_request_limit",
	"runner_failure",
	"other",
] as const
export type ProblemSolvingDiagnosticFailureCode = (typeof problemSolvingDiagnosticFailureCodes)[number]

export type ProblemSolvingHostResult = {
	phase: "sample" | "preflight" | "smoke"
	status: "passed" | "failed" | "blocked" | "cancelled"
	failureClass?: ProblemSolvingFailureClass
	failureCategory?: ProblemSolvingDiagnosticFailureCategory | null
	failureCode?: ProblemSolvingDiagnosticFailureCode | null
	modelId?: string | null
	effort?: string | null
	tracePath?: string | null
	buildIdentity: string
	usage: {
		cost: number | null
		inputTokens: number | null
		outputTokens: number | null
		requests: number | null
	}
}

export type ProblemSolvingExtensionRequest = {
	workspace: string
	profileDir: string
	artifactsDir: string
	runId: string
	requestLimit: number
	provider: "live-copilot" | "scripted"
	modelId?: string
	effort?: string
	hostVersion: string
	taskId: string
	promptPath: string
}

export type ProblemSolvingAttemptReport = {
	schemaVersion: 1
	taskId: string
	taskVersion: number
	taskDigest: string
	lane: ProblemSolvingTask["lane"]
	attemptId: string
	workspace: string
	profileDir: string
	hostVersion: string
	buildIdentity: string
	providerMode: "live-copilot" | "scripted"
	countsAsSolving: boolean
	model: { id: string | null; effort: string | null }
	tracePath: string | null
	usage: ProblemSolvingHostResult["usage"]
	graderDecision: GraderRunResult["decision"] | null
	failureClass: ProblemSolvingFailureClass | null
	failureCategory?: ProblemSolvingDiagnosticFailureCategory | null
	failureCode?: ProblemSolvingDiagnosticFailureCode | null
	status: "passed" | "failed" | "blocked" | "cancelled"
}

const EXTENSION_RUNNER = path.join("apps", "vscode-e2e", "out", "runTest.js")

export function existingExtensionRunnerArguments(
	request: ProblemSolvingExtensionRequest,
	runnerPath: string,
): string[] {
	if (request.provider !== "live-copilot")
		throw new Error("Problem-solving extension runs use the live Copilot provider")
	if (!request.modelId || !request.effort)
		throw new Error("Problem-solving extension runs require a model id and effort")
	if (
		runnerPath.replaceAll("\\", "/").includes("vscode-shim") ||
		runnerPath.replaceAll("\\", "/").includes("apps/cli/")
	) {
		throw new Error("Problem-solving runs must use the existing VS Code extension runner")
	}
	if (!path.isAbsolute(request.artifactsDir) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.runId)) {
		throw new Error("Problem-solving extension runs require an absolute artifacts directory and a runner id")
	}
	if (!Number.isSafeInteger(request.requestLimit) || request.requestLimit < 1 || request.requestLimit > 200) {
		throw new Error("Problem-solving extension runs require a request limit from 1 to 200")
	}
	return [
		runnerPath,
		"--provider",
		"live-copilot",
		"--vscode-version",
		request.hostVersion,
		"--workspace",
		request.workspace,
		"--profile-dir",
		request.profileDir,
		"--artifacts-dir",
		request.artifactsDir,
		"--init-profile",
		"--retain-evidence-for-campaign",
		"--run-id",
		request.runId,
		"--model-id",
		request.modelId,
		"--reasoning-effort",
		request.effort,
		"--file",
		"workflow.test",
		"--scenario-id",
		"problem-solving-attempt",
		"--scenario-phase",
		"run",
		"--request-limit",
		String(request.requestLimit),
	]
}

export function problemSolvingHostFromReceipts(input: {
	buildIdentity: string
	tracePath: string | null
	workflow: {
		status?: string
		requestsUsed?: number | null
		usage?: { inputTokens?: number | null; outputTokens?: number | null; cost?: number | null }
		failure?: { category?: string; code?: string }
		model?: { id?: string; reasoningEffort?: string }
	} | null
	runnerFailure?: string | null
}): ProblemSolvingHostResult {
	const requests = input.workflow?.requestsUsed
	const reported = input.workflow?.usage
	const token = (value: number | null | undefined) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
	// A zero price is not a measured cost. Copilot often stores 0 when no price was returned.
	const cost =
		typeof reported?.cost === "number" && Number.isFinite(reported.cost) && reported.cost > 0 ? reported.cost : null
	const usage = {
		cost,
		inputTokens: token(reported?.inputTokens),
		outputTokens: token(reported?.outputTokens),
		requests: typeof requests === "number" ? requests : null,
	}
	const modelId = input.workflow?.model?.id ?? null
	const effort = input.workflow?.model?.reasoningEffort ?? null
	const base = {
		phase: "sample" as const,
		buildIdentity: input.buildIdentity,
		modelId,
		effort,
		tracePath: input.tracePath,
		usage,
	}
	if (input.workflow?.status === "passed") return { ...base, status: "passed" }
	const failureClass = classifyReceipt(input.workflow, input.runnerFailure)
	const failureCategory =
		safeDiagnosticCategory(input.workflow?.failure?.category) ?? safeRunnerFailureCategory(input.runnerFailure)
	const failureCode = safeDiagnosticCode(input.workflow?.failure?.code, input.runnerFailure)
	return {
		...base,
		status:
			failureClass === "cancellation"
				? "cancelled"
				: failureClass === "authentication" || failureClass === "profile_busy"
					? "blocked"
					: "failed",
		failureClass,
		failureCategory,
		failureCode,
	}
}

function safeDiagnosticCategory(value: unknown): ProblemSolvingDiagnosticFailureCategory | null {
	return problemSolvingDiagnosticFailureCategories.find((category) => category === value) ?? null
}

function safeDiagnosticCode(
	workflowCode: unknown,
	runnerFailure: string | null | undefined,
): ProblemSolvingDiagnosticFailureCode | null {
	if (typeof workflowCode === "string") {
		return problemSolvingDiagnosticFailureCodes.find((code) => code === workflowCode) ?? "other"
	}
	return safeRunnerFailureCode(runnerFailure)
}

function safeRunnerFailureCategory(value: string | null | undefined): ProblemSolvingDiagnosticFailureCategory | null {
	if (value === "profile-busy") return "runner"
	if (typeof value === "string" && /timeout|deadline/i.test(value)) return "timeout"
	if (typeof value === "string" && /request.*limit|limit.*request/i.test(value)) return "provider"
	return null
}

function safeRunnerFailureCode(value: string | null | undefined): ProblemSolvingDiagnosticFailureCode | null {
	if (!value) return null
	if (value === "profile-busy") return "profile_busy"
	const exact = problemSolvingDiagnosticFailureCodes.find((code) => code === value)
	if (exact) return exact
	if (/timeout|deadline/i.test(value)) return "runner_timeout"
	if (/request.*limit|limit.*request/i.test(value)) return "runner_request_limit"
	return "runner_failure"
}

function classifyReceipt(
	workflow: { failure?: { category?: string; code?: string } } | null,
	runnerFailure?: string | null,
): ProblemSolvingFailureClass {
	const code = workflow?.failure?.code ?? runnerFailure ?? ""
	if (code.includes("authentication") || code === "setup-incomplete") return "authentication"
	if (code === "profile-busy") return "profile_busy"
	if (
		code === "model-unavailable" ||
		code === "discovery-unavailable" ||
		workflow?.failure?.category === "provider"
	) {
		return "provider"
	}
	if (workflow?.failure?.category === "policy") return "infrastructure"
	if (workflow?.failure?.category === "timeout" || code.includes("timeout") || code.includes("budget"))
		return "budget"
	if (code.includes("cancel")) return "cancellation"
	if (workflow) return "task"
	return "infrastructure"
}

export async function runProblemSolvingAttempt(options: {
	evalRoot: string
	repositoryRoot: string
	taskId: string
	attemptRoot: string
	attemptId: string
	hostVersion: string
	provider: "live-copilot" | "scripted"
	modelId?: string
	effort?: string
	profileDir?: string
	requestLimit?: number
	runExtension: (request: ProblemSolvingExtensionRequest) => Promise<ProblemSolvingHostResult>
	processRunner?: HarnessProcessRunner
}): Promise<ProblemSolvingAttemptReport> {
	const manifest = await loadProblemSolvingSet(options.evalRoot)
	const task = manifest.tasks.find(({ id }) => id === options.taskId)
	if (!task) throw new Error(`Problem-solving set is missing ${options.taskId}`)
	const fixture = await resolveFixture(options.evalRoot, task)
	const workspace = path.join(options.attemptRoot, options.attemptId, "workspace")
	const profileDir = options.profileDir ?? path.join(options.attemptRoot, options.attemptId, "profile")
	const artifactsDir = path.join(options.attemptRoot, options.attemptId, "artifacts")
	await fs.mkdir(profileDir, { recursive: true })
	await fs.mkdir(artifactsDir, { recursive: true })
	await fs.cp(fixture, workspace, { recursive: true })
	const request: ProblemSolvingExtensionRequest = {
		workspace,
		profileDir,
		artifactsDir,
		runId: options.attemptId,
		requestLimit: options.requestLimit ?? 40,
		provider: options.provider,
		modelId: options.modelId,
		effort: options.effort,
		hostVersion: options.hostVersion,
		taskId: task.id,
		promptPath: path.join(workspace, "prompt.md"),
	}
	const host = await options.runExtension(request)
	const diagnostic = host.phase !== "sample" || options.provider !== "live-copilot"
	const skipGrader =
		diagnostic ||
		host.status === "blocked" ||
		host.status === "cancelled" ||
		host.failureClass === "cancellation" ||
		host.failureClass === "authentication" ||
		host.failureClass === "profile_busy"
	const grader = skipGrader ? null : await gradeWorkspace(workspace, task.id, options.processRunner)
	const failureClass = classify(host, grader)
	const solved = !diagnostic && host.status === "passed" && grader?.decision === "passed" && failureClass === null
	return {
		schemaVersion: 1,
		taskId: task.id,
		taskVersion: task.version,
		taskDigest: task.digest,
		lane: task.lane,
		attemptId: options.attemptId,
		workspace,
		profileDir,
		hostVersion: options.hostVersion,
		buildIdentity: host.buildIdentity,
		providerMode: options.provider,
		countsAsSolving: solved,
		model: { id: host.modelId ?? options.modelId ?? null, effort: host.effort ?? options.effort ?? null },
		tracePath: host.tracePath ?? null,
		usage: host.usage,
		graderDecision: grader?.decision ?? null,
		failureClass,
		failureCategory: host.failureCategory ?? null,
		failureCode: host.failureCode ?? null,
		status: solved
			? "passed"
			: host.status === "cancelled" || failureClass === "cancellation"
				? "cancelled"
				: host.status === "blocked" || failureClass === "authentication" || failureClass === "profile_busy"
					? "blocked"
					: "failed",
	}
}

function classify(host: ProblemSolvingHostResult, grader: GraderRunResult | null): ProblemSolvingFailureClass | null {
	if (host.phase !== "sample") return null
	if (host.failureClass && host.failureClass !== "task") return host.failureClass
	if (host.status === "cancelled") return "cancellation"
	if (!grader || grader.decision === "passed") return host.failureClass ?? null
	return "task"
}

async function gradeWorkspace(
	workspace: string,
	taskId: string,
	processRunner: HarnessProcessRunner = new ExecaHarnessProcessRunner(),
): Promise<GraderRunResult> {
	const spec: CommandGraderSpec = {
		id: `${taskId}.visible-tests`,
		version: 1,
		type: "command",
		hardGate: true,
		failureClass: "outcome",
		commands: [{ command: "node", args: ["--test", ...(await visibleTestFiles(workspace))] }],
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 256_000,
	}
	return createDefaultGraderRegistry().execute([spec], {
		workspaceRoot: workspace,
		changedPaths: [],
		trace: [],
		processRunner,
		clock: systemClock,
	})
}

async function visibleTestFiles(workspace: string): Promise<string[]> {
	const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8")) as {
		scripts?: { test?: string }
	}
	const specific = packageJson.scripts?.test?.match(/test\/[A-Za-z0-9._-]+\.js/g)
	if (specific && !packageJson.scripts?.test?.includes("*")) return specific
	const files = (await fs.readdir(path.join(workspace, "test")))
		.filter((name) => name.endsWith(".js"))
		.sort()
		.map((name) => `test/${name}`)
	if (files.length === 0) throw new Error("Problem-solving fixture is missing a visible test")
	return files
}

async function resolveFixture(evalRoot: string, task: ProblemSolvingTask): Promise<string> {
	if (task.fixture) return path.join(evalRoot, task.fixture)
	if (task.source !== "alpha-task-bank") {
		throw new Error(`Task ${task.id} has no local fixture for the extension campaign`)
	}
	const suite = benchmarkSuiteManifestSchema.parse(
		parse(await fs.readFile(path.join(evalRoot, "frontier-v1.yaml"), "utf8"), { merge: true }),
	)
	const entry = suite.tasks.find((candidate: BenchmarkTaskManifest) => candidate.id === task.id)
	if (!entry) throw new Error(`Frontier fixture is missing for ${task.id}`)
	return path.join(evalRoot, entry.fixture)
}

export function defaultExtensionRunnerPath(repositoryRoot: string): string {
	return path.join(repositoryRoot, EXTENSION_RUNNER)
}
