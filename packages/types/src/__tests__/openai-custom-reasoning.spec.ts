import { describe, expect, it } from "vitest"
import { resolveOpenAiCustomModelInfo, openAiCustomReasoningEfforts } from "../providers/openai.js"
import { modelInfoSchema, type ModelInfo } from "../model.js"

describe("custom OpenAI reasoning declarations", () => {
	it("reads legacy defaults without mutating metadata", () => {
		const info: ModelInfo = { contextWindow: 128_000, supportsPromptCache: false, reasoningEffort: "low" }
		expect(resolveOpenAiCustomModelInfo(info).supportsReasoningEffort).toEqual(openAiCustomReasoningEfforts)
		expect(info.supportsReasoningEffort).toBeUndefined()
	})

	it.each<Partial<ModelInfo>>([
		{},
		{ supportsReasoningEffort: false, reasoningEffort: "low" },
		{ supportsReasoningEffort: [], reasoningEffort: "low" },
		{ supportsReasoningEffort: ["none", "high"], reasoningEffort: "high" },
		{ supportsReasoningBudget: true, reasoningEffort: "low" },
		{ requiredReasoningBudget: true, reasoningEffort: "low" },
		{ supportsReasoningBinary: true, reasoningEffort: "low" },
	])("preserves explicit or unknown capabilities: %j", (fields) => {
		const info: ModelInfo = { contextWindow: 128_000, supportsPromptCache: false, ...fields }
		expect(resolveOpenAiCustomModelInfo(info)).toBe(info)
	})

	it("retains declared levels through schema validation and serialization", () => {
		const info = {
			contextWindow: 128_000,
			supportsPromptCache: false,
			supportsReasoningEffort: [...openAiCustomReasoningEfforts],
		}
		expect(modelInfoSchema.parse(JSON.parse(JSON.stringify(info)))).toEqual(info)
	})
})
