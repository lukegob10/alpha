import type { ModelInfo } from "@alpha-code/types"

import { getModelParams } from "../model-params"

const optionalModel: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	supportsReasoningEffort: ["none", "low", "medium", "high"],
	requiredReasoningEffort: false,
	reasoningEffort: "medium",
}

describe("optional OpenAI-format reasoning", () => {
	it.each([
		{ enableReasoningEffort: false },
		{ reasoningEffort: "disable" as const },
		{ enableReasoningEffort: false, reasoningEffort: "high" as const },
	])("serializes explicit Off without re-enabling the API default for %j", (settings) => {
		const saved = structuredClone(settings)
		const result = getModelParams({
			format: "openai",
			modelId: "optional-frontier",
			model: optionalModel,
			settings,
			defaultTemperature: 0,
		})
		expect(result.reasoningEffort).toBe("none")
		expect(result.reasoning).toEqual({ reasoning_effort: "none" })
		expect(settings).toEqual(saved)
	})

	it("retains omission for optional models that do not declare a named zero-effort level", () => {
		const result = getModelParams({
			format: "openai",
			modelId: "legacy-optional-model",
			model: { ...optionalModel, supportsReasoningEffort: ["low", "medium", "high"] },
			settings: { enableReasoningEffort: false },
			defaultTemperature: 0,
		})
		expect(result.reasoning).toBeUndefined()
	})

	it("does not change the default unless the user explicitly turns reasoning off", () => {
		const result = getModelParams({
			format: "openai",
			modelId: "optional-frontier",
			model: optionalModel,
			settings: {},
			defaultTemperature: 0,
		})
		expect(result.reasoning).toEqual({ reasoning_effort: "medium" })
	})
})
