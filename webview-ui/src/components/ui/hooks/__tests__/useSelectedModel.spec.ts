import {
	type ProviderSettings,
	vertexDefaultModelId,
	vertexModels,
	stellarDefaultModelId,
	stellarModels,
	openAiModelInfoSaneDefaults,
} from "@alpha-code/types"

import { useSelectedModel } from "../useSelectedModel"

describe("selected model metadata", () => {
	it("defaults an unconfigured profile to Vertex, matching the runtime", () => {
		expect(useSelectedModel()).toMatchObject({
			provider: "vertex",
			id: vertexDefaultModelId,
			info: vertexModels[vertexDefaultModelId],
		})
	})

	it.each(["anthropic", "openrouter", "future-provider", "fake-ai"])(
		"preserves %s without showing metadata from a supported public provider",
		(provider) => {
			expect(
				useSelectedModel({
					apiProvider: provider as ProviderSettings["apiProvider"],
					apiModelId: "saved-model",
				}),
			).toEqual({
				provider,
				id: "saved-model",
				info: undefined,
				isLoading: false,
				isError: false,
			})
		},
	)

	it("uses the OpenAI Compatible profile's own model and metadata", () => {
		const info = { contextWindow: 12345, supportsImages: true, supportsPromptCache: false }
		expect(
			useSelectedModel({ apiProvider: "openai", openAiModelId: "custom-model", openAiCustomModelInfo: info }),
		).toMatchObject({ provider: "openai", id: "custom-model", info })
	})

	it("uses the adapter's legacy Stellar metadata fallback while preserving a saved custom model ID", () => {
		const configuration: ProviderSettings = { apiProvider: "stellar", apiModelId: "custom-gateway-model" }
		expect(useSelectedModel(configuration)).toMatchObject({
			provider: "stellar",
			id: "custom-gateway-model",
			info: stellarModels[stellarDefaultModelId],
		})
		expect(configuration.apiModelId).toBe("custom-gateway-model")
	})

	it("projects the OpenAI adapter's legacy model capabilities without rewriting saved metadata", () => {
		const info = { contextWindow: 128_000, supportsPromptCache: false, reasoningEffort: "low" as const }
		expect(
			useSelectedModel({ apiProvider: "openai", openAiModelId: "custom-model", openAiCustomModelInfo: info })
				.info,
		).toMatchObject({ reasoningEffort: "low", supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"] })
		expect(info).not.toHaveProperty("supportsReasoningEffort")
	})

	it("uses the adapter's compatible defaults for an unknown Vertex partner without changing its ID", () => {
		const configuration: ProviderSettings = { apiProvider: "vertex", apiModelId: "partner-future" }
		expect(useSelectedModel(configuration)).toMatchObject({
			provider: "vertex",
			id: "partner-future",
			info: openAiModelInfoSaneDefaults,
		})
		expect(configuration.apiModelId).toBe("partner-future")
	})

	it.each([" ClaUde-future ", " GeMINi-future "])(
		"does not borrow partner temperature metadata for the unknown %s model family",
		(apiModelId) => {
			expect(useSelectedModel({ apiProvider: "vertex", apiModelId }).info).toBeUndefined()
		},
	)
})
