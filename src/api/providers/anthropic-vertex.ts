import { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { GoogleAuth, JWTInput } from "google-auth-library"

import {
	type ModelInfo,
	type VertexModelId,
	vertexDefaultModelId,
	vertexModels,
	ANTHROPIC_DEFAULT_MAX_TOKENS,
	VERTEX_1M_CONTEXT_MODEL_IDS,
	resolveModelParameterApplicability,
	validateOptionalOutputTokenLimit,
} from "@alpha-code/types"
import { safeJsonParse } from "@alpha-code/core"

import { type ApiHandlerOptions, shouldUseReasoningBudget } from "../../shared/api"
import { logger } from "../../utils/logging"

import { getModelParams } from "../transform/model-params"

import { AnthropicMessageHandler, type AnthropicRequestContext } from "./anthropic-messages"
import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { HelixTokenManager, type HelixParseMode } from "./utils/helix-token-manager"
import { configureVertexGatewayTransport } from "./utils/vertex-gateway-transport"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"

type VertexGatewayRouteTarget = {
	projectId?: string
	location?: string
	modelOverride?: string
	extraHeaders?: Record<string, string>
}

type VertexGatewaySettings = {
	gatewayBaseUrl: string
	projectId: string
	location: string
	pemCaBundlePath: string
	helixCommand: string
	helixParseMode: HelixParseMode
	helixTokenKey: string
	refreshIntervalMinutes: number
	modelRoutingMap: Record<string, VertexGatewayRouteTarget>
}

type VertexGatewayAuthClient = {
	getRequestHeaders: (url?: string | URL) => Promise<Record<string, string>>
	projectId?: string
}

type VertexGatewayGoogleAuth = {
	getClient: () => Promise<VertexGatewayAuthClient>
}

// A model ID supplied by the gateway may be newer than the static catalog. Keep
// the opaque ID usable while withholding reasoning capabilities until the model
// has an explicitly verified entry in the catalog.
const UNKNOWN_VERTEX_CLAUDE_MODEL_INFO: ModelInfo = {
	maxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
}

// https://docs.anthropic.com/en/api/claude-on-vertex-ai
export class AnthropicVertexHandler extends AnthropicMessageHandler {
	private client?: AnthropicVertex
	private directClient?: AnthropicVertex
	private readonly vertexGatewaySettings?: VertexGatewaySettings
	private readonly vertexGatewayClients = new Map<string, AnthropicVertex>()
	private readonly helixTokenManager?: HelixTokenManager
	private readonly vertexGatewayGoogleAuth?: GoogleAuth
	private readonly gatewayFetch?: typeof fetch
	private gatewayTransportSetupPromise?: Promise<void>
	constructor(options: ApiHandlerOptions) {
		super(options)
		this.vertexGatewaySettings = this.resolveVertexGatewaySettings()

		if (this.vertexGatewaySettings) {
			this.vertexGatewayGoogleAuth = this.createGatewayGoogleAuth()
			this.gatewayFetch = this.createGatewayFetch()
			this.helixTokenManager = HelixTokenManager.getOrCreate({
				helixCommand: this.vertexGatewaySettings.helixCommand,
				helixParseMode: this.vertexGatewaySettings.helixParseMode,
				helixTokenKey: this.vertexGatewaySettings.helixTokenKey,
				refreshIntervalMinutes: this.vertexGatewaySettings.refreshIntervalMinutes,
			})

			this.client = this.createVertexClient({
				projectId: this.vertexGatewaySettings.projectId,
				location: this.vertexGatewaySettings.location,
				useHelixAuth: true,
			})
			return
		}

		// The Vertex SDK resolves Application Default Credentials while constructing
		// a direct client. Leave the client unset so creating the default provider
		// does not fail extension activation in an unconfigured environment.
	}

	private getOrCreateDirectClient(): AnthropicVertex {
		if (this.directClient) {
			return this.directClient
		}

		const projectId = this.getConfiguredProjectId() ?? "not-provided"
		const region = this.getConfiguredLocation() ?? "us-east5"

		if (this.options.vertexJsonCredentials) {
			this.directClient = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
				}),
			})
		} else if (this.options.vertexKeyFile) {
			this.directClient = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					keyFile: this.options.vertexKeyFile,
				}),
			})
		} else {
			this.directClient = new AnthropicVertex({ projectId, region })
		}

		return this.directClient
	}

	private getConfiguredProjectId(): string | undefined {
		const value = this.options.projectId ?? this.options.vertexProjectId
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private getConfiguredLocation(): string | undefined {
		const value = this.options.location ?? this.options.vertexRegion
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private getGatewayString(
		field: "gatewayBaseUrl" | "pemCaBundlePath" | "helixCommand",
		legacyField: "vertexGatewayBaseUrl" | "vertexGatewayCaBundlePath" | "vertexGatewayHelixCommand",
	): string | undefined {
		const value = this.options[field] ?? this.options[legacyField]
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private resolveVertexGatewaySettings(): VertexGatewaySettings | undefined {
		const gatewayBaseUrl = this.getGatewayString("gatewayBaseUrl", "vertexGatewayBaseUrl")
		const pemCaBundlePath = this.getGatewayString("pemCaBundlePath", "vertexGatewayCaBundlePath")
		const helixCommand = this.getGatewayString("helixCommand", "vertexGatewayHelixCommand")
		const modelRoutingMap = this.options.modelRoutingMap ?? this.options.vertexGatewayModelRoutingMap
		const gatewayModeRequested = Boolean(gatewayBaseUrl || pemCaBundlePath || helixCommand)

		if (!gatewayModeRequested) {
			return undefined
		}

		const projectId = this.getConfiguredProjectId()
		const location = this.getConfiguredLocation()

		const missingFields = [
			!gatewayBaseUrl ? "gatewayBaseUrl" : undefined,
			!projectId ? "projectId" : undefined,
			!location ? "location" : undefined,
			!pemCaBundlePath ? "pemCaBundlePath" : undefined,
			!helixCommand ? "helixCommand" : undefined,
		].filter((field): field is string => Boolean(field))

		if (missingFields.length > 0) {
			throw new Error(`Missing required Vertex gateway settings: ${missingFields.join(", ")}`)
		}

		let normalizedGatewayBaseUrl: string
		try {
			const parsedGatewayBaseUrl = new URL(gatewayBaseUrl!)
			if (!parsedGatewayBaseUrl.pathname || parsedGatewayBaseUrl.pathname === "/") {
				parsedGatewayBaseUrl.pathname = "/v1"
			}
			normalizedGatewayBaseUrl = parsedGatewayBaseUrl.toString()
		} catch {
			throw new Error("Invalid Vertex gatewayBaseUrl. Expected a valid absolute URL.")
		}

		const parseMode: HelixParseMode = this.options.helixParseMode === "json_field" ? "json_field" : "raw_stdout"
		const helixTokenKey = this.options.helixTokenKey?.trim() || "access_token"
		const refreshIntervalMinutes = this.normalizeRefreshIntervalMinutes(
			this.options.refreshIntervalMinutes ?? this.options.vertexGatewayTokenRefreshMinutes,
		)

		return {
			gatewayBaseUrl: normalizedGatewayBaseUrl,
			projectId: projectId!,
			location: location!,
			pemCaBundlePath: pemCaBundlePath!,
			helixCommand: helixCommand!,
			helixParseMode: parseMode,
			helixTokenKey,
			refreshIntervalMinutes,
			modelRoutingMap: this.parseModelRoutingMap(modelRoutingMap),
		}
	}

	private normalizeRefreshIntervalMinutes(value: unknown): number {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return 10
		}

		return Math.max(1, Math.floor(value))
	}

	private parseModelRoutingMap(rawModelRoutingMap: unknown): Record<string, VertexGatewayRouteTarget> {
		if (!rawModelRoutingMap) {
			return {}
		}

		let candidate: unknown = rawModelRoutingMap
		if (typeof rawModelRoutingMap === "string") {
			if (rawModelRoutingMap.trim().length === 0) {
				return {}
			}

			try {
				candidate = JSON.parse(rawModelRoutingMap)
			} catch {
				throw new Error("Invalid modelRoutingMap JSON for Vertex gateway configuration.")
			}
		}

		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error("Invalid modelRoutingMap. Expected an object keyed by model name.")
		}

		const normalizedRoutingMap: Record<string, VertexGatewayRouteTarget> = {}

		for (const [modelKey, routeValue] of Object.entries(candidate as Record<string, unknown>)) {
			const normalizedModelKey = modelKey.trim()
			if (!normalizedModelKey) {
				continue
			}

			if (typeof routeValue === "string") {
				const modelOverride = routeValue.trim()
				if (modelOverride.length > 0) {
					normalizedRoutingMap[normalizedModelKey] = { modelOverride }
				}
				continue
			}

			if (!routeValue || typeof routeValue !== "object" || Array.isArray(routeValue)) {
				throw new Error(`Invalid modelRoutingMap entry for "${modelKey}".`)
			}

			const routeRecord = routeValue as Record<string, unknown>
			const normalizedRoute: VertexGatewayRouteTarget = {}

			if (typeof routeRecord.projectId === "string" && routeRecord.projectId.trim().length > 0) {
				normalizedRoute.projectId = routeRecord.projectId.trim()
			}

			if (typeof routeRecord.location === "string" && routeRecord.location.trim().length > 0) {
				normalizedRoute.location = routeRecord.location.trim()
			}

			if (typeof routeRecord.modelOverride === "string" && routeRecord.modelOverride.trim().length > 0) {
				normalizedRoute.modelOverride = routeRecord.modelOverride.trim()
			}

			if (routeRecord.extraHeaders !== undefined) {
				if (
					typeof routeRecord.extraHeaders !== "object" ||
					!routeRecord.extraHeaders ||
					Array.isArray(routeRecord.extraHeaders)
				) {
					throw new Error(`Invalid extraHeaders for modelRoutingMap entry "${modelKey}".`)
				}

				const normalizedHeaders = Object.fromEntries(
					Object.entries(routeRecord.extraHeaders as Record<string, unknown>)
						.filter(
							(entry): entry is [string, string] =>
								entry[0].trim().length > 0 && typeof entry[1] === "string",
						)
						.map(([key, value]) => [key.trim(), value]),
				)

				if (Object.keys(normalizedHeaders).length > 0) {
					normalizedRoute.extraHeaders = normalizedHeaders
				}
			}

			if (Object.keys(normalizedRoute).length > 0) {
				normalizedRoutingMap[normalizedModelKey] = normalizedRoute
			}
		}

		return normalizedRoutingMap
	}

	private createGatewayGoogleAuth(): GoogleAuth {
		const authClient: VertexGatewayAuthClient = {
			getRequestHeaders: async () => ({}),
		}

		const googleAuthLike: VertexGatewayGoogleAuth = {
			getClient: async () => authClient,
		}

		return googleAuthLike as unknown as GoogleAuth
	}

	private createGatewayFetch(): typeof fetch {
		if (typeof globalThis.fetch !== "function") {
			throw new Error("Global fetch is not available in this runtime for Vertex gateway transport.")
		}

		const baseFetch = globalThis.fetch.bind(globalThis)

		return async (input, init) => {
			const response = await baseFetch(input, init)
			const url = this.normalizeRequestUrl(input, response.url)

			logger.debug("Anthropic Vertex gateway response received", {
				status: response.status,
				ok: response.ok,
				url,
			})

			return response
		}
	}

	private normalizeRequestUrl(input: Parameters<typeof fetch>[0], responseUrl?: string): string | undefined {
		const rawUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: typeof (input as { url?: unknown })?.url === "string"
						? String((input as { url: unknown }).url)
						: responseUrl

		if (!rawUrl) {
			return undefined
		}

		try {
			const parsed = new URL(rawUrl)
			return `${parsed.origin}${parsed.pathname}`
		} catch {
			return rawUrl
		}
	}

	private createVertexClient({
		projectId,
		location,
		useHelixAuth,
	}: {
		projectId: string
		location: string
		useHelixAuth: boolean
	}): AnthropicVertex {
		if (useHelixAuth) {
			if (!this.vertexGatewaySettings || !this.vertexGatewayGoogleAuth || !this.gatewayFetch) {
				throw new Error("Vertex gateway authentication is not configured.")
			}

			return new AnthropicVertex({
				projectId,
				region: location,
				baseURL: this.vertexGatewaySettings.gatewayBaseUrl,
				googleAuth: this.vertexGatewayGoogleAuth,
				fetch: this.gatewayFetch,
			})
		}

		return new AnthropicVertex({
			projectId,
			region: location,
		})
	}

	private getOrCreateVertexGatewayClient(projectId: string, location: string): AnthropicVertex {
		const cacheKey = `${projectId}::${location}`
		const existingClient = this.vertexGatewayClients.get(cacheKey)

		if (existingClient) {
			return existingClient
		}

		const nextClient = this.createVertexClient({
			projectId,
			location,
			useHelixAuth: true,
		})
		this.vertexGatewayClients.set(cacheKey, nextClient)
		return nextClient
	}

	protected override async getRequestContext(
		model: string,
		metadata?: ApiHandlerSingleCompletionMetadata,
	): Promise<AnthropicRequestContext> {
		throwIfSingleCompletionAborted(metadata)
		if (!this.vertexGatewaySettings) {
			return { client: this.getOrCreateDirectClient(), model }
		}

		await awaitSingleCompletion(this.ensureGatewayTransportConfigured(), metadata)
		throwIfSingleCompletionAborted(metadata)
		const accessToken = await awaitSingleCompletion(this.ensureGatewayAccessToken(false), metadata)

		const route =
			this.vertexGatewaySettings.modelRoutingMap[model] ??
			(this.options.apiModelId ? this.vertexGatewaySettings.modelRoutingMap[this.options.apiModelId] : undefined)

		const routedProjectId = route?.projectId ?? this.vertexGatewaySettings.projectId
		const routedLocation = route?.location ?? this.vertexGatewaySettings.location
		const routedModel = route?.modelOverride ?? model

		const client =
			routedProjectId === this.vertexGatewaySettings.projectId &&
			routedLocation === this.vertexGatewaySettings.location
				? this.client
				: this.getOrCreateVertexGatewayClient(routedProjectId, routedLocation)

		if (!client) {
			throw new Error("Vertex gateway client is not initialized.")
		}

		const requestOptions: Anthropic.RequestOptions = {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(route?.extraHeaders ?? {}),
			},
		}

		return { client, model: routedModel, requestOptions }
	}

	private async ensureGatewayTransportConfigured(): Promise<void> {
		if (!this.vertexGatewaySettings) {
			return
		}

		if (!this.gatewayTransportSetupPromise) {
			this.gatewayTransportSetupPromise = configureVertexGatewayTransport(
				this.vertexGatewaySettings.pemCaBundlePath,
			).then(() => undefined)
		}

		await this.gatewayTransportSetupPromise
	}

	private async ensureGatewayAccessToken(forceRefresh: boolean): Promise<string> {
		if (!this.helixTokenManager) {
			throw new Error("Vertex gateway token manager is not configured.")
		}

		const token = forceRefresh
			? await this.helixTokenManager.forceRefreshToken()
			: await this.helixTokenManager.getToken()

		return token
	}

	protected override async shouldRetryWithRefreshedGatewayToken(error: unknown): Promise<boolean> {
		if (!this.vertexGatewaySettings || !this.isGatewayAuthFailure(error)) {
			return false
		}

		await this.ensureGatewayAccessToken(true)
		return true
	}

	private isGatewayAuthFailure(error: unknown): boolean {
		const status = this.extractStatusCode(error)
		if (status === 401 || status === 403) {
			return true
		}

		const message = error instanceof Error ? error.message : String(error)
		return (
			/\b401\b/.test(message) ||
			/\b403\b/.test(message) ||
			/unauthorized|forbidden|authentication|permission denied|invalid token/i.test(message)
		)
	}

	private extractStatusCode(error: unknown): number | undefined {
		if (!error || typeof error !== "object") {
			return undefined
		}

		const errorRecord = error as Record<string, unknown>
		const nestedResponse =
			errorRecord.response && typeof errorRecord.response === "object"
				? (errorRecord.response as Record<string, unknown>)
				: undefined

		const possibleStatusValues = [
			errorRecord.status,
			errorRecord.statusCode,
			errorRecord.code,
			nestedResponse?.status,
		]

		for (const value of possibleStatusValues) {
			if (typeof value === "number" && Number.isFinite(value)) {
				return value
			}

			if (typeof value === "string") {
				const parsed = Number.parseInt(value, 10)
				if (Number.isFinite(parsed)) {
					return parsed
				}
			}
		}

		return undefined
	}

	protected override getToolChoiceForRequest(
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiHandlerCreateMessageMetadata["tool_choice"] {
		const toolChoice = metadata?.tool_choice

		if (this.vertexGatewaySettings && metadata?.tools?.length && (!toolChoice || toolChoice === "auto")) {
			return "required"
		}

		return toolChoice
	}

	protected override isStreamingEnabled(): boolean {
		return this.options.vertexStreamingEnabled !== false
	}

	protected override getCompletionError(error: Error): Error {
		return new Error(`Vertex completion error: ${error.message}`)
	}

	override getModel() {
		const modelId = this.options.apiModelId?.trim() || vertexDefaultModelId
		const isKnownModel = Object.prototype.hasOwnProperty.call(vertexModels, modelId)
		let id = modelId
		let info: ModelInfo = isKnownModel ? vertexModels[id as VertexModelId] : UNKNOWN_VERTEX_CLAUDE_MODEL_INFO

		// Check if 1M context beta should be enabled for supported models
		const supports1MContext = VERTEX_1M_CONTEXT_MODEL_IDS.includes(
			id as (typeof VERTEX_1M_CONTEXT_MODEL_IDS)[number],
		)
		const enable1MContext = supports1MContext && this.options.vertex1MContext

		// If 1M context beta is enabled, update the model info with tier pricing
		if (enable1MContext) {
			const tier = info.tiers?.[0]
			if (tier) {
				info = {
					...info,
					contextWindow: tier.contextWindow,
					inputPrice: tier.inputPrice,
					outputPrice: tier.outputPrice,
					cacheWritesPrice: tier.cacheWritesPrice,
					cacheReadsPrice: tier.cacheReadsPrice,
				}
			}
		}

		info = applyModelToolPreferences({ provider: "vertex", id }, info)

		const settings = shouldUseReasoningBudget({ model: info, settings: this.options })
			? { ...this.options, modelMaxTokens: validateOptionalOutputTokenLimit(this.options.modelMaxTokens) }
			: this.options
		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings,
			defaultTemperature: 0,
		})
		const maxTokens = validateOptionalOutputTokenLimit(params.maxTokens) ?? ANTHROPIC_DEFAULT_MAX_TOKENS
		if (params.reasoningBudget !== undefined && params.reasoningBudget >= maxTokens) {
			throw new RangeError("Output token limit must exceed the thinking token budget.")
		}

		// Build betas array for request headers
		const betas: string[] = []

		// Add 1M context beta flag if enabled for supported models
		if (enable1MContext) {
			betas.push("context-1m-2025-08-07")
		}

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Anthropic's API does not have this
		// suffix.
		const resolvedId = id.endsWith(":thinking") ? id.replace(":thinking", "") : id
		const applicability = resolveModelParameterApplicability({
			provider: "vertex",
			modelId: resolvedId,
			model: info,
			settings,
		})
		return {
			id: resolvedId,
			info,
			betas: betas.length > 0 ? betas : undefined,
			toolIdentity: { provider: "vertex", id: resolvedId },
			...params,
			maxTokens,
			temperature:
				applicability.fixedTemperature ?? (applicability.supportsTemperature ? params.temperature : undefined),
			verbosity: undefined,
		}
	}
}
