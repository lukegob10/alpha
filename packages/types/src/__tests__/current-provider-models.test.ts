import { anthropicModels } from "../providers/anthropic.js"
import { geminiModels } from "../providers/gemini.js"
import { openAiNativeModels } from "../providers/openai.js"
import { VERTEX_1M_CONTEXT_MODEL_IDS, vertexDefaultModelId, vertexModels } from "../providers/vertex.js"
import { getVscodeLlmModelInfo, vscodeLlmModels } from "../providers/vscode-llm.js"

describe("current provider model catalogs", () => {
	describe("OpenAI", () => {
		it("includes the current GPT and pro model IDs", () => {
			expect(Object.keys(openAiNativeModels)).toEqual(
				expect.arrayContaining([
					"gpt-5.6",
					"gpt-5.6-sol",
					"gpt-5.6-terra",
					"gpt-5.6-luna",
					"gpt-5.5",
					"gpt-5.5-pro",
					"gpt-5.4-pro",
					"gpt-5.2-pro",
					"gpt-5-pro",
					"o3-pro",
				]),
			)
		})

		it("uses the published GPT-5.6 Sol capabilities and pricing", () => {
			expect(openAiNativeModels["gpt-5.6-sol"]).toEqual(
				expect.objectContaining({
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					inputPrice: 4,
					outputPrice: 20,
					cacheReadsPrice: 0.4,
					cacheWritesPrice: 5,
					supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
				}),
			)
		})

		it("marks models without streaming support for completed-response adaptation", () => {
			expect(openAiNativeModels["gpt-5.5-pro"].supportsStreaming).toBe(false)
			expect(openAiNativeModels["o3-pro"].supportsStreaming).toBe(false)
		})
	})

	describe("Gemini", () => {
		it("includes every current conversational Gemini model in the Gemini API catalog", () => {
			expect(Object.keys(geminiModels)).toEqual(
				expect.arrayContaining([
					"gemini-3.7-flash",
					"gemini-3.6-flash",
					"gemini-3.5-flash",
					"gemini-3.5-flash-lite",
					"gemini-3.1-flash-lite",
					"gemini-3.1-pro-preview",
					"gemini-3-flash-preview",
					"gemini-2.5-flash-lite",
				]),
			)
		})

		it("keeps only 2026 frontier models in Vertex AI", () => {
			expect(Object.keys(vertexModels)).toEqual([
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.1-pro-preview",
				"gemini-3.1-pro-preview-customtools",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.1-flash-lite",
				"claude-fable-5",
				"claude-mythos-5",
				"claude-opus-5",
				"claude-sonnet-5",
				"claude-sonnet-4-6",
				"claude-opus-4-6",
				"claude-opus-4-8",
				"claude-opus-4-7",
			])
			expect(vertexDefaultModelId).toBe("claude-sonnet-5")
		})

		it("models the distinct Gemini 3.7 and 3.6 thinking-level support", () => {
			expect(geminiModels["gemini-3.7-flash"].supportsReasoningEffort).toEqual(["low", "medium", "high"])
			expect(geminiModels["gemini-3.6-flash"].supportsReasoningEffort).toEqual([
				"minimal",
				"low",
				"medium",
				"high",
			])
			expect(geminiModels["gemini-3.7-flash"].supportsTemperature).toBe(false)
			expect(geminiModels["gemini-3.6-flash"].supportsTemperature).toBe(false)
		})
	})

	describe("Anthropic", () => {
		const currentClaudeIds = [
			"claude-fable-5",
			"claude-mythos-5",
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
		] as const

		it("includes the current Claude IDs in both Anthropic and Vertex AI", () => {
			expect(Object.keys(anthropicModels)).toEqual(expect.arrayContaining([...currentClaudeIds]))
			expect(Object.keys(vertexModels)).toEqual(expect.arrayContaining([...currentClaudeIds]))
		})

		it("uses the default 1M context and 128K output limits for Claude 4.7 and later", () => {
			for (const modelId of currentClaudeIds) {
				expect(anthropicModels[modelId].contextWindow).toBe(1_000_000)
				expect(anthropicModels[modelId].maxTokens).toBe(128_000)
				expect(anthropicModels[modelId].supportsTemperature).toBe(false)
			}

			expect(VERTEX_1M_CONTEXT_MODEL_IDS).not.toContain("claude-opus-4-7")
		})

		it("uses Anthropic's published Claude Sonnet 5 pricing", () => {
			expect(anthropicModels["claude-sonnet-5"]).toEqual(
				expect.objectContaining({
					inputPrice: 2,
					outputPrice: 10,
					cacheWritesPrice: 2.5,
					cacheReadsPrice: 0.2,
				}),
			)
		})
	})

	describe("VS Code LM / GitHub Copilot", () => {
		const currentCopilotModelIds = [
			"claude-opus-5",
			"gemini-3.6-flash",
			"gemini-3.7-flash",
			"mai-code-1.1-flash",
			"kimi-k3",
			"grok-4.5",
			"grok-4.6",
		] as const

		it("includes every current addition available to Copilot in Visual Studio Code", () => {
			expect(Object.keys(vscodeLlmModels)).toEqual(expect.arrayContaining([...currentCopilotModelIds]))
		})

		it("recognizes current models from the opaque selectors returned by VS Code", () => {
			for (const modelId of currentCopilotModelIds) {
				expect(
					getVscodeLlmModelInfo({
						vendor: "copilot",
						id: `copilot-${modelId}`,
					}),
				).toBe(vscodeLlmModels[modelId])
			}
		})

		it("models the extended capabilities exposed by current Copilot models", () => {
			expect(vscodeLlmModels["claude-opus-5"]).toEqual(
				expect.objectContaining({
					supportsImages: true,
					supportsReasoningEffort: ["low", "medium", "high"],
					supportsContextWindowConfiguration: true,
				}),
			)
			expect(vscodeLlmModels["kimi-k3"]).toEqual(
				expect.objectContaining({
					supportsImages: true,
					supportsReasoningEffort: ["low", "high", "max"],
					supportsContextWindowConfiguration: true,
				}),
			)
			expect(vscodeLlmModels["mai-code-1.1-flash"]).toEqual(
				expect.objectContaining({ contextWindow: 256_000, supportsImages: true }),
			)
		})

		it("keeps retired Gemini models only as deprecated compatibility metadata", () => {
			expect(vscodeLlmModels["gemini-2.5-pro"].deprecated).toBe(true)
			expect(vscodeLlmModels["gemini-3-flash"].deprecated).toBe(true)
		})
	})
})
