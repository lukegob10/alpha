/**
 * Provider used to create code-index embeddings.
 *
 * Chat provider selection is independent from this contract. Code indexing
 * uses the GCP Vertex AI embedding API exclusively.
 */
export type EmbedderProvider = "vertex"

export interface EmbeddingModelProfile {
	dimension: number
	scoreThreshold?: number // Model-specific minimum score threshold for semantic search.
	queryPrefix?: string // Optional prefix required by the model for queries.
	// Add other model-specific properties if needed, e.g., context window size.
}

export type EmbeddingModelProfiles = {
	[provider in EmbedderProvider]?: {
		[modelId: string]: EmbeddingModelProfile
	}
}
