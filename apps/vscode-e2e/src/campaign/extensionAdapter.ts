import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { TEST_RUN_FAILURE_CODES } from "../runFailure"
import { assertWorkflowResult, MAX_WORKFLOW_RESULT_BYTES } from "../scenarios/contracts"
import { runOwnedProcess } from "./ownedProcess"
import { applyPatchPlan } from "./patchPlan"
import { auditRetainedStorage } from "../evidence/retainedStorageBudget"
import { markRunRetentionEligible } from "../evidence/retention"
import { assertOwnedTestRoot } from "../testProfile"
import { openCampaignRoot } from "./reportStore"
import { requireHeldRetentionReceipt } from "./retentionReceipt"
import { CampaignStorageError } from "./types"
import { validateScenarioResult } from "./resultValidation"
import {
	isWithin,
	readBounded,
	rejectSymlinkComponents,
	requireEvidenceRun,
	requireEvidenceRoot,
} from "../evidence/paths"
import type { CampaignConfig, CampaignOperations, FailureClass, ScenarioRequest, ScenarioResult } from "./types"

type PhaseRecord = {
	attemptId: string
	runId: string
	phase: "run" | "prepare" | "continue"
	artifacts: string
	resultPath: string
	evidence?: string
	retentionFailed?: true
}
type AttemptContext = { directory: string; workspace: string; phases: PhaseRecord[]; admissions: string[] }

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse((await readBounded(filePath, MAX_WORKFLOW_RESULT_BYTES)).toString("utf8"))
}

/** A zero exit code with all tests skipped is not rendered completion acceptance. */
export function completionReplayPassed(value: unknown): boolean {
	if (!value || typeof value !== "object") return false
	const report = value as Record<string, unknown>
	if (
		report.success !== true ||
		report.numPassedTests !== 1 ||
		report.numFailedTests !== 0 ||
		!Array.isArray(report.testResults)
	)
		return false
	return report.testResults.some((entry: unknown) => {
		if (!entry || typeof entry !== "object") return false
		const assertions = (entry as Record<string, unknown>).assertionResults
		return (
			Array.isArray(assertions) &&
			assertions.some((item: unknown) => {
				if (!item || typeof item !== "object") return false
				const assertion = item as Record<string, unknown>
				return (
					assertion.title === "replays the isolated live completion-idle capture through the rendered chat" &&
					assertion.status === "passed"
				)
			})
		)
	})
}

const blocked = (fingerprint: string, failureClass: FailureClass = "infrastructure"): ScenarioResult => ({
	status: "blocked",
	failure: { class: failureClass, fingerprint },
	usage: { requests: null, inputTokens: null, outputTokens: null, cost: null },
})

const blockObservedResult = (result: ScenarioResult, fingerprint: string): ScenarioResult => ({
	...result,
	status: "blocked",
	failure: { class: "infrastructure", fingerprint },
})

const runnerFailureCodes: ReadonlySet<string> = new Set(TEST_RUN_FAILURE_CODES)

function classifyFailure(category: string, code: string): FailureClass {
	if (
		[
			"authentication_required",
			"copilot_authentication_required",
			"authentication-required",
			"authentication-unknown",
		].includes(code)
	)
		return "authentication"
	if (["request_budget_exhausted", "request_limit_exhausted", "usage_limit", "quota_exceeded"].includes(code))
		return "usage_limit"
	return ["provider", "tool", "persistence", "lifecycle", "assertion"].includes(category)
		? (category as FailureClass)
		: "infrastructure"
}

/** This only projects independent host assertions; it never interprets assistant completion text. */
export function projectWorkflowResult(
	value: unknown,
	request: ScenarioRequest,
	phase: PhaseRecord["phase"],
	expectedRunId = `${request.attemptId}-${phase}`,
): {
	result: ScenarioResult
	checkpointed: boolean
} {
	assertWorkflowResult(value)
	const candidate = value
	if (candidate.runId !== expectedRunId || candidate.scenarioId !== request.scenarioId || candidate.phase !== phase)
		throw new Error("Invalid workflow result")
	if (candidate.hostVersion !== request.host.version || candidate.providerMode !== request.provider.mode) {
		return { result: blocked("host_or_provider_mismatch"), checkpointed: false }
	}
	if (
		request.provider.mode === "live-copilot" &&
		(candidate.model.id !== request.provider.modelId ||
			(request.provider.effort && candidate.model.reasoningEffort !== request.provider.effort))
	) {
		return { result: blocked("model_configuration_mismatch", "provider"), checkpointed: false }
	}
	const checkpointed = candidate.status === "checkpointed"
	if (checkpointed && (phase !== "prepare" || request.scenarioId !== "reload-continuation"))
		throw new Error("Unexpected checkpoint")
	const passed = candidate.status === "passed" || checkpointed
	if (!Array.isArray(candidate.taskIds) || (passed && !candidate.taskIds.length) || (passed && candidate.failure)) {
		throw new Error("Invalid workflow task outcome")
	}
	if (passed && (!candidate.checks.length || candidate.checks.some((check) => !check.passed))) {
		return { result: blocked("independent_checks_missing", "assertion"), checkpointed: false }
	}
	const projection = validateScenarioResult({
		status: checkpointed ? "passed" : candidate.status,
		usage: { requests: candidate.requestsUsed, inputTokens: null, outputTokens: null, cost: null },
		actualHostVersion: candidate.hostVersion,
		...(candidate.model.id ? { model: { id: candidate.model.id, effort: candidate.model.reasoningEffort } } : {}),
		taskIds: candidate.taskIds,
		...(candidate.failure
			? {
					failure: {
						class: classifyFailure(candidate.failure.category, candidate.failure.code),
						fingerprint: `sha256:${createHash("sha256").update(candidate.failure.code).digest("hex")}`,
					},
				}
			: {}),
	})
	return { result: projection, checkpointed }
}

export interface ExtensionCampaignAdapterOptions {
	config: CampaignConfig
	/** Canonical marked root, including all earlier campaigns. Never infer it from a process cwd. */
	campaignRoot: string
	/** The exclusive run directory created by createReportStore. */
	runDirectory: string
	profileRoot: string
	repositoryRoot: string
	persistReport: CampaignOperations["persistReport"]
	/** Required only for opted-in builds. Invoke pnpm through Node, never a .cmd shell string. */
	pnpmCliPath?: string
}

export function createExtensionCampaignOperations(
	options: ExtensionCampaignAdapterOptions,
	dependencies: { runProcess?: typeof runOwnedProcess; auditStorage?: typeof auditRetainedStorage } = {},
): CampaignOperations {
	const contexts = new Map<string, AttemptContext>()
	const runProcess = dependencies.runProcess ?? runOwnedProcess
	const auditStorage = dependencies.auditStorage ?? auditRetainedStorage
	const artifactsRoot = path.join(options.runDirectory, "host-evidence")
	const campaignPrefix = createHash("sha256").update(options.config.id).digest("hex")
	const recordedPhases: PhaseRecord[] = []
	let admissionSequence = 0
	let terminalReportSaved = false
	const assertStorageAdmission = async (signal: AbortSignal, context?: AttemptContext) => {
		const admission = await auditStorage({
			roots: [
				{ path: options.campaignRoot, label: "campaigns" },
				{ path: options.profileRoot, label: "profile", allowMissing: true },
			],
			limits: options.config.storageBudget,
			signal,
			assertOwned: async (candidate) => {
				if (isWithin(options.campaignRoot, candidate)) await openCampaignRoot(options.campaignRoot, false)
				else await assertOwnedTestRoot(candidate, "profile")
			},
		})
		const receipt = `storage-admission-${String(++admissionSequence).padStart(4, "0")}.json`
		await fs.writeFile(
			path.join(options.runDirectory, receipt),
			JSON.stringify({ schemaVersion: 1, admission }) + "\n",
			{ flag: "wx", mode: 0o600 },
		)
		context?.admissions.push(receipt)
		if (admission.status !== "within_budget")
			throw new CampaignStorageError(
				admission.status === "over_budget" ? "storage_budget" : "scan_incomplete",
				receipt,
			)
		return receipt
	}
	const runnerPath = path.join(options.repositoryRoot, "apps", "vscode-e2e", "out", "runTest.js")
	const requireCapturedEvidence = async (record: PhaseRecord): Promise<string> => {
		if (record.evidence) return record.evidence
		const root = await requireEvidenceRoot(path.dirname(record.artifacts))
		const directory = await requireEvidenceRun(root, record.runId)
		const manifestPath = path.join(directory, "manifest.json")
		const manifest = (await readJson(manifestPath)) as Record<string, unknown> | null
		if (
			!manifest ||
			manifest.kind !== "alpha-vscode-e2e-run-evidence" ||
			manifest.version !== 1 ||
			manifest.runId !== record.runId ||
			manifest.finalized !== true ||
			manifest.captureComplete !== true
		)
			throw new Error("Runner evidence missing or incomplete")
		record.evidence = manifestPath
		return manifestPath
	}
	return {
		async persistReport(report) {
			await options.persistReport(report)
			if (report.id === options.config.id && report.finishedAt && report.stopReason) terminalReportSaved = true
		},
		async runScenario(request, signal) {
			const directory = path.join(options.runDirectory, request.attemptId)
			await rejectSymlinkComponents(directory)
			await fs.mkdir(directory)
			const context: AttemptContext = {
				directory,
				workspace: path.join(directory, "workspace"),
				phases: [],
				admissions: [],
			}
			contexts.set(request.attemptId, context)
			await fs.mkdir(context.workspace)
			let requestsUsed = 0
			const phases =
				request.scenarioId === "reload-continuation" ? (["prepare", "continue"] as const) : (["run"] as const)
			for (const phase of phases) {
				if (signal.aborted) throw new Error("Campaign cancelled")
				try {
					await assertStorageAdmission(signal, context)
				} catch (error) {
					if (!(error instanceof CampaignStorageError)) throw error
					return {
						...blocked(error.code),
						usage: { requests: requestsUsed, inputTokens: null, outputTokens: null, cost: null },
					}
				}
				const remaining = Math.min(200, request.requestLimit - requestsUsed)
				if (remaining <= 0)
					return {
						...blocked("request_budget_exhausted", "usage_limit"),
						usage: { requests: requestsUsed, inputTokens: null, outputTokens: null, cost: null },
					}
				const runId = `${campaignPrefix}-${request.attemptId}-${phase}`
				const record: PhaseRecord = {
					attemptId: request.attemptId,
					runId,
					phase,
					artifacts: path.join(artifactsRoot, runId),
					resultPath: path.join(artifactsRoot, runId, "workflow-result.json"),
				}
				context.phases.push(record)
				recordedPhases.push(record)
				const args = [
					runnerPath,
					"--provider",
					request.provider.mode,
					"--vscode-version",
					request.host.version,
					"--workspace",
					context.workspace,
					"--profile-dir",
					options.profileRoot,
					"--init-profile",
					"--artifacts-dir",
					artifactsRoot,
					"--retain-evidence-for-campaign",
					"--run-id",
					record.runId,
					"--file",
					"workflow.test",
					"--scenario-id",
					request.scenarioId,
					"--scenario-phase",
					phase,
					"--scenario-result-path",
					record.resultPath,
					"--request-limit",
					String(remaining),
				]
				if (request.host.executable) args.push("--vscode-executable", request.host.executable)
				if (request.provider.modelId) args.push("--model-id", request.provider.modelId)
				if (request.provider.effort) args.push("--reasoning-effort", request.provider.effort)
				const processResult = await runProcess(
					{ executable: process.execPath, args, cwd: options.repositoryRoot },
					{ signal },
				)
				let runner: Record<string, unknown> | undefined
				try {
					const value = await readJson(path.join(record.artifacts, "run-result.json"))
					if (value && typeof value === "object" && !Array.isArray(value))
						runner = value as Record<string, unknown>
				} catch {
					/* Missing receipt is a blocker, not proof of a clean exit. */
				}
				let projection
				try {
					projection = projectWorkflowResult(await readJson(record.resultPath), request, phase, record.runId)
				} catch {
					const code =
						typeof runner?.failure === "string" && runnerFailureCodes.has(runner.failure)
							? runner.failure
							: "scenario_result_unavailable"
					projection = { result: blocked(code, classifyFailure("host", code)), checkpointed: false }
				}
				const hostClosed =
					runner?.runId === record.runId &&
					runner.execution === "extension-host" &&
					runner.hostExitObserved === true &&
					runner.ownershipGate === "verified"
				if (!hostClosed && projection.result.failure?.class !== "authentication") {
					projection.result = blockObservedResult(projection.result, "host_cleanup_unverified")
				}
				if (!processResult.cleanupVerified && processResult.signal !== null) {
					projection.result = blockObservedResult(projection.result, "process_cleanup_unverified")
				}
				try {
					await requireHeldRetentionReceipt(record.artifacts, record.runId, runner?.retentionResultPath)
				} catch {
					record.retentionFailed = true
					projection.result.retentionFailed = true
					if (projection.result.status === "passed")
						projection.result = {
							...projection.result,
							status: "blocked",
							failure: { class: "infrastructure", fingerprint: "retention_failed" },
						}
				}
				if (processResult.exitCode !== 0 && projection.result.status === "passed")
					projection.result = blockObservedResult(
						projection.result,
						runner?.failure === "evidence-failed" ? "evidence_failed" : "host_exit_failed",
					)
				if (request.scenarioId === "completion-idle" && projection.result.status === "passed") {
					const replayReportPath = path.join(directory, "completion-ui-tests.json")
					const replay = await runProcess(
						{
							executable: process.execPath,
							args: [
								path.join(options.repositoryRoot, "webview-ui/node_modules/vitest/vitest.mjs"),
								"run",
								"src/components/chat/__tests__/ChatView.spec.tsx",
								"-t",
								"isolated live completion-idle",
								"--reporter=json",
								"--outputFile",
								replayReportPath,
							],
							cwd: path.join(options.repositoryRoot, "webview-ui"),
							env: {
								...process.env,
								ALPHA_COMPLETION_IDLE_EVIDENCE: path.join(record.artifacts, "completion-idle.json"),
							},
						},
						{ signal, maxOutputBytes: 32_768 },
					)
					await fs.writeFile(path.join(directory, "completion-ui-replay.json"), JSON.stringify(replay), {
						flag: "wx",
					})
					const assertionsPassed = await readJson(replayReportPath).then(completionReplayPassed, () => false)
					if (replay.exitCode !== 0 || replay.signal !== null || replay.outputTruncated || !assertionsPassed)
						projection.result = {
							...projection.result,
							status: "failed",
							failure: { class: "assertion", fingerprint: "completion_ui_replay_failed" },
						}
				}
				if (projection.result.usage.requests === null) return projection.result
				requestsUsed += projection.result.usage.requests
				const combined = { ...projection.result, usage: { ...projection.result.usage, requests: requestsUsed } }
				if (projection.result.status !== "passed") return combined
				if (phase === "prepare" && !projection.checkpointed)
					return blocked("reload_checkpoint_missing", "lifecycle")
				if (phase !== "prepare") return combined
				// A reload is a new launch: finalize phase evidence before allowing it.
				try {
					await requireCapturedEvidence(record)
				} catch {
					return blockObservedResult(combined, "evidence_failed")
				}
			}
			return blocked("reload_continuation_missing", "lifecycle")
		},
		async preserveEvidence(request) {
			const context = contexts.get(request.attemptId)
			if (!context || (!context.phases.length && !context.admissions.length))
				throw new Error("Attempt context missing")
			for (const record of context.phases) await requireCapturedEvidence(record)
			const manifests = context.phases.map((record) => path.relative(options.runDirectory, record.evidence!))
			const summaryPath = path.join(context.directory, "evidence-index.json")
			await fs.writeFile(
				summaryPath,
				JSON.stringify({ schemaVersion: 1, manifests, admissions: context.admissions }) + "\n",
				{
					flag: "wx",
					mode: 0o600,
				},
			)
			contexts.delete(request.attemptId)
			return path.relative(options.runDirectory, summaryPath)
		},
		async finalizeRetention(report) {
			if (!terminalReportSaved || report.id !== options.config.id || !report.finishedAt || !report.stopReason)
				throw new Error("Retention requires a durable terminal campaign report")
			const attempts = new Set(report.attempts.map((attempt) => attempt.request.attemptId))
			const phases = recordedPhases.filter((phase) => attempts.has(phase.attemptId))
			let outcome: Record<string, unknown>
			let status: "complete" | "blocked" | "failed" = phases.some((phase) => phase.retentionFailed)
				? "failed"
				: "complete"
			try {
				// Keep reports and their evidence together. Matrix/iteration limits bound launches; aggregate storage
				// admission bounds retained bytes/entries. A standalone 20-run pruner cannot own a 22-launch matrix.
				const storageAdmission = await assertStorageAdmission(new AbortController().signal)
				for (const phase of phases) {
					if (!phase.evidence || phase.retentionFailed) continue
					const manifest = (await readJson(phase.evidence)) as {
						metadata?: { outcome?: string }
						captureComplete?: boolean
					}
					if (manifest.captureComplete && manifest.metadata?.outcome === "passed")
						await markRunRetentionEligible({ artifactsRoot, runId: phase.runId })
				}
				outcome = { storageAdmission }
			} catch (error) {
				if (error instanceof CampaignStorageError) {
					if (status !== "failed") status = "blocked"
					outcome = { code: error.code, storageAdmission: error.receipt }
				} else if ((error as NodeJS.ErrnoException).code === "ENOENT" && recordedPhases.length === 0)
					outcome = { noHostEvidence: true }
				else {
					status = "failed"
					outcome = { code: "retention_failed" }
				}
			}
			const receipt = "retention-result.json"
			await fs.writeFile(
				path.join(options.runDirectory, receipt),
				JSON.stringify({ schemaVersion: 1, status, ...outcome }) + "\n",
				{ flag: "wx", mode: 0o600 },
			)
			return { status, receipt }
		},
		...(options.config.repair
			? ({
					async applyPatch(repair, signal) {
						if (signal.aborted) throw new Error("Campaign cancelled")
						await assertStorageAdmission(signal)
						if (
							(await fs.realpath(options.config.repair!.sourceRoot)) !==
							(await fs.realpath(options.repositoryRoot))
						)
							throw new Error("Source scope mismatch")
						return applyPatchPlan(
							options.config.repair!.sourceRoot,
							options.config.repair!.allowedPaths,
							repair.patch,
							signal,
						)
					},
					async build(signal) {
						await assertStorageAdmission(signal)
						if (!options.pnpmCliPath || !path.isAbsolute(options.pnpmCliPath)) return false
						const result = await runProcess(
							{
								executable: process.execPath,
								args: [options.pnpmCliPath, "-w", "bundle"],
								cwd: options.repositoryRoot,
							},
							{ signal },
						)
						return result.exitCode === 0
					},
				} satisfies Pick<CampaignOperations, "applyPatch" | "build">)
			: {}),
	}
}
