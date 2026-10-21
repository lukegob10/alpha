import { describe, expect, it } from "vitest"

import { evaluateFrontierConvergence, type FrontierConvergenceGate } from "../convergence"
import { aggregateHoldoutTrials } from "../holdout"

function validGate(): FrontierConvergenceGate {
	return {
		harnessCertified: true,
		primaryModel: "luna-high",
		smokePassed: true,
		fullyPaired: true,
		predictedSegmentImproved: true,
		criticalRegressions: 0,
		safetyFailures: 0,
		infrastructureErrorRate: 0,
		costPerSuccessIncrease: 0,
		p95LatencyIncrease: 0,
		holdout: aggregateHoldoutTrials(
			Array.from({ length: 12 }, (_, index) => ({
				taskId: `holdout-${index}`,
				family: "mixed",
				difficulty: "frontier",
				passed: true,
				safetyFailed: false,
				durationMs: 10,
				costUsd: 0.1,
			})),
		),
	}
}

describe("frontier promotion evidence boundary", () => {
	it("preserves complete valid evidence and rejects missing metrics", () => {
		expect(evaluateFrontierConvergence(validGate())).toEqual({ promote: true, reasons: [] })
		for (const key of Object.keys(validGate())) {
			const value = validGate() as unknown as Record<string, unknown>
			delete value[key]
			expect(() => evaluateFrontierConvergence(value), key).toThrow()
		}
	})

	it("rejects unknown fields rather than silently accepting stale evidence formats", () => {
		expect(() => evaluateFrontierConvergence({ ...validGate(), unrecognizedSafetyResult: true })).toThrow()
		expect(() =>
			evaluateFrontierConvergence({ ...validGate(), holdout: { ...validGate().holdout, extra: true } }),
		).toThrow()
	})

	it("rejects coercible booleans, wrong models, nonfinite and nonnumeric metrics", () => {
		for (const [key, values] of Object.entries({
			harnessCertified: ["false", 1, null],
			smokePassed: ["false"],
			fullyPaired: ["false"],
			predictedSegmentImproved: ["false"],
			primaryModel: ["other", null],
			criticalRegressions: ["invalid", -1, 0.5, Number.MAX_SAFE_INTEGER + 1],
			safetyFailures: ["invalid", -1, 0.5],
			infrastructureErrorRate: ["invalid", -0.1, 1.1, NaN, Infinity],
			costPerSuccessIncrease: ["invalid", NaN, Infinity, -1.1],
			p95LatencyIncrease: ["invalid", NaN, Infinity, -1.1],
		})) {
			for (const value of values)
				expect(() => evaluateFrontierConvergence({ ...validGate(), [key]: value }), `${key}=${value}`).toThrow()
		}
	})

	it("rejects incoherent or incomplete holdout aggregates", () => {
		for (const patch of [
			{ total: 12 },
			{ passed: 13 },
			{ safetyFailures: 13 },
			{ passRate: 0.5 },
			{ costUsd: -1 },
			{ p50DurationMs: null },
			{ p50DurationMs: Infinity },
			{ segments: { "family:mixed": { total: 13, passed: 13, passRate: 1 } } },
			{ segments: { "family:mixed": { total: 12, passed: 11, passRate: 1 } } },
		]) {
			const input = validGate()
			input.holdout = (
				Object.keys(patch).length === 1 && "total" in patch ? patch : { ...input.holdout, ...patch }
			) as typeof input.holdout
			expect(() => evaluateFrontierConvergence(input), JSON.stringify(patch)).toThrow()
		}
	})

	it("retains actual safety and regression failures as nonpromotion decisions", () => {
		for (const patch of [
			{ harnessCertified: false },
			{ smokePassed: false },
			{ fullyPaired: false },
			{ predictedSegmentImproved: false },
			{ criticalRegressions: 1 },
			{ safetyFailures: 1 },
			{ infrastructureErrorRate: 0.011 },
			{ costPerSuccessIncrease: 0.201 },
			{ p95LatencyIncrease: 0.251 },
		])
			expect(evaluateFrontierConvergence({ ...validGate(), ...patch }).promote).toBe(false)
		expect(
			evaluateFrontierConvergence({ ...validGate(), costPerSuccessIncrease: -0.5, p95LatencyIncrease: -0.5 })
				.promote,
		).toBe(true)
	})
})
