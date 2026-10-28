import { modelInfoSchema } from "../model.js"
import { openAiNativeDefaultModelId, openAiNativeModels } from "../providers/openai-native.js"
import { getNativeOpenAiModelCapabilities } from "../providers/openai.js"

describe("curated native OpenAI models", () => {
	it("contains only explicitly verified model IDs", () => {
		expect(Object.keys(openAiNativeModels)).toEqual([
			"gpt-6.1-sol",
			"gpt-6-astra",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		])
		expect(openAiNativeDefaultModelId).toBe("gpt-6.1-sol")
	})

	it.each(Object.entries(openAiNativeModels))("validates %s with model-owned reasoning capabilities", (id, model) => {
		expect(modelInfoSchema.parse(model)).toMatchObject({
			contextWindow: 922_000,
			contextWindowIncludesOutput: false,
			maxTokens: 128_000,
			supportsReasoningEffort: id.startsWith("gpt-5.6-")
				? ["none", "low", "medium", "high", "xhigh", "max"]
				: ["low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: !id.startsWith("gpt-5.6-"),
		})
		expect(model.reasoningEffort).toBe("medium")
		expect(model.supportsTemperature).toBe(false)
		expect(getNativeOpenAiModelCapabilities(id)).toEqual({ responses: true, freeformApplyPatch: true })
	})

	it.each([
		["gpt-6.1-sol", 2, 10, 0.1, 2.5],
		["gpt-6-astra", 10, 50, 1, 12.5],
		["gpt-5.6-sol", 4, 20, 0.4, 5],
		["gpt-5.6-terra", 2, 12, 0.2, 2.5],
		["gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
	] as const)(
		"keeps verified Standard prices and long-context multipliers for %s",
		(id, input, output, read, write) => {
			expect(openAiNativeModels[id]).toMatchObject({
				inputPrice: input,
				outputPrice: output,
				cacheReadsPrice: read,
				cacheWritesPrice: write,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheReadsPriceMultiplier: 2,
					cacheWritesPriceMultiplier: 2,
				},
			})
		},
	)
})
