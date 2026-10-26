import type { ModelInfo } from "@alpha-code/types"

import { calculateApiCostAnthropic } from "../cost"

const model: ModelInfo = {
	contextWindow: 1_000_000,
	supportsPromptCache: true,
	inputPrice: 0.1,
	outputPrice: 0.5,
	cacheWritesPrice: 0.125,
	cacheReadsPrice: 0.01,
	longContextPricing: {
		thresholdTokens: 100_000,
		inputPriceMultiplier: 5,
		outputPriceMultiplier: 5,
		cacheWritesPriceMultiplier: 5,
		cacheReadsPriceMultiplier: 5,
	},
}

describe("Anthropic long-context usage pricing", () => {
	it.each([100_000, 100_001])("uses the correct rates for %s input tokens", (inputTokens) => {
		const multiplier = inputTokens > 100_000 ? 5 : 1
		const result = calculateApiCostAnthropic(model, inputTokens, 1_000)
		expect(result.totalCost).toBeCloseTo(
			(inputTokens * 0.1 * multiplier + 1_000 * 0.5 * multiplier) / 1_000_000,
			12,
		)
	})

	it("counts cache tokens toward the threshold and prices each input bucket once", () => {
		const saved = structuredClone(model)
		const result = calculateApiCostAnthropic(model, 90_000, 1_000, 10_000, 1)
		expect(result.totalInputTokens).toBe(100_001)
		expect(result.totalOutputTokens).toBe(1_000)
		expect(result.totalCost).toBeCloseTo((90_000 * 0.5 + 10_000 * 0.625 + 1 * 0.05 + 1_000 * 2.5) / 1_000_000, 12)
		expect(model).toEqual(saved)
	})
})
