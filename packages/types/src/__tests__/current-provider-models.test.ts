import { stellarModels } from "../providers/stellar.js"
import { VERTEX_1M_CONTEXT_MODEL_IDS, vertexDefaultModelId, vertexModels } from "../providers/vertex.js"
import {
	getVscodeLlmCatalogModels,
	getVscodeLlmExtendedContextSize,
	getVscodeLlmModelId,
	getVscodeLlmModelInfo,
	mergeVscodeLlmModels,
	vscodeLlmModels,
} from "../providers/vscode-llm.js"

describe("supported provider model catalogs", () => {
	it("keeps the Vertex catalog and default model current", () => {
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
		expect(vertexModels["xai/grok-4.6"]).toEqual(
			expect.objectContaining({
				contextWindow: 524_288,
				maxTokens: 65_536,
				supportsImages: true,
				supportsStreaming: true,
				supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			}),
		)
		expect(VERTEX_1M_CONTEXT_MODEL_IDS).not.toContain("claude-opus-4-7")
	})

	it("keeps Stellar's supported model metadata", () => {
		expect(Object.keys(stellarModels)).toEqual(["Meta-Llama-3.3-70B-Instruct"])
		expect(stellarModels["Meta-Llama-3.3-70B-Instruct"]).toEqual(
			expect.objectContaining({ contextWindow: 131_072, supportsImages: false }),
		)
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
			"gpt-6-astra",
			"gpt-6-luna",
			"gpt-6-sol",
			"gpt-6.1-sol",
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

		it("includes current Copilot model metadata", () => {
			expect(Object.keys(vscodeLlmModels)).toEqual(expect.arrayContaining([...currentCopilotModelIds]))
		})

		it("recognizes current models from opaque selectors", () => {
			for (const modelId of currentCopilotModelIds) {
				expect(getVscodeLlmModelInfo({ vendor: "copilot", id: `copilot-${modelId}` })).toBe(
					vscodeLlmModels[modelId],
				)
			}
		})

		it("configures GPT-6 default and extended context plus reasoning levels", () => {
			const expectedReasoningEfforts = {
				"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
				"gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
				"gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
			} as const

			for (const [modelId, reasoningEfforts] of Object.entries(expectedReasoningEfforts)) {
				expect(vscodeLlmModels[modelId as keyof typeof vscodeLlmModels]).toEqual(
					expect.objectContaining({
						contextWindow: 272_000,
						supportsContextWindowConfiguration: true,
						extendedContextSize: 1_050_000,
						supportsReasoningEffort: reasoningEfforts,
					}),
				)
			}
		})

		it.each([
			{ family: "gpt-6.1-sol" },
			{ id: "gpt-6.1-sol" },
			{ version: "gpt-6.1-sol" },
			{ name: "GPT-6.1 Sol" },
		])("recognizes the observed GPT-6.1 Sol host identity %j", (identity) => {
			const model = { vendor: "copilot", ...identity }
			expect(getVscodeLlmModelId(model)).toBe("gpt-6.1-sol")
			expect(getVscodeLlmModelInfo(model)).toMatchObject({
				family: "gpt-6.1-sol",
				version: "gpt-6.1-sol",
				name: "GPT-6.1 Sol",
				contextWindow: 922_000,
				maxInputTokens: 922_000,
				supportsImages: true,
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			})
		})

		it("does not invent Sol 6.1 reasoning defaults or context-configuration support", () => {
			const model = getVscodeLlmModelInfo({ vendor: "copilot", family: "gpt-6.1-sol" })
			expect(model).toBeDefined()
			expect(model?.reasoningEffort).toBeUndefined()
			expect(model?.requiredReasoningEffort).not.toBe(true)
			expect(model?.supportsContextWindowConfiguration).not.toBe(true)
			expect(model?.extendedContextSize).toBeUndefined()
		})

		it("retains opaque Sol 6.1 live routing IDs while using the observed display name for capabilities", () => {
			const liveModels = [
				{ vendor: "copilot", id: "opaque-route-a", name: "GPT-6.1 Sol", maxInputTokens: 921_793 },
				{ vendor: "copilot", id: "opaque-route-b", name: "GPT-6.1 Sol", maxInputTokens: 64_000 },
			]
			const original = structuredClone(liveModels)
			const merged = mergeVscodeLlmModels(liveModels)

			expect(merged.map(({ id }) => id)).toEqual(["opaque-route-a", "opaque-route-b"])
			expect(merged.map(getVscodeLlmModelId)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"])
			expect(liveModels).toEqual(original)
		})

		it("keeps the Sol 6.1 capability catalog selector canonical without creating availability", () => {
			expect(getVscodeLlmCatalogModels()).toContainEqual({
				vendor: "copilot",
				family: "gpt-6.1-sol",
				name: "GPT-6.1 Sol",
			})
			expect(mergeVscodeLlmModels([])).toEqual([])
			expect(getVscodeLlmModelInfo({ vendor: "other", family: "gpt-6.1-sol" })).toBeUndefined()
		})

		it("preserves distinct live model IDs and filters retired models", () => {
			const models = mergeVscodeLlmModels([
				{ vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5-standard", maxInputTokens: 272_000 },
				{ vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5-extended", maxInputTokens: 921_793 },
				{ vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5-standard", maxInputTokens: 271_000 },
				{ vendor: "copilot", family: "claude-mythos-5", id: "claude-mythos-5" },
			])
			const gpt55Models = models.filter((model) => getVscodeLlmModelInfo(model) === vscodeLlmModels["gpt-5.5"])

			expect(gpt55Models).toEqual([
				expect.objectContaining({ id: "copilot-gpt-5.5-standard", maxInputTokens: 272_000 }),
				expect.objectContaining({ id: "copilot-gpt-5.5-extended", maxInputTokens: 921_793 }),
			])
			expect(models.some((model) => JSON.stringify(model).includes("mythos"))).toBe(false)
		})

		it("does not make static catalog entries selectable without live models", () => {
			expect(mergeVscodeLlmModels([])).toEqual([])
		})

		it("normalizes extended context size from live selectors", () => {
			expect(getVscodeLlmExtendedContextSize({ family: "gpt-5.5", vendor: "copilot" })).toBeUndefined()
			expect(
				getVscodeLlmExtendedContextSize({
					family: "gpt-5.5",
					vendor: "copilot",
					maxInputTokens: 921_793,
				}),
			).toBe(922_000)
		})

		it("provides a current catalog fallback without retired models", () => {
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
	})
})
