import { ApiHandlerOptions } from "../../../shared/api" // Adjust path if needed
import { EmbedderProvider } from "./manager"
import type { ProviderSettings } from "@roo-code/types"

export type VectorStoreProvider = "qdrant" | "lancedb"

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
	isConfigured: boolean
	embedderProvider: EmbedderProvider
	vectorStoreProvider?: VectorStoreProvider
	modelId?: string
	modelDimension?: number // Generic dimension property for all providers
	openAiOptions?: ApiHandlerOptions
	ollamaOptions?: ApiHandlerOptions
	openAiCompatibleOptions?: { baseUrl: string; apiKey: string }
	geminiOptions?: { apiKey: string }
	vertexOptions?: ProviderSettings
	mistralOptions?: { apiKey: string }
	vercelAiGatewayOptions?: { apiKey: string }
	bedrockOptions?: { region: string; profile?: string }
	openRouterOptions?: { apiKey: string; specificProvider?: string }
	qdrantUrl?: string
	qdrantApiKey?: string
	localIndexPath?: string
	searchMinScore?: number
	searchMaxResults?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	configured: boolean
	embedderProvider: EmbedderProvider
	vectorStoreProvider?: VectorStoreProvider
	modelId?: string
	modelDimension?: number // Generic dimension property
	openAiKey?: string
	ollamaBaseUrl?: string
	openAiCompatibleBaseUrl?: string
	openAiCompatibleApiKey?: string
	geminiApiKey?: string
	vertexProjectId?: string
	vertexRegion?: string
	vertexKeyFile?: string
	vertexJsonCredentials?: string
	vertexGatewayBaseUrl?: string
	vertexGatewayCaBundlePath?: string
	vertexGatewayHelixCommand?: string
	vertexGatewayTokenRefreshMinutes?: number
	vertexGatewayModelRoutingMap?: string
	mistralApiKey?: string
	vercelAiGatewayApiKey?: string
	bedrockRegion?: string
	bedrockProfile?: string
	openRouterApiKey?: string
	openRouterSpecificProvider?: string
	qdrantUrl?: string
	qdrantApiKey?: string
	localIndexPath?: string
}
