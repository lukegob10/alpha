import { anthropicDefaultModelId, anthropicModels } from "../providers/anthropic.js"

describe("native Claude model catalog", () => {
	it.each([
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
	] as const)("exposes all five effort levels for %s", (modelId) => {
		expect(anthropicModels[modelId]).toMatchObject({
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			supportsTemperature: false,
		})
		expect(anthropicModels[modelId]).not.toHaveProperty("supportsReasoningBudget", true)
	})

	it("uses Fable 5.1's published limits and cache pricing", () => {
		expect(anthropicModels["claude-fable-5-1"]).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			inputPrice: 10,
			outputPrice: 50,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 0.25,
		})
	})

	it("defaults new setups to Sonnet 5 and hides retired models while retaining saved IDs", () => {
		expect(anthropicDefaultModelId).toBe("claude-sonnet-5")
		for (const modelId of [
			"claude-sonnet-4-20250514",
			"claude-opus-4-1-20250805",
			"claude-opus-4-20250514",
			"claude-3-7-sonnet-20250219:thinking",
			"claude-3-7-sonnet-20250219",
			"claude-3-5-sonnet-20241022",
			"claude-3-5-haiku-20241022",
			"claude-3-opus-20240229",
			"claude-3-haiku-20240307",
		] as const) {
			expect(anthropicModels[modelId].deprecated).toBe(true)
		}
	})
})
