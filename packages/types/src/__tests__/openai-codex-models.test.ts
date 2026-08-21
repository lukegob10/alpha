import { openAiCodexDefaultModelId, openAiCodexModels } from "../providers/openai-codex.js"

describe("openAiCodexModels", () => {
	it("uses GPT-5.6 Sol as the ChatGPT subscription default", () => {
		expect(openAiCodexDefaultModelId).toBe("gpt-5.6-sol")
	})

	it.each([
		["gpt-5.6-sol", "low", ["low", "medium", "high", "xhigh", "max"]],
		["gpt-5.6-terra", "medium", ["low", "medium", "high", "xhigh", "max"]],
		["gpt-5.6-luna", "medium", ["low", "medium", "high", "xhigh", "max"]],
		["gpt-5.5", "medium", ["low", "medium", "high", "xhigh"]],
	] as const)("exposes current Codex model metadata for %s", (modelId, defaultEffort, supportedEfforts) => {
		const modelInfo = openAiCodexModels[modelId]

		expect(modelInfo.contextWindow).toBe(272_000)
		expect(modelInfo.maxTokens).toBe(128_000)
		expect(modelInfo.supportsImages).toBe(true)
		expect(modelInfo.supportsPromptCache).toBe(true)
		expect(modelInfo.supportsReasoningEffort).toEqual(supportedEfforts)
		expect(modelInfo.reasoningEffort).toBe(defaultEffort)
	})

	it("marks models deprecated by ChatGPT sign-in as unavailable for new selection", () => {
		expect(openAiCodexModels["gpt-5.3-codex"].deprecated).toBe(true)
		expect(openAiCodexModels["gpt-5.2"].deprecated).toBe(true)
	})
})
