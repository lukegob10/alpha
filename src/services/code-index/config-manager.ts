import { ContextProxy } from "../../core/config/ContextProxy"
import { t } from "../../i18n"
import {
	embeddingApiKeyFields,
	hasCustomVertexConnection,
	isSupportedCodebaseIndexEmbedderProvider,
	normalizeCodeIndexSearchMaxResults,
	type ProviderSettings,
} from "@alpha-code/types"
import type { EmbedderProvider } from "./interfaces/manager"
import type {
	CodeIndexConfig,
	PreviousConfigSnapshot,
	VectorStoreProvider,
	EmbeddingConnectionOptions,
} from "./interfaces/config"
import { DEFAULT_LOCAL_INDEX_PATH, DEFAULT_SEARCH_MIN_SCORE } from "./constants"
import { getDefaultModelId, getModelDimension, getModelScoreThreshold } from "../../shared/embeddingModels"

export interface CodeIndexConfigurationLoadOptions {
	refreshSecrets?: boolean
}

/** Own independent indexing credentials and preserve unsupported saved provider/route intent. */
export class CodeIndexConfigManager {
	private enabled = false
	private provider: EmbedderProvider = "vertex"
	private unsupported?: string
	private removedVertexConnection = false
	private config: CodeIndexConfig = { isConfigured: false, embedderProvider: "vertex" }
	constructor(private readonly contextProxy: ContextProxy) {
		this.readConfiguration()
	}
	getContextProxy(): ContextProxy {
		return this.contextProxy
	}
	private readConfiguration(): void {
		const persisted = this.contextProxy.getGlobalState("codebaseIndexConfig")
		const settings = persisted ?? {}
		const selected = settings.codebaseIndexEmbedderProvider
		this.unsupported =
			isSupportedCodebaseIndexEmbedderProvider(selected) || (!persisted && selected === undefined)
				? undefined
				: typeof selected === "string" && selected
					? selected
					: "<missing>"
		this.provider = isSupportedCodebaseIndexEmbedderProvider(selected) ? selected : "vertex"
		this.enabled = settings.codebaseIndexEnabled === true
		const active = this.contextProxy.getProviderSettings?.()
		const vertex = active?.apiProvider === "vertex" ? active : undefined
		const vertexOptions: ProviderSettings = {
			apiProvider: "vertex",
			projectId: settings.codebaseIndexVertexProjectId || vertex?.projectId || vertex?.vertexProjectId,
			location: settings.codebaseIndexVertexRegion || vertex?.location || vertex?.vertexRegion,
			vertexKeyFile: settings.codebaseIndexVertexKeyFile ?? vertex?.vertexKeyFile,
			vertexJsonCredentials:
				this.contextProxy.getSecret("codebaseIndexVertexJsonCredentials") || vertex?.vertexJsonCredentials,
		}
		this.removedVertexConnection =
			this.provider === "vertex" &&
			(hasCustomVertexConnection({
				gatewayBaseUrl: settings.codebaseIndexVertexGatewayBaseUrl,
				pemCaBundlePath: settings.codebaseIndexVertexGatewayCaBundlePath,
				helixCommand: settings.codebaseIndexVertexGatewayHelixCommand,
				modelRoutingMap: settings.codebaseIndexVertexGatewayModelRoutingMap,
			}) ||
				(!settings.codebaseIndexVertexProjectId && vertex !== undefined && hasCustomVertexConnection(vertex)))
		const keyField = this.provider !== "vertex" ? embeddingApiKeyFields[this.provider] : undefined
		const embeddingOptions: EmbeddingConnectionOptions = {
			apiKey: keyField ? this.contextProxy.getSecret(keyField) : undefined,
			baseUrl: this.provider === "openai" ? settings.codebaseIndexOpenAiCompatibleBaseUrl : undefined,
			region: this.provider === "bedrock" ? settings.codebaseIndexBedrockRegion || "us-east-1" : undefined,
			profile: this.provider === "bedrock" ? settings.codebaseIndexBedrockProfile : undefined,
		}
		const qdrantKey = this.contextProxy.getSecret("codeIndexQdrantApiKey")
		const vectorStoreProvider =
			settings.codebaseIndexVectorStoreProvider ??
			(settings.codebaseIndexQdrantUrl || qdrantKey ? "qdrant" : "lancedb")
		const dimension = Number(settings.codebaseIndexEmbedderModelDimension)
		this.config = {
			isConfigured: false,
			embedderProvider: this.provider,
			vectorStoreProvider,
			modelId: settings.codebaseIndexEmbedderModelId || undefined,
			modelDimension: Number.isSafeInteger(dimension) && dimension > 0 ? dimension : undefined,
			vertexOptions,
			geminiApiKey: this.contextProxy.getSecret("codebaseIndexGeminiApiKey") ?? "",
			embeddingOptions,
			qdrantUrl: settings.codebaseIndexQdrantUrl,
			qdrantApiKey: qdrantKey,
			localIndexPath: settings.codebaseIndexLocalIndexPath || DEFAULT_LOCAL_INDEX_PATH,
			searchMinScore: settings.codebaseIndexSearchMinScore,
			searchMaxResults: settings.codebaseIndexSearchMaxResults,
			embeddingRateLimitSeconds: settings.codebaseIndexEmbeddingRateLimitEnabled
				? settings.codebaseIndexEmbeddingRateLimitSeconds
				: undefined,
		}
		this.config.isConfigured = this.isConfigured()
	}
	private snapshot(): PreviousConfigSnapshot {
		const c = this.config
		return {
			enabled: this.enabled,
			configured: this.isConfigured(),
			embedderProvider: this.provider,
			legacyEmbedderProvider: this.unsupported,
			vectorStoreProvider: c.vectorStoreProvider,
			modelId: c.modelId,
			modelDimension: c.modelDimension,
			vertexProjectId: this.provider === "vertex" ? c.vertexOptions?.projectId : undefined,
			vertexRegion: this.provider === "vertex" ? c.vertexOptions?.location : undefined,
			vertexKeyFile: this.provider === "vertex" ? c.vertexOptions?.vertexKeyFile : undefined,
			vertexJsonCredentials: this.provider === "vertex" ? c.vertexOptions?.vertexJsonCredentials : undefined,
			geminiApiKey: this.provider === "gemini" ? c.geminiApiKey : undefined,
			embeddingOptions: c.embeddingOptions,
			qdrantUrl: c.qdrantUrl ?? "",
			qdrantApiKey: c.qdrantApiKey ?? "",
			localIndexPath: c.localIndexPath,
			embeddingRateLimitSeconds: c.embeddingRateLimitSeconds,
		}
	}
	async loadConfiguration({ refreshSecrets = true }: CodeIndexConfigurationLoadOptions = {}) {
		const configSnapshot = this.snapshot()
		if (refreshSecrets || !this.contextProxy.isInitialized) await this.contextProxy.refreshSecrets()
		this.readConfiguration()
		return {
			configSnapshot,
			currentConfig: this.getConfig(),
			requiresRestart: this.doesConfigChangeRequireRestart(configSnapshot),
		}
	}
	isConfigured(): boolean {
		return this.configurationError === undefined
	}
	get configurationError(): string | undefined {
		if (this.unsupported)
			return t("embeddings:serviceFactory.invalidEmbedderType", { embedderProvider: this.unsupported })
		const c = this.config
		if (this.removedVertexConnection) return t("embeddings:serviceFactory.vertexGatewayRemoved")
		if (this.provider === "vertex" && (!c.vertexOptions?.projectId || !c.vertexOptions?.location))
			return t("embeddings:serviceFactory.vertexConfigMissing")
		if (["gemini", "openai-native", "openrouter"].includes(this.provider) && !c.embeddingOptions?.apiKey?.trim())
			return t(
				this.provider === "gemini"
					? "embeddings:serviceFactory.geminiConfigMissing"
					: "embeddings:serviceFactory.embeddingKeyMissing",
			)
		if (this.provider === "openai") {
			try {
				const url = new URL(c.embeddingOptions?.baseUrl ?? "")
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password ||
					url.search ||
					url.hash
				)
					throw new Error()
			} catch {
				return t("embeddings:serviceFactory.compatibleUrlMissing")
			}
		}
		if (this.provider === "bedrock" && !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(c.embeddingOptions?.region ?? ""))
			return t("embeddings:serviceFactory.bedrockRegionMissing")
		if (this.provider === "bedrock" && !getModelDimension("bedrock", c.modelId ?? getDefaultModelId("bedrock")))
			return t("embeddings:serviceFactory.embeddingModelMissing")
		if (!this.currentModelDimension || !(c.modelId ?? getDefaultModelId(this.provider)))
			return t("embeddings:serviceFactory.embeddingModelMissing")
		if (c.vectorStoreProvider === "qdrant" ? !c.qdrantUrl : !c.localIndexPath)
			return t("embeddings:serviceFactory.codeIndexingNotConfigured")
		return undefined
	}
	doesConfigChangeRequireRestart(previous: PreviousConfigSnapshot): boolean {
		if ((!previous.enabled || !previous.configured) && this.enabled && this.isConfigured()) return true
		if (previous.enabled && !this.enabled) return true
		if (!this.enabled || ((!previous.enabled || !previous.configured) && !this.isConfigured())) return false
		const current = this.snapshot()
		return (Object.keys(current) as (keyof PreviousConfigSnapshot)[]).some(
			(key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]),
		)
	}
	getConfig(): CodeIndexConfig {
		return {
			...this.config,
			isConfigured: this.isConfigured(),
			searchMinScore: this.currentSearchMinScore,
			searchMaxResults: this.currentSearchMaxResults,
		}
	}
	get isFeatureEnabled(): boolean {
		return this.enabled
	}
	get isFeatureConfigured(): boolean {
		return this.isConfigured()
	}
	get currentEmbedderProvider(): EmbedderProvider {
		return this.provider
	}
	get legacyProvider(): string | undefined {
		return this.unsupported
	}
	get qdrantConfig(): { url?: string; apiKey?: string } {
		return { url: this.config.qdrantUrl, apiKey: this.config.qdrantApiKey }
	}
	get vectorStoreConfig(): { provider: VectorStoreProvider; localIndexPath?: string } {
		return { provider: this.config.vectorStoreProvider ?? "lancedb", localIndexPath: this.config.localIndexPath }
	}
	get currentModelId(): string | undefined {
		return this.config.modelId
	}
	get currentModelDimension(): number | undefined {
		// Saved compatible deployments keep their explicit shape when a matching preset is introduced.
		if (this.provider === "openai" && this.config.modelDimension) return this.config.modelDimension
		return (
			getModelDimension(this.provider, this.config.modelId ?? getDefaultModelId(this.provider)) ??
			this.config.modelDimension
		)
	}
	get currentSearchMinScore(): number {
		return (
			this.config.searchMinScore ??
			getModelScoreThreshold(this.provider, this.config.modelId ?? getDefaultModelId(this.provider)) ??
			DEFAULT_SEARCH_MIN_SCORE
		)
	}
	get currentSearchMaxResults(): number {
		return normalizeCodeIndexSearchMaxResults(this.config.searchMaxResults)
	}
}
