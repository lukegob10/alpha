// npx vitest run src/api/transform/__tests__/reasoning.spec.ts

import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import {
	getAnthropicReasoning,
	getOpenAiReasoning,
	getAlphaReasoning,
	getGeminiReasoning,
	type GetModelReasoningOptions,
	type AnthropicReasoningParams,
	type OpenAiReasoningParams,
	type AlphaReasoningParams,
	type GeminiReasoningParams,
} from "../reasoning"

describe("reasoning transforms", () => {
	const baseModel: ModelInfo = {
		contextWindow: 16000,
		supportsPromptCache: true,
	}

	const options = (overrides: Partial<GetModelReasoningOptions> = {}): GetModelReasoningOptions => ({
		model: baseModel,
		reasoningBudget: 1000,
		reasoningEffort: "medium",
		settings: {},
		...overrides,
	})

	describe("Anthropic", () => {
		it("enables budget reasoning for required budget models", () => {
			const result: AnthropicReasoningParams | undefined = getAnthropicReasoning(
				options({ model: { ...baseModel, requiredReasoningBudget: true } }),
			)

			expect(result).toEqual({ type: "enabled", budget_tokens: 1000 })
		})

		it("enables budget reasoning when the model supports it and settings allow it", () => {
			const result = getAnthropicReasoning(
				options({
					model: { ...baseModel, supportsReasoningBudget: true },
					settings: { enableReasoningEffort: true },
				}),
			)

			expect(result).toEqual({ type: "enabled", budget_tokens: 1000 })
		})

		it("omits reasoning when the model has no budget capability", () => {
			expect(getAnthropicReasoning(options())).toBeUndefined()
		})
	})

	describe("OpenAI compatible", () => {
		it("uses the selected reasoning effort", () => {
			const result: OpenAiReasoningParams | undefined = getOpenAiReasoning(
				options({
					model: { ...baseModel, supportsReasoningEffort: true },
					settings: { reasoningEffort: "high" },
					reasoningEffort: "high",
				}),
			)

			expect(result).toEqual({ reasoning_effort: "high" })
		})

		it("uses the model effort when no setting overrides it", () => {
			const result = getOpenAiReasoning(
				options({
					model: { ...baseModel, supportsReasoningEffort: true, reasoningEffort: "low" },
					reasoningEffort: "low",
				}),
			)

			expect(result).toEqual({ reasoning_effort: "low" })
		})

		it("omits disabled or unsupported reasoning", () => {
			expect(
				getOpenAiReasoning(
					options({
						model: { ...baseModel, supportsReasoningEffort: true },
						reasoningEffort: "disable",
					}),
				),
			).toBeUndefined()
			expect(getOpenAiReasoning(options())).toBeUndefined()
		})
	})

	describe("Gemini transport", () => {
		it("uses a thinking budget for budget models", () => {
			const result: GeminiReasoningParams | undefined = getGeminiReasoning(
				options({ model: { ...baseModel, requiredReasoningBudget: true } }),
			)

			expect(result).toEqual({ thinkingBudget: 1000, includeThoughts: true })
		})

		it("maps supported effort to a thinking level", () => {
			const result = getGeminiReasoning(
				options({
					model: { ...baseModel, supportsReasoningEffort: true },
					settings: { reasoningEffort: "high" },
					reasoningEffort: "high",
				}),
			)

			expect(result).toEqual({ thinkingLevel: "HIGH", includeThoughts: true })
		})

		it("falls back to the model effort when a selected level is unsupported", () => {
			const result = getGeminiReasoning(
				options({
					model: {
						...baseModel,
						supportsReasoningEffort: ["low", "high"],
						reasoningEffort: "low",
					},
					settings: { reasoningEffort: "medium" },
					reasoningEffort: "medium",
				}),
			)

			expect(result).toEqual({ thinkingLevel: "LOW", includeThoughts: true })
		})

		it("omits disabled or unavailable thinking", () => {
			expect(
				getGeminiReasoning(
					options({
						model: { ...baseModel, supportsReasoningEffort: true },
						reasoningEffort: "disable",
					}),
				),
			).toBeUndefined()
			expect(getGeminiReasoning(options())).toBeUndefined()
		})
	})

	describe("Alpha compatibility", () => {
		it("enables required effort reasoning", () => {
			const result: AlphaReasoningParams | undefined = getAlphaReasoning(
				options({
					model: { ...baseModel, supportsReasoningEffort: true, requiredReasoningEffort: true },
				}),
			)

			expect(result).toEqual({ enabled: true, effort: "medium" })
		})

		it("returns an explicit disabled state when effort is turned off", () => {
			const result = getAlphaReasoning(
				options({
					model: { ...baseModel, supportsReasoningEffort: true },
					settings: { enableReasoningEffort: false } as ProviderSettings,
				}),
			)

			expect(result).toEqual({ enabled: false })
		})
	})
})
