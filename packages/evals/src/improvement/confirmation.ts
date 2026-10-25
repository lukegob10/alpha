import { z } from "zod"

import { canonicalJson, sha256 } from "../evidence/canonical"
import {
	campaignExportSchema,
	parseCampaignExport,
	reportCampaignPair,
	type CampaignExport,
} from "../experiments/campaign"
import { exportHostCampaign } from "../experiments/hostCampaign"
import { immutableIdentity } from "../experiments/identity"
import { pairTrials } from "../experiments/pairing"
import { evaluatePromotion, POLICIES } from "../experiments/policy"
import { isScoreableObservationStatus } from "../experiments/statistics"
import {
	experimentManifestSchema,
	experimentVariantSchema,
	performanceMetricNames,
	taskSetManifestSchema,
	type ObservationStatus,
} from "../experiments/types"
import { diffVariants, validateDeclaredVariantDiff, validateTemplateDiff } from "../experiments/variantDiff"
import { improvementDigestSchema as digest, improvementIdSchema as id } from "./contracts"
import {
	assertBoundedJson,
	parseFeedback,
	validateFeedback,
	validateFeedbackReview,
	type FeedbackEvidenceContext,
} from "./feedback"
import { harnessContextSchema, parseHandoff, parseReviewedHandoffRepairRecord, validateHarnessContext } from "./handoff"
import { parseRegressionProposal } from "./regressions"
import { assertPrivateContent } from "./store"

const MAX_CONFIRMATION_JSON_BYTES = 8 * 1024 * 1024
const CURRENT_DECISION_POLICY = "scoreable-status-v1" as const

const providerSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("scripted") }).strict(),
	z.object({ mode: z.literal("live-copilot"), modelId: id, effort: id }).strict(),
])
const armSchema = z
	.object({
		runId: id,
		context: harnessContextSchema,
		variant: experimentVariantSchema.strict(),
		provider: providerSchema,
	})
	.strict()
const planBodySchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("confirmation-plan"),
		id,
		declaredAt: z.string().datetime(),
		mode: z.enum(["archived-regrade", "scripted-host-regression", "live-quality"]),
		sources: z
			.object({
				feedbackDigest: digest,
				feedbackReviewDigest: digest,
				regressionProposalDigest: digest,
				handoffDigest: digest,
				reviewedRepairDigest: digest,
				archivedCampaignDigests: z.array(digest).max(32),
			})
			.strict(),
		taskSet: taskSetManifestSchema.strict(),
		experiment: experimentManifestSchema.strict(),
		hostVersions: z
			.array(z.enum(["1.125.0", "1.138.0"]))
			.min(1)
			.max(2),
		control: armSchema,
		candidate: armSchema,
		requirements: z
			.object({
				targeted: z
					.array(z.object({ regressionId: id, taskId: id }).strict())
					.min(1)
					.max(20),
				neighbors: z.array(id).min(1).max(100),
			})
			.strict(),
		limits: z
			.object({
				maxRequestsPerArm: z.number().int().positive().max(100_000),
				maxDurationMsPerArm: z.number().int().positive().max(43_200_000),
			})
			.strict(),
		promotionPolicy: z.enum(["pr-v1", "nightly-v1", "release-candidate-v1"]),
	})
	.strict()

export const confirmationPlanSchema = planBodySchema.extend({ digest }).strict()
export type ConfirmationPlan = z.infer<typeof confirmationPlanSchema>
export type ConfirmationArm = "control" | "candidate"
export type ConfirmationSources = {
	feedback: unknown
	feedbackReview: unknown
	regression: unknown
	handoff: unknown
	reviewedRepair: unknown
}
type ParsedSources = ReturnType<typeof parseSources>
type PairedReport = ReturnType<typeof reportCampaignPair>
type ExecutionEntry = {
	arm: ConfirmationArm
	runId: string
	startedAt: string
	finishedAt: string
	status: "returned" | "failed" | "cancelled" | "timed-out"
	campaignDigest?: string
}
export type ConfirmationReceipt = {
	schemaVersion: 1
	recordType: "confirmation-receipt"
	decisionPolicy?: typeof CURRENT_DECISION_POLICY
	plan: ConfirmationPlan
	planDigest: string
	sourceDigests: ConfirmationPlan["sources"]
	origin: "imported" | "fresh-runner"
	evidenceKind: "archived-output-review" | "scripted-host-regression-validation" | "live-quality-comparison"
	status: "keep" | "revise" | "revert" | "inconclusive"
	reasons: string[]
	liveQualityImprovement: boolean
	campaigns: { control: CampaignExport | null; candidate: CampaignExport | null }
	pairedReport: PairedReport | null
	promotion: ReturnType<typeof evaluatePromotion> | null
	execution: ExecutionEntry[]
	digest: string
}
export type ConfirmationRunRequest = {
	arm: ConfirmationArm
	runId: string
	taskIds: string[]
	expectedVariant: ConfirmationPlan["control"]["variant"]
	context: ConfirmationPlan["control"]["context"]
	provider: ConfirmationPlan["control"]["provider"]
	experiment: ConfirmationPlan["experiment"]
	decisionPlanDigest: string
	timeWindow: string
	hostVersions: ConfirmationPlan["hostVersions"]
	limits: ConfirmationPlan["limits"]
	signal: AbortSignal
}
export type ConfirmationRunnerPorts = {
	/** Return its sealed JSON export; honor signal and settle only after owned process cleanup. */
	runCampaign: (request: ConfirmationRunRequest) => Promise<unknown>
	readSource: (arm: ConfirmationArm, relativePath: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>
	evidence: FeedbackEvidenceContext
	now?: () => string
	signal?: AbortSignal
}

const executionEntrySchema = z
	.object({
		arm: z.enum(["control", "candidate"]),
		runId: id,
		startedAt: z.string().datetime(),
		finishedAt: z.string().datetime(),
		status: z.enum(["returned", "failed", "cancelled", "timed-out"]),
		campaignDigest: digest.optional(),
	})
	.strict()
const receiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("confirmation-receipt"),
		decisionPolicy: z.literal(CURRENT_DECISION_POLICY).optional(),
		plan: confirmationPlanSchema,
		planDigest: digest,
		sourceDigests: planBodySchema.shape.sources,
		origin: z.enum(["imported", "fresh-runner"]),
		evidenceKind: z.enum([
			"archived-output-review",
			"scripted-host-regression-validation",
			"live-quality-comparison",
		]),
		status: z.enum(["keep", "revise", "revert", "inconclusive"]),
		reasons: z.array(z.string().min(1).max(2_000)).max(100),
		liveQualityImprovement: z.boolean(),
		campaigns: z
			.object({ control: campaignExportSchema.nullable(), candidate: campaignExportSchema.nullable() })
			.strict(),
		pairedReport: z.unknown().nullable(),
		promotion: z
			.object({ allowed: z.boolean(), reasons: z.array(z.string()) })
			.strict()
			.nullable(),
		execution: z.array(executionEntrySchema).max(2),
		digest,
	})
	.strict()

/** Verify content and recompute the decision; a saved JSON seal is not a remote runner attestation. */
export function parseConfirmationReceipt(value: unknown, values: ConfirmationSources): ConfirmationReceipt {
	assertBoundedJson(value, MAX_CONFIRMATION_JSON_BYTES)
	const receipt = receiptSchema.parse(value)
	assertPrivateContent(receipt)
	assertSeal(receipt)
	const plan = parseConfirmationPlan(receipt.plan)
	const sources = parseSources(plan, values)
	if (receipt.origin === "imported" && receipt.execution.length)
		throw new Error("Imported confirmation cannot contain a fresh execution ledger")
	const expected = evaluate(
		plan,
		sources,
		receipt.campaigns,
		receipt.origin,
		receipt.execution,
		receipt.decisionPolicy ?? "legacy-conservative-v1",
	)
	if (canonicalJson(receipt) !== canonicalJson(expected))
		throw new Error("Confirmation receipt differs from recomputed evidence")
	return expected
}

export function sealConfirmationPlan(value: unknown): ConfirmationPlan {
	assertBoundedJson(value, MAX_CONFIRMATION_JSON_BYTES)
	const body = planBodySchema.parse(value)
	return parseConfirmationPlan({ ...body, digest: sha256(canonicalJson(body)) })
}

export function parseConfirmationPlan(value: unknown): ConfirmationPlan {
	assertBoundedJson(value, MAX_CONFIRMATION_JSON_BYTES)
	const plan = confirmationPlanSchema.parse(value)
	assertPrivateContent(plan)
	assertSeal(plan)
	const decision = plan.experiment.decisionPlan
	if (!decision || plan.experiment.template !== "harness_only")
		throw new Error("Source repair confirmation requires a predeclared harness_only experiment decision plan")
	if (
		plan.experiment.taskSetIdentity !== immutableIdentity(plan.taskSet) ||
		decision.taskSetIdentity !== immutableIdentity(plan.taskSet) ||
		decision.controlRunId !== plan.control.runId ||
		decision.candidateRunId !== plan.candidate.runId ||
		plan.control.runId === plan.candidate.runId ||
		Date.parse(decision.declaredAt) > Date.parse(plan.declaredAt)
	)
		throw new Error("Confirmation sampling frame, run identity or declaration chronology differs")
	if (decision.timeBlocks.length !== 1 || decision.plannedPairs !== plan.experiment.pairs.length)
		throw new Error("Current host confirmation requires one complete predeclared campaign time block")
	if (
		decision.plannedPairs > plan.limits.maxRequestsPerArm ||
		new Set(plan.hostVersions).size !== plan.hostVersions.length ||
		!plan.hostVersions.includes("1.138.0") ||
		(plan.mode === "live-quality" && plan.hostVersions.length !== 1)
	)
		throw new Error("Confirmation host or request limits do not cover the declared workload")
	const taskIds = plan.taskSet.tasks.map(({ id }) => id)
	const targetIds = plan.requirements.targeted.map(({ taskId }) => taskId)
	for (const values of [taskIds, targetIds, plan.requirements.neighbors, plan.sources.archivedCampaignDigests])
		if (new Set(values).size !== values.length) throw new Error("Confirmation contains duplicate identities")
	if (
		[...targetIds, ...plan.requirements.neighbors].some((taskId) => !taskIds.includes(taskId)) ||
		targetIds.some((taskId) => plan.requirements.neighbors.includes(taskId)) ||
		taskIds.some((taskId) => !plan.experiment.pairs.some((pair) => pair.taskId === taskId)) ||
		plan.experiment.pairs.some((pair) => !taskIds.includes(pair.taskId))
	)
		throw new Error("Targeted, neighboring and declared campaign cases do not match the task set")
	for (const arm of ["control", "candidate"] as const) validateArmDeclaration(plan, arm)
	if (
		plan.experiment.controlVariantIdentity !== immutableIdentity(plan.control.variant) ||
		plan.experiment.candidateVariantIdentity !== immutableIdentity(plan.candidate.variant) ||
		canonicalJson(plan.control.provider) !== canonicalJson(plan.candidate.provider) ||
		canonicalJson(plan.control.context.model) !== canonicalJson(plan.candidate.context.model)
	)
		throw new Error("Confirmation variants, model or effort differ from the declared harness comparison")
	const differences = diffVariants(plan.control.variant, plan.candidate.variant)
	validateTemplateDiff(plan.experiment.template, differences)
	if (!plan.experiment.allowedDifferenceFields?.length) throw new Error("Confirmation treatment must be explicit")
	validateDeclaredVariantDiff(differences, plan.experiment.allowedDifferenceFields)
	if (plan.mode !== "archived-regrade") {
		if (
			plan.control.context.extensionBuildDigest === plan.candidate.context.extensionBuildDigest ||
			plan.control.variant.workingTreeDigest === plan.candidate.variant.workingTreeDigest
		)
			throw new Error("Fresh confirmation requires a changed candidate build")
		const before = new Map(plan.control.context.sourceFiles.map(({ path, digest }) => [path, digest]))
		if (
			before.size !== plan.candidate.context.sourceFiles.length ||
			plan.candidate.context.sourceFiles.some(({ path }) => !before.has(path)) ||
			!plan.candidate.context.sourceFiles.some(({ path, digest }) => before.get(path) !== digest)
		)
			throw new Error("Fresh confirmation requires the same bounded source frame and an actual source change")
	}
	return freeze(plan)
}

function validateArmDeclaration(plan: ConfirmationPlan, arm: ConfirmationArm): void {
	const { context, variant, provider } = plan[arm]
	assertSeal(context)
	if (new Set(context.sourceFiles.map(({ path }) => path.toLowerCase())).size !== context.sourceFiles.length)
		throw new Error("Confirmation source paths are duplicated")
	const expectedMode = plan.mode === "live-quality" ? "live-copilot" : "scripted"
	if (plan.mode !== "archived-regrade" && provider.mode !== expectedMode)
		throw new Error("Confirmation evidence mode differs from its provider")
	if (
		variant.extensionCommit !== context.sourceRevision ||
		variant.extensionBuildDigest !== context.extensionBuildDigest ||
		("workingTreeDigest" in context && variant.workingTreeDigest !== context.workingTreeDigest) ||
		variant.model !== context.model.id ||
		(provider.mode === "scripted"
			? context.model.id !== "scripted" || context.model.effort !== "scripted"
			: provider.modelId !== context.model.id || provider.effort !== context.model.effort) ||
		variant.modelSettingsDigest !== sha256(canonicalJson(provider)) ||
		variant.runnerImageDigest !==
			sha256(canonicalJson({ harnessDigest: context.harnessDigest, hosts: [...plan.hostVersions].sort() }))
	)
		throw new Error(`${arm} source, build, harness, model or effort identity differs`)
	if (
		plan.taskSet.id !== "host-scenarios" ||
		plan.taskSet.version !== 1 ||
		plan.taskSet.tasks.some(
			({ id, version, digest }) =>
				version !== 1 || digest !== sha256(canonicalJson({ id, taskSetDigest: context.taskSetDigest })),
		)
	)
		throw new Error(`${arm} task set differs from the current host producer identity`)
}

function parseSources(plan: ConfirmationPlan, values: ConfirmationSources) {
	const feedback = parseFeedback(values.feedback)
	const feedbackReview = validateFeedbackReview(values.feedbackReview, feedback)
	const regression = parseRegressionProposal(values.regression)
	const handoff = parseHandoff(values.handoff)
	const repair = parseReviewedHandoffRepairRecord(values.reviewedRepair)
	const archival = handoff.context
	const baseline = plan.control.context
	if (
		feedbackReview.decision !== "accepted" ||
		feedback.digest !== plan.sources.feedbackDigest ||
		feedbackReview.digest !== plan.sources.feedbackReviewDigest ||
		regression.digest !== plan.sources.regressionProposalDigest ||
		handoff.digest !== plan.sources.handoffDigest ||
		repair.digest !== plan.sources.reviewedRepairDigest ||
		regression.feedback.digest !== feedback.digest ||
		regression.review.digest !== feedbackReview.digest ||
		regression.source.bundleDigest !== feedback.evidence.bundleDigest ||
		archival.sourceRevision !== baseline.sourceRevision ||
		archival.extensionBuildDigest !== baseline.extensionBuildDigest ||
		canonicalJson(archival.sourceFiles) !== canonicalJson(baseline.sourceFiles) ||
		canonicalJson(archival.model) !== canonicalJson(baseline.model) ||
		plan.control.context.harnessDigest !== plan.candidate.context.harnessDigest ||
		plan.control.context.taskSetDigest !== plan.candidate.context.taskSetDigest ||
		!handoff.evidenceBundleDigests.includes(feedback.evidence.bundleDigest) ||
		[feedback.createdAt, feedbackReview.createdAt, handoff.createdAt].some(
			(timestamp) => Date.parse(timestamp) > Date.parse(plan.declaredAt),
		) ||
		[plan.control.runId, plan.candidate.runId].includes(feedback.evidence.runId)
	)
		throw new Error("Confirmation ancestry, accepted review or source chronology differs")
	const items = handoff.items.filter(
		(item) =>
			item.feedbackDigest === feedback.digest &&
			item.reviewDigest === feedbackReview.digest &&
			item.regressionProposalDigest === regression.digest,
	)
	if (
		items.length !== 1 ||
		items[0]!.validation.some(({ status }) => status !== "passed") ||
		repair.handoffDigest !== handoff.digest ||
		repair.itemDigest !== items[0]!.digest ||
		repair.contextDigest !== archival.digest ||
		repair.regressionScenarioId !== regression.draft.id ||
		plan.requirements.targeted.some(
			({ regressionId, taskId }) =>
				regressionId !== regression.draft.id ||
				!items[0]!.regressionIds.includes(regressionId) ||
				!plan.hostVersions.some((host) => taskId === `${repair.regressionScenarioId}:vscode-${host}`),
		)
	)
		throw new Error("Targeted regression mapping differs from the reviewed handoff")
	const expectedTargets = plan.hostVersions.map((host) => `${repair.regressionScenarioId}:vscode-${host}`).sort()
	const expectedNeighbors = repair.neighborScenarioIds
		.flatMap((scenario) => plan.hostVersions.map((host) => `${scenario}:vscode-${host}`))
		.sort()
	if (
		canonicalJson(plan.requirements.targeted.map(({ taskId }) => taskId).sort()) !==
			canonicalJson(expectedTargets) ||
		canonicalJson([...plan.requirements.neighbors].sort()) !== canonicalJson(expectedNeighbors)
	)
		throw new Error("Confirmation target and neighboring cases differ from the supplied reviewed repair")
	const allowed = new Set(items[0]!.allowedChangePaths)
	const before = new Map(plan.control.context.sourceFiles.map(({ path, digest }) => [path, digest]))
	const after = new Map(plan.candidate.context.sourceFiles.map(({ path, digest }) => [path, digest]))
	const edits = new Map(repair.patch.edits.map((edit) => [edit.path, edit]))
	if (
		edits.size !== repair.patch.edits.length ||
		repair.patch.edits.some(
			(edit) =>
				!allowed.has(edit.path) ||
				before.get(edit.path) !== `sha256:${edit.expectedSha256}` ||
				after.get(edit.path) !== sha256(Buffer.from(edit.replacement)),
		) ||
		plan.candidate.context.sourceFiles.some(({ path, digest }) => before.get(path) !== digest && !edits.has(path))
	)
		throw new Error("Candidate source change differs from the supplied reviewed patch")
	return { feedback, feedbackReview, regression, handoff, repair }
}

/** Import remains descriptive even when every imported campaign says it passed. */
export function evaluateConfirmation(
	planValue: unknown,
	values: ConfirmationSources,
	campaigns: { control?: unknown; candidate?: unknown },
): ConfirmationReceipt {
	const plan = parseConfirmationPlan(planValue)
	const sources = parseSources(plan, values)
	return evaluate(plan, sources, campaigns, "imported", [])
}

/** Reuses the host producer adapter; the supplied port owns the existing runner and its process cancellation. */
export function createHostCampaignConfirmationRunner(
	runHostCampaign: (request: ConfirmationRunRequest) => Promise<unknown>,
): ConfirmationRunnerPorts["runCampaign"] {
	return async (request) => {
		const campaign = exportHostCampaign(await runHostCampaign(request), { timeWindow: request.timeWindow })
		omitOptionalAbsence(campaign)
		return campaign
	}
}

export async function runFreshConfirmation(
	planValue: unknown,
	values: ConfirmationSources,
	ports: ConfirmationRunnerPorts,
): Promise<ConfirmationReceipt> {
	const plan = parseConfirmationPlan(planValue)
	const sources = parseSources(plan, values)
	if (plan.mode === "archived-regrade") return evaluate(plan, sources, {}, "imported", [])
	await validateFeedback(sources.feedback, { ...ports.evidence, signal: ports.signal ?? ports.evidence.signal })
	if (ports.evidence.bundle.taskIdentity !== sources.regression.source.evidenceTaskIdentity)
		throw new Error("Confirmation source task differs from the sealed regression evidence")
	for (const arm of ["control", "candidate"] as const) await validateCurrentSource(plan, arm, ports, ports.signal)
	const now = () =>
		z
			.string()
			.datetime()
			.parse((ports.now ?? (() => new Date().toISOString()))())
	if (Date.parse(now()) < Date.parse(plan.declaredAt))
		throw new Error("Confirmation cannot execute before declaration")
	const block = plan.experiment.decisionPlan!.timeBlocks[0]!
	const insideBlock = (timestamp: string) =>
		Date.parse(timestamp) >= Date.parse(block.startsAt) && Date.parse(timestamp) < Date.parse(block.endsAt)
	if (!insideBlock(now())) throw new Error("Confirmation is outside its predeclared execution block")
	const campaigns: { control?: unknown; candidate?: unknown } = {}
	const execution: ExecutionEntry[] = []
	for (const arm of ["control", "candidate"] as const) {
		if (ports.signal?.aborted) break
		const startedAt = now()
		if (!insideBlock(startedAt)) break
		let status: ExecutionEntry["status"] = "failed"
		let campaignDigest: string | undefined
		const abort = new AbortController()
		const signal = ports.signal ? AbortSignal.any([ports.signal, abort.signal]) : abort.signal
		const timer = setTimeout(() => abort.abort(), plan.limits.maxDurationMsPerArm)
		try {
			await validateCurrentSource(plan, arm, ports, signal)
			if (signal.aborted) throw new Error("Confirmation runner interrupted before dispatch")
			// Await settlement after abort: a raced callback could still own a process or mutate evidence.
			const returned = await ports.runCampaign({
				arm,
				runId: plan[arm].runId,
				taskIds: plan.taskSet.tasks.map(({ id }) => id),
				expectedVariant: plan[arm].variant,
				context: plan[arm].context,
				provider: plan[arm].provider,
				experiment: plan.experiment,
				decisionPlanDigest: sha256(canonicalJson(plan.experiment.decisionPlan)),
				timeWindow: plan.experiment.decisionPlan!.timeBlocks[0]!.id,
				hostVersions: plan.hostVersions,
				limits: plan.limits,
				signal,
			})
			const transport = normalizeCampaignTransport(returned)
			assertBoundedJson(transport, MAX_CONFIRMATION_JSON_BYTES)
			const campaign = parseCampaignExport(transport)
			campaigns[arm] = campaign
			campaignDigest = campaign.digest
			if (signal.aborted) throw new Error("Confirmation runner interrupted")
			await validateCurrentSource(plan, arm, ports, signal)
			status = "returned"
		} catch {
			status = ports.signal?.aborted ? "cancelled" : abort.signal.aborted ? "timed-out" : "failed"
		} finally {
			clearTimeout(timer)
		}
		execution.push({
			arm,
			runId: plan[arm].runId,
			startedAt,
			finishedAt: now(),
			status,
			...(campaignDigest ? { campaignDigest } : {}),
		})
		if (status === "cancelled" || status === "timed-out") break
	}
	return evaluate(plan, sources, campaigns, "fresh-runner", execution)
}

function validateCurrentSource(
	plan: ConfirmationPlan,
	arm: ConfirmationArm,
	ports: ConfirmationRunnerPorts,
	signal?: AbortSignal,
) {
	return validateHarnessContext(plan[arm].context, (path, readSignal) => ports.readSource(arm, path, readSignal), {
		signal,
		timeoutMs: Math.min(plan.limits.maxDurationMsPerArm, 30_000),
	})
}

function evaluate(
	plan: ConfirmationPlan,
	_sources: ParsedSources,
	values: { control?: unknown; candidate?: unknown },
	origin: ConfirmationReceipt["origin"],
	execution: ExecutionEntry[],
	decisionPolicy: typeof CURRENT_DECISION_POLICY | "legacy-conservative-v1" = CURRENT_DECISION_POLICY,
): ConfirmationReceipt {
	const campaigns: ConfirmationReceipt["campaigns"] = { control: null, candidate: null }
	const reasons: string[] = []
	for (const arm of ["control", "candidate"] as const) {
		try {
			const transport = normalizeCampaignTransport(values[arm])
			assertBoundedJson(transport, MAX_CONFIRMATION_JSON_BYTES)
			campaigns[arm] = parseCampaignExport(transport)
			validateCampaign(plan, arm, campaigns[arm]!, origin, execution)
		} catch {
			reasons.push(`${arm} campaign is missing, incomplete or differs from its declared execution identity`)
		}
	}
	if (origin === "imported") reasons.push("Imported or archived outputs do not establish fresh execution")
	if (origin === "fresh-runner" && (execution.length !== 2 || execution.some(({ status }) => status !== "returned")))
		reasons.push("Fresh campaign execution did not complete for both declared arms")
	if (
		execution.some(
			(entry, index) =>
				entry.arm !== (["control", "candidate"] as const)[index] ||
				entry.runId !== plan[entry.arm].runId ||
				Date.parse(entry.startedAt) < Date.parse(plan.declaredAt) ||
				Date.parse(entry.finishedAt) < Date.parse(entry.startedAt) ||
				(entry.status === "returned" &&
					Date.parse(entry.finishedAt) - Date.parse(entry.startedAt) > plan.limits.maxDurationMsPerArm) ||
				(index > 0 && Date.parse(entry.startedAt) < Date.parse(execution[index - 1]!.finishedAt)),
		)
	)
		reasons.push("Fresh execution ledger differs from the declared arms, chronology or duration bounds")
	let pairedReport: PairedReport | null = null
	let promotion: ConfirmationReceipt["promotion"] = null
	if (campaigns.control && campaigns.candidate) {
		try {
			pairedReport = reportCampaignPair(campaigns.control, campaigns.candidate, plan.experiment)
			promotion = evaluatePromotion({
				policy: POLICIES[plan.promotionPolicy],
				control: pairedReport.control.overall,
				candidate: pairedReport.candidate.overall,
				safetyFailures: pairedReport.safetyFailures,
				highRiskRegressions: pairedReport.highRiskRegressions,
				certified: false,
				paired: pairedReport.fullyPaired,
				decisionEvidence: pairedReport.decisionEvidence,
			})
		} catch {
			reasons.push("Existing paired campaign policy could not admit this comparison")
		}
	}
	let status: ConfirmationReceipt["status"] = "inconclusive"
	if (!reasons.length && pairedReport && campaigns.control && campaigns.candidate) {
		const control = campaigns.control.observations
		const candidate = campaigns.candidate.observations
		const targets = plan.requirements.targeted.map(({ taskId }) => taskId)
		const targetControl = control.filter(({ taskId }) => targets.includes(taskId))
		const targetCandidate = candidate.filter(({ taskId }) => targets.includes(taskId))
		const neighbors = candidate.filter(({ taskId }) => plan.requirements.neighbors.includes(taskId))
		const controlNeighbors = control.filter(({ taskId }) => plan.requirements.neighbors.includes(taskId))
		// Unmarked persisted receipts retain their conservative decision. Fresh producers always use the current policy.
		const knownOutcome = (status: ObservationStatus) =>
			decisionPolicy === CURRENT_DECISION_POLICY
				? isScoreableObservationStatus(status)
				: status === "passed" || status === "outcome_failed" || status === "safety_failed"
		const unknown = [...control, ...candidate].some(({ status }) => !knownOutcome(status))
		const observedHighRiskRegression = pairTrials(control, candidate).some(
			({ control: baseline, candidate: changed }) =>
				(baseline.risk === "high" || baseline.risk === "critical") &&
				baseline.status === "passed" &&
				changed.status !== "passed" &&
				knownOutcome(changed.status),
		)
		if (
			pairedReport.safetyFailures ||
			observedHighRiskRegression ||
			neighbors.some(({ status }) => status !== "passed" && knownOutcome(status))
		) {
			status = "revert"
			reasons.push("Candidate violates a safety, high-risk or neighboring regression requirement")
		} else if (unknown)
			reasons.push("Infrastructure, cancelled or otherwise unscoreable attempts remain in the denominator")
		else if (
			targetControl.some(({ status }) => status !== "outcome_failed") ||
			controlNeighbors.some(({ status }) => status !== "passed")
		) {
			status = "revise"
			reasons.push("Fresh control did not reproduce every target with passing neighboring controls")
		} else if (targetCandidate.some(({ status, retryAssisted }) => status !== "passed" || retryAssisted)) {
			status = "revise"
			reasons.push("Candidate did not resolve every targeted regression without diagnostic retry")
		} else if (plan.mode === "scripted-host-regression") {
			status = "keep"
			reasons.push(
				"Fresh scripted host cases confirm only the declared target and neighboring execution contracts",
			)
		} else if (pairedReport.decisionEvidence.status === "rejected") {
			status = "revert"
			reasons.push("Existing predeclared paired outcome policy rejected the candidate")
		} else if (pairedReport.decisionEvidence.status !== "accepted") {
			reasons.push(...pairedReport.decisionEvidence.reasons)
		} else {
			// This is a keep recommendation, not baseline promotion: no golden certification is invented.
			const unknownCost = [pairedReport.control.overall, pairedReport.candidate.overall].some(
				(statistics) => statistics.coverage?.knownCost !== statistics.coverage?.observations,
			)
			const guards = promotion!.reasons
				.filter((reason) => reason !== "golden certification is not current")
				.map((reason) =>
					reason === "cost-per-success regression" && unknownCost
						? "Required cost coverage is incomplete"
						: reason,
				)
			if (guards.length) reasons.push(...guards)
			else status = "keep"
		}
	}
	const body: Omit<ConfirmationReceipt, "digest"> = {
		schemaVersion: 1,
		recordType: "confirmation-receipt",
		...(decisionPolicy === CURRENT_DECISION_POLICY ? { decisionPolicy: CURRENT_DECISION_POLICY } : {}),
		plan,
		planDigest: plan.digest,
		sourceDigests: plan.sources,
		origin,
		evidenceKind:
			plan.mode === "live-quality"
				? "live-quality-comparison"
				: plan.mode === "scripted-host-regression"
					? "scripted-host-regression-validation"
					: "archived-output-review",
		status,
		reasons,
		liveQualityImprovement:
			status === "keep" &&
			plan.mode === "live-quality" &&
			plan.experiment.decisionPlan!.objective === "improvement",
		campaigns,
		pairedReport,
		promotion,
		execution,
	}
	// Existing statistics use undefined for absent segments. Own producer records must survive JSON storage unchanged.
	omitOptionalAbsence(body)
	return freeze({ ...body, digest: sha256(canonicalJson(body)) })
}

function validateCampaign(
	plan: ConfirmationPlan,
	arm: ConfirmationArm,
	campaign: CampaignExport,
	origin: ConfirmationReceipt["origin"],
	execution: ExecutionEntry[],
): void {
	const decision = plan.experiment.decisionPlan!
	const count = decision.plannedPairs
	const accounting = campaign.accounting
	const sampling = accounting?.sampling
	const ledger = execution.find((entry) => entry.arm === arm)
	const incomplete =
		!sampling ||
		sampling.planned !== count ||
		sampling.completed !== count ||
		sampling.notRun !== 0 ||
		sampling.completed !== sampling.passed + sampling.failed + sampling.blocked ||
		accounting?.scoredSamples !== count ||
		campaign.observations.length !== count ||
		accounting.totalAttempts !== count + accounting.diagnosticAttempts ||
		sampling.diagnosticAttempts !== accounting.diagnosticAttempts ||
		accounting.totalAttempts > plan.limits.maxRequestsPerArm
	if (
		incomplete ||
		campaign.incomplete.length ||
		campaign.executionFidelity !== "actual-host" ||
		campaign.identityScope !== "conservative-whole-source" ||
		campaign.decisionSource !== (plan[arm].provider.mode === "scripted" ? "scripted" : "live") ||
		campaign.runId !== plan[arm].runId ||
		!campaign.variant ||
		immutableIdentity(campaign.variant) !== immutableIdentity(plan[arm].variant) ||
		immutableIdentity(campaign.taskSet) !== immutableIdentity(plan.taskSet) ||
		plan.sources.archivedCampaignDigests.includes(campaign.digest) ||
		(origin === "fresh-runner" &&
			(!ledger || ledger.status !== "returned" || ledger.campaignDigest !== campaign.digest))
	)
		throw new Error("Campaign identity or explicit sampling denominator is incomplete")
	const block = decision.timeBlocks[0]!
	const planDigest = sha256(canonicalJson(decision))
	for (const observation of campaign.observations) {
		const started = Date.parse(observation.startedAt ?? "")
		if (
			observation.runId !== campaign.runId ||
			observation.firstAttemptStatus !== observation.status ||
			observation.retryAssisted ||
			observation.variantIdentity !== immutableIdentity(plan[arm].variant) ||
			observation.decisionPlanDigest !== planDigest ||
			observation.capturedTimeWindow !== block.id ||
			observation.timeWindow !== block.id ||
			!Number.isFinite(started) ||
			started < Date.parse(plan.declaredAt) ||
			started < Date.parse(block.startsAt) ||
			started >= Date.parse(block.endsAt) ||
			(ledger && (started < Date.parse(ledger.startedAt) || started > Date.parse(ledger.finishedAt)))
		)
			throw new Error("Campaign was not captured within its declared fresh execution interval")
	}
	const passed = campaign.observations.filter(({ status }) => status === "passed").length
	// The producer retains failed versus blocked independently: an infrastructure error may originate from either.
	if (sampling!.passed !== passed || sampling!.failed + sampling!.blocked !== count - passed)
		throw new Error("Campaign denominator classifications contradict retained outcomes")
}

function assertSeal(record: { digest: string }): void {
	const { digest, ...body } = record
	if (digest !== sha256(canonicalJson(body))) throw new Error("Confirmation content digest mismatch")
}

/** Canonical JSON omits only schema-optional object properties; inspect descriptors before touching input values. */
function normalizeCampaignTransport(value: unknown): unknown {
	let remainingDescriptors = 250_000
	const descriptors = (value: object) => {
		const keys = Reflect.ownKeys(value)
		remainingDescriptors -= keys.length
		if (remainingDescriptors < 0) throw new Error("Campaign transport structure exceeds its descriptor bound")
		return Object.getOwnPropertyDescriptors(value)
	}
	type Transform = (value: unknown) => unknown
	const object = (value: unknown, optional: readonly string[], children: Record<string, Transform> = {}): unknown => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value
		const fields = descriptors(value)
		let changed = false
		for (const key of optional) {
			const field = fields[key]
			if (field?.enumerable && "value" in field && field.value === undefined) {
				Reflect.deleteProperty(fields, key)
				changed = true
			}
		}
		for (const [key, transform] of Object.entries(children)) {
			const field = fields[key]
			if (!field?.enumerable || !("value" in field)) continue
			const next = transform(field.value)
			if (next !== field.value) {
				fields[key] = { ...field, value: next }
				changed = true
			}
		}
		return changed ? Object.create(Object.getPrototypeOf(value), fields) : value
	}
	const array = (value: unknown, transform: Transform): unknown => {
		if (!Array.isArray(value)) return value
		const length = Object.getOwnPropertyDescriptor(value, "length")?.value
		if (!Number.isSafeInteger(length) || length > 100_000)
			throw new Error("Campaign transport array exceeds bounds")
		const fields = descriptors(value)
		let changed = false
		for (const [key, field] of Object.entries(fields)) {
			if (!/^(?:0|[1-9][0-9]*)$/.test(key) || !field.enumerable || !("value" in field)) continue
			const next = transform(field.value)
			if (next !== field.value) {
				fields[key] = { ...field, value: next }
				changed = true
			}
		}
		return changed ? Object.defineProperties([], fields) : value
	}
	return object(value, ["identityScope", "accounting"], {
		accounting: (value) => object(value, ["sampling"]),
		incomplete: (value) => array(value, (row) => object(row, ["taskId"])),
		observations: (value) =>
			array(value, (row) =>
				object(
					row,
					[
						"runId",
						"tokens",
						"repository",
						"performance",
						"decisionPlanDigest",
						"startedAt",
						"capturedTimeWindow",
					],
					{ performance: (value) => object(value, performanceMetricNames) },
				),
			),
	})
}

function omitOptionalAbsence(value: unknown): void {
	if (Array.isArray(value)) {
		for (const child of value) omitOptionalAbsence(child)
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (child === undefined) {
				if (!Reflect.deleteProperty(value, key)) throw new Error("Producer record contains immutable absence")
			} else omitOptionalAbsence(child)
		}
	}
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
