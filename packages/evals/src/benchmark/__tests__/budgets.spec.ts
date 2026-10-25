import {
	CampaignCostLedger,
	assertCampaignBudgetAuthorized,
	estimateTierBudget,
	evaluateEfficiencyRegression,
} from "../budgets"

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

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
		"rejects invalid ledger amounts %s without changing reserved or consumed money",
		(amount) => {
			expect(() => new CampaignCostLedger(amount)).toThrow(/finite|nonnegative/i)
			const ledger = new CampaignCostLedger(1)
			ledger.reserve(0.1)
			const before = ledger.snapshot()
			expect(() => ledger.reserve(amount)).toThrow(/finite|nonnegative/i)
			expect(() => ledger.settle(0.1, amount)).toThrow(/finite|nonnegative/i)
			expect(() => ledger.settle(amount, 0.05)).toThrow(/finite|nonnegative/i)
			expect(ledger.snapshot()).toEqual(before)
		},
	)

	it.each([null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
		"does not accept an efficiency comparison with an unknown or invalid measurement %s",
		(measurement) => {
			const valid = {
				baselineCostPerSuccess: 1,
				candidateCostPerSuccess: 1,
				baselineMedianLatencyMs: 100,
				candidateMedianLatencyMs: 100,
				capabilityImproved: true,
			}
			for (const field of [
				"baselineCostPerSuccess",
				"candidateCostPerSuccess",
				"baselineMedianLatencyMs",
				"candidateMedianLatencyMs",
			] as const)
				expect(evaluateEfficiencyRegression({ ...valid, [field]: measurement }).accepted).toBe(false)
		},
	)

	it("reports unavailable measurements without calling them observed regressions", () => {
		expect(
			evaluateEfficiencyRegression({
				baselineCostPerSuccess: null,
				candidateCostPerSuccess: 0,
				baselineMedianLatencyMs: 100,
				candidateMedianLatencyMs: null,
				capabilityImproved: true,
			}),
		).toEqual({
			accepted: false,
			reasons: ["cost_measurement_unavailable_or_invalid", "latency_measurement_unavailable_or_invalid"],
		})
		expect(
			evaluateEfficiencyRegression({
				baselineCostPerSuccess: 0,
				candidateCostPerSuccess: 0,
				baselineMedianLatencyMs: 0,
				candidateMedianLatencyMs: 0,
				capabilityImproved: false,
			}),
		).toEqual({ accepted: true, reasons: [] })
	})

	it("retains a known actual cost even when it exceeds the campaign cap", () => {
		const ledger = new CampaignCostLedger(0.5)
		ledger.reserve(0.1)
		expect(() => ledger.settle(0.1, 0.6)).toThrow("hard cap exceeded")
		expect(ledger.snapshot()).toMatchObject({ reservedUsd: 0, consumedUsd: 0.6, remainingUsd: -0.1 })
		expect(() => ledger.reserve(0)).toThrow("Insufficient")
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
