import { type ProviderSettings, vertexDefaultModelId, vertexModels } from "@alpha-code/types"

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
})
