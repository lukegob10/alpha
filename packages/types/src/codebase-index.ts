import { z } from "zod"

/** Default provider for new code indexes. */
export const CODEBASE_INDEX_EMBEDDER_PROVIDER = "vertex" as const

/**
 * Persisted code-index settings intentionally accept arbitrary strings here.
 * Older settings files contain provider names that are no longer executable;
 * keeping the value readable lets the config manager report a deterministic
 * migration error instead of silently selecting Vertex.
 */
export type CodebaseIndexEmbedderProvider = string

export function isSupportedCodebaseIndexEmbedderProvider(value: unknown): value is "vertex" | "gemini" {
	return value === CODEBASE_INDEX_EMBEDDER_PROVIDER || value === "gemini"
}

/**
 * Codebase Index Constants
 */
export const CODEBASE_INDEX_SEARCH_LIMITS = {
	MAX_RESULTS: 100,
	LEGACY_MAX_RESULTS: 200,
	CANDIDATES_PER_CHANNEL: 200,
	CONTEXT_TOKEN_BUDGET: 6000,
} as const

export const CODEBASE_INDEX_DEFAULTS = {
	MIN_SEARCH_RESULTS: 10,
	MAX_SEARCH_RESULTS: CODEBASE_INDEX_SEARCH_LIMITS.MAX_RESULTS,
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

/** Older settings allowed 200 results even though search capped them at 100. */
export function normalizeCodeIndexSearchMaxResults(value?: number): number {
	if (value === undefined || !Number.isFinite(value)) return CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS
	return Math.max(
		CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS,
		Math.min(CODEBASE_INDEX_SEARCH_LIMITS.MAX_RESULTS, Math.trunc(value)),
	)
}

const countSchema = z.number().int().nonnegative()

export const codebaseSearchDiagnosticsSchema = z.object({
	candidateLimit: countSchema,
	semanticCandidates: countSchema,
	lexicalCandidates: countSchema,
	fusedCandidates: countSchema,
	effectiveMaxResults: countSchema,
	contextTokenBudget: countSchema,
	estimatedContextTokens: countSchema,
	returnedChunks: countSchema,
	candidatesExamined: countSchema,
	skippedDuplicates: countSchema,
	skippedBudget: countSchema,
	skippedSource: countSchema,
	skippedInvalid: countSchema,
	remainingCandidates: countSchema,
	/** Optional so historical search messages remain readable. */
	freshCandidates: countSchema.optional(),
	indexFreshness: z.enum(["current", "catching-up", "error"]).optional(),
	semanticStatus: z.enum(["complete", "timeout", "error"]).optional(),
	lexicalStatus: z.enum(["complete", "timeout", "error"]).optional(),
	freshStatus: z.enum(["complete", "timeout", "error"]).optional(),
})

export type CodebaseSearchDiagnostics = z.infer<typeof codebaseSearchDiagnosticsSchema>

export const codebaseSearchMatchSchema = z.object({
	filePath: z.string(),
	score: z.number().finite(),
	scoreType: z.literal("hybrid").optional(),
	semanticScore: z.number().finite().optional(),
	lexicalScore: z.number().finite().optional(),
	startLine: z.number(),
	endLine: z.number(),
	context: z.string().optional(),
	codeChunk: z.string(),
})

export type CodebaseSearchMatch = z.infer<typeof codebaseSearchMatchSchema>

/** Optional diagnostics and score metadata keep older saved search messages readable. */
export const codebaseSearchResultSchema = z.object({
	query: z.string(),
	results: z.array(codebaseSearchMatchSchema),
	diagnostics: codebaseSearchDiagnosticsSchema.optional(),
})

export type CodebaseSearchResult = z.infer<typeof codebaseSearchResultSchema>

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
			.max(CODEBASE_INDEX_SEARCH_LIMITS.LEGACY_MAX_RESULTS)
			.transform(normalizeCodeIndexSearchMaxResults)
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
		gemini: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	})
	// Preserve legacy provider model maps while they are being migrated. They
	// are never selected by the supported runtime.
	.passthrough()

export type CodebaseIndexModels = z.infer<typeof codebaseIndexModelsSchema>

/**
 * CdebaseIndexProvider
 */

export const codebaseIndexProviderSchema = z.object({
	codeIndexQdrantApiKey: z.string().optional(),
	codebaseIndexVertexJsonCredentials: z.string().optional(),
	codebaseIndexGeminiApiKey: z.string().optional(),
})

export type CodebaseIndexProvider = z.infer<typeof codebaseIndexProviderSchema>
