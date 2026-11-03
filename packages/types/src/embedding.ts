/**
 * Provider used to create code-index embeddings.
 *
 * Chat provider selection is independent from this contract. Code indexing
 * supports dedicated embedding endpoints independently.
 */
export const embedderProviders = ["vertex", "gemini", "openai-native", "openai", "openrouter", "bedrock"] as const
export type EmbedderProvider = (typeof embedderProviders)[number]

export const embeddingDefaultModels: Record<EmbedderProvider, string> = {
	vertex: "gemini-embedding-001",
	gemini: "gemini-embedding-001",
	"openai-native": "text-embedding-3-large",
	openai: "",
	openrouter: "qwen/qwen3-embedding-8b",
	bedrock: "cohere.embed-v4:0",
}

/** Index keys are independent so credentials cannot follow a provider switch to another endpoint. */
export const embeddingApiKeyFields = {
	gemini: "codebaseIndexGeminiApiKey",
	"openai-native": "codebaseIndexOpenAiApiKey",
	openai: "codebaseIndexOpenAiCompatibleApiKey",
	openrouter: "codebaseIndexOpenRouterApiKey",
	bedrock: "codebaseIndexBedrockApiKey",
} as const

export interface EmbeddingModelProfile {
	dimension: number
	scoreThreshold?: number // Model-specific minimum score threshold for semantic search.
	queryPrefix?: string // Optional prefix required by the model for queries.
	documentPrefix?: string
	// Add other model-specific properties if needed, e.g., context window size.
}

/** Provider documentation verified 2026-11-03. Existing Vertex defaults preserve saved index identity. */
export const embeddingModelProfiles: EmbeddingModelProfiles = {
	vertex: {
		"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
		"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-005": { dimension: 768, scoreThreshold: 0.4 },
		"text-multilingual-embedding-002": { dimension: 768, scoreThreshold: 0.4 },
	},
	gemini: {
		"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
		"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
	},
	"openai-native": { "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 } },
	openai: { "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 } },
	openrouter: {
		"qwen/qwen3-embedding-8b": {
			dimension: 4096,
			scoreThreshold: 0.4,
			queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		},
		"openai/text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
		"google/gemini-embedding-2": {
			dimension: 3072,
			scoreThreshold: 0.4,
			queryPrefix: "task: code retrieval | query: ",
			documentPrefix: "title: none | text: ",
		},
	},
	bedrock: { "cohere.embed-v4:0": { dimension: 1536, scoreThreshold: 0.4 } },
}

export type EmbeddingModelProfiles = {
	[provider in EmbedderProvider]?: {
		[modelId: string]: EmbeddingModelProfile
	}
}
