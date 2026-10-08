import type { EmbedderProvider, EmbeddingModelProfiles } from "@alpha-code/types"

/**
 * Supported Google embedding models and their retrieval defaults.
 *
 * The profile table is intentionally provider-specific. Chat model providers
 * do not participate in code-index embedding selection.
 */
export const EMBEDDING_MODEL_PROFILES: EmbeddingModelProfiles = {
	gemini: {
		"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
		"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
	},
	vertex: {
		"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
		"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-005": { dimension: 768, scoreThreshold: 0.4 },
		"text-multilingual-embedding-002": { dimension: 768, scoreThreshold: 0.4 },
	},
}

/** Returns the built-in dimension for a known embedding model. */
export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
	return EMBEDDING_MODEL_PROFILES[provider]?.[modelId]?.dimension
}

/** Returns the retrieval threshold for a known embedding model. */
export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
	return EMBEDDING_MODEL_PROFILES[provider]?.[modelId]?.scoreThreshold
}

/** Returns the default embedding model for the selected provider. */
export function getDefaultModelId(_provider: EmbedderProvider): string {
	return "gemini-embedding-001"
}
