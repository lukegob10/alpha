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
	it.each([
		["openai-native", "text-embedding-3-small", 1536],
		["openai", "text-embedding-3-small", 1536],
		["openai", "Qwen/Qwen3-Embedding-8B", 4096],
		["openai", "Qwen/Qwen3-Embedding-4B", 2560],
		["openai", "BAAI/bge-m3", 1024],
		["openai", "nomic-ai/nomic-embed-text-v1.5", 768],
		["openrouter", "qwen/qwen3-embedding-4b", 2560],
		["openrouter", "openai/text-embedding-3-small", 1536],
		["openrouter", "cohere/embed-5-pro", 2048],
		["openrouter", "cohere/embed-5-fast", 2048],
		["openrouter", "mongodb/voyage-code-4", 1024],
		["openrouter", "mistralai/codestral-embed-2505", 1536],
		["openrouter", "baai/bge-m3", 1024],
		["bedrock", "amazon.titan-embed-text-v2:0", 1024],
	] as const)("provides standard output dimensions for %s / %s", (provider, model, dimension) => {
		expect(embeddingModelProfiles[provider]?.[model]?.dimension).toBe(dimension)
	})

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
