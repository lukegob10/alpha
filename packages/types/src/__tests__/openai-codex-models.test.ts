import { openAiCodexModels } from "../providers/openai-codex.js"

describe("openAiCodexModels", () => {
	it("exposes GPT-5.3 Codex reasoning effort levels", () => {
		const modelInfo = openAiCodexModels["gpt-5.3-codex"]

		expect(modelInfo.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh"])
		expect(modelInfo.reasoningEffort).toBe("medium")
	})
})
