import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { createExtensionCampaignOperations, projectWorkflowResult } from "../extensionAdapter"
import { prepareEvidenceRun } from "../../evidence/paths"
import { openCampaignRoot } from "../reportStore"
import { auditRetainedStorage } from "../../evidence/retainedStorageBudget"
import { markRunRetentionEligible } from "../../evidence/retention"
import { campaignExitCode, main, resolveCampaignProfileRoot } from "../../runCampaign"
import { CampaignStorageError, type ScenarioRequest, type CampaignReport, type CampaignConfig } from "../types"
import type { OwnedProcessCommand } from "../ownedProcess"
import {
	assertWorkflowResult,
	MAX_WORKFLOW_CHECKS,
	MAX_WORKFLOW_CHECK_NAME_LENGTH,
	MAX_WORKFLOW_RESULT_BYTES,
} from "../../scenarios/contracts"

const request: ScenarioRequest = {
	campaignId: "test",
	attemptId: "attempt-0001",
	host: { version: "1.122.1" },
	scenarioId: "review-edit-test-commit-followup",
	sample: 1,
	phase: "sample",
	provider: { mode: "scripted" },
	requestLimit: 5,
}
const workflow = () => ({
	schemaVersion: 1,
	runId: "attempt-0001-run",
	scenarioId: request.scenarioId,
	phase: "run",
	status: "passed",
	checks: [{ name: "file-effect", passed: true }],
	taskIds: ["task-1"],
	hostVersion: "1.122.1",
	providerMode: "scripted",
	model: { id: "fake-model" },
	requestsUsed: 2,
})

test("campaign profile selection preserves the default and forwards an explicit absolute profile root", async () => {
	const campaignRoot = path.join(os.tmpdir(), "new-campaign")
	const authenticatedProfile = path.join(os.tmpdir(), "existing-copilot-profile")
	assert.equal(resolveCampaignProfileRoot(campaignRoot), path.join(campaignRoot, "profiles"))
	assert.equal(resolveCampaignProfileRoot(campaignRoot, authenticatedProfile), authenticatedProfile)
	for (const invalid of ["relative-profile", "", `${authenticatedProfile}\0bad`])
		assert.throws(() => resolveCampaignProfileRoot(campaignRoot, invalid), /absolute path/)
	await assert.rejects(
		main(["--root", campaignRoot, "--config", "unused.json", "--profile-dir", "relative-profile"]),
		/absolute path/,
	)
	await assert.rejects(
		main(["--storage-recovery-root", campaignRoot, "--profile-dir", authenticatedProfile]),
		/Conflicting campaign modes/,
	)
})

test("real storage admission counts prior campaigns and blocks launch, patch and build without deleting sources", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-cap-")))
	context.after(() => fs.rm(root, { recursive: true, force: true }))
	await openCampaignRoot(root, true)
	const runDirectory = path.join(root, "new-campaign")
	await fs.mkdir(runDirectory)
	await fs.mkdir(path.join(root, "old-campaign"))
	const sentinel = path.join(root, "old-campaign", "private-data")
	await fs.writeFile(sentinel, "keep this retained history")
	const config: CampaignConfig = {
		id: "new-campaign",
		hosts: [request.host],
		scenarioIds: [request.scenarioId],
		samples: 1,
		provider: request.provider,
		budgets: { maxIterations: 2, maxRequests: 2, maxDurationMs: 1000, attemptTimeoutMs: 1000 },
		maxReproductions: 1,
		storageBudget: { maxBytes: 1, maxEntries: 100, maxDepth: 32 },
		repair: { enabled: true, sourceRoot: root, allowedPaths: ["src/fix.ts"], plans: [] },
	}
	let launches = 0
	const operations = createExtensionCampaignOperations(
		{
			config,
			campaignRoot: root,
			runDirectory,
			profileRoot: path.join(root, "profiles"),
			repositoryRoot: root,
			persistReport: async () => {},
		},
		{
			runProcess: async () => {
				launches++
				throw new Error("must not launch")
			},
		},
	)
	const result = await operations.runScenario(request, new AbortController().signal)
	assert.equal(result.failure?.fingerprint, "storage_budget")
	assert.equal(result.usage.requests, 0)
	const indexPath = await operations.preserveEvidence(request, result)
	const index = JSON.parse(await fs.readFile(path.join(runDirectory, indexPath), "utf8"))
	assert.equal(index.manifests.length, 0)
	assert.equal(index.admissions.length, 1)
	await assert.rejects(operations.build!(new AbortController().signal), CampaignStorageError)
	await assert.rejects(
		operations.applyPatch!(
			{
				scenarioId: "test",
				regressionScenarioId: "test",
				neighborScenarioIds: ["test"],
				diagnosisId: "test",
				patch: { id: "test", edits: [] },
			},
			new AbortController().signal,
		),
		CampaignStorageError,
	)
	assert.equal(launches, 0)
	assert.equal(await fs.readFile(sentinel, "utf8"), "keep this retained history")
})

test("projects verified metadata and rejects failed checks behind a passed claim", () => {
	const projected = projectWorkflowResult(workflow(), request, "run")
	assert.equal(projected.result.status, "passed")
	assert.equal(projected.result.actualHostVersion, "1.122.1")
	assert.equal(projected.result.usage.requests, 2)
	const invalid = { ...workflow(), checks: [{ name: "file-effect", passed: false }] }
	assert.equal(projectWorkflowResult(invalid, request, "run").result.failure?.class, "assertion")
	assert.throws(() => projectWorkflowResult({ ...workflow(), taskIds: [] }, request, "run"))
	assert.throws(() => projectWorkflowResult({ ...workflow(), runId: "stale-run" }, request, "run"))
})

test("producer and consumer share resource limits and reject malformed result envelopes", () => {
	const atLimit = {
		...workflow(),
		checks: Array.from({ length: MAX_WORKFLOW_CHECKS }, () => ({
			name: "n".repeat(MAX_WORKFLOW_CHECK_NAME_LENGTH),
			passed: true,
		})),
	}
	assertWorkflowResult(atLimit)
	assert.equal(projectWorkflowResult(atLimit, request, "run").result.status, "passed")
	for (const patch of [
		{ checks: [...atLimit.checks, { name: "extra", passed: true }] },
		{ checks: [{ name: "n".repeat(MAX_WORKFLOW_CHECK_NAME_LENGTH + 1), passed: true }] },
		{ checks: [{ name: "", passed: true }] },
		{ checks: [{ name: "test", passed: "true" }] },
		{ checks: [null] },
		{ checks: {} },
		{ phase: ["run"] },
		{ status: ["passed"] },
		{ taskIds: new Array(101).fill("task") },
		{ taskIds: [null] },
		{ model: [] },
		{ model: { id: "x".repeat(129) } },
		{ model: { reasoningEffort: 5 } },
		{ requestsUsed: -1 },
		{ requestsUsed: 0.5 },
		{ requestsUsed: Number.MAX_SAFE_INTEGER + 1 },
		{ requestsUsed: undefined },
		{ status: "failed", failure: { category: ["harness"], code: "bad" } },
	]) {
		const invalid = { ...workflow(), ...patch }
		assert.throws(() => assertWorkflowResult(invalid))
		assert.throws(() => projectWorkflowResult(invalid, request, "run"))
	}
	assert.equal(
		projectWorkflowResult({ ...workflow(), requestsUsed: null }, request, "run").result.usage.requests,
		null,
	)
})

test("does not substitute a host, model, or reasoning effort", () => {
	assert.equal(
		projectWorkflowResult({ ...workflow(), hostVersion: "1.136.1" }, request, "run").result.status,
		"blocked",
	)
	const liveRequest = { ...request, provider: { mode: "live-copilot" as const, modelId: "requested", effort: "max" } }
	for (const model of [
		{ id: "other", reasoningEffort: "max" },
		{ id: "requested", reasoningEffort: "high" },
	]) {
		assert.equal(
			projectWorkflowResult({ ...workflow(), providerMode: "live-copilot", model }, liveRequest, "run").result
				.status,
			"blocked",
		)
	}
})

test("prepare is explicitly checkpointed and cannot masquerade as a completed reload", () => {
	const reloadRequest = { ...request, scenarioId: "reload-continuation" }
	const checkpoint = {
		...workflow(),
		runId: "attempt-0001-prepare",
		scenarioId: "reload-continuation",
		phase: "prepare",
		status: "checkpointed",
	}
	assert.equal(projectWorkflowResult(checkpoint, reloadRequest, "prepare").checkpointed, true)
	assert.throws(() => projectWorkflowResult({ ...checkpoint, phase: "continue" }, reloadRequest, "continue"))
})

test("external failure details become a stable fingerprint without raw private payload", () => {
	const failed = {
		...workflow(),
		status: "failed",
		failure: { category: "assertion", code: "private-provider-payload" },
		prompt: "private prompt",
		model: { id: "fake-model", privateField: "secret" },
	}
	const projected = projectWorkflowResult(failed, request, "run").result
	assert.equal(projected.failure?.class, "assertion")
	assert.match(projected.failure!.fingerprint, /^sha256:[a-f0-9]{64}$/)
	for (const secret of ["private-provider-payload", "private prompt", "secret"])
		assert.ok(!JSON.stringify(projected).includes(secret))
	assert.throws(() => projectWorkflowResult({ ...failed, requestsUsed: Number.NaN }, request, "run"))
})

test("a finished matrix with observed failures has a nonzero exit code", () => {
	const report: CampaignReport = {
		version: 1,
		id: "test",
		mode: "report-only",
		requestedProvider: { mode: "scripted" },
		startedAt: "now",
		stopReason: "completed",
		counts: { passed: 2, failed: 1, blocked: 0 },
		usage: { requests: 3, inputTokens: null, outputTokens: null, cost: null },
		attempts: [],
		repairs: [],
	}
	assert.equal(campaignExitCode(report), 1)
	assert.equal(campaignExitCode({ ...report, counts: { passed: 2, failed: 0, blocked: 0 } }), 0)
	assert.equal(campaignExitCode({ ...report, stopReason: "authentication" }), 2)
})

test("adapter gates reload continuation on complete evidence, retention and storage admission", async (context) => {
	for (const scenario of [
		"complete",
		"incomplete-evidence",
		"capture-exit-failure",
		"host-exit-failure",
		"oversized-receipt",
		"storage-limit",
		"retention-failure",
	]) {
		const complete = scenario !== "incomplete-evidence" && scenario !== "capture-exit-failure"
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-adapter-")))
		await openCampaignRoot(root, true)
		context.after(() => fs.rm(root, { recursive: true, force: true }))
		const phases: string[] = []
		let audits = 0
		const operations = createExtensionCampaignOperations(
			{
				campaignRoot: root,
				config: {
					id: "test",
					hosts: [request.host],
					scenarioIds: ["reload-continuation"],
					samples: 1,
					provider: request.provider,
					budgets: { maxIterations: 2, maxRequests: 10, maxDurationMs: 1000, attemptTimeoutMs: 1000 },
					maxReproductions: 1,
				},
				runDirectory: root,
				profileRoot: path.join(root, "profiles"),
				repositoryRoot: root,
				persistReport: async () => {},
			},
			{
				auditStorage: async (options) => {
					audits++
					if (scenario === "storage-limit" && audits === 2)
						return {
							status: "over_budget",
							complete: false,
							bytes: 100,
							entries: 1,
							roots: 1,
							reason: "byte_limit",
						}
					return auditRetainedStorage(options)
				},
				runProcess: async (command: OwnedProcessCommand) => {
					const argument = (flag: string) => command.args[command.args.indexOf(flag) + 1]!
					const phase = argument("--scenario-phase")
					if (phase === "continue") {
						assert.equal(phases.length, 1)
						assert.ok(complete, "incomplete evidence must block the next launch")
					}
					phases.push(phase)
					const runId = argument("--run-id")
					assert.ok(command.args.includes("--retain-evidence-for-campaign"))
					assert.ok(runId.length <= 128)
					const evidence = await prepareEvidenceRun({ artifactsRoot: argument("--artifacts-dir"), runId })
					assert.equal(
						argument("--scenario-result-path"),
						path.join(evidence.artifactDirectory, "workflow-result.json"),
					)
					await fs.writeFile(
						argument("--scenario-result-path"),
						JSON.stringify({
							...workflow(),
							runId,
							scenarioId: "reload-continuation",
							phase,
							status: phase === "prepare" ? "checkpointed" : "passed",
							requestsUsed: scenario === "capture-exit-failure" ? 57 : 2,
							...(scenario === "oversized-receipt"
								? { unexpected: "x".repeat(MAX_WORKFLOW_RESULT_BYTES) }
								: {}),
						}),
					)
					await fs.writeFile(
						path.join(evidence.artifactDirectory, "run-result.json"),
						JSON.stringify({
							runId,
							retentionResultPath: path.join(evidence.artifactDirectory, "retention-result.json"),
							execution: "extension-host",
							hostExitObserved: true,
							ownershipGate: "verified",
							captureComplete: complete,
							failure: scenario === "capture-exit-failure" ? "evidence-failed" : undefined,
						}),
					)
					await fs.writeFile(
						path.join(evidence.artifactDirectory, "retention-result.json"),
						JSON.stringify({
							schemaVersion: 1,
							runId,
							status: scenario === "retention-failure" ? "failed" : "complete",
							eligibility: "held",
							result: { complete: true, overBudget: false },
						}),
					)
					await fs.writeFile(
						evidence.manifestPath,
						JSON.stringify({
							kind: "alpha-vscode-e2e-run-evidence",
							version: 1,
							runId,
							finalized: true,
							captureComplete: complete,
						}),
					)
					return {
						exitCode: scenario === "capture-exit-failure" || scenario === "host-exit-failure" ? 1 : 0,
						signal: null,
						stdout: "",
						stderr: "",
						outputTruncated: false,
						cleanupVerified: false,
					}
				},
			},
		)
		const reloadRequest = { ...request, scenarioId: "reload-continuation" }
		if (scenario === "complete") {
			const result = await operations.runScenario(reloadRequest, new AbortController().signal)
			assert.equal(result.status, "passed")
			assert.equal(result.usage.requests, 4)
			const evidencePath = await operations.preserveEvidence(reloadRequest, result)
			const index = JSON.parse(await fs.readFile(path.join(root, evidencePath), "utf8"))
			assert.equal(index.manifests.length, 2)
			assert.deepEqual(phases, ["prepare", "continue"])
			assert.equal(audits, 2)
		} else if (!complete) {
			const result = await operations.runScenario(reloadRequest, new AbortController().signal)
			assert.equal(result.status, "blocked")
			assert.equal(result.failure?.fingerprint, "evidence_failed")
			assert.equal(result.usage.requests, scenario === "capture-exit-failure" ? 57 : 2)
			await assert.rejects(operations.preserveEvidence(reloadRequest, result), /evidence missing or incomplete/)
			assert.deepEqual(phases, ["prepare"])
		} else if (scenario === "host-exit-failure" || scenario === "oversized-receipt") {
			const result = await operations.runScenario(reloadRequest, new AbortController().signal)
			assert.equal(result.status, "blocked")
			assert.equal(
				result.failure?.fingerprint,
				scenario === "host-exit-failure" ? "host_exit_failed" : "scenario_result_unavailable",
			)
			assert.equal(result.usage.requests, scenario === "host-exit-failure" ? 2 : null)
			assert.deepEqual(phases, ["prepare"])
			await operations.preserveEvidence(reloadRequest, result)
		} else {
			const result = await operations.runScenario(reloadRequest, new AbortController().signal)
			assert.equal(
				result.failure?.fingerprint,
				scenario === "storage-limit" ? "storage_budget" : "retention_failed",
			)
			assert.equal(result.usage.requests, 2)
			assert.deepEqual(phases, ["prepare"])
			await operations.preserveEvidence(reloadRequest, result)
		}
	}
})

test("terminal campaign retention preserves prior evidence and gates on aggregate storage, not standalone age/count", async (context) => {
	for (const exceedBudget of [false, true]) {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retention-integration-")))
		context.after(() => fs.rm(root, { recursive: true, force: true }))
		await openCampaignRoot(root, true)
		const runDirectory = path.join(root, "current")
		await fs.mkdir(runDirectory)
		const artifactsRoot = path.join(root, "host-evidence")
		const seed = async (runId: string, outcome = "passed", old = true, evidenceRoot = artifactsRoot) => {
			const evidence = await prepareEvidenceRun({ artifactsRoot: evidenceRoot, runId })
			await fs.writeFile(
				evidence.manifestPath,
				JSON.stringify({
					kind: "alpha-vscode-e2e-run-evidence",
					version: 1,
					runId,
					finalized: true,
					captureComplete: true,
					metadata: { outcome, finishedAt: old ? "2000-01-01T00:00:00.000Z" : new Date().toISOString() },
				}),
			)
			await fs.writeFile(
				path.join(evidence.artifactDirectory, "run-result.json"),
				JSON.stringify({
					runId,
					status: "passed",
					exitCode: 0,
					execution: "extension-host",
					ownershipGate: "verified",
					hostExitObserved: true,
					captureComplete: true,
					launchedHostPid: 111111,
					extensionHostPid: 222222,
					extensionHostParentPid: 333333,
					retentionResultPath: path.join(evidence.artifactDirectory, "retention-result.json"),
				}),
			)
			await fs.writeFile(
				path.join(evidence.artifactDirectory, "retention-result.json"),
				JSON.stringify({
					schemaVersion: 1,
					runId,
					status: "complete",
					eligibility: "held",
					result: { complete: true, overBudget: false },
				}),
			)
			return evidence
		}
		await seed("old-eligible")
		await markRunRetentionEligible({ artifactsRoot, runId: "old-eligible" })
		await seed("old-failure", "failed")
		await seed("active-campaign")
		const source = path.join(root, "raw-source")
		await fs.writeFile(source, "retained original")
		let currentRun = ""
		const settings: CampaignConfig = {
			id: "current",
			hosts: [request.host],
			scenarioIds: [request.scenarioId],
			samples: 1,
			provider: request.provider,
			budgets: { maxIterations: 2, maxRequests: 5, maxDurationMs: 1000, attemptTimeoutMs: 1000 },
			maxReproductions: 1,
		}
		const operations = createExtensionCampaignOperations(
			{
				config: settings,
				campaignRoot: root,
				runDirectory,
				profileRoot: path.join(root, "profiles"),
				repositoryRoot: root,
				persistReport: async () => {},
			},
			{
				runProcess: async (command) => {
					currentRun = command.args[command.args.indexOf("--run-id") + 1]!
					const currentArtifacts = command.args[command.args.indexOf("--artifacts-dir") + 1]!
					assert.equal(currentArtifacts, path.join(runDirectory, "host-evidence"))
					const evidence = await seed(currentRun, "passed", false, currentArtifacts)
					await fs.writeFile(
						path.join(evidence.artifactDirectory, "workflow-result.json"),
						JSON.stringify({ ...workflow(), runId: currentRun }),
					)
					return {
						exitCode: 0,
						signal: null,
						stdout: "",
						stderr: "",
						cleanupVerified: false,
						outputTruncated: false,
					}
				},
			},
		)
		const actualRequest = { ...request, campaignId: "current" }
		const result = await operations.runScenario(actualRequest, new AbortController().signal)
		assert.equal(result.status, "passed")
		const evidence = await operations.preserveEvidence(actualRequest, result)
		const terminal: CampaignReport = {
			version: 1,
			id: "current",
			mode: "report-only",
			requestedProvider: request.provider,
			startedAt: "now",
			finishedAt: "now",
			stopReason: "completed",
			counts: { passed: 1, failed: 0, blocked: 0 },
			usage: result.usage,
			repairs: [],
			attempts: [{ request: actualRequest, result, elapsedMs: 1, evidence }],
		}
		await assert.rejects(operations.finalizeRetention!(terminal), /durable terminal/)
		await operations.persistReport(terminal)
		if (exceedBudget) settings.storageBudget = { maxBytes: 1, maxEntries: 100_000, maxDepth: 32 }
		const retained = await operations.finalizeRetention!(terminal)
		const receipt = JSON.parse(await fs.readFile(path.join(runDirectory, retained.receipt!), "utf8"))
		assert.equal(retained.status, exceedBudget ? "blocked" : "complete", JSON.stringify(receipt))
		const admission = JSON.parse(await fs.readFile(path.join(runDirectory, receipt.storageAdmission), "utf8"))
		assert.equal(admission.admission.status, exceedBudget ? "over_budget" : "within_budget")
		for (const kept of ["old-eligible", "old-failure", "active-campaign"])
			assert.ok((await fs.stat(path.join(artifactsRoot, kept))).isDirectory())
		assert.ok(await fs.stat(path.join(runDirectory, "host-evidence", currentRun)))
		assert.equal(await fs.readFile(source, "utf8"), "retained original")
	}
})
