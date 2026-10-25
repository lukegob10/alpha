import { createHash } from "node:crypto"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { require as tsRequire } from "tsx/cjs/api"
import { collectOutcomeBuild, validConversation, validJournal } from "./harness/outcome-proof.mjs"

const { parseCampaignConfig } = tsRequire("../apps/vscode-e2e/src/campaign/config.ts", import.meta.url)
const { evaluateLiveGate } = tsRequire("../apps/vscode-e2e/src/campaign/liveGate.ts", import.meta.url)
const { captureCampaignEvaluationIdentity } = tsRequire(
	"../apps/vscode-e2e/src/campaign/evaluationIdentity.ts",
	import.meta.url,
)
const { completionReplayPassed, projectWorkflowResult } = tsRequire(
	"../apps/vscode-e2e/src/campaign/extensionAdapter.ts",
	import.meta.url,
)
const { requireHeldRetentionReceipt } = tsRequire(
	"../apps/vscode-e2e/src/campaign/retentionReceipt.ts",
	import.meta.url,
)
const { readBounded, rejectSymlinkComponents } = tsRequire("../apps/vscode-e2e/src/evidence/paths.ts", import.meta.url)
const { isTestExecutionCounts, isTestSuiteSelection } = tsRequire(
	"../apps/vscode-e2e/src/runFailure.ts",
	import.meta.url,
)
const { validateLiveHostReceipt } = tsRequire("../apps/vscode-e2e/src/liveHostProtocol.ts", import.meta.url)
const { isLiveProviderIdentityReceipt } = tsRequire("../apps/vscode-e2e/src/liveProviderIdentity.ts", import.meta.url)
const { joinProjectedEvidence } = tsRequire("../apps/vscode-e2e/src/evidence/journalProjection.ts", import.meta.url)

export const LIVE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const taskSources = ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl", "api_conversation_history.json"]

class AdmissionError extends Error {
	constructor(reason) {
		super("Live evidence admission blocked")
		this.reason = reason
	}
}
const requireProof = (condition, reason) => {
	if (!condition) throw new AdmissionError(reason)
}

function relativeFile(root, relative) {
	requireProof(
		typeof relative === "string" &&
			relative.length > 0 &&
			relative.length <= 1_024 &&
			!relative.includes(":") &&
			!path.posix.isAbsolute(relative) &&
			!path.win32.isAbsolute(relative) &&
			relative
				.replaceAll("\\", "/")
				.split("/")
				.every((part) => part && part !== "." && part !== ".."),
		"unsafe_evidence_path",
	)
	return path.join(root, ...relative.replaceAll("\\", "/").split("/"))
}

/** Admission consumes existing campaign/host validators; it cannot launch a host, provider request or repair. */
export async function admitLiveEvidence(
	{ repositoryRoot, evidenceDirectory, modelId, effort, now = Date.now() },
	{ captureIdentity = captureCampaignEvaluationIdentity, captureBuild = collectOutcomeBuild } = {},
) {
	const receipt = {
		schemaVersion: 1,
		kind: "alpha-imported-live-evidence-admission",
		status: "blocked",
		liveRequests: 0,
		maxAgeMs: LIVE_EVIDENCE_MAX_AGE_MS,
		checkedAt: new Date(now).toISOString(),
	}
	if (!evidenceDirectory) return { ...receipt, reason: "live_evidence_not_supplied" }
	let totalBytes = 0
	const bytes = async (file, maximum = 4 * 1024 * 1024) => {
		const value = await readBounded(file, maximum)
		totalBytes += value.length
		requireProof(totalBytes <= 256 * 1024 * 1024, "evidence_byte_limit")
		return value
	}
	const json = async (file) => JSON.parse((await bytes(file)).toString("utf8"))
	try {
		const root = path.resolve(evidenceDirectory)
		await rejectSymlinkComponents(root)
		const plan = await json(path.join(root, "gate-plan.json"))
		const config = parseCampaignConfig(plan.config)
		requireProof(config.provider.modelId === modelId && config.provider.effort === effort, "model_policy_mismatch")
		const reports = (await readdir(root)).filter((name) => /^report-\d{5}\.json$/.test(name)).sort()
		requireProof(reports.length > 0 && reports.length <= 10_000, "terminal_report_missing")
		const reportBytes = await bytes(path.join(root, reports.at(-1)))
		const report = JSON.parse(reportBytes.toString("utf8"))
		const started = Date.parse(report.startedAt)
		const finished = Date.parse(report.finishedAt)
		requireProof(
			Number.isFinite(started) && Number.isFinite(finished) && finished >= started && finished <= now + 60_000,
			"invalid_campaign_time",
		)
		requireProof(now - finished <= LIVE_EVIDENCE_MAX_AGE_MS, "live_evidence_expired")
		requireProof(Array.isArray(report.attempts) && report.attempts.length <= 512, "attempt_inventory_limit")
		const verdict = evaluateLiveGate(config, report)
		requireProof(verdict.status === "passed", "live_acceptance_failed")
		const current = await captureIdentity(repositoryRoot, config)
		requireProof(current.missing.length === 0, "current_build_or_source_unavailable")
		for (const key of [
			"extensionCommit",
			"workingTreeDigest",
			"extensionBuildDigest",
			"harnessDigest",
			"configDigest",
			"taskSetDigest",
			"sourceComponentsDigest",
		])
			requireProof(current[key] === report.evaluationIdentity[key], "source_or_build_mismatch")
		const build = await captureBuild(repositoryRoot)
		requireProof(
			build.extensionBuildDigest === current.extensionBuildDigest &&
				build.harnessDigest === current.harnessDigest,
			"current_build_changed",
		)
		const profiles = new Set()
		let retainedPhases = 0
		for (const attempt of report.attempts) {
			const { request } = attempt
			requireProof(identifier(request.attemptId), "invalid_attempt_id")
			const expectedIndex = `${request.attemptId}/evidence-index.json`
			requireProof(attempt.evidence.replaceAll("\\", "/") === expectedIndex, "attempt_capture_mismatch")
			const index = await json(relativeFile(root, expectedIndex))
			const phases = request.scenarioId === "reload-continuation" ? ["prepare", "continue"] : ["run"]
			requireProof(
				index.schemaVersion === 1 && index.manifests?.length === phases.length,
				"missing_phase_capture",
			)
			let requests = 0
			for (const [phaseIndex, phase] of phases.entries()) {
				const runId = `${sha(config.id)}-${request.attemptId}-${phase}`
				const expectedManifest = `host-evidence/${runId}/manifest.json`
				requireProof(
					index.manifests[phaseIndex].replaceAll("\\", "/") === expectedManifest,
					"phase_capture_mismatch",
				)
				const manifestPath = relativeFile(root, expectedManifest)
				const directory = path.dirname(manifestPath)
				const manifest = await json(manifestPath)
				requireProof(
					manifest.kind === "alpha-vscode-e2e-run-evidence" &&
						manifest.version === 1 &&
						manifest.runId === runId &&
						manifest.finalized === true &&
						manifest.captureComplete === true &&
						manifest.bundleSha256 === build.bundleSha256 &&
						Array.isArray(manifest.warnings) &&
						!manifest.warnings.length &&
						isDeepStrictEqual(manifest.summary, { category: "none", code: "OK" }) &&
						manifest.metadata?.scenarioId === request.scenarioId &&
						manifest.metadata.hostVersion === "1.138.0" &&
						manifest.metadata.requestedHostVersion === "1.138.0" &&
						manifest.metadata.provider === "live-copilot" &&
						manifest.metadata.modelId === modelId &&
						manifest.metadata.reasoningEffort === effort &&
						manifest.metadata.outcome === "passed",
					"invalid_host_capture",
				)
				const captureStarted = Date.parse(manifest.metadata.startedAt)
				const captureFinished = Date.parse(manifest.metadata.finishedAt)
				requireProof(
					Number.isFinite(captureStarted) &&
						Number.isFinite(captureFinished) &&
						captureFinished >= captureStarted &&
						captureStarted >= started &&
						captureFinished <= finished &&
						now - captureFinished <= LIVE_EVIDENCE_MAX_AGE_MS,
					"host_capture_expired_or_outside_campaign",
				)
				requireProof(
					Array.isArray(manifest.artifacts) &&
						manifest.artifacts.length > 0 &&
						manifest.artifacts.length <= 200 &&
						new Set(manifest.artifacts.map((entry) => entry.path)).size === manifest.artifacts.length,
					"invalid_artifact_inventory",
				)
				const artifacts = new Map()
				for (const artifact of manifest.artifacts) {
					requireProof(
						Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && hash(artifact.sha256),
						"invalid_artifact",
					)
					const content = await bytes(relativeFile(directory, artifact.path))
					requireProof(
						content.length === artifact.bytes && sha(content) === artifact.sha256,
						"artifact_checksum_mismatch",
					)
					artifacts.set(artifact.path, content)
				}
				const runner = await json(path.join(directory, "run-result.json"))
				requireProof(
					runner.runId === runId &&
						runner.status === "passed" &&
						runner.exitCode === 0 &&
						!runner.failure &&
						runner.providerMode === "live-copilot" &&
						runner.actualVSCodeVersion === "1.138.0" &&
						runner.actualModelId === modelId &&
						runner.actualReasoningEffort === effort &&
						runner.execution === "extension-host" &&
						runner.hostExitObserved === true &&
						runner.hostCleanupVerified !== false &&
						runner.ownershipGate === "verified" &&
						runner.captureComplete === true &&
						runner.requireAllTests === true &&
						isTestExecutionCounts(runner.testCounts) &&
						runner.testCounts.executed > 0 &&
						runner.testCounts.pending === 0 &&
						runner.testCounts.failed === 0 &&
						isTestSuiteSelection(runner.testSelection) &&
						runner.testSelection.testFile === "workflow.test" &&
						runner.testSelection.grep === null &&
						runner.testSelection.forbidOnly === true &&
						isLiveProviderIdentityReceipt(runner.providerIdentity) &&
						runner.providerIdentity.status === "unchanged" &&
						typeof runner.profileDir === "string" &&
						path.isAbsolute(runner.profileDir),
					"invalid_host_execution",
				)
				profiles.add(sha(runner.profileDir))
				const startedHost = await json(path.join(directory, "live-host-started.json"))
				const expectedHost = { runId, nonce: startedHost.nonce, actualVSCodeVersion: "1.138.0" }
				validateLiveHostReceipt(startedHost, expectedHost, "started")
				const completion = validateLiveHostReceipt(
					await json(path.join(directory, "host-completion.json")),
					expectedHost,
					"terminal",
					startedHost,
				)
				requireProof(completion.status === "passed", "host_completion_failed")
				await requireHeldRetentionReceipt(directory, runId, path.join(directory, "retention-result.json"))
				const projection = projectWorkflowResult(
					await json(path.join(directory, "workflow-result.json")),
					request,
					phase,
					runId,
				)
				requireProof(
					projection.result.status === "passed" && projection.result.usage.requests > 0,
					"independent_outcome_failed",
				)
				const taskIds = projection.result.taskIds
				requireProof(
					Array.isArray(taskIds) &&
						taskIds.every(identifier) &&
						new Set(taskIds).size === taskIds.length &&
						isDeepStrictEqual(manifest.metadata.taskIds, taskIds) &&
						Array.isArray(manifest.taskEvidence) &&
						manifest.taskEvidence.length === taskIds.length * taskSources.length,
					"task_capture_mismatch",
				)
				for (const taskId of taskIds) {
					for (const file of taskSources)
						requireProof(
							manifest.taskEvidence.filter(
								(entry) =>
									entry.taskId === taskId && entry.file === file && entry.status === "captured",
							).length === 1,
							"task_capture_missing",
						)
					const projectedArtifact = (name) => {
						const value = artifacts.get(`${taskId}-${name}`)
						requireProof(value, "task_projection_missing")
						return JSON.parse(value.toString("utf8"))
					}
					const lifecycle = projectedArtifact(`${taskSources[0]}.projection.json`)
					const eventLog = projectedArtifact(`${taskSources[1]}.projection.json`)
					const conversation = projectedArtifact(`${taskSources[2]}.projection.json`)
					requireProof(
						validJournal(lifecycle, taskId, true, { requireCompleted: false }) &&
							validJournal(eventLog, taskId, false) &&
							validConversation(conversation, { requireTools: false }),
						"invalid_task_projection",
					)
					const joined = projectedArtifact("evidence-join.json")
					const expected = JSON.parse(
						JSON.stringify({
							status: "captured",
							validation: { lifecycle: "validated", eventLog: "validated" },
							...joinProjectedEvidence({
								lifecycle: lifecycle.projection.events,
								eventLog: eventLog.projection.events,
							}),
						}),
					)
					requireProof(
						isDeepStrictEqual(joined, expected) &&
							expected.records.some((record) => record.status === "joined"),
						"invalid_task_evidence_join",
					)
				}
				requests += projection.result.usage.requests
				if (phaseIndex === phases.length - 1) {
					requireProof(
						isDeepStrictEqual(projection.result.taskIds, attempt.result.taskIds) &&
							isDeepStrictEqual(runner.providerIdentity, attempt.result.providerIdentity),
						"attempt_projection_mismatch",
					)
				}
				retainedPhases++
			}
			requireProof(requests === attempt.result.usage.requests, "attempt_usage_mismatch")
			if (request.scenarioId === "completion-idle") {
				const replay = await json(relativeFile(root, `${request.attemptId}/completion-ui-replay.json`))
				requireProof(
					replay.exitCode === 0 &&
						replay.signal === null &&
						!replay.outputTruncated &&
						completionReplayPassed(
							await json(relativeFile(root, `${request.attemptId}/completion-ui-tests.json`)),
						),
					"completion_replay_missing_or_failed",
				)
			}
		}
		const finalIdentity = await captureIdentity(repositoryRoot, config)
		requireProof(isDeepStrictEqual(current, finalIdentity), "source_or_build_changed_during_admission")
		return {
			...receipt,
			status: "passed",
			campaignId: config.id,
			provider: config.provider,
			scenarioScope: verdict.scenarioScope,
			completedAt: report.finishedAt,
			reportSha256: sha(reportBytes),
			source: current,
			profileSha256: [...profiles].sort(),
			counts: report.counts,
			retainedPhases,
		}
	} catch (error) {
		return {
			...receipt,
			reason:
				error instanceof AdmissionError
					? error.reason
					: error?.code === "ENOENT"
						? "live_evidence_missing"
						: "invalid_live_evidence",
		}
	}
}

async function main(args) {
	const options = {
		repositoryRoot: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
		evidenceDirectory: process.env.ALPHA_LIVE_EVIDENCE_DIR || undefined,
		modelId: process.env.ALPHA_LIVE_EVAL_MODEL_ID || undefined,
		effort: process.env.ALPHA_LIVE_EVAL_EFFORT || undefined,
	}
	const supplied = new Set()
	for (let index = 0; index < args.length; index += 2) {
		const field = { "--evidence-dir": "evidenceDirectory", "--model-id": "modelId", "--effort": "effort" }[
			args[index]
		]
		if (!field || !args[index + 1] || supplied.has(field))
			throw new Error("Invalid live evidence admission arguments")
		supplied.add(field)
		options[field] = args[index + 1]
	}
	const result = await admitLiveEvidence(options)
	const directory = path.join(options.repositoryRoot, "artifacts/harness")
	await rejectSymlinkComponents(directory)
	await mkdir(directory, { recursive: true })
	await writeFile(path.join(directory, "live-evidence-policy.json"), JSON.stringify(result, null, 2) + "\n", {
		mode: 0o600,
	})
	process.stdout.write(JSON.stringify(result) + "\n")
	process.exitCode = result.status === "passed" ? 0 : 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch(() => {
		process.stderr.write("Live evidence admission could not complete.\n")
		process.exitCode = 2
	})
}
