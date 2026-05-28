import { describe, expect, it } from "vitest"

import {
	calculateGoalSeekUtility,
	compareGoalSeekScores,
	hasPassedGoalSeekTarget,
	normalizeGoalSeekVerifierResult,
} from "../goalSeekUtils"

describe("goalSeekUtils", () => {
	it("compares maximize and minimize scores", () => {
		expect(compareGoalSeekScores(10, 11, "maximize")).toBe(true)
		expect(compareGoalSeekScores(10, 9, "maximize")).toBe(false)
		expect(compareGoalSeekScores(10, 9, "minimize")).toBe(true)
		expect(compareGoalSeekScores(10, 11, "minimize")).toBe(false)
	})

	it("detects target pass for both score directions", () => {
		expect(hasPassedGoalSeekTarget(90, 80, "maximize")).toBe(true)
		expect(hasPassedGoalSeekTarget(70, 80, "maximize")).toBe(false)
		expect(hasPassedGoalSeekTarget(20, 30, "minimize")).toBe(true)
		expect(hasPassedGoalSeekTarget(40, 30, "minimize")).toBe(false)
	})

	it("penalizes broad risky candidates in utility ranking", () => {
		const safeCandidate = {
			id: "safe",
			title: "Small cache improvement",
			rationale: "Improves hot path with low blast radius",
			expectedRewardImpact: 75,
			affectedPaths: ["src/cache.ts"],
			directoryRisk: 15,
			complexity: 20,
			regressionRisk: 15,
			reversibility: 90,
		}
		const rewriteCandidate = {
			id: "rewrite",
			title: "Rewrite runtime",
			rationale: "Potentially large reward with high risk",
			expectedRewardImpact: 90,
			affectedPaths: ["src"],
			directoryRisk: 90,
			complexity: 95,
			regressionRisk: 90,
			reversibility: 20,
		}

		expect(calculateGoalSeekUtility(safeCandidate)).toBeGreaterThan(calculateGoalSeekUtility(rewriteCandidate))
	})

	it("normalizes verifier output with improvement and target metadata", () => {
		const result = normalizeGoalSeekVerifierResult(
			{ score: 42, reason: "Reduced failures" },
			"minimize",
			50,
			60,
			'{"score":42}',
		)

		expect(result).toMatchObject({
			score: 42,
			direction: "minimize",
			improved: true,
			passedTarget: true,
			reason: "Reduced failures",
			rawOutput: '{"score":42}',
		})
	})
})
