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
} from "@alpha-code/types"
import { safeJsonParse } from "@alpha-code/core"

import { ApiHandlerOptions } from "../../shared/api"
import { logger } from "../../utils/logging"

import { ApiStream } from "../transform/stream"
import { addCacheBreakpoints } from "../transform/caching/vertex"
import { getModelParams } from "../transform/model-params"
import { filterNonAnthropicBlocks } from "../transform/anthropic-filter"
import {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../core/prompts/tools/native-tools/converters"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { HelixTokenManager, type HelixParseMode } from "./utils/helix-token-manager"
import { configureVertexGatewayTransport } from "./utils/vertex-gateway-transport"

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

type AnthropicRequestContext = {
	client: AnthropicVertex
	model: string
	requestOptions?: Anthropic.RequestOptions
}

type VertexGatewayAuthClient = {
	getRequestHeaders: (url?: string | URL) => Promise<Record<string, string>>
	projectId?: string
}

type VertexGatewayGoogleAuth = {
	getClient: () => Promise<VertexGatewayAuthClient>
}

// https://docs.anthropic.com/en/api/claude-on-vertex-ai
export class AnthropicVertexHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: AnthropicVertex
	private readonly vertexGatewaySettings?: VertexGatewaySettings
	private readonly vertexGatewayClients = new Map<string, AnthropicVertex>()
	private readonly helixTokenManager?: HelixTokenManager
	private readonly vertexGatewayGoogleAuth?: GoogleAuth
	private readonly gatewayFetch?: typeof fetch
	private gatewayTransportSetupPromise?: Promise<void>

	constructor(options: ApiHandlerOptions) {
		super()

		this.options = options
		this.vertexGatewaySettings = this.resolveVertexGatewaySettings()

		// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#regions
		const projectId = this.getConfiguredProjectId() ?? "not-provided"
		const region = this.getConfiguredLocation() ?? "us-east5"

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

		if (this.options.vertexJsonCredentials) {
			this.client = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
				}),
			})
		} else if (this.options.vertexKeyFile) {
			this.client = new AnthropicVertex({
				projectId,
				region,
				googleAuth: new GoogleAuth({
					scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					keyFile: this.options.vertexKeyFile,
				}),
			})
		} else {
			this.client = new AnthropicVertex({ projectId, region })
		}
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

	private async getRequestContext(model: string): Promise<AnthropicRequestContext> {
		if (!this.vertexGatewaySettings) {
			return { client: this.client, model }
		}

		await this.ensureGatewayTransportConfigured()
		const accessToken = await this.ensureGatewayAccessToken(false)

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

	private async shouldRetryWithRefreshedGatewayToken(error: unknown): Promise<boolean> {
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

	private mergeRequestOptions(
		baseRequestOptions: Anthropic.RequestOptions | undefined,
		overrideRequestOptions: Anthropic.RequestOptions | undefined,
	): Anthropic.RequestOptions | undefined {
		if (!baseRequestOptions && !overrideRequestOptions) {
			return undefined
		}

		const mergedHeaders =
			baseRequestOptions?.headers || overrideRequestOptions?.headers
				? {
						...(baseRequestOptions?.headers ?? {}),
						...(overrideRequestOptions?.headers ?? {}),
					}
				: undefined

		return {
			...(baseRequestOptions ?? {}),
			...(overrideRequestOptions ?? {}),
			...(mergedHeaders ? { headers: mergedHeaders } : {}),
		}
	}

	private removeCacheControlFromMessages(
		messages: Anthropic.Messages.MessageParam[],
	): Anthropic.Messages.MessageParam[] {
		return messages.map((message) => {
			if (typeof message.content === "string" || !Array.isArray(message.content)) {
				return message
			}

			return {
				...message,
				content: message.content.map((content) => {
					if (!content || typeof content !== "object" || !("cache_control" in content)) {
						return content
					}

					const { cache_control: _cacheControl, ...rest } = content as unknown as Record<string, unknown>
					return rest as unknown as (typeof message.content)[number]
				}),
			}
		})
	}

	private isPromptCachingDisabledError(error: unknown): boolean {
		const message = this.extractErrorMessage(error)
		return (
			/prompt caching has been disabled/i.test(message) ||
			(/cache_control/i.test(message) && /prompt caching/i.test(message))
		)
	}

	private extractErrorMessage(error: unknown): string {
		if (typeof error === "string") {
			return error
		}

		if (error instanceof Error && typeof error.message === "string") {
			return error.message
		}

		try {
			return JSON.stringify(error)
		} catch {
			return String(error)
		}
	}

	private stringifyInitialToolInput(input: unknown): string | undefined {
		if (input == null) {
			return undefined
		}

		if (typeof input === "string") {
			return input.trim() ? input : undefined
		}

		if (typeof input === "object") {
			if (!Array.isArray(input) && Object.keys(input).length === 0) {
				return undefined
			}

			try {
				return JSON.stringify(input)
			} catch {
				return undefined
			}
		}

		return undefined
	}

	private stringifyToolArguments(input: unknown): string {
		return this.stringifyInitialToolInput(input) ?? "{}"
	}

	private getToolChoiceForRequest(
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiHandlerCreateMessageMetadata["tool_choice"] {
		const toolChoice = metadata?.tool_choice

		if (this.vertexGatewaySettings && metadata?.tools?.length && (!toolChoice || toolChoice === "auto")) {
			return "required"
		}

		return toolChoice
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		let { id, info, temperature, maxTokens, reasoning: thinking, betas } = this.getModel()

		const { supportsPromptCache } = info

		// Filter out non-Anthropic blocks (reasoning, thoughtSignature, etc.) before sending to the API
		const sanitizedMessages = filterNonAnthropicBlocks(messages)

		const nativeToolParams = {
			tools: convertOpenAIToolsToAnthropic(metadata?.tools ?? []),
			tool_choice: convertOpenAIToolChoiceToAnthropic(
				this.getToolChoiceForRequest(metadata),
				metadata?.parallelToolCalls,
			),
		}
		const uncachedMessages = this.removeCacheControlFromMessages(sanitizedMessages)

		const betaRequestOptions: Anthropic.RequestOptions | undefined = betas?.length
			? { headers: { "anthropic-beta": betas.join(",") } }
			: undefined
		let didRetryForGatewayAuth = false
		let didRetryWithoutPromptCache = false
		let usePromptCache = supportsPromptCache

		while (true) {
			const requestContext = await this.getRequestContext(id)

			/**
			 * Vertex API has specific limitations for prompt caching:
			 * 1. Maximum of 4 blocks can have cache_control
			 * 2. Only text blocks can be cached (images and other content types cannot)
			 * 3. Cache control can only be applied to user messages, not assistant messages
			 *
			 * Our caching strategy:
			 * - Cache the system prompt (1 block)
			 * - Cache the last text block of the second-to-last user message (1 block)
			 * - Cache the last text block of the last user message (1 block)
			 * This ensures we stay under the 4-block limit while maintaining effective caching
			 * for the most relevant context.
			 */
			const params = {
				model: id,
				max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
				temperature,
				thinking,
				system: usePromptCache
					? [{ text: systemPrompt, type: "text" as const, cache_control: { type: "ephemeral" } }]
					: systemPrompt,
				messages: usePromptCache ? addCacheBreakpoints(sanitizedMessages) : uncachedMessages,
				...nativeToolParams,
			}

			const requestParams = {
				...params,
				model: requestContext.model,
				stream: this.options.vertexStreamingEnabled !== false,
			}
			const requestOptions = this.mergeRequestOptions(betaRequestOptions, requestContext.requestOptions)
			let emittedAnyStreamChunk = false
			const activeToolUseBlocks = new Map<
				number,
				{
					id: string
					initialArguments?: string
					sawInputJsonDelta: boolean
				}
			>()

			try {
				if (requestParams.stream === false) {
					const response = await requestContext.client.messages.create(
						requestParams as Anthropic.Messages.MessageCreateParamsNonStreaming,
						requestOptions,
					)

					if (response.usage) {
						yield {
							type: "usage",
							inputTokens: response.usage.input_tokens || 0,
							outputTokens: response.usage.output_tokens || 0,
							cacheWriteTokens: response.usage.cache_creation_input_tokens || undefined,
							cacheReadTokens: response.usage.cache_read_input_tokens || undefined,
						}
					}

					for (const [index, block] of response.content.entries()) {
						switch (block.type) {
							case "text": {
								if (index > 0) {
									yield { type: "text", text: "\n" }
								}
								yield { type: "text", text: block.text }
								break
							}
							case "thinking": {
								if (index > 0) {
									yield { type: "reasoning", text: "\n" }
								}
								yield { type: "reasoning", text: (block as any).thinking }
								break
							}
							case "tool_use": {
								const toolUseBlock = block as Anthropic.Messages.ToolUseBlock & { input?: unknown }
								yield {
									type: "tool_call",
									id: toolUseBlock.id,
									name: toolUseBlock.name,
									arguments: this.stringifyToolArguments(toolUseBlock.input),
								}
								break
							}
						}
					}

					return
				}

				const stream = await requestContext.client.messages.create(
					requestParams as Anthropic.Messages.MessageCreateParamsStreaming,
					requestOptions,
				)

				for await (const chunk of stream) {
					emittedAnyStreamChunk = true

					switch (chunk.type) {
						case "message_start": {
							const usage = chunk.message!.usage

							yield {
								type: "usage",
								inputTokens: usage.input_tokens || 0,
								outputTokens: usage.output_tokens || 0,
								cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
								cacheReadTokens: usage.cache_read_input_tokens || undefined,
							}

							break
						}
						case "message_delta": {
							yield {
								type: "usage",
								inputTokens: 0,
								outputTokens: chunk.usage!.output_tokens || 0,
							}

							break
						}
						case "content_block_start": {
							switch (chunk.content_block!.type) {
								case "text": {
									if (chunk.index! > 0) {
										yield { type: "text", text: "\n" }
									}

									yield { type: "text", text: chunk.content_block!.text }
									break
								}
								case "thinking": {
									if (chunk.index! > 0) {
										yield { type: "reasoning", text: "\n" }
									}

									yield { type: "reasoning", text: (chunk.content_block as any).thinking }
									break
								}
								case "tool_use": {
									const toolUseBlock = chunk.content_block as Anthropic.Messages.ToolUseBlock & {
										input?: unknown
									}
									const index = chunk.index!
									activeToolUseBlocks.set(index, {
										id: toolUseBlock.id,
										initialArguments: this.stringifyInitialToolInput(toolUseBlock.input),
										sawInputJsonDelta: false,
									})

									// Emit initial tool call partial with id and name
									yield {
										type: "tool_call_partial",
										index,
										id: toolUseBlock.id,
										name: toolUseBlock.name,
										arguments: undefined,
									}
									break
								}
							}

							break
						}
						case "content_block_delta": {
							switch (chunk.delta!.type) {
								case "text_delta": {
									yield { type: "text", text: chunk.delta!.text }
									break
								}
								case "thinking_delta": {
									yield { type: "reasoning", text: (chunk.delta as any).thinking }
									break
								}
								case "input_json_delta": {
									const activeToolUseBlock = activeToolUseBlocks.get(chunk.index!)
									if (activeToolUseBlock) {
										activeToolUseBlock.sawInputJsonDelta = true
									}

									// Emit tool call partial chunks as arguments stream in
									yield {
										type: "tool_call_partial",
										index: chunk.index,
										id: undefined,
										name: undefined,
										arguments: (chunk.delta as any).partial_json,
									}
									break
								}
							}

							break
						}
						case "content_block_stop": {
							const activeToolUseBlock = activeToolUseBlocks.get(chunk.index!)
							if (activeToolUseBlock) {
								if (!activeToolUseBlock.sawInputJsonDelta && activeToolUseBlock.initialArguments) {
									yield {
										type: "tool_call_partial",
										index: chunk.index,
										id: undefined,
										name: undefined,
										arguments: activeToolUseBlock.initialArguments,
									}
								}

								yield {
									type: "tool_call_end",
									id: activeToolUseBlock.id,
								}
								activeToolUseBlocks.delete(chunk.index!)
							}

							// Note: Signature for multi-turn thinking would require using stream.finalMessage()
							// after iteration completes, which requires restructuring the streaming approach.
							break
						}
					}
				}

				return
			} catch (error) {
				if (
					!didRetryForGatewayAuth &&
					!emittedAnyStreamChunk &&
					(await this.shouldRetryWithRefreshedGatewayToken(error))
				) {
					didRetryForGatewayAuth = true
					continue
				}

				if (!didRetryWithoutPromptCache && usePromptCache && this.isPromptCachingDisabledError(error)) {
					didRetryWithoutPromptCache = true
					usePromptCache = false
					continue
				}

				throw error
			}
		}
	}

	getModel() {
		const modelId = this.options.apiModelId
		let id = modelId && modelId in vertexModels ? (modelId as VertexModelId) : vertexDefaultModelId
		let info: ModelInfo = vertexModels[id]

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

		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

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
		return {
			id: id.endsWith(":thinking") ? id.replace(":thinking", "") : id,
			info,
			betas: betas.length > 0 ? betas : undefined,
			...params,
		}
	}

	async completePrompt(prompt: string) {
		try {
			let {
				id,
				info: { supportsPromptCache },
				temperature,
				maxTokens = ANTHROPIC_DEFAULT_MAX_TOKENS,
				reasoning: thinking,
			} = this.getModel()

			let didRetryForGatewayAuth = false
			let didRetryWithoutPromptCache = false
			let usePromptCache = supportsPromptCache

			while (true) {
				const requestContext = await this.getRequestContext(id)

				const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
					model: id,
					max_tokens: maxTokens,
					temperature,
					thinking,
					messages: [
						{
							role: "user",
							content: usePromptCache
								? [{ type: "text" as const, text: prompt, cache_control: { type: "ephemeral" } }]
								: prompt,
						},
					],
					stream: false,
				}

				const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
					...params,
					model: requestContext.model,
				}

				try {
					const response = await requestContext.client.messages.create(
						requestParams,
						requestContext.requestOptions,
					)
					const content = response.content[0]

					if (content.type === "text") {
						return content.text
					}

					return ""
				} catch (error) {
					if (!didRetryForGatewayAuth && (await this.shouldRetryWithRefreshedGatewayToken(error))) {
						didRetryForGatewayAuth = true
						continue
					}

					if (!didRetryWithoutPromptCache && usePromptCache && this.isPromptCachingDisabledError(error)) {
						didRetryWithoutPromptCache = true
						usePromptCache = false
						continue
					}

					throw error
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Vertex completion error: ${error.message}`)
			}

			throw error
		}
	}
}
