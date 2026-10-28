import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { parse } from "yaml"

import {
	inspectTaskLifecycle,
	inspectToolTransactions,
} from "../../../../apps/vscode-e2e/src/scenarios/transactionAssertions"
import {
	benchmarkReleaseLockSchema,
	benchmarkSuiteManifestSchema,
	benchmarkTaskManifestSchema,
	type BenchmarkTaskManifest,
} from "../benchmark/contracts"
import { canonicalFixtureBytes, fixtureTreeDigest } from "../benchmark/fixtureDigest.mjs"
import { benchmarkTaskSetDigest } from "../benchmark/loader"
import {
	assertPrivateContent,
	parseImprovementEvidenceBundle,
	privateArtifactStore,
	readBoundedFile,
	readBoundedJson,
	readOwnedFile,
	writeOwnedJson,
} from "../improvement/store"
import { ExecaHarnessProcessRunner } from "../orchestration/processRunner"
import type { HarnessProcessRunner } from "../orchestration/ports"
import type { ContentAddressedArtifactStore } from "./artifactStore"
import { canonicalJson, sha256 } from "./canonical"
import { collectRequiredEvidence, type CaptureStatuses, type RequiredEvidence } from "./collector"
import { EventJournal } from "./eventJournal"
import { evidenceBundleDigest, validateEvidenceBundle } from "./integrity"
import { manifestIdentity, taskManifestSchema } from "./manifests"
import { redact } from "./redaction"
import { collectWorkspaceEvidence } from "./runtimeCollector"
import type { ArtifactCaptureStatus, ArtifactDescriptor, EvidenceBundle } from "./types"
import { workspaceSnapshotPath } from "./workspaceSnapshot"

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const hostId = z
	.string()
	.max(96)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const taskId = z
	.string()
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const absolutePath = z
	.string()
	.max(4096)
	.refine((value) => path.isAbsolute(value) && !value.includes("\0"))
const date = z.string().datetime({ offset: true })
const closureSchema = z
	.object({
		schemaVersion: z.literal(1),
		scope: z.literal("observed-owned-host-process-family"),
		observedAt: date,
		cleanupVerified: z.boolean(),
		source: z.enum(["prior-owned-tree-cleanup", "process-snapshot"]),
		ownedPids: z.array(z.number().int().positive()).min(1).max(32),
		matchingProcessIds: z.array(z.number().int().positive()).max(2000),
		unavailableCommandLines: z.number().int().nonnegative(),
		failure: z
			.enum(["host-not-closed", "prior-cleanup-unverified", "process-proof-unavailable", "owned-process-remains"])
			.optional(),
	})
	.strict()
const markerName = ".alpha-e2e-owned.json"
const taskFiles = [
	"api_conversation_history.json",
	"ui_messages.json",
	"agent_lifecycle_events.jsonl",
	"agent_turn_events.jsonl",
] as const

export const nativeHostPrepareInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("alpha-native-host-capture-prepare"),
		hostRunId: hostId,
		runDirectory: absolutePath,
		workspace: absolutePath,
		catalogRoot: absolutePath,
		taskId: z.string().min(1).max(256),
		extensionRoot: absolutePath,
		repositoryRoot: absolutePath,
		userDataDir: absolutePath,
		extensionId: z
			.string()
			.max(128)
			.regex(/^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/),
		startedAt: date,
		taskIdsBefore: z.array(taskId).max(2000).optional(),
	})
	.strict()

const sourceFileSchema = z.object({ path: z.string(), digest, sizeBytes: z.number().int().nonnegative() }).strict()
const contextSchema = nativeHostPrepareInputSchema
	.omit({ kind: true, taskIdsBefore: true })
	.extend({
		kind: z.literal("alpha-native-host-capture-context"),
		scope: z.literal("owned-native-host-public-task"),
		databaseIdentity: z.literal("not-applicable"),
		sourceTask: benchmarkTaskManifestSchema,
		runtimeManifest: taskManifestSchema.strict(),
		taskIdsBefore: z.array(taskId).max(2000),
		baselineCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
		baselineGitTree: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
		baselineGitDirectory: absolutePath,
		baselineConfigDigest: digest,
		gitExecutable: absolutePath,
		gitExecutableDigest: digest,
		fixtureFiles: z.array(sourceFileSchema).max(2000),
		logsBefore: z.array(sourceFileSchema).max(2000),
		build: z
			.object({
				bundleDigest: digest,
				packageDigest: digest,
				identityScope: z.literal("observed-extension-bundle-bytes"),
			})
			.strict(),
		digest,
	})
	.strict()
export type NativeHostCaptureContext = z.infer<typeof contextSchema>

const hostResultSchema = z
	.object({
		status: z.enum(["passed", "failed", "blocked", "cancelled", "timed_out"]),
		failure: z.string().max(256).optional(),
		execution: z.string().max(128),
		hostExitObserved: z.boolean(),
		hostCleanupVerified: z.boolean().optional(),
		ownershipGate: z.string().max(128).optional(),
		actualVSCodeVersion: z.string().max(128).optional(),
		actualModelId: z.string().max(256).optional(),
		actualReasoningEffort: z.string().max(128).optional(),
		providerMode: z.enum(["scripted", "live-copilot"]),
		providerIdentity: z.unknown().optional(),
		hostCaptureClosure: closureSchema.optional(),
		userDataDir: absolutePath,
		extensionHostPid: z.number().int().positive().optional(),
		extensionHostParentPid: z.number().int().positive().optional(),
	})
	.passthrough()
export const nativeHostFinalizeInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("alpha-native-host-capture-finalize"),
		contextPath: absolutePath,
		expectedContextDigest: digest,
		hostRunId: hostId,
		runDirectory: absolutePath,
		workspace: absolutePath,
		storagePath: absolutePath.optional(),
		logsPath: absolutePath.optional(),
		taskIds: z.array(taskId).max(100),
		finishedAt: date,
		workflowResultPath: absolutePath,
		result: hostResultSchema,
	})
	.strict()

const resultSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("alpha-native-host-capture-result"),
		hostRunId: hostId,
		status: z.enum(["captured", "incomplete", "failed"]),
		contextPath: absolutePath,
		contextDigest: digest,
		captureResultPath: absolutePath,
		bundlePath: absolutePath.optional(),
		bundleDigest: digest.optional(),
		artifactsRoot: absolutePath.optional(),
		integrity: z
			.object({ valid: z.boolean(), issues: z.array(z.object({ code: z.string(), detail: z.string() })) })
			.optional(),
		missingArtifacts: z.array(z.string()),
		sources: z.array(
			z.object({
				path: z.string(),
				status: z.enum(["captured", "captured-empty", "missing", "failed"]),
				digest: digest.optional(),
			}),
		),
		failure: z.string().max(256).optional(),
		digest,
	})
	.strict()
export type NativeHostCaptureResult = z.infer<typeof resultSchema>
type CapturePorts = { secrets?: string[]; signal?: AbortSignal; processRunner?: HarnessProcessRunner }
type SourceState = NativeHostCaptureResult["sources"][number]

/** Runs before the first model request. The catalog and original fixture remain the task authority. */
export async function prepareNativeHostCapture(
	value: unknown,
	ports: CapturePorts = {},
): Promise<{ contextPath: string; contextDigest: string }> {
	ports.signal?.throwIfAborted()
	const input = nativeHostPrepareInputSchema.parse(value)
	await verifyRunDirectory(input.runDirectory, input.hostRunId)
	await verifyOwnedRoot(input.workspace, "workspace")
	await verifyProfile(input.userDataDir)
	for (const directory of [input.workspace, input.catalogRoot, input.extensionRoot, input.repositoryRoot])
		await realDirectory(directory)
	if (related(input.workspace, input.runDirectory) || related(input.workspace, input.catalogRoot))
		throw new Error("Native capture requires an isolated workspace and evidence directory")
	const sourceTask = await selectedPublicTask(input.catalogRoot, input.taskId, ports)
	if (sourceTask.partition === "holdout" || !sourceTask.fixtureDigest || !sourceTask.promptDigest)
		throw new Error("Native capture requires a public task with sealed fixture and prompt identities")
	const fixture = await readTree(input.workspace, ports)
	if (fixtureTreeDigest(fixture) !== sourceTask.fixtureDigest)
		throw new Error("Native capture workspace differs from the trusted fixture")
	const prompt = fixture.find((file) => file.path === sourceTask.prompt)
	if (!prompt || sha256(canonicalFixtureBytes(prompt.bytes)) !== sourceTask.promptDigest)
		throw new Error("Native capture prompt differs from the trusted task")
	const storage = storageDirectory(input)
	const before = await listTaskIds(storage)
	if (input.taskIdsBefore && canonicalJson([...input.taskIdsBefore].sort()) !== canonicalJson(before))
		throw new Error("Native capture pre-agent task inventory differs from the actual profile")
	const directory = path.join(input.runDirectory, "improvement")
	await ensureDirectory(directory)
	const baselineGitDirectory = path.join(directory, "baseline.git")
	const gitExecutable = await resolveGitExecutable(input.workspace)
	const gitExecutableDigest = sha256(await readBoundedFile(gitExecutable, 64 * 1024 * 1024))
	const runner = captureRunner(ports, baselineGitDirectory, input.workspace, gitExecutable)
	const baselineCommit = await establishBaseline(input.workspace, baselineGitDirectory, runner)
	const baselineGitTree = await git(input.workspace, runner, ["rev-parse", `${baselineCommit}^{tree}`])
	const runtimeManifest = taskManifestSchema.strict().parse({
		schemaVersion: 1,
		id: sourceTask.id,
		version: sourceTask.version,
		fixtureDigest: sourceTask.fixtureDigest,
		workspaceCommit: baselineCommit,
		capabilities: sourceTask.capabilities,
		risk: sourceTask.risk,
		network: sourceTask.validation.network,
		graders: sourceTask.graders.map(({ id, version }) => ({ id, version })),
	})
	const body = {
		...input,
		kind: "alpha-native-host-capture-context" as const,
		scope: "owned-native-host-public-task" as const,
		databaseIdentity: "not-applicable" as const,
		sourceTask,
		runtimeManifest,
		taskIdsBefore: before,
		baselineCommit,
		baselineGitTree,
		baselineGitDirectory,
		baselineConfigDigest: sha256(await readOwnedFile(baselineGitDirectory, "config")),
		gitExecutable,
		gitExecutableDigest,
		fixtureFiles: fixture.map(({ path: file, bytes }) => ({
			path: file,
			digest: sha256(bytes),
			sizeBytes: bytes.length,
		})),
		logsBefore: await logInventory(path.join(input.userDataDir, "logs"), ports),
		build: {
			bundleDigest: sha256(await readOwnedFile(input.extensionRoot, "dist/extension.js", 64 * 1024 * 1024)),
			packageDigest: sha256(await readOwnedFile(input.extensionRoot, "package.json")),
			identityScope: "observed-extension-bundle-bytes" as const,
		},
	}
	const context = contextSchema.parse({ ...body, digest: sha256(canonicalJson(body)) })
	assertPrivateContent(context, ports.secrets)
	ports.signal?.throwIfAborted()
	await writeOwnedJson(directory, "context.json", context)
	return { contextPath: path.join(directory, "context.json"), contextDigest: context.digest }
}

/** Captures original bytes after the owned host exits; validity is evidence completeness, never a grade. */
export async function finalizeNativeHostCapture(
	value: unknown,
	ports: CapturePorts = {},
): Promise<NativeHostCaptureResult> {
	ports.signal?.throwIfAborted()
	const input = nativeHostFinalizeInputSchema.parse(value)
	await verifyRunDirectory(input.runDirectory, input.hostRunId)
	const directory = path.join(input.runDirectory, "improvement")
	if (!same(input.contextPath, path.join(directory, "context.json")))
		throw new Error("Native capture context escaped its run")
	const context = await readContext(input.contextPath)
	if (
		context.digest !== input.expectedContextDigest ||
		context.hostRunId !== input.hostRunId ||
		!same(context.runDirectory, input.runDirectory) ||
		!same(context.workspace, input.workspace) ||
		!same(context.userDataDir, input.result.userDataDir) ||
		Date.parse(input.finishedAt) < Date.parse(context.startedAt)
	)
		throw new Error("Native capture identity differs from its pre-agent context")
	const captureResultPath = path.join(directory, "capture-result.json")
	const base = {
		schemaVersion: 1 as const,
		kind: "alpha-native-host-capture-result" as const,
		hostRunId: input.hostRunId,
		contextPath: input.contextPath,
		contextDigest: context.digest,
		captureResultPath,
		missingArtifacts: [] as string[],
		sources: [] as SourceState[],
	}
	try {
		const proofs = await verifyHostProofs(input, context, ports)
		await verifyOwnedRoot(context.workspace, "workspace")
		await verifyProfile(context.userDataDir)
		const storage = storageDirectory(context)
		if (input.storagePath && !same(input.storagePath, storage))
			throw new Error("Native task storage escaped its profile")
		if (input.logsPath && !same(input.logsPath, path.join(context.userDataDir, "logs")))
			throw new Error("Native logs escaped their profile")
		if (!same(input.workflowResultPath, path.join(input.runDirectory, "workflow-result.json")))
			throw new Error("Native workflow receipt escaped its run")
		const sources = base.sources
		const workflow = await readSourceJson(input.workflowResultPath, "workflow-result.json", sources, ports)
		const workflowRecord = workflow === undefined ? undefined : workflowSchema.parse(workflow)
		if (
			workflowRecord &&
			(workflowRecord.runId !== input.hostRunId ||
				canonicalJson(workflowRecord.taskIds) !== canonicalJson(input.taskIds) ||
				canonicalJson(proofs.manifest.metadata.taskIds) !== canonicalJson(input.taskIds) ||
				workflowRecord.hostVersion !== input.result.actualVSCodeVersion ||
				workflowRecord.providerMode !== input.result.providerMode)
		)
			throw new Error("Native workflow task or host attribution differs from the owned run")
		const currentIds = await listTaskIds(storage)
		const selected = workflowRecord?.taskIds ?? currentIds.filter((id) => !context.taskIdsBefore.includes(id))
		if (
			selected.length !== 1 ||
			selected.some((id) => context.taskIdsBefore.includes(id) || !currentIds.includes(id))
		)
			throw new Error("Native capture requires one newly created, exactly attributed task")
		const selectedTask = selected[0]!
		const raw = new Map<string, unknown>()
		for (const file of taskFiles) {
			const relative = `tasks/${selectedTask}/${file}`
			const data = await readSourceJson(
				path.join(storage, ...relative.split("/")),
				relative,
				sources,
				ports,
				file.endsWith("jsonl"),
			)
			if (data !== undefined) raw.set(file, data)
		}
		for (const file of ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl"]) {
			const events = raw.get(file)
			if (
				events !== undefined &&
				(!Array.isArray(events) || events.some((event) => record(event)?.taskId !== selectedTask))
			)
				throw new Error("Native task journal contains a foreign task identity")
		}
		const history = raw.get("api_conversation_history.json")
		const ui = raw.get("ui_messages.json")
		if ((history !== undefined && !Array.isArray(history)) || (ui !== undefined && !Array.isArray(ui)))
			throw new Error("Native task conversation is not an observed message array")
		const model = workflowRecord?.model.id ?? input.result.actualModelId
		if (!model || (input.result.actualModelId && model !== input.result.actualModelId))
			throw new Error("Native capture lacks an observed, consistent model identity")
		if (
			workflowRecord?.model.reasoningEffort !== undefined &&
			input.result.actualReasoningEffort !== undefined &&
			workflowRecord.model.reasoningEffort !== input.result.actualReasoningEffort
		)
			throw new Error("Native capture observed reasoning effort differs between host and task")
		const reasoningEffort = workflowRecord?.model.reasoningEffort ?? input.result.actualReasoningEffort ?? null
		const runtimeVariant = {
			build: context.build,
			host: input.result.actualVSCodeVersion,
			provider: input.result.providerMode,
			model,
			reasoningEffort,
			providerIdentity: input.result.providerIdentity ?? null,
			approvalPolicyDigest: workflowRecord?.e2eApprovalPolicySha256 ?? null,
		}
		const traceInspection = inspectNativeTrace(
			history,
			ui,
			raw.get("agent_lifecycle_events.jsonl"),
			raw.get("agent_turn_events.jsonl"),
			selectedTask,
		)
		const identity = nativeIdentity(input.hostRunId)
		const artifactsRoot = path.join(directory, "artifacts")
		await ensureDirectory(artifactsRoot)
		const store = boundedStore(privateArtifactStore(artifactsRoot, ports.secrets), ports)
		const usage = workflowRecord?.usage
		const finalResponse = observedFinalResponse(history)
		const tests = observedTestOutput(history, context.sourceTask)
		const logs = await observedLogs(context, sources, ports)
		const statuses: CaptureStatuses = {
			transcript: history === undefined ? sourceStatus(sources, "api_conversation_history.json") : "captured",
			final_response: finalResponse ? "captured" : "missing",
			test_output: tests.length ? "captured" : "missing",
			extension_log: logs.length ? "captured" : "missing",
			usage: usage && Object.values(usage).some((count) => count !== null) ? "captured" : "missing",
		}
		const environment = clean(
			{
				scope: context.scope,
				databaseIdentity: context.databaseIdentity,
				hostRunId: input.hostRunId,
				actualHostVersion: input.result.actualVSCodeVersion,
				providerMode: input.result.providerMode,
				model,
				reasoningEffort,
				providerIdentity: input.result.providerIdentity ?? null,
				profileDigest: sha256(context.userDataDir),
				build: context.build,
				runtimeManifest: context.runtimeManifest,
				contextDigest: context.digest,
				proofDigests: proofs.digests,
				testOutputOrigin: "agent-tool-output",
				independentGrade: false,
				runtimeVariant,
			},
			ports,
		)
		const evidence: RequiredEvidence = {
			final_diff: undefined,
			git_status: undefined,
			tree_digest: undefined,
			transcript:
				history === undefined
					? undefined
					: clean({ taskId: selectedTask, providerHistory: history, uiMessages: ui ?? null }, ports),
			final_response: finalResponse === undefined ? undefined : clean(finalResponse, ports),
			test_output: tests.length
				? clean({ origin: "agent-tool-output", independentGrade: false, receipts: tests }, ports)
				: undefined,
			extension_log: logs.length ? clean(logs, ports) : undefined,
			environment_manifest: environment,
			usage: usage === undefined ? undefined : clean({ origin: "workflow-task-history-usage", ...usage }, ports),
			stop_reason: clean(
				{
					origin: "observed-host-outcome",
					status: input.result.status,
					failure: input.result.failure ?? null,
					workflowStatus: workflowRecord?.status ?? null,
				},
				ports,
			),
		}
		let artifacts: ArtifactDescriptor[]
		try {
			if (
				!same(context.baselineGitDirectory, path.join(directory, "baseline.git")) ||
				sha256(await readOwnedFile(context.baselineGitDirectory, "config")) !== context.baselineConfigDigest
			)
				throw new Error("Native baseline configuration changed")
			if (
				inside(context.workspace, context.gitExecutable) ||
				sha256(await readBoundedFile(context.gitExecutable, 64 * 1024 * 1024)) !== context.gitExecutableDigest
			)
				throw new Error("Native capture Git executable identity changed")
			const runner = captureRunner(ports, context.baselineGitDirectory, context.workspace, context.gitExecutable)
			if (
				(await git(context.workspace, runner, ["rev-parse", `${context.baselineCommit}^{tree}`])) !==
				context.baselineGitTree
			)
				throw new Error("Native baseline commit changed")
			// Snapshot encoding must not hide credentials inside base64; reject such workspace bytes before storing them.
			await readTree(context.workspace, ports)
			const workspace = await collectWorkspaceEvidence({
				attemptId: identity.attemptId,
				workspace: context.workspace,
				baselineCommit: context.baselineCommit,
				processRunner: runner,
				store,
				secrets: ports.secrets,
				stopReason: String(input.result.status),
			})
			artifacts = workspace.filter(({ kind }) =>
				["final_diff", "git_status", "tree_digest", "workspace_snapshot"].includes(kind),
			)
		} catch {
			ports.signal?.throwIfAborted()
			for (const kind of ["final_diff", "git_status", "tree_digest"] as const) statuses[kind] = "failed"
			artifacts = []
			sources.push({ path: "workspace", status: "failed" })
		}
		const required = await collectRequiredEvidence(identity.attemptId, evidence, store, {
			secrets: ports.secrets,
			captureStatuses: statuses,
		})
		artifacts.push(...required.filter(({ kind }) => !artifacts.some((existing) => existing.kind === kind)))
		artifacts.push(
			await store.put({
				attemptId: identity.attemptId,
				kind: "other",
				bytes: Buffer.from(
					canonicalJson(
						clean(
							{
								kind: "native-host-original-task-journals",
								taskId: selectedTask,
								sources,
								lifecycle: raw.get("agent_lifecycle_events.jsonl") ?? null,
								turns: raw.get("agent_turn_events.jsonl") ?? null,
								traceInspection,
							},
							ports,
						),
					),
				),
				mediaType: "application/json",
				access: "private",
				captureStatus: traceInspection.errors.length ? "failed" : "captured",
			}),
		)
		const journal = new EventJournal(identity, { secrets: ports.secrets })
		journal.append(
			"native_host.capture_prepared",
			{
				contextDigest: context.digest,
				taskIdentity: manifestIdentity(context.runtimeManifest),
				sourceTaskIdentity: `${context.sourceTask.id}@${context.sourceTask.version}`,
				baselineCommit: context.baselineCommit,
				scope: context.scope,
				databaseIdentity: "not-applicable",
			},
			context.startedAt,
		)
		journal.append(
			"native_host.task_observed",
			clean({ taskId: selectedTask, sources, workflow: workflowRecord ?? null, traceInspection }, ports),
			input.finishedAt,
		)
		journal.append(
			"native_host.host_exited",
			clean(
				{
					status: input.result.status,
					failure: input.result.failure ?? null,
					hostExitObserved: true,
					ownershipGate: "verified",
					proofDigests: proofs.digests,
				},
				ports,
			),
			input.finishedAt,
		)
		const bundle: EvidenceBundle = {
			schemaVersion: 1,
			...identity,
			taskIdentity: manifestIdentity(context.runtimeManifest),
			// Version 1 omitted observed effort/provider build/policy. Preserve those historical IDs; new variants bind them.
			variantIdentity: `native-host-runtime@2:${sha256(canonicalJson(runtimeVariant))}`,
			identityStatus: "attempt-bound",
			events: journal.all(),
			artifacts,
		}
		bundle.bundleDigest = evidenceBundleDigest(bundle)
		const integrity = await validateEvidenceBundle(bundle, store, { requireWorkspaceSnapshot: true })
		const missingArtifacts: string[] = artifacts
			.filter(({ captureStatus }) => ["missing", "failed", "unavailable"].includes(captureStatus ?? "missing"))
			.map(({ kind }) => kind)
		for (const source of sources)
			if (["missing", "failed"].includes(source.status)) missingArtifacts.push(source.path)
		if (!workflowRecord) missingArtifacts.push("workflow-result.json")
		missingArtifacts.push(...traceInspection.errors.map((code) => `native_trace:${code}`))
		const status = integrity.valid && !missingArtifacts.length ? ("captured" as const) : ("incomplete" as const)
		ports.signal?.throwIfAborted()
		await writeOwnedJson(directory, "bundle.json", bundle)
		return publishResult(directory, {
			...base,
			status,
			bundlePath: path.join(directory, "bundle.json"),
			bundleDigest: bundle.bundleDigest,
			artifactsRoot,
			integrity,
			missingArtifacts: [...new Set(missingArtifacts)],
		})
	} catch {
		ports.signal?.throwIfAborted()
		// Error text may contain private paths or provider content. Publish a stable failure code only.
		return publishResult(directory, {
			...base,
			status: "failed",
			failure: "native-host-evidence-validation-failed",
		})
	}
}

/** Offline import reads only the sealed capture product and CAS, never a mutable profile or task workspace. */
export async function readNativeHostCapture(input: {
	captureResultPath: string
	sourceRoot: string
	secrets?: string[]
	signal?: AbortSignal
}): Promise<{
	bundle: EvidenceBundle
	artifactsRoot: string
	sourceTask: BenchmarkTaskManifest
	runtimeManifest: z.infer<typeof taskManifestSchema>
	capture: NativeHostCaptureResult
}> {
	input.signal?.throwIfAborted()
	await realDirectory(input.sourceRoot)
	const expected = path.join(input.sourceRoot, "improvement", "capture-result.json")
	if (!same(input.captureResultPath, expected)) throw new Error("Native capture result escaped its owned source root")
	const capture = resultSchema.parse(await readBoundedJson(expected))
	verifySeal(capture)
	await verifyRunDirectory(input.sourceRoot, capture.hostRunId)
	const directory = path.join(input.sourceRoot, "improvement")
	if (
		capture.status !== "captured" ||
		capture.missingArtifacts.length > 0 ||
		capture.sources.some(({ status }) => status === "failed" || status === "missing") ||
		capture.integrity?.valid !== true ||
		capture.integrity.issues.length > 0 ||
		!capture.bundlePath ||
		!capture.artifactsRoot ||
		!capture.bundleDigest ||
		!same(capture.contextPath, path.join(directory, "context.json")) ||
		!same(capture.bundlePath, path.join(directory, "bundle.json")) ||
		!same(capture.artifactsRoot, path.join(directory, "artifacts")) ||
		!same(capture.captureResultPath, expected)
	)
		throw new Error("Native capture is incomplete or its product identity differs")
	const context = await readContext(capture.contextPath)
	if (
		context.digest !== capture.contextDigest ||
		context.hostRunId !== capture.hostRunId ||
		!same(context.runDirectory, input.sourceRoot)
	)
		throw new Error("Native capture context identity or seal differs")
	if (
		context.sourceTask.partition === "holdout" ||
		!context.sourceTask.fixtureDigest ||
		!context.sourceTask.promptDigest ||
		context.sourceTask.repository.snapshotDigest !== context.sourceTask.fixtureDigest
	)
		throw new Error("Native capture source task is not a sealed public fixture")
	const bundle = parseImprovementEvidenceBundle(await readBoundedJson(capture.bundlePath))
	const identity = nativeIdentity(context.hostRunId)
	if (
		bundle.bundleDigest !== capture.bundleDigest ||
		bundle.taskIdentity !== manifestIdentity(context.runtimeManifest) ||
		bundle.runId !== identity.runId ||
		bundle.trialId !== identity.trialId ||
		bundle.attemptId !== identity.attemptId ||
		bundle.artifacts.some(({ access }) => access !== "private")
	)
		throw new Error("Native bundle does not belong to its captured context")
	if (bundle.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0) > MAX_TOTAL_BYTES)
		throw new Error("Native capture CAS exceeds its aggregate import bound")
	assertPrivateContent(bundle, input.secrets)
	const store = privateArtifactStore(capture.artifactsRoot, input.secrets)
	const integrity = await validateEvidenceBundle(bundle, store, {
		requireWorkspaceSnapshot: true,
	})
	input.signal?.throwIfAborted()
	if (!integrity.valid) throw new Error("Native capture CAS or bundle failed integrity")
	// Old self-sealed captures can predate native trace checks. Revalidate retained bytes without rewriting history.
	const transcriptDescriptors = bundle.artifacts.filter(({ kind }) => kind === "transcript")
	const journalDescriptors = bundle.artifacts.filter(({ kind }) => kind === "other")
	if (transcriptDescriptors.length !== 1 || journalDescriptors.length !== 1)
		throw new Error("Native capture requires its exact original trace artifacts")
	const transcript = record(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await store.get(transcriptDescriptors[0]!))!)),
	)
	const journals = record(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await store.get(journalDescriptors[0]!))!)),
	)
	if (
		!transcript ||
		!journals ||
		journals.kind !== "native-host-original-task-journals" ||
		typeof transcript.taskId !== "string" ||
		transcript.taskId !== journals.taskId ||
		inspectNativeTrace(
			transcript.providerHistory,
			transcript.uiMessages,
			journals.lifecycle,
			journals.turns,
			transcript.taskId,
		).errors.length
	)
		throw new Error("Native capture retained trace is incomplete")
	return {
		bundle,
		artifactsRoot: capture.artifactsRoot,
		sourceTask: context.sourceTask,
		runtimeManifest: context.runtimeManifest,
		capture,
	}
}

const workflowSchema = z
	.object({
		schemaVersion: z.literal(1),
		runId: hostId,
		scenarioId: z.literal("problem-solving-attempt"),
		phase: z.literal("run"),
		status: z.enum(["passed", "failed", "blocked", "checkpointed"]),
		taskIds: z.array(taskId).max(100),
		hostVersion: z.string(),
		providerMode: z.enum(["scripted", "live-copilot"]),
		model: z.object({
			id: z.string().optional(),
			family: z.string().optional(),
			vendor: z.string().optional(),
			reasoningEffort: z.string().optional(),
		}),
		e2eApprovalPolicySha256: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		usage: z
			.object({
				inputTokens: z.number().int().nonnegative().nullable(),
				outputTokens: z.number().int().nonnegative().nullable(),
				cost: z.number().nonnegative().nullable(),
			})
			.optional(),
	})
	.passthrough()

function nativeIdentity(id: string) {
	return { runId: `native-host:${id}`, trialId: `native-host-trial:${id}`, attemptId: `native-host-attempt:${id}` }
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function same(left: string, right: string): boolean {
	return path.relative(path.resolve(left), path.resolve(right)) === ""
}
function inside(root: string, value: string): boolean {
	const relative = path.relative(root, value)
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function related(left: string, right: string): boolean {
	return inside(left, right) || inside(right, left)
}
function storageDirectory(context: { userDataDir: string; extensionId: string }): string {
	return path.join(context.userDataDir, "User", "globalStorage", context.extensionId.toLowerCase())
}
async function selectedPublicTask(
	root: string,
	requested: string,
	ports: CapturePorts,
): Promise<BenchmarkTaskManifest> {
	const index = z.object({ suites: z.array(z.string().min(1).max(512)).min(1).max(128) }).parse(
		parse(Buffer.from(await readOwnedFile(root, "benchmark-suites.yaml", 256 * 1024)).toString("utf8"), {
			merge: true,
			maxAliasCount: 100,
		}),
	)
	const matches: BenchmarkTaskManifest[] = []
	let bytesRead = 0
	for (const relative of index.suites) {
		ports.signal?.throwIfAborted()
		const bytes = await readOwnedFile(root, relative, 1024 * 1024)
		bytesRead += bytes.length
		if (bytesRead > 16 * 1024 * 1024) throw new Error("Native benchmark catalog exceeds its byte bound")
		const suite = benchmarkSuiteManifestSchema.parse(
			parse(Buffer.from(bytes).toString("utf8"), { merge: true, maxAliasCount: 100 }),
		)
		if (suite.status === "released") {
			const lock = benchmarkReleaseLockSchema.parse(
				JSON.parse(
					Buffer.from(
						await readOwnedFile(root, `releases/${suite.id}@${suite.version}.lock.json`, 256 * 1024),
					).toString("utf8"),
				),
			)
			if (
				lock.suiteIdentity !== `${suite.id}@${suite.version}` ||
				lock.manifestDigest !== sha256(canonicalJson(suite)) ||
				lock.taskSetDigest !== benchmarkTaskSetDigest(suite.tasks)
			)
				throw new Error("Native selected catalog release seal differs")
		}
		matches.push(
			...suite.tasks.filter((task) =>
				requested.includes("@") ? `${task.id}@${task.version}` === requested : task.id === requested,
			),
		)
	}
	if (matches.length !== 1) throw new Error("Native capture requires one trusted public benchmark task")
	const task = matches[0]!
	if (
		sha256(canonicalJson(task.graders)) !== task.graderReferenceDigest ||
		sha256(canonicalJson(task.validation)) !== task.environmentDigest ||
		!workspaceSnapshotPath(task.prompt) ||
		task.repository.snapshotDigest !== task.fixtureDigest
	)
		throw new Error("Native public task contract identities differ")
	return task
}
async function realDirectory(value: string): Promise<void> {
	if (!path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes(".."))
		throw new Error("Native capture requires an absolute contained directory")
	let current = path.parse(value).root
	for (const component of path.relative(current, value).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("Native capture requires real directory components")
	}
}
async function ensureDirectory(value: string): Promise<void> {
	await realDirectory(path.dirname(value))
	await fs.mkdir(value, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error
	})
	await realDirectory(value)
}
async function verifyRunDirectory(directory: string, id: string): Promise<void> {
	await realDirectory(directory)
	const marker = record(await readBoundedJson(path.join(directory, ".alpha-vscode-e2e-evidence-run.json")))
	const rootMarker = record(
		await readBoundedJson(path.join(path.dirname(directory), ".alpha-vscode-e2e-evidence-root.json")),
	)
	if (
		path.basename(directory) !== id ||
		marker?.kind !== "alpha-vscode-e2e-run" ||
		marker.version !== 1 ||
		marker.runId !== id ||
		rootMarker?.kind !== "alpha-vscode-e2e-evidence-root" ||
		rootMarker.version !== 1
	)
		throw new Error("Native capture requires the runner's actual owned evidence directory")
}
async function verifyOwnedRoot(root: string, kind: "workspace" | "profile" | "temporary"): Promise<void> {
	const marker = z
		.object({ schemaVersion: z.literal(1), purpose: z.literal("alpha-vscode-e2e"), kind: z.literal(kind) })
		.strict()
		.parse(await readBoundedJson(path.join(root, markerName)))
	if (marker.kind !== kind) throw new Error("Native capture source ownership is not verified")
}
async function verifyProfile(userDataDir: string): Promise<void> {
	await realDirectory(userDataDir)
	const versionRoot = path.dirname(userDataDir)
	const profileRoot = path.dirname(versionRoot)
	// The persistent runner owns the profile root; its exact reference-host data is two fixed children below it.
	if (
		path.basename(userDataDir) !== "user-data" ||
		path.basename(versionRoot) !== "1.138.0" ||
		!same(userDataDir, path.join(profileRoot, "1.138.0", "user-data"))
	)
		throw new Error("Native capture requires the owned exact reference-host profile layout")
	await verifyOwnedRoot(profileRoot, "profile")
}
async function listTaskIds(storage: string): Promise<string[]> {
	try {
		const directory = path.join(storage, "tasks")
		await realDirectory(directory)
		const entries = await fs.readdir(directory, { withFileTypes: true })
		if (entries.length > 2000) throw new Error("Native task inventory is not bounded and owned")
		const ids: string[] = []
		for (const entry of entries) {
			if (entry.name === "_index.json" && entry.isFile() && !entry.isSymbolicLink()) {
				// TaskHistoryStore's derived cache is metadata, never an authority for captured task IDs.
				const file = path.join(directory, entry.name)
				if ((await fs.lstat(file)).nlink !== 1) throw new Error("Native task index must not be linked")
				await readBoundedFile(file, 1024 * 1024)
				continue
			}
			if (entry.isSymbolicLink() || !entry.isDirectory() || !taskId.safeParse(entry.name).success)
				throw new Error("Native task inventory is not bounded and owned")
			ids.push(entry.name)
		}
		return ids.sort()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}
async function readTree(root: string, ports: CapturePorts): Promise<Array<{ path: string; bytes: Buffer }>> {
	await realDirectory(root)
	const files: Array<{ path: string; bytes: Buffer }> = []
	let total = 0
	let entriesSeen = 0
	const visit = async (directory: string): Promise<void> => {
		ports.signal?.throwIfAborted()
		if (path.relative(root, directory).split(path.sep).length > 32)
			throw new Error("Native workspace directory depth exceeded")
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (++entriesSeen > 5000) throw new Error("Native workspace entry bound exceeded")
			if ([".git", "node_modules"].includes(entry.name) && entry.isDirectory()) continue
			const file = path.join(directory, entry.name)
			const relative = path.relative(root, file).split(path.sep).join("/")
			if (relative === markerName) continue
			if (!workspaceSnapshotPath(relative) || entry.isSymbolicLink())
				throw new Error("Native workspace contains an unsafe path")
			if (entry.isDirectory()) await visit(file)
			else {
				const bytes = Buffer.from(await readOwnedFile(root, relative, 4 * 1024 * 1024))
				total += bytes.length
				if (total > 32 * 1024 * 1024 || files.length >= 2000)
					throw new Error("Native workspace exceeds its capture bound")
				assertPrivateContent(bytes.toString("utf8"), ports.secrets)
				files.push({ path: relative, bytes })
			}
		}
	}
	await visit(root)
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}
async function resolveGitExecutable(workspace: string): Promise<string> {
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(entry)) continue
		const candidate = path.join(entry, process.platform === "win32" ? "git.exe" : "git")
		try {
			const executable = await fs.realpath(candidate)
			if (!(await fs.lstat(executable)).isFile() || inside(workspace, executable)) continue
			return executable
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTDIR"
			)
				throw error
		}
	}
	throw new Error("Native capture requires a trusted absolute Git executable")
}
function captureRunner(
	ports: CapturePorts,
	gitDirectory: string,
	workspace: string,
	executable: string,
): HarnessProcessRunner {
	const delegate = ports.processRunner ?? new ExecaHarnessProcessRunner()
	const noConfig = process.platform === "win32" ? "NUL" : "/dev/null"
	const env = Object.fromEntries(
		Object.entries({
			PATH: process.env.PATH,
			...(process.platform === "win32"
				? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
				: {}),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: noConfig,
			GIT_CONFIG_SYSTEM: noConfig,
			GIT_ATTR_NOSYSTEM: "1",
		}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	)
	return {
		run: (spec) => {
			ports.signal?.throwIfAborted()
			if (spec.command !== "git" || !spec.cwd || !same(spec.cwd, workspace))
				throw new Error("Native capture only runs fixed Git evidence operations")
			const args = [...spec.args]
			if (args[0] === "diff") args.splice(1, 0, "--no-textconv")
			return delegate.run({
				...spec,
				command: executable,
				args: [
					"--git-dir",
					gitDirectory,
					"--work-tree",
					workspace,
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.longpaths=true",
					"-c",
					"core.hooksPath=",
					"-c",
					`core.attributesFile=${noConfig}`,
					...args,
				],
				env,
				...(ports.signal ? { signal: ports.signal } : {}),
			})
		},
	}
}
async function git(workspace: string, runner: HarnessProcessRunner, args: string[]): Promise<string> {
	const result = await runner.run({
		command: "git",
		args,
		cwd: workspace,
		timeoutMs: 30_000,
		maxOutputBytes: 10 * 1024 * 1024,
	})
	if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
		throw new Error("Native capture Git evidence is incomplete")
	return result.stdout.trim()
}
async function establishBaseline(
	workspace: string,
	gitDirectory: string,
	runner: HarnessProcessRunner,
): Promise<string> {
	await fs.mkdir(gitDirectory, { mode: 0o700 })
	await git(workspace, runner, ["-c", "init.templateDir=", "init", "-q"])
	await git(workspace, runner, ["config", "core.autocrlf", "false"])
	await git(workspace, runner, ["add", "--force", "--all", "--", ".", ":(exclude)node_modules"])
	await git(workspace, runner, [
		"-c",
		"user.name=Alpha evaluation capture",
		"-c",
		"user.email=alpha-evaluation@localhost",
		"commit",
		"--no-gpg-sign",
		"-qm",
		"Native evaluation pre-agent fixture baseline",
	])
	try {
		const metadata = await fs.lstat(path.join(workspace, ".git"))
		if (metadata.isSymbolicLink() || !metadata.isDirectory())
			throw new Error("Native baseline requires an isolated Git directory")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		// The scenario may use Git, but post-agent evidence never trusts this model-writable copy.
		await fs.cp(gitDirectory, path.join(workspace, ".git"), { recursive: true, errorOnExist: true })
	}
	const gitWorkspace = await git(workspace, runner, ["rev-parse", "--show-toplevel"])
	await realDirectory(gitWorkspace)
	// Git expands Windows 8.3 aliases. Compare real directory identities without admitting symlink components.
	if (
		!same(await fs.realpath(gitWorkspace), await fs.realpath(workspace)) ||
		(await git(workspace, runner, ["status", "--porcelain", "--untracked-files=all"]))
	)
		throw new Error("Native capture requires a clean isolated pre-agent baseline")
	return git(workspace, runner, ["rev-parse", "HEAD"])
}
function verifySeal(value: { digest: string }): void {
	const { digest: actual, ...body } = value
	if (actual !== sha256(canonicalJson(body))) throw new Error("Native capture seal differs from its bytes")
}
async function readContext(file: string): Promise<NativeHostCaptureContext> {
	const context = contextSchema.parse(await readBoundedJson(file))
	verifySeal(context)
	if (
		context.runtimeManifest.id !== context.sourceTask.id ||
		context.runtimeManifest.version !== context.sourceTask.version ||
		context.runtimeManifest.fixtureDigest !== context.sourceTask.fixtureDigest ||
		context.runtimeManifest.workspaceCommit !== context.baselineCommit
	)
		throw new Error("Native context task identity is inconsistent")
	return context
}
async function verifyHostProofs(
	input: z.infer<typeof nativeHostFinalizeInputSchema>,
	context: NativeHostCaptureContext,
	ports: CapturePorts,
) {
	if (
		input.result.execution !== "extension-host" ||
		!input.result.hostExitObserved ||
		input.result.hostCleanupVerified !== true ||
		input.result.ownershipGate !== "verified" ||
		input.result.actualVSCodeVersion !== "1.138.0"
	)
		throw new Error("Native capture requires an exited, verified exact reference host")
	const files = [
		"improvement/host-outcome.json",
		"manifest.json",
		"host-preflight.json",
		"host-identity.json",
		"improvement/host-closure.json",
	]
	const proofs: unknown[] = []
	const digests: Record<string, string> = {}
	for (const file of files) {
		ports.signal?.throwIfAborted()
		const bytes = await readOwnedFile(input.runDirectory, file, MAX_SOURCE_BYTES)
		proofs.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
		digests[file] = sha256(bytes)
	}
	const outcome = z
		.object({
			schemaVersion: z.literal(1),
			kind: z.literal("alpha-native-host-outcome"),
			hostRunId: hostId,
			contextPath: absolutePath,
			expectedContextDigest: digest,
			finishedAt: date,
			result: hostResultSchema,
		})
		.strict()
		.parse(proofs[0])
	const manifest = z
		.object({
			kind: z.literal("alpha-vscode-e2e-run-evidence"),
			version: z.literal(1),
			runId: hostId,
			finalized: z.literal(true),
			bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
			metadata: z.object({
				scenarioId: z.literal("problem-solving-attempt"),
				hostVersion: z.literal("1.138.0"),
				requestedHostVersion: z.literal("1.138.0"),
				provider: z.string(),
				modelId: z.string().optional(),
				taskIds: z.array(taskId),
				startedAt: date,
				finishedAt: date,
				outcome: z.string(),
			}),
			artifacts: z
				.array(
					z.object({
						path: z.string(),
						bytes: z.number().int().nonnegative().max(MAX_SOURCE_BYTES),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
					}),
				)
				.max(2000),
		})
		.passthrough()
		.parse(proofs[1])
	const preflight = z
		.object({
			runId: hostId,
			actualVSCodeVersion: z.literal("1.138.0"),
			actualModelId: z.string().optional(),
			actualReasoningEffort: z.string().optional(),
			providerIdentity: z.unknown().optional(),
			status: z.enum(["passed", "failed", "blocked"]),
		})
		.passthrough()
		.parse(proofs[2])
	const host = z
		.object({
			runId: hostId,
			actualVSCodeVersion: z.literal("1.138.0"),
			ownershipGate: z.literal("verified"),
			pid: z.number().int().positive(),
			ppid: z.number().int().positive(),
		})
		.passthrough()
		.parse(proofs[3])
	const closure = closureSchema.parse(proofs[4])
	if (
		outcome.hostRunId !== context.hostRunId ||
		outcome.expectedContextDigest !== input.expectedContextDigest ||
		!same(outcome.contextPath, input.contextPath) ||
		outcome.finishedAt !== input.finishedAt ||
		canonicalJson(outcome.result) !== canonicalJson(input.result) ||
		manifest.runId !== context.hostRunId ||
		preflight.runId !== context.hostRunId ||
		host.runId !== context.hostRunId ||
		manifest.bundleSha256 !== context.build.bundleDigest.slice(7) ||
		manifest.metadata.startedAt !== context.startedAt ||
		manifest.metadata.provider !== input.result.providerMode ||
		manifest.metadata.outcome !== input.result.status ||
		preflight.actualModelId !== input.result.actualModelId ||
		preflight.actualReasoningEffort !== input.result.actualReasoningEffort ||
		canonicalJson(preflight.providerIdentity ?? null) !== canonicalJson(input.result.providerIdentity ?? null) ||
		(input.result.status === "passed" && preflight.status !== "passed") ||
		manifest.metadata.modelId !== input.result.actualModelId ||
		canonicalJson(closure) !== canonicalJson(input.result.hostCaptureClosure) ||
		!closure.cleanupVerified ||
		closure.matchingProcessIds.length !== 0 ||
		closure.failure !== undefined ||
		Date.parse(closure.observedAt) < Date.parse(context.startedAt) ||
		Date.parse(closure.observedAt) > Date.parse(input.finishedAt) ||
		!closure.ownedPids.includes(host.pid) ||
		(input.result.extensionHostPid !== undefined && input.result.extensionHostPid !== host.pid) ||
		(input.result.extensionHostParentPid !== undefined && input.result.extensionHostParentPid !== host.ppid)
	)
		throw new Error("Native host proof identities disagree")
	let total = 0
	const paths = new Set<string>()
	for (const artifact of manifest.artifacts) {
		if (paths.has(artifact.path)) throw new Error("Native host manifest repeats an artifact")
		paths.add(artifact.path)
		const bytes = await readOwnedFile(input.runDirectory, artifact.path, MAX_SOURCE_BYTES)
		total += bytes.length
		if (total > MAX_TOTAL_BYTES || bytes.length !== artifact.bytes || sha256(bytes).slice(7) !== artifact.sha256)
			throw new Error("Native host retained artifact differs from its manifest")
	}
	return { manifest, digests }
}
async function readSourceJson(
	file: string,
	label: string,
	sources: SourceState[],
	ports: CapturePorts,
	jsonl = false,
): Promise<unknown | undefined> {
	ports.signal?.throwIfAborted()
	try {
		const bytes = await readBoundedFile(file, MAX_SOURCE_BYTES)
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		const value: unknown = jsonl
			? text
					.split(/\r?\n/)
					.filter(Boolean)
					.map((line) => JSON.parse(line) as unknown)
			: JSON.parse(text)
		if (Array.isArray(value) && value.length > 50_000) throw new Error("Native source event bound exceeded")
		sources.push({ path: label, status: bytes.length ? "captured" : "captured-empty", digest: sha256(bytes) })
		return value
	} catch (error) {
		ports.signal?.throwIfAborted()
		sources.push({ path: label, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed" })
		return undefined
	}
}
function sourceStatus(sources: SourceState[], suffix: string): ArtifactCaptureStatus {
	return sources.find(({ path: source }) => source.endsWith(suffix))?.status ?? "missing"
}
function inspectNativeTrace(history: unknown, ui: unknown, lifecycle: unknown, turns: unknown, task: string) {
	const transactions = inspectToolTransactions(history)
	const lifecycleInspection = inspectTaskLifecycle(
		lifecycle,
		task,
		history === undefined ? {} : { apiHistory: history },
	)
	const errors = new Set<string>([...transactions.errors, ...lifecycleInspection.errors])
	if (!Array.isArray(history) || history.length === 0) errors.add("provider_history_empty")
	if (!Array.isArray(ui) || ui.length === 0) errors.add("ui_messages_empty")
	for (const [events, perTurn, prefix] of [
		[lifecycle, true, "lifecycle_journal"],
		[turns, false, "turn_journal"],
	] as const) {
		if (!Array.isArray(events) || events.length === 0) {
			errors.add(`${prefix}_empty`)
			continue
		}
		const sequences = new Map<string, number>()
		for (const value of events) {
			const event = record(value)
			const runId = event?.runId
			const turnId = event?.turnId
			if (
				!event ||
				event.taskId !== task ||
				typeof runId !== "string" ||
				!runId.trim() ||
				(perTurn && (typeof turnId !== "string" || !turnId.trim())) ||
				(!perTurn &&
					(typeof record(event.event)?.type !== "string" || !String(record(event.event)?.type).trim()))
			) {
				errors.add(`${prefix}_envelope_invalid`)
				continue
			}
			const partition = JSON.stringify(perTurn ? [runId, turnId] : [runId])
			const expected = (sequences.get(partition) ?? 0) + 1
			if (event.sequence !== expected) errors.add(`${prefix}_sequence_invalid`)
			sequences.set(partition, expected)
		}
	}
	return { errors: [...errors], transactions, lifecycle: lifecycleInspection }
}
function clean(value: unknown, ports: Pick<CapturePorts, "secrets">): string | object {
	const scrub = (item: unknown): unknown => {
		if (typeof item === "string")
			return item
				.replace(/\bBearer\s+[a-zA-Z0-9._~-]{12,}/g, "[REDACTED:alpha-redaction-v1]")
				.replace(/\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}/g, "[REDACTED:alpha-redaction-v1]")
		if (Array.isArray(item)) return item.map(scrub)
		const object = record(item)
		return object ? Object.fromEntries(Object.entries(object).map(([key, child]) => [key, scrub(child)])) : item
	}
	const result = scrub(redact(value, { secrets: ports.secrets }))
	if (typeof result !== "string" && (result === null || typeof result !== "object"))
		throw new Error("Native rich artifact must be text or structured observed content")
	return result
}
function boundedStore(delegate: ContentAddressedArtifactStore, ports: CapturePorts): ContentAddressedArtifactStore {
	let total = 0
	return {
		put: async (input) => {
			ports.signal?.throwIfAborted()
			total += input.bytes.length
			if (total > MAX_TOTAL_BYTES) throw new Error("Native capture CAS byte bound exceeded")
			return delegate.put({ ...input, access: "private" })
		},
		get: (descriptor) => {
			ports.signal?.throwIfAborted()
			return delegate.get(descriptor)
		},
	}
}
function observedFinalResponse(history: unknown): string | undefined {
	if (!Array.isArray(history)) return undefined
	const assistant = [...history].reverse().find((message) => record(message)?.role === "assistant")
	const content = record(assistant)?.content
	if (typeof content === "string") return content.trim() ? content : undefined
	if (!Array.isArray(content) || content.some((block) => record(block)?.type === "tool_use")) return undefined
	const text = content
		.flatMap((block) =>
			record(block)?.type === "text" && typeof record(block)?.text === "string"
				? [String(record(block)!.text)]
				: [],
		)
		.join("\n")
	return text.trim() ? text : undefined
}
function observedTestOutput(history: unknown, task: BenchmarkTaskManifest): unknown[] {
	if (!Array.isArray(history)) return []
	const calls = new Map<string, Record<string, unknown>>()
	const receipts: unknown[] = []
	const commands = task.validation.commands.map(({ command, args }) => [command, ...args].join(" "))
	for (const message of history) {
		const content = record(message)?.content
		if (!Array.isArray(content)) continue
		for (const value of content) {
			const block = record(value)
			if (
				block?.type === "tool_use" &&
				typeof block.id === "string" &&
				["exec_command", "execute_command"].includes(String(block.name))
			) {
				const input = record(block.input)
				const command = input?.cmd ?? input?.command
				if (typeof command === "string" && commands.some((expected) => command.trim() === expected))
					calls.set(block.id, { toolCallId: block.id, toolName: block.name, command })
			}
			if (
				block?.type === "tool_result" &&
				typeof block.tool_use_id === "string" &&
				calls.has(block.tool_use_id)
			) {
				receipts.push({ ...calls.get(block.tool_use_id), result: block })
				calls.delete(block.tool_use_id)
			}
		}
	}
	return receipts
}
async function logInventory(root: string, ports: CapturePorts): Promise<z.infer<typeof sourceFileSchema>[]> {
	try {
		await realDirectory(root)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	const output: z.infer<typeof sourceFileSchema>[] = []
	let total = 0
	let entriesSeen = 0
	const visit = async (directory: string): Promise<void> => {
		ports.signal?.throwIfAborted()
		if (path.relative(root, directory).split(path.sep).length > 32)
			throw new Error("Native log directory depth exceeded")
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (++entriesSeen > 5000) throw new Error("Native log entry bound exceeded")
			const file = path.join(directory, entry.name)
			const relative = path.relative(root, file).split(path.sep).join("/")
			if (entry.isSymbolicLink()) throw new Error("Native logs contain a symbolic link")
			if (entry.isDirectory()) await visit(file)
			else if (/(?:^|\/)(?:exthost\.log|[^/]*alpha[^/]*\.log)$/i.test(relative)) {
				const bytes = await readOwnedFile(root, relative, MAX_SOURCE_BYTES)
				total += bytes.length
				if (output.length >= 2000 || total > 32 * 1024 * 1024)
					throw new Error("Native logs exceed their capture bound")
				output.push({ path: relative, digest: sha256(bytes), sizeBytes: bytes.length })
			}
		}
	}
	await visit(root)
	return output
}
async function observedLogs(
	context: NativeHostCaptureContext,
	sources: SourceState[],
	ports: CapturePorts,
): Promise<unknown[]> {
	const root = path.join(context.userDataDir, "logs")
	const output: unknown[] = []
	try {
		for (const file of await logInventory(root, ports)) {
			if (context.logsBefore.some((prior) => prior.path === file.path && prior.digest === file.digest)) continue
			const bytes = await readOwnedFile(root, file.path, MAX_SOURCE_BYTES)
			if (sha256(bytes) !== file.digest) throw new Error("Native log changed during capture")
			const prior = context.logsBefore.find((item) => item.path === file.path)
			if (
				prior &&
				(bytes.length < prior.sizeBytes || sha256(bytes.subarray(0, prior.sizeBytes)) !== prior.digest)
			)
				throw new Error("Native log replaced or truncated a pre-agent source")
			const observed = prior ? bytes.subarray(prior.sizeBytes) : bytes
			output.push({
				path: file.path,
				sourceDigest: file.digest,
				sourceOffset: prior?.sizeBytes ?? 0,
				digest: sha256(observed),
				text: new TextDecoder("utf-8", { fatal: true }).decode(observed),
			})
			sources.push({
				path: `logs/${file.path}`,
				status: observed.length ? "captured" : "captured-empty",
				digest: sha256(observed),
			})
		}
	} catch {
		ports.signal?.throwIfAborted()
		sources.push({ path: "extension-logs", status: "failed" })
	}
	return output
}
async function publishResult(
	directory: string,
	body: Omit<NativeHostCaptureResult, "digest">,
): Promise<NativeHostCaptureResult> {
	const result = resultSchema.parse({ ...body, digest: sha256(canonicalJson(body)) })
	await writeOwnedJson(directory, "capture-result.json", result)
	return result
}
