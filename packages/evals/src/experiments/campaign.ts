import { z } from "zod"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { immutableIdentity } from "./identity"
import { buildPairedExperimentReport } from "./reporting"
import type { ExperimentDecision } from "./policy"
import {
	experimentManifestSchema,
	experimentVariantSchema,
	pairKeySchema,
	taskSetManifestSchema,
	trialObservationSchema,
	type ExperimentManifest,
	type ExperimentDecisionPlan,
} from "./types"

/** Local native measurements cannot assert an OS boundary or private-asset isolation through a receipt label. */
export const campaignAgentIsolationSchema = z
	.object({
		boundary: z.literal("trusted-local-native-host"),
		privateAssetIsolation: z.literal("unestablished"),
		osSandbox: z.literal(false),
	})
	.strict()

/**
 * native-host-protocol-v1 denotes the native host's externally enforced budget and observed machine,
 * provider transport/controller retries, Alpha runtime retries as treatment, and an observed resource envelope
 * without an OS CPU/memory boundary. Its exact native receipt fields are NATIVE_EXPERIMENT_CONDITION_SCOPES.
 * It does not assert that the product harness's scheduler or retry behavior stayed unchanged.
 */
export const campaignConditionIdentityScopeSchema = z.literal("native-host-protocol-v1")

/** Portable producer receipt. Incomplete runs stay readable but cannot silently enter a paired report. */
export const campaignExportSchema = z.object({
	schemaVersion: z.literal(1),
	runId: z.string().min(1),
	executionFidelity: z.enum(["unit", "integrated", "actual-host"]),
	decisionSource: z.enum(["scripted", "live"]),
	identityScope: z.enum(["component", "conservative-whole-source"]).optional(),
	agentIsolation: campaignAgentIsolationSchema.optional(),
	conditionIdentityScope: campaignConditionIdentityScopeSchema.optional(),
	accounting: z
		.object({
			totalAttempts: z.number().int().nonnegative(),
			scoredSamples: z.number().int().nonnegative(),
			diagnosticAttempts: z.number().int().nonnegative(),
			totalCost: z.number().finite().nonnegative().nullable(),
			sampling: z
				.object({
					planned: z.number().int().nonnegative(),
					completed: z.number().int().nonnegative(),
					passed: z.number().int().nonnegative(),
					failed: z.number().int().nonnegative(),
					blocked: z.number().int().nonnegative(),
					notRun: z.number().int().nonnegative(),
					diagnosticAttempts: z.number().int().nonnegative(),
				})
				.optional(),
		})
		.optional(),
	variant: experimentVariantSchema.nullable(),
	taskSet: taskSetManifestSchema,
	observations: trialObservationSchema.array(),
	incomplete: z.array(z.object({ taskId: z.string().optional(), reason: z.string().min(1) })),
	digest: z.string(),
})

export type CampaignExport = z.infer<typeof campaignExportSchema>

export function sealCampaignExport(value: Omit<CampaignExport, "digest">): CampaignExport {
	const body = campaignExportSchema.omit({ digest: true }).parse(value)
	return { ...body, digest: sha256(canonicalJson(body)) }
}

export function parseCampaignExport(value: unknown): CampaignExport {
	const receipt = campaignExportSchema.parse(value)
	const { digest, ...body } = receipt
	if (digest !== sha256(canonicalJson(body))) throw new Error("Campaign export digest mismatch")
	return receipt
}

/** Materialize the caller's declared treatment; never infer allowed differences from outcomes. */
export function declareCampaignPair(
	controlValue: unknown,
	candidateValue: unknown,
	declaration: {
		id: string
		template: string
		allowedDifferenceFields: string[]
		independentUnit: string
		decisionPlan?: ExperimentDecisionPlan
	},
): ExperimentManifest {
	const control = parseCampaignExport(controlValue)
	const candidate = parseCampaignExport(candidateValue)
	if (!control.variant || !candidate.variant) throw new Error("Campaign variant identity is unavailable")
	return experimentManifestSchema.parse({
		schemaVersion: 1,
		...declaration,
		taskSetIdentity: immutableIdentity(control.taskSet),
		controlVariantIdentity: immutableIdentity(control.variant),
		candidateVariantIdentity: immutableIdentity(candidate.variant),
		pairs: control.observations.map((observation) => pairKeySchema.parse(observation)),
	})
}

export function reportCampaignPair(controlValue: unknown, candidateValue: unknown, manifestValue: ExperimentManifest) {
	const control = parseCampaignExport(controlValue)
	const candidate = parseCampaignExport(candidateValue)
	const manifest = experimentManifestSchema.parse(manifestValue)
	if (control.incomplete.length || candidate.incomplete.length || !control.variant || !candidate.variant)
		throw new Error("Campaign evidence is incomplete; repair the producer evidence before pairing")
	if (control.conditionIdentityScope !== candidate.conditionIdentityScope)
		throw new Error("Campaign fixed-condition identity domains differ")
	if (
		control.executionFidelity !== candidate.executionFidelity ||
		control.decisionSource !== candidate.decisionSource ||
		(control.identityScope ?? "component") !== (candidate.identityScope ?? "component")
	)
		throw new Error("Campaign execution fidelity, decision source or identity scope differs")
	if (immutableIdentity(control.taskSet) !== immutableIdentity(candidate.taskSet))
		throw new Error("Campaign task-set identities differ")
	const report = buildPairedExperimentReport(control.observations, candidate.observations, {
		manifest,
		taskSet: control.taskSet,
		controlVariant: control.variant,
		candidateVariant: candidate.variant,
	})
	const body = {
		...report,
		analysisDigest: report.digest,
		producerEvidence: {
			control: control.digest,
			candidate: candidate.digest,
			executionFidelity: control.executionFidelity,
			decisionSource: control.decisionSource,
			identityScope: control.identityScope ?? "component",
			...(control.conditionIdentityScope ? { conditionIdentityScope: control.conditionIdentityScope } : {}),
			accounting: { control: control.accounting ?? null, candidate: candidate.accounting ?? null },
			...(control.agentIsolation || candidate.agentIsolation
				? {
						agentIsolation: {
							control: control.agentIsolation ?? null,
							candidate: candidate.agentIsolation ?? null,
						},
					}
				: {}),
		},
	}
	return { ...body, digest: sha256(canonicalJson(body)) }
}

export function renderCampaignPair(
	report: Omit<ReturnType<typeof reportCampaignPair>, "decisionEvidence"> & { decisionEvidence?: ExperimentDecision },
): string {
	const candidate = report.candidate.overall
	const effect = candidate.uncertainty
	const decision: ExperimentDecision = report.decisionEvidence ?? {
		status: "inconclusive",
		reasons: ["Historical report contains no predeclared decision evidence"],
	}
	return [
		"# Paired experiment",
		"",
		`Execution: ${report.producerEvidence.executionFidelity}; decisions: ${report.producerEvidence.decisionSource}.`,
		`Pairs: ${report.pairCount}; scoreable: ${candidate.coverage?.pairedScoreable}; excluded: ${candidate.coverage?.pairedExcluded}.`,
		`Independent unit: ${effect?.independentUnit}; paired clusters: ${effect?.pairedClusters}.`,
		`Candidate minus control, equal cluster weight: ${effect?.pairedDelta ?? "unavailable"}; empirical 95% interval: ${JSON.stringify(effect?.pairedBootstrap95 ?? null)}.`,
		`Bounded paired 95% interval: ${JSON.stringify(effect?.pairedBounds95 ?? null)}; this bound requires independent declared sampling units.`,
		`Declared objective: ${decision.objective ?? "unavailable"}; margin: ${decision.margin ?? "unavailable"}; population: ${decision.population ?? "unavailable"}.`,
		`Candidate known cost observations: ${candidate.coverage?.knownCost}/${candidate.coverage?.observations}; cost per success: ${candidate.costPerSuccess ?? "unavailable"}.`,
		`Observed delivery: ${candidate.delivery?.successes ?? "unavailable"}/${candidate.delivery?.attempts ?? "unavailable"}; conditional outcome denominator: ${candidate.denominators?.conditionalOutcome ?? "unavailable"}. Pass-at-k and consistency include unscoreable attempts; their task denominators are ${candidate.denominators?.passAtKTasks ?? "unavailable"} and ${candidate.denominators?.consistencyAtKTasks ?? "unavailable"}.`,
		`Cost and latency cover all sample attempts; outcome rates exclude unscoreable statuses as counted above. Producer accounting (including diagnostic reproduction): ${JSON.stringify(report.producerEvidence.accounting)}.`,
		"",
		`Decision: ${decision.status}. ${decision.reasons.join("; ")}${decision.reasons.length ? "." : ""} This decision concerns only the declared paired outcome claim; promotion guards and performance acceptance are separate. Empirical all-success intervals are not future reliability bounds. Scripted runs measure execution contracts, not live planning capability.`,
		"",
	].join("\n")
}
