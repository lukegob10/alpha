import path from "node:path"
import { z } from "zod"

import { projectWorkflowResult } from "../../../../apps/vscode-e2e/src/campaign/extensionAdapter"
import { validateLiveHostReceipt } from "../../../../apps/vscode-e2e/src/liveHostProtocol"
import { isLiveProviderIdentityReceipt } from "../../../../apps/vscode-e2e/src/liveProviderIdentity"
import { joinProjectedEvidence } from "../../../../apps/vscode-e2e/src/evidence/journalProjection"
import type { ScenarioRequest } from "../../../../apps/vscode-e2e/src/campaign/types"
import type { RequiredArtifactKind } from "../evidence/types"
import type { ContentAddressedArtifactStore } from "../evidence/artifactStore"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { containsSecret } from "../evidence/redaction"
import { improvementDigestSchema, improvementIdSchema } from "./contracts"
import { assertBoundedJson, verifyWithinDeadline } from "./feedback"

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const text = z.string().min(1).max(256)
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.string().datetime()
const usageSchema = z
	.object({
		requests: z.number().int().nonnegative().nullable(),
		inputTokens: z.number().int().nonnegative().nullable(),
		outputTokens: z.number().int().nonnegative().nullable(),
		cost: z.number().finite().nonnegative().nullable(),
	})
	.strict()
const providerSchema = z.object({ mode: z.literal("live-copilot"), modelId: text, effort: text.optional() })
const sourceIdentitySchema = z
	.object({
		extensionCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
		workingTreeDigest: hex,
		extensionBuildDigest: hex,
		harnessDigest: hex,
		configDigest: hex,
		taskSetDigest: hex,
		sourceComponentsDigest: hex,
		unchanged: z.literal(true),
		missing: z.array(z.string()).length(0),
	})
	.strict()
const attemptSchema = z.object({
	request: z.object({
		campaignId: improvementIdSchema,
		attemptId: improvementIdSchema,
		host: z.object({ version: z.literal("1.138.0") }),
		scenarioId: improvementIdSchema,
		sample: z.number().int().nonnegative(),
		phase: z.enum(["sample", "reproduce", "regression-before", "verify-fix", "neighbor"]),
		provider: providerSchema,
		requestLimit: z.number().int().positive(),
	}),
	result: z.object({ status: z.enum(["passed", "failed", "blocked"]), usage: usageSchema }),
	evidence: z.string().min(1).max(1024),
	evidenceFailed: z.literal(false).optional(),
})
const reportSchema = z.object({
	version: z.literal(1),
	id: improvementIdSchema,
	startedAt: timestamp,
	finishedAt: timestamp,
	requestedProvider: providerSchema,
	evaluationIdentity: sourceIdentitySchema,
	attempts: z.array(attemptSchema).min(1).max(512),
})
const descriptorSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: improvementDigestSchema,
		attemptId: improvementIdSchema,
		kind: z.literal("other"),
		digest: improvementDigestSchema,
		mediaType: z.literal("application/json"),
		sizeBytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
		access: z.literal("reviewer"),
		retention: z.literal("campaign"),
		uploadState: z.literal("complete"),
		captureStatus: z.enum(["captured", "captured-empty"]),
		createdAt: timestamp,
	})
	.strict()
const sourceFileSchema = z.object({ path: z.string().min(1).max(1024), digest: improvementDigestSchema }).strict()
const phaseSchema = z
	.object({
		phase: z.enum(["run", "prepare", "continue"]),
		runId: improvementIdSchema,
		actualHostVersion: z.literal("1.138.0"),
		modelId: text,
		reasoningEffort: text.optional(),
		providerIdentityDigest: improvementDigestSchema,
		profileDigest: improvementDigestSchema,
		extensionEntrypointDigest: improvementDigestSchema,
		taskIds: z.array(improvementIdSchema).max(100),
		status: z.enum(["passed", "failed", "blocked"]),
		usage: usageSchema,
		captureComplete: z.boolean(),
		inputs: z.array(sourceFileSchema).min(5).max(8),
		artifacts: z
			.array(z.object({ path: z.string().min(1).max(1024), descriptor: descriptorSchema }).strict())
			.max(200),
		unavailable: z.array(z.string().min(1).max(128)).max(32),
	})
	.strict()
const unavailableWholeBundle = [
	"final_diff",
	"git_status",
	"tree_digest",
	"transcript",
	"final_response",
	"test_output",
	"extension_log",
	"environment_manifest",
	"usage",
	"stop_reason",
] as const satisfies readonly RequiredArtifactKind[]

export const hostEvidenceObservationSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("host-evidence-observation"),
		scope: z.literal("retained-host-observation"),
		id: improvementIdSchema,
		createdAt: timestamp,
		campaignId: improvementIdSchema,
		attemptId: improvementIdSchema,
		scenarioId: improvementIdSchema,
		report: sourceFileSchema,
		index: sourceFileSchema,
		sourceIdentity: sourceIdentitySchema,
		campaignStatus: z.enum(["passed", "failed", "blocked"]),
		campaignUsage: usageSchema,
		phases: z.array(phaseSchema).min(1).max(2),
		unavailableWholeBundle: z.array(z.enum(unavailableWholeBundle)).length(unavailableWholeBundle.length),
		semanticGradingEligible: z.literal(false),
		regressionGenerationEligible: z.literal(false),
		digest: improvementDigestSchema,
	})
	.strict()

export type HostEvidenceObservation = z.infer<typeof hostEvidenceObservationSchema>
export type HostEvidenceImportPorts = {
	/** A caller-owned, symlink-safe, bounded reader relative to one explicit campaign run directory. */
	readFile(relative: string, maxBytes: number): Promise<Uint8Array>
	store: ContentAddressedArtifactStore
	now?: Date
	secrets?: string[]
	signal?: AbortSignal
}

export function parseHostEvidenceObservation(value: unknown): HostEvidenceObservation {
	assertBoundedJson(value, 8 * 1024 * 1024)
	const parsed = hostEvidenceObservationSchema.parse(value)
	const { digest, ...content } = parsed
	if (digest !== sha256(canonicalJson(content))) throw new Error("Host observation digest mismatch")
	if (canonicalJson(parsed.unavailableWholeBundle) !== canonicalJson(unavailableWholeBundle))
		throw new Error("Host observations cannot claim whole evaluator evidence")
	let totalBytes = 0
	for (const phase of parsed.phases) {
		for (const { path: file, descriptor } of phase.artifacts) {
			assertRelativeFile(file)
			if (descriptor.attemptId !== parsed.attemptId) throw new Error("Host artifact attempt mismatch")
			totalBytes += descriptor.sizeBytes
		}
	}
	if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Host observation retained byte bound exceeded")
	return parsed
}

/** Import retained privacy projections only; this cannot reconstruct absent task content or authorize an eval pass. */
export async function importHostEvidence(
	input: { id: string; reportPath: string; attemptId: string },
	ports: HostEvidenceImportPorts,
): Promise<HostEvidenceObservation> {
	try {
		return await verifyWithinDeadline(async (signal) => {
			improvementIdSchema.parse(input.id)
			improvementIdSchema.parse(input.attemptId)
			const createdAt = (ports.now ?? new Date()).toISOString()
			let totalBytes = 0
			const read = async (relative: string) => {
				assertRelativeFile(relative)
				if (signal.aborted) throw new Error("Host import aborted")
				const bytes = await ports.readFile(relative, MAX_FILE_BYTES)
				if (signal.aborted) throw new Error("Host import aborted")
				totalBytes += bytes.byteLength
				if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES)
					throw new Error("Host import byte bound")
				const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
				assertBoundedJson(value, MAX_FILE_BYTES)
				assertNoSecrets(value, ports.secrets)
				return { bytes, value, source: { path: relative, digest: sha256(bytes) } }
			}
			const reportFile = await read(input.reportPath)
			const report = reportSchema.parse(reportFile.value)
			if (Date.parse(report.finishedAt) < Date.parse(report.startedAt))
				throw new Error("Invalid campaign interval")
			if (new Set(report.attempts.map(({ request }) => request.attemptId)).size !== report.attempts.length)
				throw new Error("Duplicate campaign attempt identity")
			const attempt = report.attempts.find(({ request }) => request.attemptId === input.attemptId)
			if (
				!attempt ||
				attempt.request.campaignId !== report.id ||
				canonicalJson(attempt.request.provider) !== canonicalJson(report.requestedProvider)
			)
				throw new Error("Host campaign attempt identity mismatch")
			const indexPath = `${input.attemptId}/evidence-index.json`
			if (attempt.evidence.replaceAll("\\", "/") !== indexPath)
				throw new Error("Host evidence index identity mismatch")
			const indexFile = await read(indexPath)
			const index = z
				.object({ schemaVersion: z.literal(1), manifests: z.array(z.string().max(1024)).min(1).max(2) })
				.parse(indexFile.value)
			const expectedPhases =
				attempt.request.scenarioId === "reload-continuation"
					? (["prepare", "continue"] as const)
					: (["run"] as const)
			if (index.manifests.length > expectedPhases.length) throw new Error("Unexpected host phase inventory")
			const phases: HostEvidenceObservation["phases"] = []
			for (const [position, relativeManifest] of index.manifests.entries()) {
				const phase = expectedPhases[position]
				if (!phase) throw new Error("Unexpected host phase")
				const runId = `${sha256(report.id).slice(7)}-${input.attemptId}-${phase}`
				const directory = `host-evidence/${runId}`
				if (relativeManifest.replaceAll("\\", "/") !== `${directory}/manifest.json`)
					throw new Error("Host phase identity mismatch")
				const manifestFile = await read(`${directory}/manifest.json`)
				const manifest = manifestSchema.parse(manifestFile.value)
				if (
					manifest.runId !== runId ||
					manifest.metadata.scenarioId !== attempt.request.scenarioId ||
					manifest.metadata.modelId !== attempt.request.provider.modelId ||
					manifest.metadata.reasoningEffort !== attempt.request.provider.effort ||
					Date.parse(manifest.metadata.startedAt) < Date.parse(report.startedAt) ||
					Date.parse(manifest.metadata.finishedAt) > Date.parse(report.finishedAt) ||
					Date.parse(manifest.metadata.finishedAt) < Date.parse(manifest.metadata.startedAt)
				)
					throw new Error("Host manifest identity mismatch")
				const runnerFile = await read(`${directory}/run-result.json`)
				const runner = runnerSchema.parse(runnerFile.value)
				if (
					runner.runId !== runId ||
					runner.actualModelId !== manifest.metadata.modelId ||
					runner.actualReasoningEffort !== manifest.metadata.reasoningEffort ||
					runner.captureComplete !== manifest.captureComplete ||
					!isLiveProviderIdentityReceipt(runner.providerIdentity) ||
					runner.providerIdentity.status !== "unchanged"
				)
					throw new Error("Host runner identity mismatch")
				const started = await read(`${directory}/live-host-started.json`)
				const nonce = z.object({ nonce: z.string() }).parse(started.value).nonce
				const expectedHost = { runId, nonce, actualVSCodeVersion: "1.138.0" }
				const start = validateLiveHostReceipt(started.value, expectedHost, "started")
				const completionFile = await read(`${directory}/host-completion.json`)
				const completion = validateLiveHostReceipt(completionFile.value, expectedHost, "terminal", start)
				if (
					start.pid !== runner.extensionHostPid ||
					start.ppid !== runner.extensionHostParentPid ||
					(runner.status === "passed") !== (completion.status === "passed")
				)
					throw new Error("Owned host completion mismatch")
				const retentionFile = await read(`${directory}/retention-result.json`)
				const retention = z
					.object({
						schemaVersion: z.literal(1),
						runId: z.string(),
						status: z.literal("complete"),
						eligibility: z.literal("held"),
						maintenance: z.literal("campaign-owned"),
					})
					.parse(retentionFile.value)
				if (retention.runId !== runId) throw new Error("Host retention identity mismatch")
				const workflowFile = await read(`${directory}/workflow-result.json`)
				const workflow = projectWorkflowResult(
					workflowFile.value,
					attempt.request as ScenarioRequest,
					phase,
					runId,
				)
				if (
					workflow.result.actualHostVersion !== "1.138.0" ||
					workflow.result.model?.id !== runner.actualModelId ||
					canonicalJson(workflow.result.taskIds) !== canonicalJson(manifest.metadata.taskIds) ||
					(attempt.result.status === "passed" && workflow.result.status !== "passed")
				)
					throw new Error("Host workflow observation mismatch")
				const artifacts: HostEvidenceObservation["phases"][number]["artifacts"] = []
				const observed = new Map<string, unknown>()
				if (new Set(manifest.artifacts.map(({ path: file }) => file)).size !== manifest.artifacts.length)
					throw new Error("Duplicate host artifact")
				for (const artifact of manifest.artifacts) {
					assertRelativeFile(artifact.path)
					if (!isPrivacyArtifact(artifact.path, manifest.metadata.taskIds))
						throw new Error("Host artifact is outside the retained privacy projection contract")
					const file = await read(`${directory}/${artifact.path}`)
					if (file.bytes.byteLength !== artifact.bytes || sha256(file.bytes) !== `sha256:${artifact.sha256}`)
						throw new Error("Host artifact checksum mismatch")
					const descriptor = await ports.store.put({
						attemptId: input.attemptId,
						kind: "other",
						bytes: file.bytes,
						mediaType: "application/json",
						access: "reviewer",
						retention: "campaign",
						createdAt,
					})
					if (descriptor.digest !== sha256(file.bytes))
						throw new Error("Imported host artifact identity mismatch")
					artifacts.push({ path: artifact.path, descriptor: descriptorSchema.parse(descriptor) })
					observed.set(artifact.path, file.value)
				}
				const missingProjections = validateProjectionJoins(manifest.metadata.taskIds, observed)
				phases.push({
					phase,
					runId,
					actualHostVersion: "1.138.0",
					modelId: runner.actualModelId,
					...(runner.actualReasoningEffort ? { reasoningEffort: runner.actualReasoningEffort } : {}),
					providerIdentityDigest: sha256(canonicalJson(runner.providerIdentity)),
					profileDigest: sha256(runner.profileDir),
					extensionEntrypointDigest: `sha256:${manifest.bundleSha256}`,
					taskIds: manifest.metadata.taskIds,
					status: workflow.result.status,
					usage: workflow.result.usage,
					captureComplete: manifest.captureComplete,
					inputs: [
						manifestFile.source,
						runnerFile.source,
						started.source,
						completionFile.source,
						retentionFile.source,
						workflowFile.source,
					],
					artifacts,
					unavailable: [
						...missingProjections,
						"loaded-full-build-identity",
						...(!manifest.captureComplete ? ["complete-trace-capture"] : []),
						...(workflow.result.usage.inputTokens === null || workflow.result.usage.outputTokens === null
							? ["usage-token-counts"]
							: []),
						...(workflow.result.usage.cost === null ? ["usage-cost"] : []),
					],
				})
			}
			if (index.manifests.length !== expectedPhases.length) {
				if (attempt.result.status === "passed")
					throw new Error("Passed campaign attempt has missing host phases")
				phases.at(-1)?.unavailable.push("continuation-phase")
			}
			const content = {
				schemaVersion: 1 as const,
				recordType: "host-evidence-observation" as const,
				scope: "retained-host-observation" as const,
				id: input.id,
				createdAt,
				campaignId: report.id,
				attemptId: input.attemptId,
				scenarioId: attempt.request.scenarioId,
				report: reportFile.source,
				index: indexFile.source,
				sourceIdentity: report.evaluationIdentity,
				campaignStatus: attempt.result.status,
				campaignUsage: attempt.result.usage,
				phases,
				unavailableWholeBundle: [...unavailableWholeBundle],
				semanticGradingEligible: false as const,
				regressionGenerationEligible: false as const,
			}
			return parseHostEvidenceObservation({ ...content, digest: sha256(canonicalJson(content)) })
		}, ports.signal)
	} catch {
		throw new Error("Retained host evidence import failed integrity or identity verification")
	}
}

const manifestSchema = z.object({
	kind: z.literal("alpha-vscode-e2e-run-evidence"),
	version: z.literal(1),
	runId: improvementIdSchema,
	finalized: z.literal(true),
	bundleSha256: hex,
	captureComplete: z.boolean(),
	metadata: z.object({
		scenarioId: improvementIdSchema,
		hostVersion: z.literal("1.138.0"),
		requestedHostVersion: z.literal("1.138.0"),
		provider: z.literal("live-copilot"),
		modelId: text,
		reasoningEffort: text.optional(),
		taskIds: z.array(improvementIdSchema).max(100),
		startedAt: timestamp,
		finishedAt: timestamp,
	}),
	artifacts: z
		.array(
			z.object({
				path: z.string().min(1).max(1024),
				bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
				sha256: hex,
			}),
		)
		.max(200),
})
const runnerSchema = z.object({
	runId: improvementIdSchema,
	status: z.enum(["passed", "failed", "blocked"]),
	providerMode: z.literal("live-copilot"),
	actualVSCodeVersion: z.literal("1.138.0"),
	actualModelId: text,
	actualReasoningEffort: text.optional(),
	execution: z.literal("extension-host"),
	hostExitObserved: z.literal(true),
	ownershipGate: z.literal("verified"),
	captureComplete: z.boolean(),
	extensionHostPid: z.number().int().positive(),
	extensionHostParentPid: z.number().int().positive(),
	launchedHostPid: z.number().int().positive(),
	profileDir: z.string().min(1).max(4096),
	providerIdentity: z.unknown(),
})

function assertRelativeFile(value: string): void {
	if (
		value.length > 1024 ||
		value.includes(":") ||
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		!value.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== "." && part !== "..")
	)
		throw new Error("Unsafe retained host evidence path")
}

function assertNoSecrets(value: unknown, secrets: string[] = []): void {
	if (
		containsSecret(value, secrets) ||
		/\b(?:Bearer\s+[a-zA-Z0-9._~-]{12,}|sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,})/.test(canonicalJson(value))
	)
		throw new Error("Host evidence contains credentials")
}

function isPrivacyArtifact(file: string, taskIds: string[]): boolean {
	if (
		[
			"repository-before.json",
			"repository-after.json",
			"agent-control-summary.json",
			"storage-lock.json",
			"logs-index.json",
		].includes(file)
	)
		return true
	return taskIds.some((taskId) =>
		[
			"agent_lifecycle_events.jsonl.projection.json",
			"agent_turn_events.jsonl.projection.json",
			"api_conversation_history.json.projection.json",
			"evidence-join.json",
		].some((name) => file === `${taskId}-${name}`),
	)
}

function validateProjectionJoins(taskIds: string[], artifacts: Map<string, unknown>): string[] {
	const unavailable = new Set<string>()
	const journal = z.object({
		sourceBytes: z.number().int().nonnegative(),
		sourceSha256: hex,
		projection: z.object({
			validationStatus: z.enum(["validated", "unverified", "incomplete"]),
			events: z.array(z.unknown()).max(10_000),
		}),
	})
	for (const taskId of taskIds) {
		const lifecycle = artifacts.get(`${taskId}-agent_lifecycle_events.jsonl.projection.json`)
		const events = artifacts.get(`${taskId}-agent_turn_events.jsonl.projection.json`)
		const join = artifacts.get(`${taskId}-evidence-join.json`)
		const conversation = artifacts.get(`${taskId}-api_conversation_history.json.projection.json`)
		if (lifecycle === undefined) unavailable.add("lifecycle-projection")
		if (events === undefined) unavailable.add("turn-projection")
		if (join === undefined) unavailable.add("cross-stream-join")
		if (conversation === undefined) unavailable.add("conversation-projection")
		if (lifecycle === undefined || events === undefined || join === undefined) continue
		const left = journal.parse(lifecycle).projection
		const right = journal.parse(events).projection
		for (const event of [...left.events, ...right.events]) {
			const row = z.record(z.unknown()).parse(event)
			if (row.taskIdSha256 !== undefined && row.taskIdSha256 !== sha256(taskId).slice(7))
				throw new Error("Host projection contains a different task identity")
		}
		const expected = {
			status:
				left.validationStatus === "validated" &&
				right.validationStatus === "validated" &&
				joinProjectedEvidence({ lifecycle: left.events, eventLog: right.events }).records.some(
					({ status }) => status === "joined",
				)
					? "captured"
					: "incomplete",
			validation: { lifecycle: left.validationStatus, eventLog: right.validationStatus },
			...joinProjectedEvidence({ lifecycle: left.events, eventLog: right.events }),
		}
		if (canonicalJson(JSON.parse(JSON.stringify(expected))) !== canonicalJson(join))
			throw new Error("Host projected join mismatch")
		if (expected.status !== "captured") unavailable.add("complete-cross-stream-join")
	}
	return [...unavailable]
}

export async function validateHostEvidenceObservation(
	value: unknown,
	store: ContentAddressedArtifactStore,
	options: { signal?: AbortSignal } = {},
): Promise<HostEvidenceObservation> {
	const observation = parseHostEvidenceObservation(value)
	await verifyWithinDeadline(async (signal) => {
		for (const phase of observation.phases)
			for (const { descriptor } of phase.artifacts) {
				if (signal.aborted) throw new Error("Host observation verification aborted")
				const bytes = await store.get(descriptor)
				if (signal.aborted) throw new Error("Host observation verification aborted")
				if (!bytes || bytes.byteLength !== descriptor.sizeBytes || sha256(bytes) !== descriptor.digest)
					throw new Error("Retained host observation artifact integrity failed")
			}
	}, options.signal)
	return observation
}
