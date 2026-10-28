import { modelInfoSchema } from "../model.js"
import { openAiNativeDefaultModelId, openAiNativeModels } from "../providers/openai-native.js"
import { getNativeOpenAiModelCapabilities } from "../providers/openai.js"

describe("curated native OpenAI models", () => {
	it("contains only explicitly verified frontier model IDs", () => {
		expect(Object.keys(openAiNativeModels)).toEqual(["gpt-6.1-sol", "gpt-6-astra"])
		expect(openAiNativeDefaultModelId).toBe("gpt-6.1-sol")
	})

	it.each(Object.entries(openAiNativeModels))("validates %s with model-owned reasoning capabilities", (id, model) => {
		expect(modelInfoSchema.parse(model)).toMatchObject({
			contextWindow: 922_000,
			contextWindowIncludesOutput: false,
			maxTokens: 128_000,
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: true,
		})
		expect(model.reasoningEffort).toBe("medium")
		expect(model.supportsTemperature).toBe(false)
		expect(getNativeOpenAiModelCapabilities(id)).toEqual({ responses: true, freeformApplyPatch: true })
	})

	it.each([
		["gpt-6.1-sol", 2, 10, 0.1, 2.5],
		["gpt-6-astra", 10, 50, 1, 12.5],
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
