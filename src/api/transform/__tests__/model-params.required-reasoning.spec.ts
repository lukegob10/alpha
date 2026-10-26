import type { ModelInfo } from "@alpha-code/types"

import { getModelParams } from "../model-params"

const model: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	supportsReasoningEffort: ["low", "medium", "high"],
	requiredReasoningEffort: true,
	reasoningEffort: "medium",
}

describe("required model reasoning at the adapter boundary", () => {
	it.each([
		{ enableReasoningEffort: false },
		{ reasoningEffort: "disable" as const },
		{ reasoningEffort: "max" as const },
		{ enableReasoningEffort: false, reasoningEffort: "high" as const },
	])("retains a supported effort for %j", (settings) => {
		const saved = structuredClone(settings)
		const result = getModelParams({
			format: "openai",
			modelId: "frontier-model",
			model,
			settings,
			defaultTemperature: 0,
		})
		expect(result.reasoningEffort).toBe(settings.reasoningEffort === "high" ? "high" : "medium")
		expect(result.reasoning).toEqual({ reasoning_effort: result.reasoningEffort })
		expect(settings).toEqual(saved)
	})

	it("uses the first advertised effort only when a required model has no default", () => {
		const result = getModelParams({
			format: "openai",
			modelId: "frontier-model",
			model: { ...model, reasoningEffort: undefined },
			settings: {},
			defaultTemperature: 0,
		})
		expect(result.reasoning).toEqual({ reasoning_effort: "low" })
	})

	it("keeps optional reasoning disabled when the user turns it off", () => {
		const result = getModelParams({
			format: "openai",
			modelId: "optional-model",
			model: { ...model, requiredReasoningEffort: false },
			settings: { enableReasoningEffort: false, reasoningEffort: "high" },
			defaultTemperature: 0,
		})
		expect(result.reasoning).toBeUndefined()
	})

	it.each(["disable", "max"] as const)(
		"maps unsupported Gemini %s to the required model default",
		(reasoningEffort) => {
			const result = getModelParams({
				format: "gemini",
				modelId: "frontier-gemini",
				model,
				settings: { reasoningEffort, enableReasoningEffort: false },
				defaultTemperature: 1,
			})
			expect(result.reasoningEffort).toBe("medium")
			expect(result.reasoning).toEqual({ thinkingLevel: "MEDIUM", includeThoughts: true })
		},
	)
})
