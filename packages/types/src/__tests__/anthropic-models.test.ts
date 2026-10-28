import { describe, expect, it } from "vitest"

import { modelInfoSchema } from "../model.js"
import { anthropicDefaultModelId, anthropicModels } from "../providers/anthropic.js"

describe("direct Anthropic catalog", () => {
	it("advertises the verified frontier models and keeps the Opus default", () => {
		expect(Object.keys(anthropicModels)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])
		expect(anthropicDefaultModelId).toBe("claude-opus-5-5")
	})

	it.each([
		{ id: "claude-opus-5-5", effort: "medium", required: true },
		{ id: "claude-sonnet-5-5", effort: "high", required: true },
		{ id: "claude-fable-5-1", effort: "high", required: true },
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

	it("records Fable's verified native prompt-cache rates", () => {
		expect(anthropicModels["claude-fable-5-1"]).toMatchObject({
			inputPrice: 10,
			outputPrice: 50,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 0.25,
			minTokensPerCachePoint: 512,
		})
	})
})
