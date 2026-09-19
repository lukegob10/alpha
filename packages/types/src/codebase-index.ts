import { z } from "zod"

/** The only provider supported by the code index. */
export const CODEBASE_INDEX_EMBEDDER_PROVIDER = "vertex" as const

/**
 * Persisted code-index settings intentionally accept arbitrary strings here.
 * Older settings files contain provider names that are no longer executable;
 * keeping the value readable lets the config manager report a deterministic
 * migration error instead of silently selecting Vertex.
 */
export type CodebaseIndexEmbedderProvider = string

export function isSupportedCodebaseIndexEmbedderProvider(
	value: unknown,
): value is typeof CODEBASE_INDEX_EMBEDDER_PROVIDER {
	return value === CODEBASE_INDEX_EMBEDDER_PROVIDER
}

/**
 * Codebase Index Constants
 */
export const CODEBASE_INDEX_DEFAULTS = {
	MIN_SEARCH_RESULTS: 10,
	MAX_SEARCH_RESULTS: 200,
	DEFAULT_SEARCH_RESULTS: 50,
	SEARCH_RESULTS_STEP: 10,
	MIN_SEARCH_SCORE: 0,
	MAX_SEARCH_SCORE: 1,
	DEFAULT_SEARCH_MIN_SCORE: 0.4,
	SEARCH_SCORE_STEP: 0.05,
	MIN_EMBEDDING_RATE_LIMIT_SECONDS: 0.1,
	MAX_EMBEDDING_RATE_LIMIT_SECONDS: 60,
	DEFAULT_EMBEDDING_RATE_LIMIT_SECONDS: 1,
	EMBEDDING_RATE_LIMIT_STEP: 0.1,
} as const

/**
 * CodebaseIndexConfig
 */

export const codebaseIndexConfigSchema = z
	.object({
		codebaseIndexEnabled: z.boolean().optional(),
		codebaseIndexVectorStoreProvider: z.enum(["qdrant", "lancedb"]).optional(),
		codebaseIndexLocalIndexPath: z.string().optional(),
		codebaseIndexQdrantUrl: z.string().optional(),
		// Deliberately broad for backward-compatible imports. Unsupported legacy
		// values are rejected by CodeIndexConfigManager before indexing starts.
		codebaseIndexEmbedderProvider: z.string().optional(),
		codebaseIndexEmbedderModelId: z.string().optional(),
		codebaseIndexEmbedderModelDimension: z.number().optional(),
		codebaseIndexSearchMinScore: z.number().min(0).max(1).optional(),
		codebaseIndexSearchMaxResults: z
			.number()
			.min(CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS)
			.max(CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS)
			.optional(),
		codebaseIndexEmbeddingRateLimitEnabled: z.boolean().optional(),
		codebaseIndexEmbeddingRateLimitSeconds: z
			.number()
			.min(CODEBASE_INDEX_DEFAULTS.MIN_EMBEDDING_RATE_LIMIT_SECONDS)
			.max(CODEBASE_INDEX_DEFAULTS.MAX_EMBEDDING_RATE_LIMIT_SECONDS)
			.optional(),
		// Vertex specific fields
		codebaseIndexVertexProjectId: z.string().optional(),
		codebaseIndexVertexRegion: z.string().optional(),
		codebaseIndexVertexKeyFile: z.string().optional(),
		codebaseIndexVertexGatewayBaseUrl: z.string().optional(),
		codebaseIndexVertexGatewayCaBundlePath: z.string().optional(),
		codebaseIndexVertexGatewayHelixCommand: z.string().optional(),
		codebaseIndexVertexGatewayTokenRefreshMinutes: z.number().int().positive().optional(),
		codebaseIndexVertexGatewayModelRoutingMap: z.string().optional(),
	})
	// Keep removed provider fields readable during import/startup. The runtime
	// only consumes the fields above and rejects a legacy provider string.
	.passthrough()

export type CodebaseIndexConfig = z.infer<typeof codebaseIndexConfigSchema>

/**
 * CodebaseIndexModels
 */

export const codebaseIndexModelsSchema = z
	.object({
		vertex: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	})
	// Preserve legacy provider model maps while they are being migrated. They
	// are never selected by the Vertex-only runtime.
	.passthrough()

export type CodebaseIndexModels = z.infer<typeof codebaseIndexModelsSchema>

/**
 * CdebaseIndexProvider
 */

export const codebaseIndexProviderSchema = z.object({
	codeIndexQdrantApiKey: z.string().optional(),
	codebaseIndexVertexJsonCredentials: z.string().optional(),
})

export type CodebaseIndexProvider = z.infer<typeof codebaseIndexProviderSchema>
