import { describe, expect, it } from "vitest"

import { modelInfoSchema } from "../model.js"
import { resolveXaiModelInfo, xaiDefaultModelId, xaiModels } from "../providers/xai.js"

describe("curated xAI models", () => {
	it("retains Grok 4.7 as the default alongside the explicit Grok 4.6 route", () => {
		expect(xaiDefaultModelId).toBe("grok-4.7")
		expect(Object.keys(xaiModels)).toEqual(["grok-4.7", "grok-4.6"])
	})

	it.each(["grok-4.7", "grok-4.6"] as const)("advertises %s with its verified mandatory reasoning levels", (id) => {
		expect(resolveXaiModelInfo(id)).toMatchObject({
			contextWindow: 500_000,
			maxTokens: 128_000,
			supportsImages: true,
			supportsTemperature: true,
			supportsVerbosity: false,
			supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			reasoningEffort: "high",
			requiredReasoningEffort: true,
			preserveReasoning: true,
		})
		expect(modelInfoSchema.safeParse(xaiModels[id]).success).toBe(true)
	})

	it.each(["grok-latest", "grok-unknown", "__proto__", "toString"])(
		"rejects unsupported saved model %s without substituting a different model",
		(modelId) => {
			expect(() => resolveXaiModelInfo(modelId)).toThrow("Unsupported xAI model")
		},
	)
})
