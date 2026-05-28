import type {
	GoalSeekCandidate,
	GoalSeekRankingWeights,
	GoalSeekScoreDirection,
	GoalSeekVerifierResult,
} from "@alpha-code/types"

export const defaultGoalSeekRankingWeights: GoalSeekRankingWeights = {
	expectedReward: 1,
	directoryRisk: 0.8,
	complexity: 0.7,
	regressionRisk: 0.8,
	reversibility: 0.5,
}

const clampScore = (value: number) => Math.max(0, Math.min(100, value))

export const calculateGoalSeekUtility = (
	candidate: Omit<GoalSeekCandidate, "utilityScore">,
	weights: GoalSeekRankingWeights = defaultGoalSeekRankingWeights,
): number => {
	const expectedReward = clampScore(candidate.expectedRewardImpact)
	const riskPenalty =
		clampScore(candidate.directoryRisk) * weights.directoryRisk +
		clampScore(candidate.complexity) * weights.complexity +
		clampScore(candidate.regressionRisk) * weights.regressionRisk
	const reversibilityCredit = clampScore(candidate.reversibility) * weights.reversibility
	return Number((expectedReward * weights.expectedReward + reversibilityCredit - riskPenalty).toFixed(2))
}

export const compareGoalSeekScores = (
	previousScore: number | undefined,
	nextScore: number,
	direction: GoalSeekScoreDirection,
): boolean => {
	if (previousScore === undefined) {
		return true
	}
	return direction === "maximize" ? nextScore > previousScore : nextScore < previousScore
}

export const hasPassedGoalSeekTarget = (
	score: number,
	targetScore: number,
	direction: GoalSeekScoreDirection,
): boolean => (direction === "maximize" ? score >= targetScore : score <= targetScore)

export const normalizeGoalSeekVerifierResult = (
	result: Partial<GoalSeekVerifierResult> & { score: number; reason?: string },
	direction: GoalSeekScoreDirection,
	targetScore: number,
	previousScore?: number,
	rawOutput?: string,
): GoalSeekVerifierResult => {
	const improved = compareGoalSeekScores(previousScore, result.score, direction)
	const passedTarget = hasPassedGoalSeekTarget(result.score, targetScore, direction)
	return {
		score: result.score,
		direction,
		improved,
		passedTarget,
		reason: result.reason?.trim() || "Verifier returned a score without a reason.",
		nextInstructions: result.nextInstructions,
		rawOutput,
	}
}
