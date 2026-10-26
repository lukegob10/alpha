import { describe, expect, it } from "vitest"

import { modelInfoSchema } from "../model.js"
import { anthropicDefaultModelId, anthropicModels } from "../providers/anthropic.js"

describe("direct Anthropic catalog", () => {
	it("advertises the verified native 5.5 family and keeps the Opus default", () => {
		expect(Object.keys(anthropicModels)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
		expect(anthropicDefaultModelId).toBe("claude-opus-5-5")
	})

	it.each([
		{ id: "claude-opus-5-5", effort: "medium", required: true },
		{ id: "claude-sonnet-5-5", effort: "high", required: true },
		{ id: "claude-haiku-5-5", effort: "medium", required: false },
	] as const)("retains $id model-specific reasoning capabilities", ({ id, effort, required }) => {
		expect(modelInfoSchema.parse(anthropicModels[id])).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			requiredReasoningEffort: required,
			reasoningEffort: effort,
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			supportsTemperature: false,
			preserveReasoning: true,
		})
	})

	it("records verified Haiku pricing on both sides of the 100k input threshold", () => {
		expect(anthropicModels["claude-haiku-5-5"]).toMatchObject({
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
		})
	})
})
