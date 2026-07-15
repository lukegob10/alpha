import { certifyHarness } from "../certification/index"
import { findBaseline, recordPromotionOutcome } from "../db/index"
import { canonicalJson, sha256 } from "../evidence/index"
import { evaluatePromotion, type PromotionPolicy } from "./policy"
import type { ExperimentStatistics } from "./statistics"

export async function promoteBaseline(
	input: {
		baselineIdentity: string
		rollbackBaselineIdentity: string
		experimentIdentity: string
		variantIdentity: string
		taskSetIdentity: string
		report: { control: ExperimentStatistics; candidate: ExperimentStatistics }
		policy: PromotionPolicy
		reviewer: string
		rationale: string
		safetyFailures: number
		highRiskRegressions: number
		paired: boolean
	},
	certification: () => Promise<void> = certifyHarness,
): Promise<{ promoted: boolean; reasons: string[] }> {
	if (!input.reviewer.trim() || !input.rationale.trim()) throw new Error("Promotion requires reviewer and rationale")
	if (input.rollbackBaselineIdentity === input.baselineIdentity)
		throw new Error("Rollback target must be a prior baseline")
	if (!(await findBaseline(input.rollbackBaselineIdentity))) throw new Error("Rollback baseline does not exist")
	let certified = true
	try {
		await certification()
	} catch {
		certified = false
	}
	const decision = evaluatePromotion({
		policy: input.policy,
		candidate: input.report.candidate,
		control: input.report.control,
		safetyFailures: input.safetyFailures,
		highRiskRegressions: input.highRiskRegressions,
		certified,
		paired: input.paired,
	})
	const promotion: Parameters<typeof recordPromotionOutcome>[0] = {
		baselineIdentity: input.baselineIdentity,
		rollbackBaselineIdentity: input.rollbackBaselineIdentity,
		experimentIdentity: input.experimentIdentity,
		policyId: input.policy.id,
		reviewer: input.reviewer,
		rationale: input.rationale,
		decision: decision.allowed ? "accepted" : "rejected",
		reasons: decision.reasons,
	}
	await recordPromotionOutcome(
		promotion,
		decision.allowed
			? {
					identity: input.baselineIdentity,
					variantIdentity: input.variantIdentity,
					taskSetIdentity: input.taskSetIdentity,
					reportDigest: sha256(canonicalJson(input.report)),
					createdBy: input.reviewer,
				}
			: undefined,
	)
	return { promoted: decision.allowed, reasons: decision.reasons }
}
