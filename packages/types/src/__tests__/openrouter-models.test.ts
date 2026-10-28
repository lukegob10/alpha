import { describe, expect, it } from "vitest"
import { modelInfoSchema } from "../model.js"
import { openRouterModels, openRouterDefaultModelId } from "../providers/openrouter.js"

describe("curated OpenRouter model contracts", () => {
	it("publishes a small explicit catalog with a supported default", () => {
		expect(Object.keys(openRouterModels)).toEqual([
			"openai/gpt-6.1-sol",
			"anthropic/claude-sonnet-5.5",
			"google/gemini-4-argon",
			"openai/gpt-6-astra",
			"openai/gpt-5.6-sol",
			"openai/gpt-5.6-terra",
			"openai/gpt-5.6-luna",
			"x-ai/grok-4.7",
			"anthropic/claude-opus-5.5",
			"anthropic/claude-fable-5.1",
			"moonshotai/kimi-k3.1-pro",
			"meta/muse-wonder",
		])
		expect(Object.hasOwn(openRouterModels, openRouterDefaultModelId)).toBe(true)
	})

	it.each(Object.entries(openRouterModels))("keeps %s reasoning replayable through saved metadata", (_id, info) => {
		expect(modelInfoSchema.parse(JSON.parse(JSON.stringify(info)))).toEqual(info)
		expect(info.supportsReasoningEffort).toContain(info.reasoningEffort)
		const efforts: readonly string[] = info.supportsReasoningEffort
		expect(efforts.includes("none")).toBe(!info.requiredReasoningEffort)
		expect(info.preserveReasoning).toBe(true)
	})

	it.each([
		["openai/gpt-6.1-sol", 2, 10],
		["openai/gpt-6-astra", 10, 50],
	])("uses verified router capabilities and pricing for %s", (id, inputPrice, outputPrice) => {
		const info = openRouterModels[id as keyof typeof openRouterModels]
		expect(info).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			requiredReasoningEffort: true,
			reasoningEffort: "medium",
			supportsTemperature: false,
			inputPrice,
			outputPrice,
		})
		expect(info.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
	})

	it("keeps frontier Claude reasoning and router cache prices explicit", () => {
		expect(openRouterModels["anthropic/claude-fable-5.1"]).toMatchObject({
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			inputPrice: 10,
			outputPrice: 50,
			cacheReadsPrice: 0.25,
			cacheWritesPrice: 12.5,
		})
		expect(openRouterModels["anthropic/claude-opus-5.5"]).toMatchObject({
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			inputPrice: 4,
			outputPrice: 20,
		})
	})

	it.each(["x-ai/grok-4.7"] as const)("retains route-specific output and pricing limits for %s", (id) => {
		expect(openRouterModels[id]).toMatchObject({
			contextWindow: 500_000,
			maxTokens: 450_000,
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			inputPrice: 2,
			outputPrice: 6,
			longContextPricing: { thresholdTokens: 200_000, inputPriceMultiplier: 2, outputPriceMultiplier: 2 },
		})
	})

	it("does not infer native-provider effort levels for the Gemini route", () => {
		expect(openRouterModels["google/gemini-4-argon"].supportsReasoningEffort).toEqual(["low", "medium", "high"])
		expect(openRouterModels["google/gemini-4-argon"].supportsReasoningEffort).not.toContain("max")
		expect(openRouterModels["google/gemini-4-argon"]).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 943_718,
			contextWindowIncludesOutput: true,
		})
	})

	it.each(["moonshotai/kimi-k3.1-pro"] as const)(
		"exposes only the verified required reasoning levels for %s",
		(id) => {
			const info = openRouterModels[id]
			expect(info).toMatchObject({
				contextWindow: 1_048_576,
				requiredReasoningEffort: true,
				reasoningEffort: "max",
				supportsReasoningEffort: ["low", "high", "max"],
				supportsPromptCache: true,
				supportsStreaming: true,
				supportsVerbosity: false,
			})
			expect(info.supportsReasoningEffort).not.toContain("none")
			expect(info.supportsReasoningEffort).not.toContain("medium")
			expect(info.supportsReasoningEffort).not.toContain("xhigh")
		},
	)

	it.each([["moonshotai/kimi-k3.1-pro", 2, 10, 0.2, 943_718]] as const)(
		"keeps router pricing and output metadata for %s",
		(id, inputPrice, outputPrice, cacheReadsPrice, maxTokens) => {
			expect(openRouterModels[id]).toMatchObject({ inputPrice, outputPrice, cacheReadsPrice, maxTokens })
			// The router does not publish one shared cache-write price across these endpoints.
			expect(openRouterModels[id]).not.toHaveProperty("cacheWritesPrice")
		},
	)

	it("keeps model-specific vision and sampling controls separate", () => {
		expect(openRouterModels["moonshotai/kimi-k3.1-pro"]).toMatchObject({
			supportsImages: true,
			supportsTemperature: false,
		})
		expect(openRouterModels["meta/muse-wonder"]).toMatchObject({
			supportsImages: true,
			supportsTemperature: true,
			maxTokens: 943_718,
			requiredReasoningEffort: true,
			supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max"],
		})
		expect(openRouterModels["moonshotai/kimi-k3.1-pro"]).not.toHaveProperty("defaultTemperature")
	})
})
