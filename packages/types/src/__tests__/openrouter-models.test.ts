import { describe, expect, it } from "vitest"
import { modelInfoSchema } from "../model.js"
import { openRouterModels, openRouterDefaultModelId } from "../providers/openrouter.js"

describe("curated OpenRouter model contracts", () => {
	it("publishes a small explicit catalog with a supported default", () => {
		expect(Object.keys(openRouterModels)).toEqual([
			"openai/gpt-6.1-sol",
			"anthropic/claude-sonnet-5.5",
			"google/gemini-3.8-flash",
			"openai/gpt-6-luna",
			"openai/gpt-5.6-sol",
			"openai/gpt-5.6-terra",
			"openai/gpt-5.6-luna",
			"x-ai/grok-4.6",
			"x-ai/grok-4.7",
			"anthropic/claude-opus-5.5",
			"anthropic/claude-haiku-5.5",
			"moonshotai/kimi-k3.1-pro",
			"moonshotai/kimi-k3",
			"z-ai/glm-5.3",
			"z-ai/glm-5.3-flash",
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
		["openai/gpt-6-luna", 0.1, 0.5],
		["openai/gpt-5.6-sol", 4, 20],
		["openai/gpt-5.6-terra", 2, 12],
		["openai/gpt-5.6-luna", 0.2, 1.2],
	])("uses verified router capabilities and pricing for %s", (id, inputPrice, outputPrice) => {
		const info = openRouterModels[id as keyof typeof openRouterModels]
		expect(info).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			requiredReasoningEffort: false,
			reasoningEffort: "medium",
			supportsTemperature: false,
			inputPrice,
			outputPrice,
		})
		expect(info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
	})

	it("keeps Haiku's router Off option and prompt-length pricing tier explicit", () => {
		expect(openRouterModels["anthropic/claude-haiku-5.5"]).toMatchObject({
			requiredReasoningEffort: false,
			reasoningEffort: "medium",
			inputPrice: 0.1,
			outputPrice: 0.5,
			longContextPricing: { thresholdTokens: 100_000, inputPriceMultiplier: 5, outputPriceMultiplier: 5 },
		})
		expect(openRouterModels["anthropic/claude-opus-5.5"]).toMatchObject({
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			inputPrice: 4,
			outputPrice: 20,
		})
	})

	it.each(["x-ai/grok-4.6", "x-ai/grok-4.7"] as const)(
		"retains route-specific output and pricing limits for %s",
		(id) => {
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
		},
	)

	it("does not infer native-provider effort levels for the Gemini route", () => {
		expect(openRouterModels["google/gemini-3.8-flash"].supportsReasoningEffort).toEqual(["low", "medium", "high"])
		expect(openRouterModels["google/gemini-3.8-flash"].supportsReasoningEffort).not.toContain("max")
	})

	it.each(["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3", "z-ai/glm-5.3", "z-ai/glm-5.3-flash"] as const)(
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

	it.each([
		["moonshotai/kimi-k3.1-pro", 2, 10, 0.2, 943_718],
		["moonshotai/kimi-k3", 0.239, 10.8, 0.21, 943_718],
		["z-ai/glm-5.3", 0.079, 1.4, 0.078, 943_718],
		["z-ai/glm-5.3-flash", 0.15, 0.5, 0.03, 943_717],
	] as const)(
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
		expect(openRouterModels["moonshotai/kimi-k3"]).toMatchObject({
			supportsImages: true,
			supportsTemperature: true,
		})
		expect(openRouterModels["moonshotai/kimi-k3"]).not.toHaveProperty("defaultTemperature")
		expect(openRouterModels["z-ai/glm-5.3"]).toMatchObject({
			supportsImages: false,
			supportsTemperature: true,
			defaultTemperature: 1,
		})
		expect(openRouterModels["z-ai/glm-5.3-flash"]).toMatchObject({
			supportsImages: true,
			supportsTemperature: true,
			defaultTemperature: 1,
		})
	})
})
