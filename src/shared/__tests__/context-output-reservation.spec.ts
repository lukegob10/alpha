import type { ModelInfo } from "@alpha-code/types"
import { getModelReservedOutputTokens } from "../api"

describe("context output reservation", () => {
	const model: ModelInfo = { contextWindow: 200_000, maxTokens: 100_000, supportsPromptCache: false }
	it("uses the same effective output cap as ordinary provider requests", () => {
		expect(getModelReservedOutputTokens({ modelId: "model", model })).toBe(40_000)
	})
	it("does not subtract output from a provider's dedicated input window", () => {
		expect(
			getModelReservedOutputTokens({ modelId: "model", model: { ...model, contextWindowIncludesOutput: false } }),
		).toBe(0)
	})
	it.each([undefined, -1, 0, Number.NaN, Infinity])("normalizes an unavailable output cap (%s)", (maxTokens) => {
		expect(getModelReservedOutputTokens({ modelId: "gpt-5", model: { ...model, maxTokens } })).toBe(8192)
	})
	it("honors the configured reasoning output budget", () => {
		expect(
			getModelReservedOutputTokens({
				modelId: "claude",
				model: { ...model, supportsReasoningBudget: true },
				settings: { enableReasoningEffort: true, modelMaxTokens: 16_384 },
			}),
		).toBe(16_384)
	})
})
