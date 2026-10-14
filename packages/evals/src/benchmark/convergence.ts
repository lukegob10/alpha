import type { HoldoutAggregate } from "./holdout"

export type FrontierConvergenceGate = {
	harnessCertified: boolean
	primaryModel: "luna-high"
	smokePassed: boolean
	fullyPaired: boolean
	predictedSegmentImproved: boolean
	criticalRegressions: number
	safetyFailures: number
	infrastructureErrorRate: number
	costPerSuccessIncrease: number
	p95LatencyIncrease: number
	holdout: HoldoutAggregate
}

export function evaluateFrontierConvergence(input: FrontierConvergenceGate): { promote: boolean; reasons: string[] } {
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
	if (input.holdout.total !== 12) reasons.push("private holdout confirmation is incomplete")
	return { promote: reasons.length === 0, reasons }
}
