import {
	CampaignCostLedger,
	assertCampaignBudgetAuthorized,
	estimateTierBudget,
	evaluateEfficiencyRegression,
} from "../index"

describe("benchmark cost governance", () => {
	it.each([
		["t0", 0],
		["t1", 0.5],
		["t2", 1],
		["t3", 2],
	] as const)("keeps %s reservations inside its hard cap", (tier, cap) => {
		const budget = estimateTierBudget(tier)
		expect(budget.hardCapUsd).toBe(cap)
		expect(budget.reservedCostUsd).toBeLessThanOrEqual(cap)
		expect(() => assertCampaignBudgetAuthorized(budget, false)).not.toThrow()
	})

	it("requires explicit approval for T5 and caps above $2", () => {
		expect(estimateTierBudget("t4")).toMatchObject({ estimatedCostUsd: 0.96, reservedCostUsd: 1.92, hardCapUsd: 2 })
		const release = estimateTierBudget("t5")
		expect(release).toMatchObject({ estimatedCostUsd: 10.4, reservedCostUsd: 16, hardCapUsd: 16 })
		expect(() => assertCampaignBudgetAuthorized(release, false)).toThrow("explicit approval")
		expect(() => assertCampaignBudgetAuthorized(release, true)).not.toThrow()
		expect(() => assertCampaignBudgetAuthorized(estimateTierBudget("t3", { hardCapUsd: 3 }), false)).toThrow(
			"explicit approval",
		)
	})

	it("reserves before scheduling and remains safe under out-of-order settlement", () => {
		const ledger = new CampaignCostLedger(0.5)
		for (let index = 0; index < 8; index++) ledger.reserve(0.05)
		expect(ledger.snapshot()).toEqual({ hardCapUsd: 0.5, reservedUsd: 0.4, consumedUsd: 0, remainingUsd: 0.1 })
		expect(() => ledger.reserve(0.11)).toThrow("Insufficient")
		ledger.settle(0.05, 0.035)
		ledger.settle(0.05, 0.04)
		expect(ledger.snapshot()).toMatchObject({ reservedUsd: 0.3, consumedUsd: 0.075, remainingUsd: 0.125 })
	})

	it("blocks unjustified cost and latency regressions", () => {
		expect(
			evaluateEfficiencyRegression({
				baselineCostPerSuccess: 1,
				candidateCostPerSuccess: 1.21,
				baselineMedianLatencyMs: 100,
				candidateMedianLatencyMs: 126,
				capabilityImproved: false,
			}),
		).toEqual({
			accepted: false,
			reasons: ["cost_per_success_regression_over_20_percent", "median_latency_regression_over_25_percent"],
		})
		expect(
			evaluateEfficiencyRegression({
				baselineCostPerSuccess: 1,
				candidateCostPerSuccess: 1.3,
				baselineMedianLatencyMs: 100,
				candidateMedianLatencyMs: 140,
				capabilityImproved: true,
			}).accepted,
		).toBe(true)
	})
})
