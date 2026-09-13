/**
 * Interface for code index embedders.
 * Provider adapters preserve retrieval roles where the model supports them.
 */
export interface IEmbedder {
	/**
	 * Creates embeddings for the given texts.
	 * @param texts Array of text strings to create embeddings for
	 * @param model Optional model ID to use for embeddings
	 * @param purpose Document indexing by default; search callers explicitly request query embeddings
	 * @returns Promise resolving to an EmbeddingResponse
	 */
	createEmbeddings(texts: string[], model?: string, purpose?: "document" | "query"): Promise<EmbeddingResponse>

	/**
	 * Validates the embedder configuration by testing connectivity and credentials.
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	validateConfiguration(): Promise<{ valid: boolean; error?: string }>

	get embedderInfo(): EmbedderInfo
}

export interface EmbeddingResponse {
	embeddings: number[][]
	usage?: {
		promptTokens: number
		totalTokens: number
	}
}

export type AvailableEmbedders =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "vertex"
	| "mistral"
	| "vercel-ai-gateway"
	| "bedrock"
	| "openrouter"

export interface EmbedderInfo {
	name: AvailableEmbedders
}
