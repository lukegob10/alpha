import { describe, expect, it } from "vitest"

import {
	DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
	taskGoalCreateInputSchema,
	taskGoalObjectiveSchema,
	taskGoalResumeInputSchema,
	taskGoalSchema,
	taskGoalStatusSchema,
} from "../task-goal.js"

describe("native goal contract", () => {
	it("requires an explicit, bounded objective and preserves optional budgets", () => {
		expect(taskGoalCreateInputSchema.parse({ objective: "  Finish the requested work  " })).toEqual({
			objective: "Finish the requested work",
		})
		expect(taskGoalCreateInputSchema.parse({ objective: "Ship", tokenBudget: 100, maxContinuations: 2 })).toEqual({
			objective: "Ship",
			tokenBudget: 100,
			maxContinuations: 2,
		})
		expect(taskGoalCreateInputSchema.safeParse({ objective: "" }).success).toBe(false)
		expect(taskGoalCreateInputSchema.safeParse({ objective: " \n\t " }).success).toBe(false)
		expect(taskGoalCreateInputSchema.safeParse({ objective: "Ship", unauthorized: true }).success).toBe(false)
	})

	it("uses the upstream 4000 Unicode character limit", () => {
		expect(taskGoalObjectiveSchema.parse("🔧".repeat(4_000))).toBe("🔧".repeat(4_000))
		expect(taskGoalObjectiveSchema.safeParse("x".repeat(4_001)).success).toBe(false)
	})

	it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid token budgets (%s)",
		(budget) => {
			expect(taskGoalCreateInputSchema.safeParse({ objective: "Ship", tokenBudget: budget }).success).toBe(false)
		},
	)

	it.each([0, -1, 1.5, 1_001])("rejects unbounded continuation counts (%s)", (maxContinuations) => {
		expect(taskGoalCreateInputSchema.safeParse({ objective: "Ship", maxContinuations }).success).toBe(false)
	})

	it("represents every stopped and recoverable status", () => {
		for (const status of ["active", "paused", "blocked", "complete", "budget_limited", "usage_limited"]) {
			expect(taskGoalStatusSchema.parse(status)).toBe(status)
		}
		expect(taskGoalStatusSchema.safeParse("cancelled").success).toBe(false)
	})

	it("round-trips current saved state and rejects inconsistent continuation counts", () => {
		const state = {
			goalId: "goal-1",
			taskId: "task-1",
			objective: "Ship",
			status: "active",
			tokensUsed: 12,
			timeUsedMs: 30,
			version: 2,
			controlVersion: 1,
			createdAt: 1,
			updatedAt: 2,
			maxContinuations: DEFAULT_TASK_GOAL_MAX_CONTINUATIONS,
			continuationCount: 1,
			recoveryDeferred: true,
		}
		expect(taskGoalSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
		expect(taskGoalSchema.safeParse({ ...state, continuationCount: 21 }).success).toBe(false)
		expect(taskGoalSchema.safeParse({ ...state, version: 0 }).success).toBe(false)
	})

	it("allows only the host resume contract to explicitly remove a token budget", () => {
		expect(taskGoalResumeInputSchema.parse({ tokenBudget: null })).toEqual({ tokenBudget: null })
		expect(taskGoalCreateInputSchema.safeParse({ objective: "Ship", tokenBudget: null }).success).toBe(false)
	})
})
