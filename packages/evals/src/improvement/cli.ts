import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

import { parse as parseYaml } from "yaml"
import { z } from "zod"

import {
	benchmarkSuiteManifestSchema,
	benchmarkTaskManifestSchema,
	type BenchmarkTaskManifest,
} from "../benchmark/contracts"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { taskManifestSchema } from "../evidence/manifests"
import { validateEvidenceBundle } from "../evidence/integrity"
import type { EvidenceBundle } from "../evidence/types"
import { exportHostCampaign } from "../experiments/hostCampaign"
import { ExecaHarnessProcessRunner } from "../orchestration/processRunner"
import { feedbackInputSchema, feedbackReviewInputSchema, feedbackSchema, type Feedback } from "./contracts"
import {
	parseFeedback,
	parseFeedbackReview,
	sealFeedback,
	sealFeedbackReview,
	validateFeedback,
	validateFeedbackReview,
} from "./feedback"
import {
	buildHandoff,
	parseHandoff,
	sealHarnessContext,
	validateHarnessContext,
	harnessContextSchema,
	handoffCandidateSchema,
	regradeArchivedEvidence,
	validateArchivedGraderSpecs,
	parseArchivedRegradeReceipt,
	buildRegressionValidation,
	parseRegressionValidationReceipt,
	sealReviewedHandoffRepair,
	parseReviewedHandoffRepair,
	parseReviewedHandoffRepairRecord,
	materializeHandoff,
} from "./handoff"
import {
	modelReviewConfigurationSchema,
	modelReviewInputSchema,
	privateArtifactExportApprovalSchema,
	runModelReview,
} from "./modelReview"
import {
	createRegressionProposal,
	materializeRegressionProposal,
	parseRegressionProposal,
	regressionHostPolicySchema,
	verifyRegressionControls,
} from "./regressions"
import {
	evaluateConfirmation,
	parseConfirmationPlan,
	sealConfirmationPlan,
	parseConfirmationReceipt,
	runFreshConfirmation,
	type ConfirmationRunRequest,
} from "./confirmation"
import { createRegressionExecutionBoundary, regressionExecutionConfigurationSchema } from "./execution"
import { importHostEvidence, validateHostEvidenceObservation } from "./hostEvidence"
import {
	ImprovementArtifactStore,
	assertPrivateContent,
	readBoundedJson,
	readOwnedFile,
	stageReference,
	parseImprovementEvidenceBundle,
	ensureOwnedDirectory,
	type StoredStage,
} from "./store"

const commands = [
	"capture",
	"capture-host",
	"capture-native",
	"context",
	"feedback-human",
	"feedback-model",
	"adjudicate",
	"propose",
	"materialize",
	"regrade",
	"validate",
	"handoff",
	"review-repair",
	"confirmation-plan",
	"confirm-import",
	"confirm-run",
	"report",
	"show",
] as const
const valueFlags = [
	"--store",
	"--iteration",
	"--id",
	"--input",
	"--from",
	"--source-artifacts",
	"--catalog-root",
	"--task",
	"--runtime-manifest",
	"--configuration",
	"--source-root",
	"--feedback-record",
	"--approve-proposal-digest",
	"--approve-private-artifact-digests",
]
const switchFlags = ["--allow-network", "--allow-execution"]
export const improvementCliHelp = `benchmark:improve <${commands.join("|")}> --store <absolute-root> --iteration <id> --id <stage-id>
Stage commands consume --input <absolute-json> and --from <comma-separated-stage-ids>.
capture: --source-artifacts <CAS-root>; input is a sealed EvidenceBundle.
capture-host: --source-root <owned-campaign-run>; input {id,reportPath,attemptId}; retained observations remain ineligible for semantic feedback or generated regressions.
capture-native: --source-root <owned-run-directory>; input {captureResultPath}; imports only complete opt-in rich native captures and retains their verified task mapping.
context: --source-root <actual-source-root>; input {sourcePaths,identityReceipt} from an existing host campaign.
feedback-human: input is FeedbackInput. adjudicate: input is FeedbackReviewInput.
feedback-model: --configuration <json> --allow-network; input supplies rubric, current harness context, selected evidence.
Private selected artifacts additionally require --approve-private-artifact-digests <sha256:...,...> bound to that bundle, endpoint, and model; holdout remains ineligible.
propose / feedback-model: --catalog-root <public-evals> --task <id@version>; optional --runtime-manifest <json>.
materialize: input {ownedRoot,destinationName,policy}; --approve-proposal-digest <exact-digest>.
validate: input {policy,execution:{image,limits}}; --approve-proposal-digest <exact-digest> --allow-execution.
handoff: input {id,createdAt,context,candidates}; --source-root <actual-source-root>.
regrade: input {specs,ownedRoot,destinationName}; archived evidence only, no agent execution.
review-repair: input is a human-reviewed repair; --source-root checks actual source and emits its seal.
confirmation-plan: input is a plain predeclared confirmation plan; emits its seal.
confirm-import: input {plan,control?,candidate?}; imported results cannot establish a fresh-run keep decision.
confirm-run: input {plan,adapter}; --allow-execution (and --allow-network for live quality).
report: --from <confirmation-id>. show reads an existing stage without writing.
All stages are private, sealed, append-only records. No command applies source patches or promotes a baseline.`

export type ImprovementCliPorts = {
	signal?: AbortSignal
	now?: () => string
	modelReview?: typeof runModelReview
	runCampaign?: (request: ConfirmationRunRequest) => Promise<unknown>
}

class ImprovementCliBlocked extends Error {
	constructor(
		readonly reason: "current_context_artifacts_unavailable",
		readonly hint: string,
	) {
		super(hint)
	}
}

async function currentContextIdentity(root: string, signal?: AbortSignal) {
	signal?.throwIfAborted()
	try {
		const { sourceDigest } = await import("../../../../apps/vscode-e2e/src/campaign/evaluationIdentity")
		const { fingerprintArtifactPaths } = await import("../../../../apps/vscode-e2e/src/campaign/liveGate")
		const [revision, source, build, harness, taskSet] = await Promise.all([
			new ExecaHarnessProcessRunner().run({
				command: "git",
				args: ["rev-parse", "HEAD"],
				cwd: root,
				timeoutMs: 10000,
				maxOutputBytes: 1024,
				signal,
			}),
			sourceDigest(root, ["."]),
			fingerprintArtifactPaths(root, ["src/package.json", "src/dist", "src/webview-ui/build"]),
			fingerprintArtifactPaths(root, ["apps/vscode-e2e/out"]),
			sourceDigest(root, [
				"apps/vscode-e2e/src/scenarios",
				"apps/vscode-e2e/src/suite",
				"apps/vscode-e2e/src/campaign/scenarios.ts",
				"apps/vscode-e2e/src/campaign/developmentSuites.ts",
			]),
		])
		signal?.throwIfAborted()
		if (revision.exitCode !== 0 || revision.timedOut || !/^[a-f0-9]{40}$/.test(revision.stdout.trim()))
			throw new Error("Unavailable revision")
		return {
			sourceRevision: revision.stdout.trim(),
			workingTreeDigest: normalizedDigest(source),
			extensionBuildDigest: normalizedDigest(build),
			harnessDigest: normalizedDigest(harness),
			taskSetDigest: normalizedDigest(taskSet),
		}
	} catch (error) {
		if (signal?.aborted) throw error
		throw new ImprovementCliBlocked(
			"current_context_artifacts_unavailable",
			"Build the current extension, webview, and E2E runner with existing commands, then retry context against that owned checkout.",
		)
	}
}

function options(args: string[]) {
	const command = args[0]
	if (!commands.includes(command as (typeof commands)[number]))
		throw new Error("Unknown improvement command; use --help")
	const values = new Map<string, string>()
	const switches = new Set<string>()
	for (let index = 1; index < args.length; index++) {
		const flag = args[index]!
		if (switchFlags.includes(flag)) {
			if (switches.has(flag)) throw new Error("Duplicate improvement flag")
			switches.add(flag)
		} else if (valueFlags.includes(flag)) {
			const value = args[++index]
			if (!value || value.startsWith("--") || values.has(flag))
				throw new Error("Invalid or duplicate improvement option")
			values.set(flag, value)
		} else throw new Error("Unknown improvement option")
	}
	const required = (flag: string) => {
		const value = values.get(flag)
		if (!value) throw new Error(`Missing ${flag}`)
		return value
	}
	const from = (values.get("--from") ?? "").split(",").filter(Boolean)
	if (from.length > 64 || new Set(from).size !== from.length)
		throw new Error("Improvement inputs must be unique and bounded")
	return { command, values, switches, required, from }
}

function only(stages: StoredStage[], stage: StoredStage["manifest"]["stage"]): StoredStage {
	const matching = stages.filter(({ manifest }) => manifest.stage === stage)
	if (matching.length !== 1) throw new Error(`Exactly one ${stage} stage is required`)
	return matching[0]!
}
function bundleFrom(stage: StoredStage): EvidenceBundle {
	if (stage.manifest.stage !== "capture") throw new Error("A capture stage is required")
	return parseImprovementEvidenceBundle(stage.value)
}
function selectedFeedback(stage: StoredStage, id?: string): Feedback {
	if (feedbackSchema.safeParse(stage.value).success) return parseFeedback(stage.value)
	const review = z
		.object({
			recordType: z.literal("model-review"),
			admission: z.literal("requires-human-review"),
			feedback: z.array(feedbackSchema).min(1).max(8),
		})
		.passthrough()
		.parse(stage.value)
	const selected = review.feedback.filter((item) => item.id === id)
	if (selected.length !== 1) throw new Error("Model review requires --feedback-record selecting one observation")
	return parseFeedback(selected[0])
}

function confirmationSources(stages: StoredStage[], feedbackRecord?: string) {
	return {
		feedback: selectedFeedback(only(stages, "feedback"), feedbackRecord),
		feedbackReview: only(stages, "feedback-review").value,
		regression: parseRegressionProposal(only(stages, "regression-proposal").value),
		handoff: parseHandoff(
			z.object({ manifest: z.unknown() }).passthrough().parse(only(stages, "handoff").value).manifest,
		),
		reviewedRepair: parseReviewedHandoffRepairRecord(only(stages, "reviewed-repair").value),
	}
}

function normalizedDigest(value: unknown): string {
	return z
		.string()
		.regex(/^sha256:[a-f0-9]{64}$/)
		.parse(typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : value)
}

function capturedCampaignWindow(value: unknown): string {
	const provenance = z
		.object({
			decisionTimeWindow: z.string().min(1).max(128).optional(),
			attempts: z
				.array(
					z
						.object({
							request: z
								.object({ phase: z.string(), timeWindow: z.string().min(1).max(128).optional() })
								.passthrough(),
						})
						.passthrough(),
				)
				.max(1000),
		})
		.passthrough()
		.parse(value)
	const windows = new Set(
		provenance.attempts
			.map(({ request }) => request.timeWindow)
			.filter((window): window is string => window !== undefined),
	)
	if (provenance.decisionTimeWindow) windows.add(provenance.decisionTimeWindow)
	const samples = provenance.attempts.filter(({ request }) => request.phase === "sample")
	if (windows.size > 1 || (windows.size === 1 && samples.some(({ request }) => request.timeWindow === undefined)))
		throw new Error("Campaign context has conflicting or incomplete captured time windows")
	return [...windows][0] ?? "legacy-context-reference"
}

/** Resolve partition and source identity from the operator-selected catalog, never model-supplied provenance. */
async function catalogTask(root: string, identity: string): Promise<BenchmarkTaskManifest> {
	const index = z
		.object({ schemaVersion: z.literal(1).optional(), suites: z.array(z.string().min(1)).min(1).max(128) })
		.strict()
		.parse(parseYaml(new TextDecoder().decode(await readOwnedFile(root, "benchmark-suites.yaml", 1024 * 1024))))
	let selected: BenchmarkTaskManifest | undefined
	let readBytes = 0
	for (const relative of index.suites) {
		const bytes = await readOwnedFile(root, relative, 1024 * 1024)
		readBytes += bytes.length
		if (readBytes > 16 * 1024 * 1024) throw new Error("Selected benchmark catalog exceeds its byte budget")
		const suite = benchmarkSuiteManifestSchema.parse(parseYaml(new TextDecoder().decode(bytes)))
		for (const task of suite.tasks)
			if (`${task.id}@${task.version}` === identity) {
				if (selected) throw new Error("Source task identity is duplicated in the catalog")
				selected = task
			}
	}
	if (!selected || selected.partition === "holdout" || !selected.fixtureDigest)
		throw new Error("Source task must be a sealed public catalog task")
	return selected
}

export async function runImprovementCli(
	args: string[],
	ports: ImprovementCliPorts = {},
): Promise<StoredStage | { help: string }> {
	if (args.length === 0 || args.includes("--help")) return { help: improvementCliHelp }
	const opts = options(args)
	if (
		opts.values.has("--approve-private-artifact-digests") &&
		(opts.command !== "feedback-model" || !opts.switches.has("--allow-network"))
	)
		throw new Error("Private artifact export approval is valid only for feedback-model with --allow-network")
	ports.signal?.throwIfAborted()
	const store = await ImprovementArtifactStore.open({
		root: opts.required("--store"),
		iterationId: opts.required("--iteration"),
	})
	const id = opts.required("--id")
	if (opts.command === "show") return store.read(id)
	if (id.length > 80 || /^(?:feedback|review)_[a-f0-9]{64}$/.test(id))
		throw new Error("Output stage ID is too long or reserved for intrinsic identity binding")
	const stages = await Promise.all(opts.from.map((source) => store.read(source)))
	const input = opts.values.has("--input") ? await readBoundedJson(opts.required("--input")) : undefined
	assertPrivateContent(input)
	const references = stages.map(({ manifest }) => stageReference(manifest))
	const configuration = opts.values.has("--configuration")
		? await readBoundedJson(opts.required("--configuration"))
		: undefined
	const runtimeManifest = opts.values.has("--runtime-manifest")
		? await readBoundedJson(opts.required("--runtime-manifest"))
		: undefined
	const sourceTask = opts.values.has("--catalog-root")
		? await catalogTask(opts.required("--catalog-root"), opts.required("--task"))
		: undefined
	const requestDigest = sha256(
		canonicalJson({
			command: opts.command,
			input: input ?? null,
			configuration: configuration ?? null,
			runtimeManifest: runtimeManifest ?? null,
			sourceTask: sourceTask ?? null,
			options: [...opts.values],
			flags: [...opts.switches],
			references,
		}),
	)
	const reportValue = () => {
		const parsed = parseConfirmationReceipt(
			only(stages, "confirmation").value,
			confirmationSources(stages, opts.values.get("--feedback-record")),
		)
		return {
			schemaVersion: 1,
			recordType: "improvement-report",
			iterationId: store.iterationId,
			status: parsed.status,
			evidenceKind: parsed.evidenceKind,
			objective: parsed.plan.experiment.decisionPlan?.objective,
			margin: parsed.plan.experiment.decisionPlan?.margin,
			population: parsed.plan.experiment.decisionPlan?.population,
			liveQualityImprovement: parsed.liveQualityImprovement,
			reasons: parsed.reasons,
			confirmationDigest: parsed.digest,
			promotion: "not-performed",
			ancestry: references,
		}
	}
	try {
		const existing = await store.read(id)
		if (existing.manifest.requestDigest !== requestDigest)
			throw new Error("Improvement ID already binds another request")
		if (opts.command === "validate") {
			const receipt = parseRegressionValidationReceipt(existing.value)
			if (receipt.proposalDigest !== parseRegressionProposal(only(stages, "regression-proposal").value).digest)
				throw new Error("Resumed validation ancestry mismatch")
		} else if (opts.command === "capture" || opts.command === "capture-native") {
			const integrity = await validateEvidenceBundle(
				parseImprovementEvidenceBundle(existing.value),
				store.artifacts,
			)
			if (!integrity.valid) throw new Error("Resumed evidence capture is incomplete or corrupt")
		} else if (opts.command === "confirm-import" || opts.command === "confirm-run") {
			parseConfirmationReceipt(existing.value, confirmationSources(stages, opts.values.get("--feedback-record")))
		} else if (opts.command === "report") {
			if (existing.manifest.stage !== "report" || canonicalJson(existing.value) !== canonicalJson(reportValue()))
				throw new Error("Resumed report contradicts its confirmation evidence")
		} else if (opts.command === "context") {
			await validateHarnessContext(
				existing.value,
				(relative) => readOwnedFile(opts.required("--source-root"), relative, 2 * 1024 * 1024),
				{ signal: ports.signal },
			)
			const context = harnessContextSchema.parse(existing.value)
			const current = await currentContextIdentity(opts.required("--source-root"), ports.signal)
			if (
				context.sourceRevision !== current.sourceRevision ||
				(context.workingTreeDigest !== undefined && context.workingTreeDigest !== current.workingTreeDigest) ||
				context.extensionBuildDigest !== current.extensionBuildDigest ||
				context.harnessDigest !== current.harnessDigest ||
				context.taskSetDigest !== current.taskSetDigest
			)
				throw new Error("Resumed context build or harness is stale; use a new context stage")
		} else if (opts.command === "capture-host") {
			await validateHostEvidenceObservation(existing.value, store.artifacts, { signal: ports.signal })
		}
		return existing
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const write = (stage: StoredStage["manifest"]["stage"], value: unknown) => {
		ports.signal?.throwIfAborted()
		return store.write({ id, stage, inputs: references, requestDigest, value })
	}
	const bindIntrinsicIdentity = async (record: Feedback | ReturnType<typeof parseFeedbackReview>) => {
		const canonicalId = `${record.recordType === "feedback" ? "feedback" : "review"}_${sha256(record.id).slice(7)}`
		let canonical: StoredStage
		try {
			canonical = await store.read(canonicalId)
			if (canonicalJson(canonical.value) !== canonicalJson(record))
				throw new Error("Intrinsic feedback or review ID already binds different content")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			canonical = await store.write({
				id: canonicalId,
				stage: record.recordType === "feedback" ? "feedback" : "feedback-review",
				inputs: [...references],
				value: record,
			})
		}
		if (!references.some(({ id }) => id === canonicalId)) references.push(stageReference(canonical.manifest))
	}
	const claimExecution = async () => {
		const requestId = `${id}_request`
		try {
			await store.read(requestId)
			throw new Error("An unfinished execution request exists; inspect it and choose a fresh action ID")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const claimed = await store.write({
			id: requestId,
			stage: "execution-request",
			inputs: references,
			requestDigest,
			value: {
				command: opts.command,
				input,
				configuration: configuration ?? null,
				options: [...opts.values],
				flags: [...opts.switches],
				requestDigest,
			},
		})
		references.push(stageReference(claimed.manifest))
	}
	const evidence = () => {
		if (
			!stages.some(({ manifest }) => manifest.stage === "capture") &&
			stages.some(({ manifest }) => manifest.stage === "host-observation")
		)
			throw new Error(
				"Retained host observations lack a complete EvidenceBundle and cannot enter semantic feedback or regression generation",
			)
		return { bundle: bundleFrom(only(stages, "capture")), store: store.artifacts }
	}
	const feedback = () => selectedFeedback(only(stages, "feedback"), opts.values.get("--feedback-record"))
	const proposal = () => parseRegressionProposal(only(stages, "regression-proposal").value)
	const trustedSource = async () => {
		if (!sourceTask) throw new Error("A trusted public source catalog and task identity are required")
		let runtime = runtimeManifest ? taskManifestSchema.strict().parse(runtimeManifest) : undefined
		const nativeReferences = only(stages, "capture").manifest.inputs.filter(
			({ stage }) => stage === "native-source",
		)
		if (nativeReferences.length > 1) throw new Error("Native capture source mapping is ambiguous")
		if (nativeReferences[0]) {
			const native = z
				.object({
					sourceTask: benchmarkTaskManifestSchema,
					runtimeManifest: taskManifestSchema.strict(),
					capture: z.unknown(),
				})
				.strict()
				.parse((await store.read(nativeReferences[0])).value)
			if (
				canonicalJson(native.sourceTask) !== canonicalJson(sourceTask) ||
				(runtime && canonicalJson(runtime) !== canonicalJson(native.runtimeManifest))
			)
				throw new Error(
					"Native task mapping differs from the independently selected public catalog or runtime manifest",
				)
			runtime = native.runtimeManifest
		}
		return {
			sourceTask,
			...(runtime ? { sourceRuntimeManifest: runtime } : {}),
		}
	}
	if (opts.command === "capture") {
		if (stages.length) throw new Error("Capture is a source stage without prior inputs")
		return write("capture", await store.importEvidence(input, opts.required("--source-artifacts")))
	}
	if (opts.command === "capture-host") {
		if (stages.length) throw new Error("Host capture is a source observation without prior stages")
		const supplied = z
			.object({ id: z.string(), reportPath: z.string(), attemptId: z.string() })
			.strict()
			.parse(input)
		return write(
			"host-observation",
			await importHostEvidence(supplied, {
				readFile: (relative, maxBytes) => readOwnedFile(opts.required("--source-root"), relative, maxBytes),
				store: store.artifacts,
				signal: ports.signal,
			}),
		)
	}
	if (opts.command === "capture-native") {
		if (stages.length) throw new Error("Native capture is a source stage without prior inputs")
		const supplied = z.object({ captureResultPath: z.string() }).strict().parse(input)
		const { readNativeHostCapture } = await import("../evidence/nativeHostCapture")
		const sourceRoot = opts.required("--source-root")
		await readOwnedFile(sourceRoot, supplied.captureResultPath, 4 * 1024 * 1024)
		const native = await readNativeHostCapture({
			captureResultPath: path.join(sourceRoot, ...supplied.captureResultPath.split("/")),
			sourceRoot,
			signal: ports.signal,
		})
		const bundle = await store.importEvidence(native.bundle, native.artifactsRoot)
		const mapping = await store.write({
			id: `${id}_native-source`,
			stage: "native-source",
			requestDigest,
			value: { sourceTask: native.sourceTask, runtimeManifest: native.runtimeManifest, capture: native.capture },
		})
		references.push(stageReference(mapping.manifest))
		return write("capture", bundle)
	}
	if (opts.command === "context") {
		const supplied = z
			.object({ sourcePaths: z.array(z.string().min(1)).min(1).max(64), identityReceipt: z.unknown() })
			.strict()
			.parse(input)
		const root = opts.required("--source-root")
		// Reuse the existing producer's strict owned host identity and accounting validation.
		exportHostCampaign(supplied.identityReceipt, { timeWindow: capturedCampaignWindow(supplied.identityReceipt) })
		const receipt = z
			.object({
				evaluationIdentity: z.object({
					extensionCommit: z.string().regex(/^[a-f0-9]{40}$/),
					harnessDigest: z.string(),
					extensionBuildDigest: z.string(),
					taskSetDigest: z.string(),
				}),
				requestedProvider: z.object({
					mode: z.enum(["scripted", "live-copilot"]),
					modelId: z.string().optional(),
					effort: z.string().optional(),
				}),
			})
			.passthrough()
			.parse(supplied.identityReceipt)
		await claimExecution()
		const current = await currentContextIdentity(root, ports.signal)
		const sourceFiles = []
		for (const relative of supplied.sourcePaths)
			sourceFiles.push({ path: relative, digest: sha256(await readOwnedFile(root, relative, 2 * 1024 * 1024)) })
		const model =
			receipt.requestedProvider.mode === "scripted"
				? { id: "scripted", effort: "scripted" }
				: { id: receipt.requestedProvider.modelId, effort: receipt.requestedProvider.effort }
		if (canonicalJson(current) !== canonicalJson(await currentContextIdentity(root, ports.signal)))
			throw new Error("Current source or built artifacts changed while producing context")
		return write(
			"harness-context",
			await validateHarnessContext(
				sealHarnessContext({
					schemaVersion: 1,
					...current,
					sourceFiles,
					model,
				}),
				(relative) => readOwnedFile(root, relative, 2 * 1024 * 1024),
				{ signal: ports.signal },
			),
		)
	}
	if (opts.command === "feedback-human") {
		const annotation = feedbackInputSchema.parse(input)
		if (annotation.source.type !== "human") throw new Error("Human feedback requires a human source")
		const record = await sealFeedback(annotation, evidence())
		await bindIntrinsicIdentity(record)
		return write("feedback", record)
	}
	if (opts.command === "feedback-model") {
		if (!opts.switches.has("--allow-network")) throw new Error("Model review requires explicit --allow-network")
		const selected = modelReviewInputSchema.omit({ sourceTask: true, sourceRuntimeManifest: true }).parse(input)
		const configured = modelReviewConfigurationSchema.parse(configuration)
		const source = await trustedSource()
		const selectedEvidence = evidence()
		const privateArtifactExportApproval = opts.values.has("--approve-private-artifact-digests")
			? privateArtifactExportApprovalSchema.parse({
					bundleDigest: selectedEvidence.bundle.bundleDigest,
					artifactDigests: opts.required("--approve-private-artifact-digests").split(","),
					endpoint: configured.endpoint,
					model: configured.model,
				})
			: undefined
		await claimExecution()
		const result = await (ports.modelReview ?? runModelReview)({
			configuration: configured,
			input: { ...selected, ...source },
			evidence: selectedEvidence,
			...(privateArtifactExportApproval ? { privateArtifactExportApproval } : {}),
			signal: ports.signal,
		})
		for (const record of result.feedback) await bindIntrinsicIdentity(record)
		return write("feedback", result)
	}
	if (opts.command === "adjudicate") {
		const observed = await validateFeedback(feedback(), evidence())
		const record = sealFeedbackReview(feedbackReviewInputSchema.parse(input), observed)
		await bindIntrinsicIdentity(record)
		return write("feedback-review", record)
	}
	if (opts.command === "propose") {
		const supplied = z.object({ draft: z.unknown(), policy: regressionHostPolicySchema }).strict().parse(input)
		const observed = await validateFeedback(feedback(), evidence())
		const review = validateFeedbackReview(only(stages, "feedback-review").value, observed)
		return write(
			"regression-proposal",
			await createRegressionProposal({
				draft: supplied.draft,
				policy: regressionHostPolicySchema.parse(supplied.policy),
				...(await trustedSource()),
				feedback: observed,
				review,
				evidence: evidence(),
			}),
		)
	}
	if (opts.command === "materialize") {
		const supplied = z
			.object({
				ownedRoot: z.string().min(1),
				destinationName: z.string().min(1),
				policy: regressionHostPolicySchema,
			})
			.strict()
			.parse(input)
		if (proposal().digest !== opts.required("--approve-proposal-digest"))
			throw new Error("Proposal code approval digest mismatch")
		await claimExecution()
		return write(
			"materialization",
			await materializeRegressionProposal({
				...supplied,
				proposal: proposal(),
				selectedProposalDigest: opts.required("--approve-proposal-digest"),
				evidence: evidence(),
			}),
		)
	}
	if (opts.command === "validate") {
		if (!opts.switches.has("--allow-execution"))
			throw new Error("Generated control execution requires explicit --allow-execution")
		const supplied = z
			.object({ policy: regressionHostPolicySchema, execution: regressionExecutionConfigurationSchema })
			.strict()
			.parse(input)
		const selected = proposal()
		if (selected.digest !== opts.required("--approve-proposal-digest"))
			throw new Error("Proposal code approval digest mismatch")
		const materialized = z
			.object({
				root: z.string(),
				fixtureRoot: z.string(),
				taskManifestPath: z.string(),
				provenancePath: z.string(),
				task: benchmarkTaskManifestSchema,
				proposal: z.unknown().transform(parseRegressionProposal),
			})
			.strict()
			.parse(only(stages, "materialization").value)
		if (parseRegressionProposal(materialized.proposal).digest !== selected.digest)
			throw new Error("Materialization ancestry mismatch")
		const archived = parseArchivedRegradeReceipt(only(stages, "archived-regrade").value)
		if (archived.proposalDigest !== selected.digest || archived.bundleDigest !== selected.source.bundleDigest)
			throw new Error("Archived validation ancestry differs from its reviewed proposal")
		await claimExecution()
		const executionBoundary = await createRegressionExecutionBoundary({
			configuration: supplied.execution,
			ownedRoot: materialized.root,
			policyDigest: selected.policyDigest,
			signal: ports.signal,
		})
		let receipt
		try {
			receipt = await verifyRegressionControls({
				materialized,
				policy: supplied.policy,
				executionApproval: { proposalDigest: selected.digest, policyDigest: selected.policyDigest },
				executionBoundary,
				signal: ports.signal,
			})
		} finally {
			await executionBoundary.dispose()
		}
		return write("validation", buildRegressionValidation({ proposal: selected, controls: receipt, archived }))
	}
	if (opts.command === "regrade") {
		const supplied = z
			.object({ specs: z.array(z.unknown()).min(1).max(32), ownedRoot: z.string(), destinationName: z.string() })
			.strict()
			.parse(input)
		const context = harnessContextSchema.parse(only(stages, "harness-context").value)
		await claimExecution()
		const result = await regradeArchivedEvidence(
			{
				proposal: proposal(),
				bundle: evidence().bundle,
				context,
				specs: validateArchivedGraderSpecs(supplied.specs),
			},
			{
				store: store.artifacts,
				readSource: (relative) => readOwnedFile(opts.required("--source-root"), relative, 2 * 1024 * 1024),
				ownedRoot: supplied.ownedRoot,
				destinationName: supplied.destinationName,
				signal: ports.signal,
			},
		)
		return write("archived-regrade", result.receipt)
	}
	if (opts.command === "handoff") {
		const supplied = z
			.object({
				id: z.string(),
				createdAt: z.string(),
				context: harnessContextSchema.optional(),
				candidates: z.array(handoffCandidateSchema).min(1).max(100),
				output: z.object({ ownedRoot: z.string(), destinationName: z.string() }).strict().optional(),
			})
			.strict()
			.parse(input)
		const context = supplied.context ?? harnessContextSchema.parse(only(stages, "harness-context").value)
		const result = await buildHandoff(
			{
				...supplied,
				context,
				bundles: stages.filter(({ manifest }) => manifest.stage === "capture").map(bundleFrom),
				feedback: stages
					.filter(({ manifest }) => manifest.stage === "feedback")
					.flatMap((stage) => {
						if (feedbackSchema.safeParse(stage.value).success) return [parseFeedback(stage.value)]
						return z
							.object({ feedback: z.array(feedbackSchema).min(1).max(8) })
							.passthrough()
							.parse(stage.value)
							.feedback.map(parseFeedback)
					}),
				reviews: stages
					.filter(({ manifest }) => manifest.stage === "feedback-review")
					.map(({ value }) => parseFeedbackReview(value)),
				proposals: stages
					.filter(({ manifest }) => manifest.stage === "regression-proposal")
					.map(({ value }) => parseRegressionProposal(value)),
				validations: stages
					.filter(({ manifest }) => manifest.stage === "validation")
					.map(({ value }) => parseRegressionValidationReceipt(value)),
			},
			{
				store: store.artifacts,
				readSource: (relative) => readOwnedFile(opts.required("--source-root"), relative, 2 * 1024 * 1024),
				signal: ports.signal,
			},
		)
		const materialized = supplied.output
			? await materializeHandoff(result.manifest, { ...supplied.output, signal: ports.signal })
			: undefined
		return write("handoff", {
			manifest: result.manifest,
			markdown: result.markdown,
			...(materialized ? { output: materialized } : {}),
		})
	}
	if (opts.command === "review-repair") {
		const manifest = parseHandoff(
			z.object({ manifest: z.unknown() }).passthrough().parse(only(stages, "handoff").value).manifest,
		)
		const record = sealReviewedHandoffRepair(input)
		await parseReviewedHandoffRepair(record, {
			manifest,
			currentContext: harnessContextSchema.parse(only(stages, "harness-context").value),
			readSource: (relative) => readOwnedFile(opts.required("--source-root"), relative, 2 * 1024 * 1024),
			signal: ports.signal,
		})
		return write("reviewed-repair", record)
	}
	if (opts.command === "confirmation-plan") return write("confirmation-plan", sealConfirmationPlan(input))
	if (opts.command === "confirm-import" || opts.command === "confirm-run") {
		const supplied = z
			.object({
				plan: z.unknown().optional(),
				control: z.unknown().optional(),
				candidate: z.unknown().optional(),
				adapter: z.unknown().optional(),
			})
			.strict()
			.parse(input)
		const plan = parseConfirmationPlan(supplied.plan ?? only(stages, "confirmation-plan").value)
		const sources = {
			feedback: feedback(),
			feedbackReview: only(stages, "feedback-review").value,
			regression: proposal(),
			handoff: parseHandoff(
				z.object({ manifest: z.unknown() }).passthrough().parse(only(stages, "handoff").value).manifest,
			),
			reviewedRepair: parseReviewedHandoffRepairRecord(only(stages, "reviewed-repair").value),
		}
		if (opts.command === "confirm-import")
			return write(
				"confirmation",
				evaluateConfirmation(plan, sources, { control: supplied.control, candidate: supplied.candidate }),
			)
		if (
			!opts.switches.has("--allow-execution") ||
			(plan.mode === "live-quality" && !opts.switches.has("--allow-network"))
		)
			throw new Error(
				"Fresh runner requires --allow-execution and live quality additionally requires --allow-network",
			)
		const adapter = hostAdapterSchema.parse(supplied.adapter)
		await claimExecution()
		const result = await runFreshConfirmation(plan, sources, {
			runCampaign: ports.runCampaign ?? ((request) => runExistingHostCampaign(request, adapter)),
			readSource: (arm, relative) => readOwnedFile(adapter[arm].repositoryRoot, relative, 2 * 1024 * 1024),
			evidence: evidence(),
			now: ports.now,
			signal: ports.signal,
		})
		return write("confirmation", result)
	}
	if (opts.command === "report") return write("report", reportValue())
	throw new Error("Unsupported improvement stage")
}

export function improvementCliExitCode(result: StoredStage | { help: string }): number {
	if (!("manifest" in result)) return 0
	if (result.manifest.stage === "validation") {
		const { status } = parseRegressionValidationReceipt(result.value)
		return status === "passed" ? 0 : status === "failed" ? 1 : 2
	}
	if (result.manifest.stage === "confirmation") {
		const { status } = z
			.object({ status: z.enum(["keep", "revise", "revert", "inconclusive"]) })
			.passthrough()
			.parse(result.value)
		return status === "keep" ? 0 : status === "inconclusive" ? 2 : 1
	}
	return 0
}

const armAdapterSchema = z
	.object({
		repositoryRoot: z.string().min(1),
		campaignRoot: z.string().min(1),
		profileRoot: z.string().min(1),
		config: z.unknown(),
	})
	.strict()
const hostAdapterSchema = z.object({ control: armAdapterSchema, candidate: armAdapterSchema }).strict()

/** Fixed existing runner entrypoint; no model-supplied executable, shell command, patch, or environment is accepted. */
export async function runExistingHostCampaign(
	request: ConfirmationRunRequest,
	adapters: z.infer<typeof hostAdapterSchema>,
): Promise<unknown> {
	const adapter = adapters[request.arm]
	const { parseCampaignConfig } = await import("../../../../apps/vscode-e2e/src/campaign/config")
	const base = parseCampaignConfig(adapter.config)
	if (base.repair) throw new Error("Fresh confirmation does not apply source patches")
	const scenarios = [
		...new Set(
			request.taskIds.map((taskId) => {
				const matched = /^(.+):vscode-(1\.(?:125|138)\.0)$/.exec(taskId)
				if (!matched)
					throw new Error("Fresh host confirmation requires registered exact-host scenario task IDs")
				return matched[1]!
			}),
		),
	]
	if (
		canonicalJson([...base.scenarioIds].sort()) !== canonicalJson([...scenarios].sort()) ||
		canonicalJson(base.hosts.map(({ version }) => version).sort()) !==
			canonicalJson([...request.hostVersions].sort()) ||
		base.budgets.maxRequests > request.limits.maxRequestsPerArm ||
		base.budgets.maxDurationMs > request.limits.maxDurationMsPerArm
	)
		throw new Error("Fresh host configuration differs from declared scenarios or exceeds its budget")
	const config = parseCampaignConfig({
		...base,
		id: request.runId,
		provider: request.provider,
		collectionMode: "sample-only",
		decisionPlanDigest: request.decisionPlanDigest,
		decisionTimeWindow: request.timeWindow,
	})
	await readOwnedFile(adapter.repositoryRoot, "apps/vscode-e2e/out/runTest.js", 2 * 1024 * 1024)
	const { openCampaignRoot, createReportStore } = await import("../../../../apps/vscode-e2e/src/campaign/reportStore")
	const { runCampaign } = await import("../../../../apps/vscode-e2e/src/campaign/controller")
	const { createExtensionCampaignOperations } = await import(
		"../../../../apps/vscode-e2e/src/campaign/extensionAdapter"
	)
	const { captureCampaignEvaluationIdentity, finishCampaignEvaluationIdentity } = await import(
		"../../../../apps/vscode-e2e/src/campaign/evaluationIdentity"
	)
	const { prepareLiveSidecar } = await import("../../../../apps/vscode-e2e/src/liveHostProtocol")
	const ownedCampaignRoot = await openCampaignRoot(adapter.campaignRoot, false)
	await ensureOwnedDirectory(path.join(adapter.repositoryRoot, "artifacts", "harness"))
	await readOwnedFile(adapter.repositoryRoot, "scripts/harness/lease.mjs", 65536)
	const leaseModule = z
		.object({
			acquireBuildLease: z
				.function()
				.args(z.string(), z.string())
				.returns(z.promise(z.function().args().returns(z.promise(z.void())))),
		})
		.passthrough()
		.parse(createRequire(import.meta.url)(path.join(adapter.repositoryRoot, "scripts", "harness", "lease.mjs")))
	const release = await leaseModule.acquireBuildLease(adapter.repositoryRoot, `improvement-${request.runId}`)
	let dispatched = false
	let closed = false
	try {
		const reports = await createReportStore(ownedCampaignRoot, config.id)
		const operations = createExtensionCampaignOperations({
			config,
			campaignRoot: ownedCampaignRoot,
			runDirectory: reports.directory,
			profileRoot: adapter.profileRoot,
			repositoryRoot: adapter.repositoryRoot,
			persistReport: reports.persistReport,
		})
		if (config.provider.mode === "live-copilot") await prepareLiveSidecar()
		const before = await captureCampaignEvaluationIdentity(adapter.repositoryRoot, config)
		if (
			before.missing.length ||
			before.extensionCommit !== request.context.sourceRevision ||
			normalizedDigest(before.extensionBuildDigest) !== request.context.extensionBuildDigest ||
			normalizedDigest(before.harnessDigest) !== request.context.harnessDigest ||
			normalizedDigest(before.taskSetDigest) !== request.context.taskSetDigest ||
			normalizedDigest(before.workingTreeDigest) !== request.expectedVariant.workingTreeDigest ||
			normalizedDigest(before.sourceComponentsDigest) !== request.expectedVariant.promptDigest ||
			normalizedDigest(before.configDigest) !== request.expectedVariant.resourceProfileDigest
		)
			throw new Error(
				"Current host build, source, workload, or policy differs from the declared confirmation arm",
			)
		request.signal.throwIfAborted()
		dispatched = true
		// The existing controller awaits each owned operation's bounded cleanup after cancellation.
		const report = await runCampaign(config, operations, request.signal)
		report.evaluationIdentity = finishCampaignEvaluationIdentity(
			before,
			await captureCampaignEvaluationIdentity(adapter.repositoryRoot, config),
		)
		report.evaluationPlan = {
			scenarioIds: config.scenarioIds,
			hostVersions: config.hosts.map(({ version }) => version),
			samples: config.samples,
		}
		await reports.persistReport(report)
		const exported = exportHostCampaign(report, { timeWindow: request.timeWindow })
		closed = report.stopReason === "completed" && report.retention?.status === "complete"
		return exported
	} finally {
		// Unknown shutdown retains the existing shared lease for inspection and blocks another host arm.
		if (!dispatched || closed) await release()
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const abort = new AbortController()
	const cancel = () => abort.abort()
	process.once("SIGINT", cancel)
	process.once("SIGTERM", cancel)
	runImprovementCli(process.argv.slice(2), { signal: abort.signal })
		.then((result) => {
			process.stdout.write(JSON.stringify(result, null, 2) + "\n")
			process.exitCode = process.argv[2] === "show" ? 0 : improvementCliExitCode(result)
		})
		.catch((error: unknown) => {
			process.stderr.write(
				JSON.stringify(
					error instanceof ImprovementCliBlocked
						? { status: "blocked", reason: error.reason, hint: error.hint }
						: { status: "blocked", reason: "improvement_input_validation_or_stage_failed" },
				) + "\n",
			)
			process.exitCode = 1
		})
		.finally(() => {
			process.removeListener("SIGINT", cancel)
			process.removeListener("SIGTERM", cancel)
		})
}
