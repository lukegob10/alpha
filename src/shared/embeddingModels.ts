import type { EmbedderProvider, EmbeddingModelProfiles } from "@alpha-code/types"

/**
 * Supported Vertex AI embedding models and their retrieval defaults.
 *
 * The profile table is intentionally provider-specific. Chat model providers
 * do not participate in code-index embedding selection.
 */
export const EMBEDDING_MODEL_PROFILES: EmbeddingModelProfiles = {
	vertex: {
		"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
		"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-005": { dimension: 768, scoreThreshold: 0.4 },
		"text-multilingual-embedding-002": { dimension: 768, scoreThreshold: 0.4 },
	},
}

/** Returns the built-in dimension for a known Vertex model. */
export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
	return provider === "vertex" ? EMBEDDING_MODEL_PROFILES.vertex?.[modelId]?.dimension : undefined
}

/** Returns the retrieval threshold for a known Vertex model. */
export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
	return provider === "vertex" ? EMBEDDING_MODEL_PROFILES.vertex?.[modelId]?.scoreThreshold : undefined
}

/** Returns the default Vertex embedding model. */
export function getDefaultModelId(_provider: EmbedderProvider): string {
	return "gemini-embedding-001"
}
