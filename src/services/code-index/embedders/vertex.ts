import { googleEmbeddingInput } from "../shared/google-embedding"
import {
	GoogleGenAI,
	type EmbedContentConfig,
	type EmbedContentParameters,
	type EmbedContentResponse,
} from "@google/genai"
import type { JWTInput } from "google-auth-library"
import { safeJsonParse } from "@alpha-code/core"
import type { ProviderSettings } from "@alpha-code/types"
import { TelemetryEventName } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { t } from "../../../i18n"
import { HelixTokenManager, type HelixParseMode } from "../../../api/providers/utils/helix-token-manager"
import { configureVertexGatewayTransport } from "../../../api/providers/utils/vertex-gateway-transport"
import { GEMINI_MAX_ITEM_TOKENS, MAX_BATCH_RETRIES } from "../constants"
import type {
	IEmbedder,
	EmbeddingResponse,
	EmbedderInfo,
	EmbeddingProgress,
	EmbeddingPriority,
} from "../interfaces/embedder"
import { EmbeddingRequestQueue } from "../shared/embedding-request-queue"
import { withEmbeddingTimeout } from "../shared/embedding-request"
import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../shared/embedding-rate-limiter"
import {
	EmbeddingRequestError,
	getEmbeddingStatus,
	getEmbeddingRetryDelayMs,
	isRetryableEmbeddingError,
} from "../shared/embedding-retry"
import { formatEmbeddingError, withValidationErrorHandling } from "../shared/validation-helpers"

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
	getRequestHeaders: (url?: string | URL) => Promise<Iterable<[string, string]>>
}

type EmbedRequestContext = {
	client: GoogleGenAI
	model: string
	httpOptions?: EmbedContentConfig["httpOptions"]
}

/**
 * Vertex/GCP Gemini embedder for code indexing.
 *
 * Gateway mode intentionally mirrors the main Gemini Vertex provider:
 * Helix supplies bearer tokens, Google auth is neutralized so it cannot
 * overwrite gateway auth, PEM trust is configured before requests, and
 * per-model routing may override project/location/model/headers.
 */
export class VertexGeminiEmbedder implements IEmbedder {
	private static readonly DEFAULT_MODEL = "gemini-embedding-001"
	private readonly client: GoogleGenAI
	private readonly requestConcurrency: number
	private readonly embeddingRequests: EmbeddingRequestQueue
	private readonly embeddingRateLimiter: EmbeddingRateLimiter
	private readonly modelId: string
	private readonly options: ProviderSettings
	private readonly vertexGatewaySettings?: VertexGatewaySettings
	private readonly vertexGatewayClients = new Map<string, GoogleGenAI>()
	private readonly helixTokenManager?: HelixTokenManager
	private readonly vertexGatewayAuthClient?: VertexGatewayAuthClient
	private gatewayTransportSetupPromise?: Promise<void>

	constructor(options: ProviderSettings, modelId?: string, embeddingRateLimitSeconds?: number) {
		if (
			options.apiProvider !== "vertex" ||
			!this.getConfiguredProjectId(options) ||
			!this.getConfiguredLocation(options)
		) {
			throw new Error(t("embeddings:serviceFactory.vertexConfigMissing"))
		}

		this.options = options
		this.modelId = modelId || VertexGeminiEmbedder.DEFAULT_MODEL
		// EmbedContent returns one vector per request. Overlap more independent Gemini 2
		// requests while retaining a shared bound and the user's request-start spacing.
		this.requestConcurrency = this.modelId === "gemini-embedding-2" ? 16 : 8
		this.embeddingRequests = new EmbeddingRequestQueue(this.requestConcurrency)
		this.embeddingRateLimiter = new EmbeddingRateLimiter((embeddingRateLimitSeconds ?? 0) * 1000)
		this.vertexGatewaySettings = this.resolveVertexGatewaySettings()

		if (this.vertexGatewaySettings) {
			this.vertexGatewayAuthClient = {
				getRequestHeaders: async () => [],
			}
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

		const project = this.getConfiguredProjectId(options)!
		const location = this.getConfiguredLocation(options)!

		if (options.vertexJsonCredentials) {
			this.client = new GoogleGenAI({
				vertexai: true,
				project,
				location,
				googleAuthOptions: {
					credentials: safeJsonParse<JWTInput>(options.vertexJsonCredentials, undefined),
				},
			})
		} else if (options.vertexKeyFile) {
			this.client = new GoogleGenAI({
				vertexai: true,
				project,
				location,
				googleAuthOptions: { keyFile: options.vertexKeyFile },
			})
		} else {
			this.client = new GoogleGenAI({ vertexai: true, project, location })
		}
	}

	async createEmbeddings(
		texts: string[],
		model?: string,
		purpose: "document" | "query" = "document",
		signal?: AbortSignal,
		onProgress?: (progress: EmbeddingProgress) => void,
		priority: EmbeddingPriority = purpose === "query" ? "query" : "bulk",
	): Promise<EmbeddingResponse> {
		signal?.throwIfAborted()
		const selectedModel = model || this.modelId
		const maxItemTokens = this.getMaxItemTokens(selectedModel)
		const validTexts: string[] = []
		const estimatedTokenCounts: number[] = []

		for (let i = 0; i < texts.length; i++) {
			const text = texts[i]
			const estimatedTokens = Math.ceil(text.length / 4)

			if (estimatedTokens > maxItemTokens) {
				console.warn(
					t("embeddings:textExceedsTokenLimit", {
						index: i,
						itemTokens: estimatedTokens,
						maxTokens: maxItemTokens,
					}),
				)
				continue
			}

			validTexts.push(text)
			estimatedTokenCounts.push(estimatedTokens)
		}

		if (validTexts.length === 0) {
			return { embeddings: [], usage: { promptTokens: 0, totalTokens: 0 } }
		}

		// Gemini 001 predict and Gemini 2 embedContent accept one input per request.
		// Share a request bound across concurrent scanner batches and preserve input order.
		const responses: EmbeddingResponse[] = new Array(validTexts.length)
		let nextIndex = 0
		let failed = false
		// Refill a free slot immediately instead of waiting for the slowest request in a wave.
		// Bound queued work per caller as well as active requests across scanner batches and queries.
		const workers = await Promise.allSettled(
			Array.from({ length: Math.min(this.requestConcurrency, validTexts.length) }, async () => {
				while (!failed && nextIndex < validTexts.length) {
					signal?.throwIfAborted()
					const index = nextIndex++
					try {
						onProgress?.({ stage: "queued" })
						responses[index] = await this.embeddingRequests.run(
							priority,
							() =>
								this.embedBatchWithRetries(
									[validTexts[index]],
									[estimatedTokenCounts[index]],
									selectedModel,
									purpose,
									signal,
									onProgress,
									priority,
								),
							signal,
						)
					} catch (error) {
						failed = true
						throw error
					}
				}
			}),
		)
		// Drain accepted requests before surfacing a failure so a caller's retry cannot overlap them.
		const failure = workers.find((worker) => worker.status === "rejected")
		if (failure?.status === "rejected") throw failure.reason

		const result: EmbeddingResponse = { embeddings: [], usage: { promptTokens: 0, totalTokens: 0 } }
		for (const response of responses) {
			result.embeddings.push(...response.embeddings)
			result.usage!.promptTokens += response.usage?.promptTokens ?? 0
			result.usage!.totalTokens += response.usage?.totalTokens ?? 0
		}
		return result
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				const response = await this.createEmbeddings(["test"])

				if (!response.embeddings.length) {
					return {
						valid: false,
						error: t("embeddings:validation.invalidResponse"),
					}
				}

				return { valid: true }
			} catch (error) {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "VertexGeminiEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "vertex")
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "vertex",
			preferredBatchSize: this.requestConcurrency,
			managesRateLimit: true,
		}
	}

	private getConfiguredProjectId(options = this.options): string | undefined {
		const value = options.projectId ?? options.vertexProjectId
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private getConfiguredLocation(options = this.options): string | undefined {
		const value = options.location ?? options.vertexRegion
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
			normalizedGatewayBaseUrl = new URL(gatewayBaseUrl!).toString()
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

	private createVertexClient({
		projectId,
		location,
		useHelixAuth,
	}: {
		projectId: string
		location: string
		useHelixAuth: boolean
	}): GoogleGenAI {
		if (useHelixAuth) {
			if (!this.vertexGatewaySettings || !this.vertexGatewayAuthClient) {
				throw new Error("Vertex gateway authentication is not configured.")
			}

			return new GoogleGenAI({
				vertexai: true,
				project: projectId,
				location,
				googleAuthOptions: {
					authClient: this.vertexGatewayAuthClient as any,
				},
				httpOptions: {
					baseUrl: this.vertexGatewaySettings.gatewayBaseUrl,
				},
			})
		}

		return new GoogleGenAI({ vertexai: true, project: projectId, location })
	}

	private async getRequestContext(model: string): Promise<EmbedRequestContext> {
		if (!this.vertexGatewaySettings) {
			return { client: this.client, model }
		}

		await this.ensureGatewayTransportConfigured()
		const accessToken = await this.ensureGatewayAccessToken(false)
		const route = this.vertexGatewaySettings.modelRoutingMap[model]
		const routedProjectId = route?.projectId ?? this.vertexGatewaySettings.projectId
		const routedLocation = route?.location ?? this.vertexGatewaySettings.location
		const routedModel = route?.modelOverride ?? model

		const client =
			routedProjectId === this.vertexGatewaySettings.projectId &&
			routedLocation === this.vertexGatewaySettings.location
				? this.client
				: this.getOrCreateVertexGatewayClient(routedProjectId, routedLocation)

		return {
			client,
			model: routedModel,
			httpOptions: {
				baseUrl: this.vertexGatewaySettings.gatewayBaseUrl,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					...(route?.extraHeaders ?? {}),
				},
			},
		}
	}

	private getOrCreateVertexGatewayClient(projectId: string, location: string): GoogleGenAI {
		const cacheKey = `${projectId}::${location}`
		const existingClient = this.vertexGatewayClients.get(cacheKey)

		if (existingClient) {
			return existingClient
		}

		const nextClient = this.createVertexClient({ projectId, location, useHelixAuth: true })
		this.vertexGatewayClients.set(cacheKey, nextClient)
		return nextClient
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

		return forceRefresh ? await this.helixTokenManager.forceRefreshToken() : await this.helixTokenManager.getToken()
	}

	private async shouldRetryWithRefreshedGatewayToken(error: unknown): Promise<boolean> {
		if (!this.vertexGatewaySettings || !this.isGatewayAuthFailure(error)) {
			return false
		}

		await this.ensureGatewayAccessToken(true)
		return true
	}

	private isGatewayAuthFailure(error: unknown): boolean {
		const status = getEmbeddingStatus(error)
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

	private getMaxItemTokens(modelId: string): number {
		return modelId === "gemini-embedding-2" ? 8192 : GEMINI_MAX_ITEM_TOKENS
	}

	private async embedBatchWithRetries(
		texts: string[],
		estimatedTokenCounts: number[],
		selectedModel: string,
		purpose: "document" | "query",
		signal?: AbortSignal,
		onProgress?: (progress: EmbeddingProgress) => void,
		priority: EmbeddingPriority = purpose === "query" ? "query" : "bulk",
	): Promise<EmbeddingResponse> {
		let didRetryForGatewayAuth = false
		let lastError: unknown
		let requestAttempts = 0

		for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
			signal?.throwIfAborted()
			// Preserve the gateway's pre-2.1.34 predict payload, including opaque model aliases.
			// Native Google task types/instructions are not part of that gateway contract.
			const input = this.vertexGatewaySettings
				? { contents: texts, config: {} }
				: googleEmbeddingInput(texts, selectedModel, purpose)
			try {
				// Gate actual request starts, including retries and calls from concurrent index consumers.
				onProgress?.({ stage: "queued" })
				await this.embeddingRateLimiter.wait(
					signal,
					1,
					(waitMs) => onProgress?.({ stage: "queued", waitMs }),
					priority,
				)
				requestAttempts++
				onProgress?.({ stage: "request" })
				const response = await withEmbeddingTimeout(async (requestSignal) => {
					const requestContext = await this.getRequestContext(selectedModel)
					requestSignal.throwIfAborted()
					const params: EmbedContentParameters = {
						model: requestContext.model,
						contents: input.contents,
						config: {
							...input.config,
							...(requestContext.httpOptions ? { httpOptions: requestContext.httpOptions } : {}),
							abortSignal: requestSignal,
						},
					}
					return requestContext.client.models.embedContent(params)
				}, signal)
				signal?.throwIfAborted()
				return this.createEmbeddingResponse(response, estimatedTokenCounts)
			} catch (error) {
				signal?.throwIfAborted()
				lastError = error

				if (
					!didRetryForGatewayAuth &&
					(await withEmbeddingTimeout(() => this.shouldRetryWithRefreshedGatewayToken(error), signal))
				) {
					didRetryForGatewayAuth = true
					attempt--
					continue
				}

				const hasMoreAttempts = attempt < MAX_BATCH_RETRIES - 1
				const retryDelayMs = getEmbeddingRetryDelayMs(error, attempt)
				if (getEmbeddingStatus(error) === 429) this.embeddingRateLimiter.defer(retryDelayMs)
				if (hasMoreAttempts && isRetryableEmbeddingError(error)) {
					onProgress?.({ stage: "retry", waitMs: retryDelayMs })
					await waitForEmbeddingDelay(retryDelayMs, signal)
					continue
				}

				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "VertexGeminiEmbedder:createEmbeddings",
					attempt: requestAttempts,
				})
				throw new EmbeddingRequestError(formatEmbeddingError(error, requestAttempts))
			}
		}

		throw new EmbeddingRequestError(formatEmbeddingError(lastError, requestAttempts))
	}

	private createEmbeddingResponse(response: EmbedContentResponse, estimatedTokenCounts: number[]): EmbeddingResponse {
		const responseEmbeddings = response.embeddings ?? []
		const embeddings = responseEmbeddings.map((embedding) => embedding.values ?? [])

		if (embeddings.length !== estimatedTokenCounts.length || embeddings.some((values) => values.length === 0)) {
			throw new Error(t("embeddings:validation.invalidResponse"))
		}

		const promptTokens = responseEmbeddings.reduce(
			(total, embedding, index) => total + (embedding.statistics?.tokenCount ?? estimatedTokenCounts[index] ?? 0),
			0,
		)
		const totalTokens = promptTokens || estimatedTokenCounts.reduce((total, count) => total + count, 0)

		return {
			embeddings,
			usage: {
				promptTokens: totalTokens,
				totalTokens,
			},
		}
	}
}
