import { isScoreableObservationStatus, type ExperimentStatistics } from "./statistics"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { experimentDecisionPlanSchema, type ExperimentDecisionPlan, type PairedTrial } from "./types"

export type ExperimentDecision = {
	status: "accepted" | "rejected" | "inconclusive"
	policyId?: string
	planDigest?: string
	reasons: string[]
	interval95?: [number, number] | null
	statisticsDigest?: string
	claim?: ExperimentDecisionPlan["claim"]
	objective?: ExperimentDecisionPlan["objective"]
	margin?: number
	population?: string
}

/** A successful observation or an empirical all-pass interval is not acceptance evidence. */
export function evaluateExperimentDecision(
	plan: ExperimentDecisionPlan | undefined,
	statistics: ExperimentStatistics,
	pairs: PairedTrial[],
	context?: { taskSetIdentity: string },
): ExperimentDecision {
	if (!plan) return { status: "inconclusive", reasons: ["No predeclared decision plan was captured"] }
	const parsed = experimentDecisionPlanSchema.safeParse(plan)
	if (!parsed.success) return { status: "inconclusive", reasons: ["Decision plan is invalid"] }
	plan = parsed.data
	const planDigest = sha256(canonicalJson(plan))
	const reasons: string[] = []
	if (pairs.length !== plan.plannedPairs) reasons.push("Final decision schedule is incomplete")
	if (context?.taskSetIdentity !== plan.taskSetIdentity)
		reasons.push("Task sampling frame differs from the predeclared task set")
	if (
		plan.controlRunId === plan.candidateRunId ||
		pairs.some(
			({ control, candidate }) => control.runId !== plan.controlRunId || candidate.runId !== plan.candidateRunId,
		)
	)
		reasons.push("Paired run identities differ from the predeclared runs")
	const observations = pairs.flatMap(({ control, candidate }) => [control, candidate])
	if (
		observations.some(
			(observation) =>
				observation.decisionPlanDigest !== planDigest ||
				!observation.startedAt ||
				Date.parse(observation.startedAt) < Date.parse(plan.declaredAt),
		)
	)
		reasons.push("Decision plan was not captured before every paired attempt")
	const uncertainty = statistics.uncertainty
	if (uncertainty?.independentUnit !== plan.independentUnit)
		reasons.push("Independent sampling unit differs from the declared decision plan")
	if ((uncertainty?.pairedClusters ?? 0) < plan.minimumIndependentUnits)
		reasons.push("Independent coverage is below the declared requirement")
	if (!pairs.length || (statistics.coverage?.pairedScoreable ?? 0) / pairs.length < plan.minimumPairedCoverage)
		reasons.push("Scoreable paired coverage is below the declared requirement")
	const represented = pairs.filter(({ control, candidate }) =>
		[control.status, candidate.status].every(isScoreableObservationStatus),
	)
	if (plan.requiredFamilies.some((family) => !represented.some(({ candidate }) => candidate.family === family)))
		reasons.push("Required task-family coverage is incomplete")
	if (
		observations.some(({ timeWindow, capturedTimeWindow, startedAt }) => {
			const block = plan.timeBlocks.find(({ id }) => id === timeWindow)
			const started = Date.parse(startedAt ?? "")
			return (
				capturedTimeWindow !== timeWindow ||
				!block ||
				!Number.isFinite(started) ||
				started < Date.parse(block.startsAt) ||
				started >= Date.parse(block.endsAt)
			)
		}) ||
		plan.timeBlocks.some(({ id }) => !represented.some(({ candidate }) => candidate.timeWindow === id))
	)
		reasons.push("Declared time-block coverage is incomplete")
	const interval95 = uncertainty?.pairedBounds95 ?? null
	if (!interval95 || interval95[1] - interval95[0] > plan.maximumIntervalWidth)
		reasons.push("Paired uncertainty exceeds the declared precision requirement")
	const evidence = {
		policyId: plan.id,
		planDigest,
		interval95,
		statisticsDigest: sha256(canonicalJson(statistics)),
		claim: plan.claim,
		objective: plan.objective,
		margin: plan.margin,
		population: plan.population,
	}
	if (reasons.length || !interval95) return { ...evidence, status: "inconclusive", reasons }
	const threshold = plan.objective === "noninferiority" ? -plan.margin : plan.margin
	if (interval95[0] > threshold) return { ...evidence, status: "accepted", reasons: [] }
	if (interval95[1] < threshold)
		return { ...evidence, status: "rejected", reasons: ["Paired outcome is below the declared margin"] }
	return { ...evidence, status: "inconclusive", reasons: ["Paired uncertainty overlaps the declared margin"] }
}

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
	decisionEvidence?: ExperimentDecision
}): { allowed: boolean; reasons: string[] } {
	const reasons: string[] = []
	if (!input.certified) reasons.push("golden certification is not current")
	if (!input.paired) reasons.push("control and candidate are not fully paired")
	if (
		input.decisionEvidence?.status !== "accepted" ||
		input.decisionEvidence.statisticsDigest !== sha256(canonicalJson(input.candidate))
	)
		reasons.push("predeclared paired decision evidence is inconclusive or rejected")
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
