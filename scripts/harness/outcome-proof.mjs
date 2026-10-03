import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { require as tsRequire } from "tsx/cjs/api"
import { readExecutionJson } from "./execution-evidence.mjs"

const { projectWorkflowResult } = tsRequire("../../apps/vscode-e2e/src/campaign/extensionAdapter.ts", import.meta.url)
const { joinProjectedEvidence } = tsRequire("../../apps/vscode-e2e/src/evidence/journalProjection.ts", import.meta.url)
const { rejectSymlinkComponents, readBounded } = tsRequire(
	"../../apps/vscode-e2e/src/evidence/paths.ts",
	import.meta.url,
)
const { fingerprintArtifactPaths } = tsRequire("../../apps/vscode-e2e/src/campaign/liveGate.ts", import.meta.url)
const { DEVELOPMENT_SCENARIOS } = tsRequire(
	"../../apps/vscode-e2e/src/scenarios/developmentCatalog.ts",
	import.meta.url,
)
const { DEVELOPMENT_PHASE_OUTCOME_CHECK_NAMES } = tsRequire(
	"../../apps/vscode-e2e/src/scenarios/developmentFixture.ts",
	import.meta.url,
)
const { REPOSITORY_VERIFICATION_CHECK_NAMES } = tsRequire(
	"../../apps/vscode-e2e/src/scenarios/repositoryFixture.ts",
	import.meta.url,
)
const requiredOutcomeChecks = (scenarioId) =>
	scenarioId === "review-edit-test-commit-followup"
		? Object.entries(REPOSITORY_VERIFICATION_CHECK_NAMES).flatMap(([phase, names]) =>
				names.map((name) => `${phase}_${name}`),
			)
		: (DEVELOPMENT_SCENARIOS[scenarioId]?.phases ?? []).flatMap((phase) =>
				(DEVELOPMENT_PHASE_OUTCOME_CHECK_NAMES[phase] ?? []).map((name) => `${phase}_${name}`),
			)
const sha = (value) => createHash("sha256").update(value).digest("hex")
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const identifier = (value) =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== "." && value !== ".."
const sourceFiles = ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl", "api_conversation_history.json"]
const sameIds = (left, right) =>
	Array.isArray(left) &&
	left.length > 0 &&
	left.length <= 20 &&
	left.every(identifier) &&
	new Set(left).size === left.length &&
	Array.isArray(right) &&
	isDeepStrictEqual([...left].sort(), [...right].sort())
const positive = (value, bound) => Number.isSafeInteger(value) && value > 0 && value <= bound
const onlyKeys = (value, keys) =>
	value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key))
const artifactBytes = (value) => Buffer.from(JSON.stringify(value, null, 2))
const eventKeys = [
	"type",
	"policyDigestSha256",
	...[
		"eventId",
		"taskId",
		"runId",
		"turnId",
		"stepId",
		"requestId",
		"attemptId",
		"correlationId",
		"causationId",
		"callId",
	].map((key) => `${key}Sha256`),
	"sequence",
	"occurredAt",
	"attempt",
	"requestIndex",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"batchSize",
	"parallelBatchCount",
	"parallelToolCount",
	"durationMs",
	"truncatedResultCount",
	"exitCode",
	"status",
	"phase",
	"decision",
	"commandCategory",
	"retry",
	"retryable",
	"toolCategory",
	"code",
	"purpose",
	"usageSource",
	"providerFailureCode",
]

export class OutcomeProofError extends Error {
	constructor(reason) {
		super("Outcome capture admission failed")
		if (!outcomeReasons.has(reason)) throw new Error("Invalid outcome admission code")
		this.reason = reason
	}
}

const outcomeReasons = new Set([
	"noncomparable_outcome_build",
	"outcome_proof_limit",
	"invalid_outcome_capture_binding",
	"invalid_outcome_metadata",
	"outcome_capture_outside_host",
	"invalid_independent_workflow_result",
	"failed_independent_workflow_result",
	"invalid_independent_workflow_projection",
	"missing_independent_workflow_checks",
	"missing_outcome_task_artifacts",
	"invalid_outcome_artifact",
	"invalid_outcome_artifact_checksum",
	"invalid_outcome_repository_capture",
	"missing_outcome_task_capture",
	"invalid_outcome_task_projection",
	"invalid_outcome_evidence_join",
	"invalid_outcome_manifest_binding",
])

/** The same existing build owner used by the campaign, plus its separately captured extension.js hash. */
export async function collectOutcomeBuild(root) {
	const bundle = path.join(root, "src", "dist", "extension.js")
	await rejectSymlinkComponents(bundle)
	if (!positive((await stat(bundle)).size, 512 * 1024 * 1024)) throw new Error("Invalid outcome bundle")
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(bundle)) hash.update(chunk)
	return {
		bundleSha256: hash.digest("hex"),
		extensionBuildDigest: await fingerprintArtifactPaths(root, [
			"src/package.json",
			"src/dist",
			"src/webview-ui/build",
		]),
		harnessDigest: await fingerprintArtifactPaths(root, ["apps/vscode-e2e/out"]),
	}
}

function validJournal(value, taskId, lifecycle) {
	if (
		!onlyKeys(value, ["sourceBytes", "sourceSha256", "projection"]) ||
		!positive(value.sourceBytes, 4 * 1024 * 1024) ||
		!digest(value.sourceSha256)
	)
		return false
	const projection = value.projection
	if (
		!onlyKeys(projection, ["events", "captureStatus", "validationStatus", "warnings", "complete"]) ||
		projection.captureStatus !== "captured" ||
		projection.validationStatus !== "validated" ||
		projection.complete !== true ||
		!Array.isArray(projection.warnings) ||
		projection.warnings.length ||
		!Array.isArray(projection.events) ||
		!positive(projection.events.length, 2000)
	)
		return false
	const partitions = new Map()
	for (const event of projection.events) {
		if (
			!onlyKeys(event, eventKeys) ||
			!/^[a-z_]+$/.test(event.type ?? "") ||
			event.taskIdSha256 !== sha(taskId) ||
			!digest(event.runIdSha256) ||
			(lifecycle && !digest(event.turnIdSha256)) ||
			!positive(event.sequence, 2000)
		)
			return false
		for (const [key, field] of Object.entries(event)) {
			if (key.endsWith("Sha256")) {
				if (!digest(field)) return false
			} else if (key === "purpose") {
				if (
					!["model_request_started", "model_request_failed", "request_usage"].includes(event.type) ||
					!["task", "reasoning-summary"].includes(field)
				)
					return false
			} else if (key === "usageSource") {
				if (event.type !== "request_usage" || !["provider", "estimate", "unknown"].includes(field)) return false
			} else if (key === "providerFailureCode") {
				if (event.type !== "model_request_failed" || field !== "request_timeout") return false
			} else if (typeof field === "string") {
				if (!/^[A-Za-z_]+$/.test(field) || field.length > 128) return false
			} else if (typeof field !== "boolean" && (typeof field !== "number" || !Number.isFinite(field)))
				return false
		}
		const partition = lifecycle ? `${event.runIdSha256}:${event.turnIdSha256}` : event.runIdSha256
		const sequence = (partitions.get(partition) ?? 0) + 1
		if (event.sequence !== sequence) return false
		partitions.set(partition, sequence)
	}
	const terminal = projection.events.filter((event) => event.type === "turn_terminal").at(-1)
	return !lifecycle || terminal?.status === "completed"
}

function validConversation(value) {
	if (
		!onlyKeys(value, ["sourceBytes", "sourceSha256", "projection"]) ||
		!positive(value.sourceBytes, 4 * 1024 * 1024) ||
		!digest(value.sourceSha256) ||
		!Array.isArray(value.projection) ||
		!positive(value.projection.length, 10_000)
	)
		return false
	const calls = new Map()
	for (const message of value.projection) {
		if (
			!onlyKeys(message, ["role", "tools"]) ||
			!["assistant", "user"].includes(message.role) ||
			!Array.isArray(message.tools) ||
			message.tools.length > 1000
		)
			return false
		for (const tool of message.tools) {
			if (!onlyKeys(tool, ["type", "idSha256", "isError"]) || !digest(tool.idSha256)) return false
			if (tool.type === "call") {
				if (message.role !== "assistant" || calls.has(tool.idSha256) || tool.isError !== undefined) return false
				calls.set(tool.idSha256, false)
			} else if (tool.type === "result") {
				if (message.role !== "user" || calls.get(tool.idSha256) !== false || typeof tool.isError !== "boolean")
					return false
				calls.set(tool.idSha256, true)
			} else return false
		}
	}
	return calls.size > 0 && [...calls.values()].every(Boolean)
}

function validRepository(value) {
	return (
		onlyKeys(value, ["commit", "files", "complete", "skipped"]) &&
		value.complete === true &&
		Number.isSafeInteger(value.skipped) &&
		value.skipped >= 0 &&
		(value.commit === undefined || /^[a-f0-9]{40}$/.test(value.commit)) &&
		Array.isArray(value.files) &&
		value.files.length <= 1000 &&
		new Set(value.files.map((file) => file.path)).size === value.files.length &&
		value.files.every(
			(file) =>
				onlyKeys(file, ["path", "bytes", "sha256"]) &&
				typeof file.path === "string" &&
				!path.isAbsolute(file.path) &&
				!file.path.split(/[\\/]/).some((part) => part === "..") &&
				Number.isSafeInteger(file.bytes) &&
				file.bytes >= 0 &&
				file.bytes <= 256 * 1024 &&
				digest(file.sha256),
		)
	)
}

/** Re-admit bounded, privacy-safe owner projections; a capture-complete flag alone proves no task outcome. */
export function outcomeProofVerdict(proofs, campaign, receipts, build) {
	const failed = (reason) => ({ status: "failed", reason })
	if (
		!Array.isArray(proofs) ||
		!Array.isArray(campaign?.attempts) ||
		proofs.length !== campaign.attempts.length ||
		!build ||
		!Object.values(build).every(digest) ||
		campaign.evaluationIdentity?.extensionBuildDigest !== build.extensionBuildDigest ||
		campaign.evaluationIdentity?.harnessDigest !== build.harnessDigest
	)
		return failed("noncomparable_outcome_build")
	if (Buffer.byteLength(JSON.stringify(proofs)) > 6 * 1024 * 1024) return failed("outcome_proof_limit")
	for (const attempt of campaign.attempts) {
		const proof = proofs.find((value) => value?.scenarioId === attempt.request.scenarioId)
		const receipt = receipts.find((value) => value.runId === proof?.runId)
		const manifest = proof?.manifest
		const metadata = manifest?.metadata
		if (
			!proof ||
			proof.schemaVersion !== 1 ||
			proof.kind !== "alpha-scripted-outcome-proof" ||
			proof.bundleSha256 !== build.bundleSha256 ||
			!receipt ||
			receipt.scenarioId !== attempt.request.scenarioId ||
			manifest?.kind !== "alpha-vscode-e2e-run-evidence" ||
			manifest.version !== 1 ||
			manifest.runId !== receipt.runId ||
			manifest.finalized !== true ||
			manifest.captureComplete !== true ||
			!isDeepStrictEqual(manifest.summary, { category: "none", code: "OK" }) ||
			!Array.isArray(manifest.warnings) ||
			manifest.warnings.length ||
			manifest.bundleSha256 !== build.bundleSha256 ||
			metadata?.scenarioId !== attempt.request.scenarioId ||
			metadata.hostVersion !== "1.125.0" ||
			metadata.requestedHostVersion !== "1.125.0" ||
			metadata.provider !== "scripted" ||
			metadata.outcome !== "passed" ||
			!sameIds(proof.taskIds, metadata.taskIds) ||
			!sameIds(proof.taskIds, attempt.result.taskIds)
		)
			return failed("invalid_outcome_capture_binding")
		if (
			!onlyKeys(metadata, [
				"scenarioId",
				"hostVersion",
				"requestedHostVersion",
				"provider",
				"modelId",
				"reasoningEffort",
				"taskIds",
				"startedAt",
				"finishedAt",
				"outcome",
			])
		)
			return failed("invalid_outcome_metadata")
		const started = Date.parse(metadata.startedAt),
			finished = Date.parse(metadata.finishedAt)
		if (
			!Number.isFinite(started) ||
			!Number.isFinite(finished) ||
			finished < started ||
			started !== Date.parse(receipt.startedAt) ||
			finished > Date.parse(receipt.completedAt)
		)
			return failed("outcome_capture_outside_host")
		const workflow = proof.workflow
		try {
			const bytes = Buffer.from(JSON.stringify(workflow?.value, null, 2) + "\n")
			if (
				!workflow ||
				!positive(workflow.bytes, 1024 * 1024) ||
				workflow.bytes !== bytes.length ||
				workflow.sha256 !== sha(bytes) ||
				!onlyKeys(workflow.value, [
					"schemaVersion",
					"runId",
					"scenarioId",
					"phase",
					"status",
					"checks",
					"taskIds",
					"hostVersion",
					"providerMode",
					"model",
					"requestsUsed",
					"requestsByPurpose",
					"e2eApprovalPolicySha256",
					"usage",
					"failure",
				]) ||
				!sameIds(proof.taskIds, workflow.value.taskIds)
			)
				return failed("invalid_independent_workflow_result")
			const projected = projectWorkflowResult(workflow.value, attempt.request, "run", receipt.runId)
			if (projected.checkpointed || projected.result.status !== "passed")
				return failed("failed_independent_workflow_result")
			if (
				!onlyKeys(workflow.value.model, ["id", "family", "vendor", "reasoningEffort"]) ||
				(workflow.value.requestsByPurpose &&
					!onlyKeys(workflow.value.requestsByPurpose, ["task", "reasoning-summary"])) ||
				(workflow.value.usage && !onlyKeys(workflow.value.usage, ["inputTokens", "outputTokens", "cost"]))
			)
				return failed("invalid_independent_workflow_projection")
			const independentChecks = requiredOutcomeChecks(attempt.request.scenarioId)
			const requiredChecks = [
				...independentChecks,
				"tool_transactions_complete",
				"actual_tool_calls_present",
				"all_calls_have_receipts",
				"required_turns_completed",
				"no_unexpected_failed_turn",
			]
			if (
				!independentChecks.length ||
				requiredChecks.some(
					(name) => !workflow.value.checks.some((check) => check.name === name && check.passed),
				) ||
				!workflow.value.checks.every((check) => onlyKeys(check, ["name", "passed"]))
			)
				return failed("missing_independent_workflow_checks")
		} catch {
			return failed("invalid_independent_workflow_result")
		}
		if (
			!Array.isArray(manifest.taskEvidence) ||
			manifest.taskEvidence.length !== proof.taskIds.length * 3 ||
			!manifest.taskEvidence.every((entry) => onlyKeys(entry, ["taskId", "file", "status"])) ||
			!Array.isArray(manifest.artifacts) ||
			manifest.artifacts.length > 1000 ||
			!manifest.artifacts.every(
				(artifact) =>
					onlyKeys(artifact, ["path", "bytes", "sha256"]) &&
					identifier(artifact.path) &&
					positive(artifact.bytes, 8 * 1024 * 1024) &&
					digest(artifact.sha256),
			) ||
			new Set(manifest.artifacts.map((artifact) => artifact.path)).size !== manifest.artifacts.length ||
			!Array.isArray(proof.artifacts) ||
			proof.artifacts.length !== proof.taskIds.length * 4 + 2
		)
			return failed("missing_outcome_task_artifacts")
		const artifacts = new Map()
		for (const artifact of proof.artifacts) {
			if (!onlyKeys(artifact, ["path", "bytes", "sha256", "value"])) return failed("invalid_outcome_artifact")
			const declared = manifest.artifacts.find((value) => value.path === artifact.path)
			const bytes = artifactBytes(artifact.value)
			if (
				!declared ||
				!identifier(artifact.path) ||
				!positive(bytes.length, 8 * 1024 * 1024) ||
				artifact.bytes !== bytes.length ||
				declared.bytes !== bytes.length ||
				artifact.sha256 !== sha(bytes) ||
				declared.sha256 !== artifact.sha256 ||
				artifacts.has(artifact.path)
			)
				return failed("invalid_outcome_artifact_checksum")
			artifacts.set(artifact.path, artifact.value)
		}
		if (
			!validRepository(artifacts.get("repository-before.json")) ||
			!validRepository(artifacts.get("repository-after.json"))
		)
			return failed("invalid_outcome_repository_capture")
		for (const taskId of proof.taskIds) {
			for (const file of sourceFiles)
				if (
					manifest.taskEvidence.filter(
						(entry) => entry.taskId === taskId && entry.file === file && entry.status === "captured",
					).length !== 1
				)
					return failed("missing_outcome_task_capture")
			const lifecycle = artifacts.get(`${taskId}-${sourceFiles[0]}.projection.json`)
			const eventLog = artifacts.get(`${taskId}-${sourceFiles[1]}.projection.json`)
			const conversation = artifacts.get(`${taskId}-${sourceFiles[2]}.projection.json`)
			if (
				!validJournal(lifecycle, taskId, true) ||
				!validJournal(eventLog, taskId, false) ||
				!validConversation(conversation)
			)
				return failed("invalid_outcome_task_projection")
			const joined = artifacts.get(`${taskId}-evidence-join.json`)
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
			if (!isDeepStrictEqual(joined, expected) || !expected.records.some((record) => record.status === "joined"))
				return failed("invalid_outcome_evidence_join")
		}
	}
	return { status: "passed", proofs, build }
}

async function confinedJson(root, relative) {
	if (
		typeof relative !== "string" ||
		path.isAbsolute(relative) ||
		relative.split(/[\\/]/).some((part) => !part || part === "..")
	)
		throw new Error("Invalid outcome evidence path")
	const absolute = path.resolve(root, relative)
	if (path.relative(root, absolute).startsWith("..")) throw new Error("Outcome evidence escaped")
	await rejectSymlinkComponents(absolute)
	return { absolute, value: await readExecutionJson(absolute) }
}

export async function readOutcomeProofs(directory, campaign, receipts, build) {
	const proofs = []
	for (const attempt of campaign.attempts) {
		const receipt = receipts.find((value) => value.scenarioId === attempt.request.scenarioId)
		const index = (await confinedJson(directory, attempt.evidence)).value
		const relative = `host-evidence/${receipt.runId}/manifest.json`
		if (
			index?.schemaVersion !== 1 ||
			!Array.isArray(index.manifests) ||
			index.manifests.length !== 1 ||
			index.manifests[0].replaceAll("\\", "/") !== relative
		)
			throw new OutcomeProofError("invalid_outcome_manifest_binding")
		const { absolute, value: raw } = await confinedJson(directory, relative)
		const manifest = {
			kind: raw.kind,
			version: raw.version,
			runId: raw.runId,
			finalized: raw.finalized,
			metadata: raw.metadata,
			summary: raw.summary,
			bundleSha256: raw.bundleSha256,
			captureComplete: raw.captureComplete,
			warnings: raw.warnings,
			artifacts: raw.artifacts,
			taskEvidence: raw.taskEvidence,
		}
		const taskIds = manifest.metadata?.taskIds
		if (!sameIds(taskIds, taskIds)) throw new OutcomeProofError("invalid_outcome_capture_binding")
		const runDirectory = path.dirname(absolute)
		const workflowPath = path.join(runDirectory, "workflow-result.json")
		await rejectSymlinkComponents(workflowPath)
		const workflowBytes = await readBounded(workflowPath, 1024 * 1024)
		if (!positive(workflowBytes.length, 1024 * 1024)) throw new Error("Invalid workflow result size")
		const workflow = { bytes: workflowBytes.length, sha256: sha(workflowBytes), value: JSON.parse(workflowBytes) }
		const names = [
			"repository-before.json",
			"repository-after.json",
			...taskIds.flatMap((taskId) => [
				...sourceFiles.map((file) => `${taskId}-${file}.projection.json`),
				`${taskId}-evidence-join.json`,
			]),
		]
		const artifacts = []
		for (const name of names) {
			const { absolute: artifactPath } = await confinedJson(runDirectory, name)
			const bytes = await readBounded(artifactPath, 8 * 1024 * 1024)
			const value = JSON.parse(bytes)
			artifacts.push({ path: name, bytes: bytes.length, sha256: sha(bytes), value })
		}
		proofs.push({
			schemaVersion: 1,
			kind: "alpha-scripted-outcome-proof",
			scenarioId: attempt.request.scenarioId,
			runId: receipt.runId,
			taskIds,
			bundleSha256: build.bundleSha256,
			manifest,
			workflow,
			artifacts,
		})
	}
	const verdict = outcomeProofVerdict(proofs, campaign, receipts, build)
	if (verdict.status !== "passed") throw new OutcomeProofError(verdict.reason)
	return proofs
}
