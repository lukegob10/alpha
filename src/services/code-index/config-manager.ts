import { ContextProxy } from "../../core/config/ContextProxy"
import { t } from "../../i18n"
import type { ProviderSettings } from "@alpha-code/types"
import { isSupportedCodebaseIndexEmbedderProvider } from "@alpha-code/types"
import type { EmbedderProvider } from "./interfaces/manager"
import type { CodeIndexConfig, PreviousConfigSnapshot, VectorStoreProvider } from "./interfaces/config"
import { DEFAULT_LOCAL_INDEX_PATH, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_MIN_SCORE } from "./constants"
import { getDefaultModelId, getModelDimension, getModelScoreThreshold } from "../../shared/embeddingModels"

/**
 * Owns persisted code-index settings and the Vertex-only embedding contract.
 *
 * Legacy provider strings are intentionally retained in `legacyEmbedderProvider`
 * instead of being mapped to Vertex. This keeps old settings readable while
 * preventing an old index from being queried or rewritten with a different
 * embedding space without an explicit user change.
 */
export class CodeIndexConfigManager {
	private codebaseIndexEnabled = false
	private embedderProvider: EmbedderProvider = "vertex"
	private legacyEmbedderProvider?: string
	private modelId?: string
	private modelDimension?: number
	private vertexOptions?: ProviderSettings
	private vectorStoreProvider: VectorStoreProvider = "lancedb"
	private qdrantUrl?: string = "http://localhost:6333"
	private qdrantApiKey?: string
	private localIndexPath?: string = DEFAULT_LOCAL_INDEX_PATH
	private searchMinScore?: number
	private searchMaxResults?: number
	private embeddingRateLimitSeconds?: number

	constructor(private readonly contextProxy: ContextProxy) {
		this._loadAndSetConfiguration()
	}

	public getContextProxy(): ContextProxy {
		return this.contextProxy
	}

	private resolveVertexOptions(
		codebaseIndexConfig: Record<string, unknown>,
		activeVertexOptions?: ProviderSettings,
		vertexJsonCredentials?: string,
	): ProviderSettings | undefined {
		const projectId =
			codebaseIndexConfig.codebaseIndexVertexProjectId ||
			activeVertexOptions?.projectId ||
			activeVertexOptions?.vertexProjectId
		const location =
			codebaseIndexConfig.codebaseIndexVertexRegion ||
			activeVertexOptions?.location ||
			activeVertexOptions?.vertexRegion
		const gatewayBaseUrl =
			codebaseIndexConfig.codebaseIndexVertexGatewayBaseUrl ||
			activeVertexOptions?.gatewayBaseUrl ||
			activeVertexOptions?.vertexGatewayBaseUrl
		const pemCaBundlePath =
			codebaseIndexConfig.codebaseIndexVertexGatewayCaBundlePath ||
			activeVertexOptions?.pemCaBundlePath ||
			activeVertexOptions?.vertexGatewayCaBundlePath
		const helixCommand =
			codebaseIndexConfig.codebaseIndexVertexGatewayHelixCommand ||
			activeVertexOptions?.helixCommand ||
			activeVertexOptions?.vertexGatewayHelixCommand
		const refreshIntervalMinutes =
			codebaseIndexConfig.codebaseIndexVertexGatewayTokenRefreshMinutes ??
			activeVertexOptions?.refreshIntervalMinutes ??
			activeVertexOptions?.vertexGatewayTokenRefreshMinutes
		const modelRoutingMap =
			codebaseIndexConfig.codebaseIndexVertexGatewayModelRoutingMap ||
			activeVertexOptions?.modelRoutingMap ||
			activeVertexOptions?.vertexGatewayModelRoutingMap

		const hasCodeIndexVertexSettings = [
			codebaseIndexConfig.codebaseIndexVertexProjectId,
			codebaseIndexConfig.codebaseIndexVertexRegion,
			codebaseIndexConfig.codebaseIndexVertexKeyFile,
			vertexJsonCredentials,
			codebaseIndexConfig.codebaseIndexVertexGatewayBaseUrl,
			codebaseIndexConfig.codebaseIndexVertexGatewayCaBundlePath,
			codebaseIndexConfig.codebaseIndexVertexGatewayHelixCommand,
			codebaseIndexConfig.codebaseIndexVertexGatewayTokenRefreshMinutes,
			codebaseIndexConfig.codebaseIndexVertexGatewayModelRoutingMap,
		].some((value) => value !== undefined && value !== "")

		if (!activeVertexOptions && !hasCodeIndexVertexSettings) {
			return undefined
		}

		return {
			...(activeVertexOptions ?? {}),
			apiProvider: "vertex",
			projectId: typeof projectId === "string" ? projectId : undefined,
			location: typeof location === "string" ? location : undefined,
			vertexProjectId: typeof projectId === "string" ? projectId : undefined,
			vertexRegion: typeof location === "string" ? location : undefined,
			vertexKeyFile:
				typeof codebaseIndexConfig.codebaseIndexVertexKeyFile === "string"
					? codebaseIndexConfig.codebaseIndexVertexKeyFile
					: activeVertexOptions?.vertexKeyFile,
			vertexJsonCredentials: vertexJsonCredentials || activeVertexOptions?.vertexJsonCredentials,
			gatewayBaseUrl: typeof gatewayBaseUrl === "string" ? gatewayBaseUrl : undefined,
			pemCaBundlePath: typeof pemCaBundlePath === "string" ? pemCaBundlePath : undefined,
			helixCommand: typeof helixCommand === "string" ? helixCommand : undefined,
			helixParseMode: activeVertexOptions?.helixParseMode,
			helixTokenKey: activeVertexOptions?.helixTokenKey,
			refreshIntervalMinutes: typeof refreshIntervalMinutes === "number" ? refreshIntervalMinutes : undefined,
			modelRoutingMap:
				typeof modelRoutingMap === "string" || (modelRoutingMap !== null && typeof modelRoutingMap === "object")
					? (modelRoutingMap as string | Record<string, unknown>)
					: undefined,
			vertexGatewayBaseUrl: typeof gatewayBaseUrl === "string" ? gatewayBaseUrl : undefined,
			vertexGatewayCaBundlePath: typeof pemCaBundlePath === "string" ? pemCaBundlePath : undefined,
			vertexGatewayHelixCommand: typeof helixCommand === "string" ? helixCommand : undefined,
			vertexGatewayTokenRefreshMinutes:
				typeof refreshIntervalMinutes === "number" ? refreshIntervalMinutes : undefined,
			vertexGatewayModelRoutingMap: typeof modelRoutingMap === "string" ? modelRoutingMap : undefined,
		}
	}

	private resolveVectorStoreProvider(
		codebaseIndexConfig: Record<string, unknown>,
		qdrantApiKey?: string,
	): VectorStoreProvider {
		const configuredProvider = codebaseIndexConfig.codebaseIndexVectorStoreProvider
		if (configuredProvider === "qdrant" || configuredProvider === "lancedb") {
			return configuredProvider
		}
		if (codebaseIndexConfig.codebaseIndexQdrantUrl || qdrantApiKey) {
			return "qdrant"
		}
		return "lancedb"
	}

	private _loadAndSetConfiguration(): void {
		const persistedConfig = this.contextProxy?.getGlobalState("codebaseIndexConfig") as
			| (Record<string, unknown> & { codebaseIndexEmbedderProvider?: unknown })
			| undefined
		const hasPersistedConfig = persistedConfig !== undefined && persistedConfig !== null
		const codebaseIndexConfig: Record<string, unknown> = persistedConfig ?? {
			codebaseIndexEnabled: false,
			codebaseIndexVectorStoreProvider: "lancedb",
			codebaseIndexLocalIndexPath: DEFAULT_LOCAL_INDEX_PATH,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "vertex",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMinScore: undefined,
			codebaseIndexSearchMaxResults: undefined,
			codebaseIndexEmbeddingRateLimitEnabled: false,
			codebaseIndexEmbeddingRateLimitSeconds: undefined,
			codebaseIndexVertexProjectId: "",
			codebaseIndexVertexRegion: "",
			codebaseIndexVertexKeyFile: "",
			codebaseIndexVertexGatewayBaseUrl: "",
			codebaseIndexVertexGatewayCaBundlePath: "",
			codebaseIndexVertexGatewayHelixCommand: "",
			codebaseIndexVertexGatewayTokenRefreshMinutes: undefined,
			codebaseIndexVertexGatewayModelRoutingMap: "",
		}

		const rawProvider = codebaseIndexConfig.codebaseIndexEmbedderProvider
		if (isSupportedCodebaseIndexEmbedderProvider(rawProvider)) {
			this.legacyEmbedderProvider = undefined
		} else if (!hasPersistedConfig && rawProvider === undefined) {
			this.legacyEmbedderProvider = undefined
		} else {
			this.legacyEmbedderProvider =
				typeof rawProvider === "string" && rawProvider.length > 0 ? rawProvider : "<missing>"
		}
		this.embedderProvider = "vertex"

		const providerSettings = this.contextProxy?.getProviderSettings?.()
		const activeVertexOptions = providerSettings?.apiProvider === "vertex" ? providerSettings : undefined
		const qdrantApiKey = this.contextProxy?.getSecret("codeIndexQdrantApiKey") ?? ""
		const vertexJsonCredentials = this.contextProxy?.getSecret("codebaseIndexVertexJsonCredentials") ?? ""

		this.codebaseIndexEnabled = codebaseIndexConfig.codebaseIndexEnabled === true
		this.vectorStoreProvider = this.resolveVectorStoreProvider(codebaseIndexConfig, qdrantApiKey)
		this.qdrantUrl =
			typeof codebaseIndexConfig.codebaseIndexQdrantUrl === "string"
				? codebaseIndexConfig.codebaseIndexQdrantUrl
				: undefined
		this.qdrantApiKey = qdrantApiKey
		this.localIndexPath =
			typeof codebaseIndexConfig.codebaseIndexLocalIndexPath === "string" &&
			codebaseIndexConfig.codebaseIndexLocalIndexPath
				? codebaseIndexConfig.codebaseIndexLocalIndexPath
				: DEFAULT_LOCAL_INDEX_PATH
		this.searchMinScore =
			typeof codebaseIndexConfig.codebaseIndexSearchMinScore === "number"
				? codebaseIndexConfig.codebaseIndexSearchMinScore
				: undefined
		this.searchMaxResults =
			typeof codebaseIndexConfig.codebaseIndexSearchMaxResults === "number"
				? codebaseIndexConfig.codebaseIndexSearchMaxResults
				: undefined
		this.embeddingRateLimitSeconds =
			codebaseIndexConfig.codebaseIndexEmbeddingRateLimitEnabled === true &&
			typeof codebaseIndexConfig.codebaseIndexEmbeddingRateLimitSeconds === "number"
				? codebaseIndexConfig.codebaseIndexEmbeddingRateLimitSeconds
				: undefined

		const rawDimension = codebaseIndexConfig.codebaseIndexEmbedderModelDimension
		const numericDimension = typeof rawDimension === "number" ? rawDimension : Number(rawDimension)
		this.modelDimension = Number.isFinite(numericDimension) && numericDimension > 0 ? numericDimension : undefined
		this.modelId =
			typeof codebaseIndexConfig.codebaseIndexEmbedderModelId === "string" &&
			codebaseIndexConfig.codebaseIndexEmbedderModelId.length > 0
				? codebaseIndexConfig.codebaseIndexEmbedderModelId
				: undefined
		this.vertexOptions = this.resolveVertexOptions(codebaseIndexConfig, activeVertexOptions, vertexJsonCredentials)
	}

	public async loadConfiguration(): Promise<{
		configSnapshot: PreviousConfigSnapshot
		currentConfig: {
			isConfigured: boolean
			embedderProvider: EmbedderProvider
			vectorStoreProvider?: VectorStoreProvider
			modelId?: string
			modelDimension?: number
			vertexOptions?: ProviderSettings
			qdrantUrl?: string
			qdrantApiKey?: string
			localIndexPath?: string
			searchMinScore?: number
			searchMaxResults?: number
			embeddingRateLimitSeconds?: number
		}
		requiresRestart: boolean
	}> {
		const previousConfigSnapshot: PreviousConfigSnapshot = {
			enabled: this.codebaseIndexEnabled,
			configured: this.isConfigured(),
			embedderProvider: this.embedderProvider,
			legacyEmbedderProvider: this.legacyEmbedderProvider,
			vectorStoreProvider: this.vectorStoreProvider,
			modelId: this.modelId,
			modelDimension: this.modelDimension,
			vertexProjectId: this.vertexOptions?.projectId ?? this.vertexOptions?.vertexProjectId ?? "",
			vertexRegion: this.vertexOptions?.location ?? this.vertexOptions?.vertexRegion ?? "",
			vertexKeyFile: this.vertexOptions?.vertexKeyFile ?? "",
			vertexJsonCredentials: this.vertexOptions?.vertexJsonCredentials ?? "",
			vertexGatewayBaseUrl: this.vertexOptions?.gatewayBaseUrl ?? this.vertexOptions?.vertexGatewayBaseUrl ?? "",
			vertexGatewayCaBundlePath:
				this.vertexOptions?.pemCaBundlePath ?? this.vertexOptions?.vertexGatewayCaBundlePath ?? "",
			vertexGatewayHelixCommand:
				this.vertexOptions?.helixCommand ?? this.vertexOptions?.vertexGatewayHelixCommand ?? "",
			vertexGatewayTokenRefreshMinutes:
				this.vertexOptions?.refreshIntervalMinutes ?? this.vertexOptions?.vertexGatewayTokenRefreshMinutes,
			vertexGatewayModelRoutingMap: this.serializeModelRoutingMap(this.vertexOptions),
			qdrantUrl: this.qdrantUrl ?? "",
			qdrantApiKey: this.qdrantApiKey ?? "",
			localIndexPath: this.localIndexPath ?? DEFAULT_LOCAL_INDEX_PATH,
			embeddingRateLimitSeconds: this.embeddingRateLimitSeconds,
		}

		await this.contextProxy.refreshSecrets()
		this._loadAndSetConfiguration()
		const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)

		return {
			configSnapshot: previousConfigSnapshot,
			currentConfig: {
				isConfigured: this.isConfigured(),
				embedderProvider: this.embedderProvider,
				vectorStoreProvider: this.vectorStoreProvider,
				modelId: this.modelId,
				modelDimension: this.modelDimension,
				vertexOptions: this.vertexOptions,
				qdrantUrl: this.qdrantUrl,
				qdrantApiKey: this.qdrantApiKey,
				localIndexPath: this.localIndexPath,
				searchMinScore: this.currentSearchMinScore,
				searchMaxResults: this.currentSearchMaxResults,
				embeddingRateLimitSeconds: this.embeddingRateLimitSeconds,
			},
			requiresRestart,
		}
	}

	public isConfigured(): boolean {
		return (
			this.legacyEmbedderProvider === undefined &&
			this.vertexOptions?.apiProvider === "vertex" &&
			Boolean(this.getConfiguredProjectId(this.vertexOptions)) &&
			Boolean(this.getConfiguredLocation(this.vertexOptions)) &&
			this.isVectorStoreConfigured()
		)
	}

	private isVectorStoreConfigured(): boolean {
		return this.vectorStoreProvider === "qdrant" ? Boolean(this.qdrantUrl) : Boolean(this.localIndexPath)
	}

	private getConfiguredProjectId(options?: ProviderSettings): string | undefined {
		return options?.projectId || options?.vertexProjectId
	}

	private getConfiguredLocation(options?: ProviderSettings): string | undefined {
		return options?.location || options?.vertexRegion
	}

	private serializeModelRoutingMap(options?: ProviderSettings): string {
		const routes = options?.modelRoutingMap ?? options?.vertexGatewayModelRoutingMap
		return typeof routes === "string" ? routes : routes ? JSON.stringify(routes) : ""
	}

	public get configurationError(): string | undefined {
		if (this.legacyEmbedderProvider !== undefined) {
			return t("embeddings:serviceFactory.invalidEmbedderType", {
				embedderProvider: this.legacyEmbedderProvider,
			})
		}
		if (
			!this.vertexOptions ||
			!this.getConfiguredProjectId(this.vertexOptions) ||
			!this.getConfiguredLocation(this.vertexOptions)
		) {
			return t("embeddings:serviceFactory.vertexConfigMissing")
		}
		if (!this.isVectorStoreConfigured()) {
			return t("embeddings:serviceFactory.codeIndexingNotConfigured")
		}
		return undefined
	}

	public doesConfigChangeRequireRestart(prev: PreviousConfigSnapshot): boolean {
		const nowConfigured = this.isConfigured()
		const prevEnabled = prev?.enabled ?? false
		const prevConfigured = prev?.configured ?? false

		if ((!prevEnabled || !prevConfigured) && this.codebaseIndexEnabled && nowConfigured) return true
		if (prevEnabled && !this.codebaseIndexEnabled) return true
		if ((!prevEnabled || !prevConfigured) && (!this.codebaseIndexEnabled || !nowConfigured)) return false
		if (!this.codebaseIndexEnabled) return false

		if (prev.legacyEmbedderProvider !== this.legacyEmbedderProvider) return true
		if (prev.embedderProvider !== this.embedderProvider) return true
		if (prev.vectorStoreProvider !== this.vectorStoreProvider) return true
		if ((prev.modelId ?? getDefaultModelId("vertex")) !== (this.modelId ?? getDefaultModelId("vertex"))) return true
		if (prev.modelDimension !== this.modelDimension) return true

		const currentProjectId = this.vertexOptions?.projectId ?? this.vertexOptions?.vertexProjectId ?? ""
		const currentRegion = this.vertexOptions?.location ?? this.vertexOptions?.vertexRegion ?? ""
		const currentKeyFile = this.vertexOptions?.vertexKeyFile ?? ""
		const currentJsonCredentials = this.vertexOptions?.vertexJsonCredentials ?? ""
		const currentGatewayBaseUrl =
			this.vertexOptions?.gatewayBaseUrl ?? this.vertexOptions?.vertexGatewayBaseUrl ?? ""
		const currentGatewayCaBundlePath =
			this.vertexOptions?.pemCaBundlePath ?? this.vertexOptions?.vertexGatewayCaBundlePath ?? ""
		const currentGatewayHelixCommand =
			this.vertexOptions?.helixCommand ?? this.vertexOptions?.vertexGatewayHelixCommand ?? ""
		const currentGatewayTokenRefreshMinutes =
			this.vertexOptions?.refreshIntervalMinutes ?? this.vertexOptions?.vertexGatewayTokenRefreshMinutes
		const currentGatewayModelRoutingMap = this.serializeModelRoutingMap(this.vertexOptions)

		if (
			prev.vertexProjectId !== currentProjectId ||
			prev.vertexRegion !== currentRegion ||
			prev.vertexKeyFile !== currentKeyFile ||
			prev.vertexJsonCredentials !== currentJsonCredentials ||
			prev.vertexGatewayBaseUrl !== currentGatewayBaseUrl ||
			prev.vertexGatewayCaBundlePath !== currentGatewayCaBundlePath ||
			prev.vertexGatewayHelixCommand !== currentGatewayHelixCommand ||
			prev.vertexGatewayTokenRefreshMinutes !== currentGatewayTokenRefreshMinutes ||
			prev.vertexGatewayModelRoutingMap !== currentGatewayModelRoutingMap
		) {
			return true
		}

		if (
			(prev.qdrantUrl ?? "") !== (this.qdrantUrl ?? "") ||
			(prev.qdrantApiKey ?? "") !== (this.qdrantApiKey ?? "") ||
			(prev.localIndexPath ?? DEFAULT_LOCAL_INDEX_PATH) !== (this.localIndexPath ?? DEFAULT_LOCAL_INDEX_PATH) ||
			prev.embeddingRateLimitSeconds !== this.embeddingRateLimitSeconds
		) {
			return true
		}

		return false
	}

	public getConfig(): CodeIndexConfig {
		return {
			isConfigured: this.isConfigured(),
			embedderProvider: this.embedderProvider,
			vectorStoreProvider: this.vectorStoreProvider,
			modelId: this.modelId,
			modelDimension: this.modelDimension,
			vertexOptions: this.vertexOptions,
			qdrantUrl: this.qdrantUrl,
			qdrantApiKey: this.qdrantApiKey,
			localIndexPath: this.localIndexPath,
			searchMinScore: this.currentSearchMinScore,
			searchMaxResults: this.currentSearchMaxResults,
			embeddingRateLimitSeconds: this.embeddingRateLimitSeconds,
		}
	}

	public get isFeatureEnabled(): boolean {
		return this.codebaseIndexEnabled
	}

	public get isFeatureConfigured(): boolean {
		return this.isConfigured()
	}

	public get currentEmbedderProvider(): EmbedderProvider {
		return this.embedderProvider
	}

	public get legacyProvider(): string | undefined {
		return this.legacyEmbedderProvider
	}

	public get qdrantConfig(): { url?: string; apiKey?: string } {
		return { url: this.qdrantUrl, apiKey: this.qdrantApiKey }
	}

	public get vectorStoreConfig(): { provider: VectorStoreProvider; localIndexPath?: string } {
		return { provider: this.vectorStoreProvider, localIndexPath: this.localIndexPath }
	}

	public get currentModelId(): string | undefined {
		return this.modelId
	}

	public get currentModelDimension(): number | undefined {
		const modelId = this.modelId ?? getDefaultModelId("vertex")
		const modelDimension = getModelDimension("vertex", modelId)
		return modelDimension ?? (this.modelDimension && this.modelDimension > 0 ? this.modelDimension : undefined)
	}

	public get currentSearchMinScore(): number {
		if (this.searchMinScore !== undefined) return this.searchMinScore
		const modelId = this.modelId ?? getDefaultModelId("vertex")
		return getModelScoreThreshold("vertex", modelId) ?? DEFAULT_SEARCH_MIN_SCORE
	}

	public get currentSearchMaxResults(): number {
		return this.searchMaxResults ?? DEFAULT_MAX_SEARCH_RESULTS
	}
}
