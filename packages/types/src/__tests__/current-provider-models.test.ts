import { anthropicModels } from "../providers/anthropic.js"
import { geminiModels } from "../providers/gemini.js"
import { openAiNativeModels } from "../providers/openai.js"
import { VERTEX_1M_CONTEXT_MODEL_IDS, vertexDefaultModelId, vertexModels } from "../providers/vertex.js"
import {
	getVscodeLlmCatalogModels,
	getVscodeLlmExtendedContextSize,
	getVscodeLlmModelInfo,
	mergeVscodeLlmModels,
	vscodeLlmModels,
} from "../providers/vscode-llm.js"

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
				"xai/grok-4.6",
				"claude-fable-5",
				"claude-opus-5",
				"claude-sonnet-5",
				"claude-sonnet-4-6",
				"claude-opus-4-6",
				"claude-opus-4-8",
				"claude-opus-4-7",
			])
			expect(vertexDefaultModelId).toBe("claude-sonnet-5")
		})

		it("models Grok 4.6 as a global OpenAI-compatible Vertex partner model", () => {
			expect(vertexModels["xai/grok-4.6"]).toEqual(
				expect.objectContaining({
					contextWindow: 524_288,
					maxTokens: 65_536,
					supportsImages: true,
					supportsStreaming: true,
					supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
				}),
			)
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
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
		] as const

		it("includes the current Claude IDs in both Anthropic and Vertex AI", () => {
			expect(Object.keys(anthropicModels)).toEqual(expect.arrayContaining([...currentClaudeIds]))
			expect(Object.keys(vertexModels)).toEqual(expect.arrayContaining([...currentClaudeIds]))
			expect(anthropicModels).not.toHaveProperty("claude-mythos-5")
			expect(vertexModels).not.toHaveProperty("claude-mythos-5")
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
			"gpt-5-mini",
			"gpt-5.3-codex",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"claude-fable-5",
			"claude-haiku-4.5",
			"claude-sonnet-4.5",
			"claude-sonnet-4.6",
			"claude-sonnet-5",
			"claude-opus-4.5",
			"claude-opus-4.6",
			"claude-opus-4.7",
			"claude-opus-4.8",
			"claude-opus-4.8-fast",
			"claude-opus-5",
			"gemini-3.1-pro",
			"gemini-3.5-flash",
			"gemini-3.6-flash",
			"gemini-3.7-flash",
			"mai-code-1-flash",
			"mai-code-1.1-flash",
			"raptor-mini",
			"kimi-k2.7-code",
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
					contextWindow: 200_000,
					supportsImages: true,
					supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
					supportsContextWindowConfiguration: true,
					extendedContextSize: 936_000,
				}),
			)
			expect(vscodeLlmModels["claude-sonnet-4.6"].supportsReasoningEffort).toEqual([
				"low",
				"medium",
				"high",
				"max",
			])
			expect(vscodeLlmModels["claude-haiku-4.5"].supportsImages).toBe(true)
			expect(vscodeLlmModels["claude-opus-4.8-fast"].name).toBe("Claude Opus 4.8 (fast mode) (Preview)")
			expect(vscodeLlmModels["kimi-k3"]).toEqual(
				expect.objectContaining({
					contextWindow: 917_504,
					supportsImages: true,
					supportsReasoningEffort: ["low", "high", "max"],
				}),
			)
			expect(vscodeLlmModels["kimi-k3"].supportsContextWindowConfiguration).toBe(false)
			expect(vscodeLlmModels["mai-code-1.1-flash"]).toEqual(
				expect.objectContaining({ supportsImages: true, supportsReasoningEffort: ["low", "medium", "high"] }),
			)
			expect(vscodeLlmModels["gpt-5.4"]).toEqual(
				expect.objectContaining({
					supportsImages: true,
					supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
				}),
			)
			expect(vscodeLlmModels["gemini-3.1-pro"]).toEqual(
				expect.objectContaining({
					name: "Gemini 3.1 Pro (Preview)",
					contextWindow: 200_000,
					extendedContextSize: 936_000,
					supportsContextWindowConfiguration: true,
				}),
			)
			expect(vscodeLlmModels["gemini-3.5-flash"].contextWindow).toBe(200_000)
			expect(vscodeLlmModels["grok-4.6"]).toEqual(
				expect.objectContaining({
					contextWindow: 200_000,
					extendedContextSize: 425_001,
					supportsContextWindowConfiguration: true,
				}),
			)
			expect(vscodeLlmModels["gpt-5.6-luna"].contextWindow).toBe(200_000)
			expect(getVscodeLlmExtendedContextSize({ family: "gpt-5.5", vendor: "copilot" })).toBeUndefined()
			expect(
				getVscodeLlmExtendedContextSize({
					family: "gpt-5.5",
					vendor: "copilot",
					maxInputTokens: 921_793,
				}),
			).toBe(922_000)
			expect(
				getVscodeLlmExtendedContextSize({
					family: "claude-opus-4.8",
					vendor: "copilot",
					maxInputTokens: 936_000,
				}),
			).toBe(936_000)
		})

		it("provides a current catalog fallback without retired or fictitious models", () => {
			const catalogFamilies = getVscodeLlmCatalogModels().map((model) => model.family)

			expect(catalogFamilies).toEqual(
				expect.arrayContaining([
					"gpt-5.3-codex",
					"gpt-5.5",
					"gpt-5.6-luna",
					"gpt-5.6-sol",
					"gpt-5.6-terra",
					"claude-opus-4.6",
					"claude-opus-4.7",
					"claude-opus-4.8",
					"claude-sonnet-4.6",
				]),
			)
			expect(catalogFamilies).not.toContain("gpt-5.4-nano")
			expect(catalogFamilies).not.toContain("claude-mythos-5")
		})

		it("preserves distinct live model IDs, deduplicates exact identities, and filters Mythos", () => {
			const models = mergeVscodeLlmModels([
				{
					vendor: "copilot",
					family: "gpt-5.5",
					id: "copilot-gpt-5.5-standard",
					maxInputTokens: 272_000,
				},
				{
					vendor: "copilot",
					family: "gpt-5.5",
					id: "copilot-gpt-5.5-extended",
					maxInputTokens: 921_793,
				},
				{
					vendor: "copilot",
					family: "gpt-5.5",
					id: "copilot-gpt-5.5-standard",
					maxInputTokens: 271_000,
				},
				{
					vendor: "copilot",
					family: "claude-mythos-5",
					id: "claude-mythos-5",
				},
			])
			const gpt55Models = models.filter((model) => getVscodeLlmModelInfo(model) === vscodeLlmModels["gpt-5.5"])

			expect(gpt55Models).toEqual([
				expect.objectContaining({ id: "copilot-gpt-5.5-standard", maxInputTokens: 272_000 }),
				expect.objectContaining({ id: "copilot-gpt-5.5-extended", maxInputTokens: 921_793 }),
			])
			expect(models.some((model) => JSON.stringify(model).includes("mythos"))).toBe(false)
		})

		it("never turns the static catalog into selectable live models", () => {
			expect(mergeVscodeLlmModels([])).toEqual([])
		})

		it("recognizes the opaque Raptor selector returned by Copilot", () => {
			expect(getVscodeLlmModelInfo({ vendor: "copilot", family: "oswe-vscode", id: "oswe-vscode-prime" })).toBe(
				vscodeLlmModels["raptor-mini"],
			)
		})

		it("keeps retired Gemini models only as deprecated compatibility metadata", () => {
			expect(vscodeLlmModels["gemini-2.5-pro"].deprecated).toBe(true)
			expect(vscodeLlmModels["gemini-3-flash"].deprecated).toBe(true)
		})
	})
})
