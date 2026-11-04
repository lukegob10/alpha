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
	/** Retrieval purpose values used by OpenRouter models with a native input_type parameter. */
	inputType?: { query: string; document: string }
}

/**
 * Curated text/code embedding models; provider IDs and default dimensions verified 2026-11-03.
 * Existing defaults preserve saved index identity. Compatible IDs use the publishers' deployment names.
 */
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
	"openai-native": {
		"text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
	},
	openai: {
		"text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
		"Qwen/Qwen3-Embedding-8B": {
			dimension: 4096,
			scoreThreshold: 0.4,
			queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		},
		"Qwen/Qwen3-Embedding-4B": {
			dimension: 2560,
			scoreThreshold: 0.4,
			queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		},
		"BAAI/bge-m3": { dimension: 1024, scoreThreshold: 0.4 },
		"nomic-ai/nomic-embed-text-v1.5": {
			dimension: 768,
			scoreThreshold: 0.4,
			queryPrefix: "search_query: ",
			documentPrefix: "search_document: ",
		},
	},
	openrouter: {
		"qwen/qwen3-embedding-8b": {
			dimension: 4096,
			scoreThreshold: 0.4,
			queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		},
		"qwen/qwen3-embedding-4b": {
			dimension: 2560,
			scoreThreshold: 0.4,
			queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		},
		"openai/text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
		"openai/text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
		"google/gemini-embedding-2": {
			dimension: 3072,
			scoreThreshold: 0.4,
			queryPrefix: "task: code retrieval | query: ",
			documentPrefix: "title: none | text: ",
		},
		"cohere/embed-5-pro": {
			dimension: 2048,
			scoreThreshold: 0.4,
			inputType: { query: "search_query", document: "search_document" },
		},
		"cohere/embed-5-fast": {
			dimension: 2048,
			scoreThreshold: 0.4,
			inputType: { query: "search_query", document: "search_document" },
		},
		"mongodb/voyage-code-4": {
			dimension: 1024,
			scoreThreshold: 0.4,
			inputType: { query: "query", document: "document" },
		},
		"mistralai/codestral-embed-2505": { dimension: 1536, scoreThreshold: 0.4 },
		"baai/bge-m3": { dimension: 1024, scoreThreshold: 0.4 },
	},
	bedrock: {
		"cohere.embed-v4:0": { dimension: 1536, scoreThreshold: 0.4 },
		"amazon.titan-embed-text-v2:0": { dimension: 1024, scoreThreshold: 0.4 },
	},
}

export type EmbeddingModelProfiles = {
	[provider in EmbedderProvider]?: {
		[modelId: string]: EmbeddingModelProfile
	}
}
