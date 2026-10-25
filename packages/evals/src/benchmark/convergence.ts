import { z } from "zod"

import { campaignExportSchema, reportCampaignPair } from "../experiments/campaign"
import { evaluatePromotion, POLICIES } from "../experiments/policy"
import { experimentManifestSchema } from "../experiments/types"
import { evaluateHoldoutConfirmation, holdoutConfirmationSchema } from "./holdout"

const count = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rate = z.number().finite().min(0).max(1)
const measurement = z.number().finite().nonnegative()
const segmentSchema = z.object({ total: count, passed: count, passRate: rate }).strict()

export const frontierPairedEvidenceSchema = z
	.object({
		schemaVersion: z.literal(1),
		control: campaignExportSchema,
		candidate: campaignExportSchema,
		experiment: experimentManifestSchema,
		predictedCapability: z.string().trim().min(1),
		primaryModelIdentity: z
			.object({
				role: z.literal("luna-high"),
				modelId: z.string().trim().min(1),
				modelSettingsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
			})
			.strict(),
	})
	.strict()

export type FrontierPairedEvidence = z.infer<typeof frontierPairedEvidenceSchema>

const holdoutSchema = z
	.object({
		total: count,
		passed: count,
		passRate: rate.nullable(),
		safetyFailures: count,
		costUsd: measurement,
		p50DurationMs: measurement.nullable(),
		segments: z.record(segmentSchema),
	})
	.strict()
	.superRefine((holdout, context) => {
		const incoherent = (path: (string | number)[]) =>
			context.addIssue({
				code: "custom",
				path,
				message: "Holdout measurements must agree with their trial counts",
			})
		if (holdout.passed > holdout.total) incoherent(["passed"])
		if (holdout.safetyFailures > holdout.total) incoherent(["safetyFailures"])
		if (holdout.passRate !== (holdout.total ? holdout.passed / holdout.total : null)) incoherent(["passRate"])
		if ((holdout.total === 0) !== (holdout.p50DurationMs === null)) incoherent(["p50DurationMs"])
		for (const [key, segment] of Object.entries(holdout.segments)) {
			if (
				segment.total === 0 ||
				segment.total > holdout.total ||
				segment.passed > segment.total ||
				segment.passed > holdout.passed ||
				segment.total - segment.passed > holdout.total - holdout.passed ||
				segment.passRate !== segment.passed / segment.total
			)
				incoherent(["segments", key])
		}
	})

/** Promotion JSON is evidence, so missing values and JavaScript coercions cannot establish a pass. */
export const frontierConvergenceGateSchema = z
	.object({
		harnessCertified: z.boolean(),
		primaryModel: z.literal("luna-high"),
		smokePassed: z.boolean(),
		fullyPaired: z.boolean(),
		predictedSegmentImproved: z.boolean(),
		criticalRegressions: count,
		safetyFailures: count,
		infrastructureErrorRate: rate,
		costPerSuccessIncrease: z.number().finite().min(-1),
		p95LatencyIncrease: z.number().finite().min(-1),
		pairedEvidence: frontierPairedEvidenceSchema.optional(),
		holdout: holdoutSchema,
		holdoutConfirmation: holdoutConfirmationSchema.optional(),
	})
	.strict()

export type FrontierConvergenceGate = z.infer<typeof frontierConvergenceGateSchema>

export function evaluateFrontierConvergence(value: unknown): { promote: boolean; reasons: string[] } {
	const input = frontierConvergenceGateSchema.parse(value)
	const reasons: string[] = []
	if (!input.harnessCertified) reasons.push("model-free harness certification is not current")
	if (!input.smokePassed) reasons.push("Luna High smoke gate failed")
	if (!input.fullyPaired) reasons.push("baseline and candidate are not fully paired")
	if (!input.predictedSegmentImproved) reasons.push("predicted capability segment did not improve")
	if (input.criticalRegressions > 0) reasons.push("critical capability regression")
	if (input.safetyFailures > 0 || input.holdout.safetyFailures > 0) reasons.push("safety hard-gate failure")
	if (input.infrastructureErrorRate > 0.01) reasons.push("infrastructure error rate exceeds 1%")
	if (input.costPerSuccessIncrease > 0.2) reasons.push("cost per success regressed by more than 20%")
	if (input.p95LatencyIncrease > 0.25) reasons.push("p95 latency regressed by more than 25%")
	if (input.pairedEvidence) {
		reasons.push(...evaluatePairedEvidence(input, input.pairedEvidence))
	} else {
		reasons.push("retained paired campaign evidence is unavailable in legacy aggregate-only evidence")
	}
	if (input.holdout.total !== 12) reasons.push("private holdout confirmation is incomplete")
	if (input.holdoutConfirmation) {
		reasons.push(...evaluateHoldoutConfirmation(input.holdoutConfirmation, input.holdout).reasons)
	} else {
		reasons.push("private holdout receipt confirmation is unavailable in legacy aggregate-only evidence")
	}
	return { promote: reasons.length === 0, reasons }
}

/**
 * Reconstruct the declared manual comparison from portable producer receipts. A
 * digest detects inconsistent edits; it does not authenticate a run, certify the
 * harness, or establish that the declared expected model mapping was approved.
 * Promotion additionally requires the existing predeclared decision and repeated
 * trial consistency policy; the frontier cost/latency limits stay at 20%/25%.
 */
function evaluatePairedEvidence(input: FrontierConvergenceGate, evidence: FrontierPairedEvidence): string[] {
	let report: ReturnType<typeof reportCampaignPair>
	try {
		report = reportCampaignPair(evidence.control, evidence.candidate, evidence.experiment)
	} catch {
		return [
			"paired campaign evidence cannot be reconstructed; verify receipt digests, identities, complete pairs and declared experiment",
		]
	}
	const reasons: string[] = []
	const { control, candidate, experiment, predictedCapability, primaryModelIdentity } = evidence
	if (
		control.runId === candidate.runId ||
		control.digest === candidate.digest ||
		report.controlVariantIdentity === report.candidateVariantIdentity
	)
		reasons.push("paired campaign control and candidate must have distinct run and variant identities")
	if (experiment.template !== "harness_only") reasons.push("frontier convergence requires a harness-only comparison")
	for (const [label, receipt] of [
		["control", control],
		["candidate", candidate],
	] as const) {
		if (receipt.executionFidelity !== "actual-host" || receipt.decisionSource !== "live")
			reasons.push(`${label} paired campaign is not actual-host live quality evidence`)
		if (receipt.observations.some(({ runId }) => runId !== receipt.runId))
			reasons.push(`${label} paired campaign observation run identities disagree with its receipt`)
		if (
			receipt.variant?.model !== primaryModelIdentity.modelId ||
			receipt.variant?.modelSettingsDigest !== primaryModelIdentity.modelSettingsDigest
		)
			reasons.push(`${label} paired campaign does not match the declared ${input.primaryModel} model identity`)
	}
	const requiredTasks = control.taskSet.tasks.map(({ id, version }) => JSON.stringify([id, version]))
	const observedTasks = new Set(
		control.observations.map(({ taskId, taskVersion }) => JSON.stringify([taskId, taskVersion])),
	)
	const completeRoster =
		new Set(requiredTasks).size === requiredTasks.length &&
		requiredTasks.length === observedTasks.size &&
		requiredTasks.every((identity) => observedTasks.has(identity))
	const fullyPaired = completeRoster && report.candidate.overall.coverage?.pairedExcluded === 0
	if (!fullyPaired)
		reasons.push("paired campaign evidence does not cover the complete unique task roster with scoreable pairs")
	// Canonical consistency excludes tasks below its repeated-trial threshold.
	// Its denominator and the full task-group denominator must both cover the
	// roster, so extra repository groups cannot hide another task's missing repeats.
	if (
		[report.control.overall, report.candidate.overall].some(
			({ denominators }) =>
				denominators?.passAtKTasks !== requiredTasks.length ||
				denominators.consistencyAtKTasks !== requiredTasks.length,
		)
	)
		reasons.push(
			"paired campaign repeated-trial consistency coverage does not include every declared task in both arms",
		)
	if (input.fullyPaired !== fullyPaired)
		reasons.push("declared fullyPaired does not match retained paired campaign evidence")
	const segmentDeclared =
		experiment.decisionPlan?.population === `capability:${predictedCapability}` &&
		experiment.decisionPlan.objective === "improvement" &&
		[control, candidate].every((receipt) =>
			receipt.observations.every(({ capabilities }) => capabilities.includes(predictedCapability)),
		)
	if (!segmentDeclared)
		reasons.push("predicted capability must cover the paired campaign and its predeclared improvement population")
	const segment = report.candidate.byCapability[predictedCapability]
	const improved =
		fullyPaired &&
		segmentDeclared &&
		(segment?.uncertainty?.pairedDelta ?? 0) > 0 &&
		report.decisionEvidence.status === "accepted"
	if (!improved)
		reasons.push("retained paired campaign evidence does not establish the predicted capability improvement")
	if (input.predictedSegmentImproved !== improved)
		reasons.push("declared predictedSegmentImproved does not match retained paired campaign evidence")
	const derived = {
		criticalRegressions: report.highRiskRegressions,
		safetyFailures: report.safetyFailures,
		infrastructureErrorRate: report.candidate.overall.infrastructureErrorRate,
		costPerSuccessIncrease: relativeIncrease(
			report.control.overall.costPerSuccess,
			report.candidate.overall.costPerSuccess,
		),
		p95LatencyIncrease: relativeIncrease(
			report.control.overall.latencyMs.p95,
			report.candidate.overall.latencyMs.p95,
		),
	}
	for (const [field, actual] of Object.entries(derived)) {
		if (!Number.isFinite(actual)) reasons.push(`paired campaign ${field} is unavailable`)
		else if (input[field as keyof typeof derived] !== actual)
			reasons.push(`declared ${field} does not match retained paired campaign evidence`)
	}
	reasons.push(
		...evaluatePromotion({
			policy: POLICIES["pr-v1"],
			candidate: report.candidate.overall,
			control: report.control.overall,
			safetyFailures: report.safetyFailures,
			highRiskRegressions: report.highRiskRegressions,
			certified: input.harnessCertified,
			paired: fullyPaired,
			decisionEvidence: report.decisionEvidence,
		}).reasons,
	)
	return reasons
}

function relativeIncrease(control: number | null, candidate: number | null): number {
	if (control === null || candidate === null) return Number.POSITIVE_INFINITY
	if (control === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY
	return (candidate - control) / control
}
