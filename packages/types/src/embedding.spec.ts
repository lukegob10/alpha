import { describe, expect, it } from "vitest"
import {
	embedderProviders,
	embeddingApiKeyFields,
	embeddingDefaultModels,
	embeddingModelProfiles,
} from "./embedding.js"
import { codebaseIndexProviderSchema, isSupportedCodebaseIndexEmbedderProvider } from "./codebase-index.js"
import { SECRET_STATE_KEYS } from "./global-settings.js"
describe("indexing provider contract", () => {
	it("supports dedicated embedding providers without changing saved Google defaults", () => {
		expect(embedderProviders).toEqual(["vertex", "gemini", "openai-native", "openai", "openrouter", "bedrock"])
		expect(embeddingDefaultModels.vertex).toBe("gemini-embedding-001")
		expect(embeddingDefaultModels.gemini).toBe("gemini-embedding-001")
		for (const provider of embedderProviders) {
			expect(isSupportedCodebaseIndexEmbedderProvider(provider)).toBe(true)
			if (provider !== "openai")
				expect(embeddingModelProfiles[provider]?.[embeddingDefaultModels[provider]]?.dimension).toBeGreaterThan(
					0,
				)
		}
		expect(isSupportedCodebaseIndexEmbedderProvider("retired-provider")).toBe(false)
	})
	it("keeps every indexing key in the secret schema and storage registry", () => {
		for (const key of Object.values(embeddingApiKeyFields)) {
			expect(SECRET_STATE_KEYS).toContain(key)
			expect(codebaseIndexProviderSchema.parse({ [key]: "index-secret" })).toHaveProperty(key, "index-secret")
		}
	})
})
