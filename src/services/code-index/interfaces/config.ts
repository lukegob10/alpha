import type { EmbedderProvider } from "./manager"
import type { ProviderSettings } from "@alpha-code/types"

export type VectorStoreProvider = "qdrant" | "lancedb"

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
	isConfigured: boolean
	embedderProvider: EmbedderProvider
	vectorStoreProvider?: VectorStoreProvider
	modelId?: string
	modelDimension?: number // Optional override for custom Vertex models
	vertexOptions?: ProviderSettings
	qdrantUrl?: string
	qdrantApiKey?: string
	localIndexPath?: string
	searchMinScore?: number
	searchMaxResults?: number
	embeddingRateLimitSeconds?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	configured: boolean
	embedderProvider: EmbedderProvider
	legacyEmbedderProvider?: string
	vectorStoreProvider?: VectorStoreProvider
	modelId?: string
	modelDimension?: number
	vertexProjectId?: string
	vertexRegion?: string
	vertexKeyFile?: string
	vertexJsonCredentials?: string
	vertexGatewayBaseUrl?: string
	vertexGatewayCaBundlePath?: string
	vertexGatewayHelixCommand?: string
	vertexGatewayTokenRefreshMinutes?: number
	vertexGatewayModelRoutingMap?: string
	qdrantUrl?: string
	qdrantApiKey?: string
	localIndexPath?: string
	embeddingRateLimitSeconds?: number
}
