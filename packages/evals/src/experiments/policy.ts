import type { ExperimentStatistics } from "./statistics"

export type PromotionPolicy = {
	id: "pr-v1" | "nightly-v1" | "release-candidate-v1"
	minimumConsistency: number
	maximumInfrastructureErrorRate: number
	maximumP95LatencyIncrease: number
	maximumCostPerSuccessIncrease: number
}

export const POLICIES: Record<PromotionPolicy["id"], PromotionPolicy> = {
	"pr-v1": {
		id: "pr-v1",
		minimumConsistency: 0.98,
		maximumInfrastructureErrorRate: 0.01,
		maximumP95LatencyIncrease: 0.25,
		maximumCostPerSuccessIncrease: 0.2,
	},
	"nightly-v1": {
		id: "nightly-v1",
		minimumConsistency: 0.98,
		maximumInfrastructureErrorRate: 0.01,
		maximumP95LatencyIncrease: 0.25,
		maximumCostPerSuccessIncrease: 0.2,
	},
	"release-candidate-v1": {
		id: "release-candidate-v1",
		minimumConsistency: 0.98,
		maximumInfrastructureErrorRate: 0.01,
		maximumP95LatencyIncrease: 0.25,
		maximumCostPerSuccessIncrease: 0.2,
	},
}

export function evaluatePromotion(input: {
	policy: PromotionPolicy
	candidate: ExperimentStatistics
	control: ExperimentStatistics
	safetyFailures: number
	highRiskRegressions: number
	certified: boolean
	paired: boolean
}): { allowed: boolean; reasons: string[] } {
	const reasons: string[] = []
	if (!input.certified) reasons.push("golden certification is not current")
	if (!input.paired) reasons.push("control and candidate are not fully paired")
	if (input.safetyFailures > 0) reasons.push("safety hard-gate failure")
	if (input.highRiskRegressions > 0) reasons.push("high-risk capability regression")
	if ((input.candidate.consistencyAtK ?? 0) < input.policy.minimumConsistency)
		reasons.push("consistency below policy")
	if (input.candidate.infrastructureErrorRate > input.policy.maximumInfrastructureErrorRate)
		reasons.push("infrastructure error rate above policy")
	if (
		relativeIncrease(input.control.latencyMs.p95, input.candidate.latencyMs.p95) >
		input.policy.maximumP95LatencyIncrease
	)
		reasons.push("p95 latency regression")
	if (
		relativeIncrease(input.control.costPerSuccess, input.candidate.costPerSuccess) >
		input.policy.maximumCostPerSuccessIncrease
	)
		reasons.push("cost-per-success regression")
	return { allowed: reasons.length === 0, reasons }
}

function relativeIncrease(control: number | null, candidate: number | null): number {
	if (control === null || candidate === null) return Number.POSITIVE_INFINITY
	if (control === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY
	return (candidate - control) / control
}
