import type { Anthropic } from "@anthropic-ai/sdk"
import {
	GoogleGenAI,
	type GenerateContentResponseUsageMetadata,
	type GenerateContentParameters,
	type GenerateContentConfig,
	type GroundingMetadata,
	FunctionCallingConfigMode,
} from "@google/genai"
import type { JWTInput } from "google-auth-library"

import {
	type ModelInfo,
	type GeminiModelId,
	geminiDefaultModelId,
	geminiModels,
	ApiProviderError,
} from "@alpha-code/types"
import { safeJsonParse } from "@alpha-code/core"
import { TelemetryService } from "@alpha-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"

import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { t } from "i18next"
import type { ApiStream, GroundingSource } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"
import { HelixTokenManager, type HelixParseMode } from "./utils/helix-token-manager"
import { configureVertexGatewayTransport } from "./utils/vertex-gateway-transport"

type GeminiHandlerOptions = ApiHandlerOptions & {
	isVertex?: boolean
}

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

type GeminiRequestContext = {
	client: GoogleGenAI
	model: string
	httpOptions?: GenerateContentConfig["httpOptions"]
}

type VertexGatewayAuthClient = {
	getRequestHeaders: (url?: string | URL) => Promise<Iterable<[string, string]>>
}

export class GeminiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions

	private client: GoogleGenAI
	private readonly isVertex: boolean
	private readonly vertexGatewaySettings?: VertexGatewaySettings
	private readonly vertexGatewayClients = new Map<string, GoogleGenAI>()
	private readonly helixTokenManager?: HelixTokenManager
	private readonly vertexGatewayAuthClient?: VertexGatewayAuthClient
	private gatewayTransportSetupPromise?: Promise<void>
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly providerName = "Gemini"

	constructor({ isVertex, ...options }: GeminiHandlerOptions) {
		super()

		this.options = options
		this.isVertex = Boolean(isVertex)
		this.vertexGatewaySettings = this.isVertex ? this.resolveVertexGatewaySettings() : undefined

		const project = this.getConfiguredProjectId() ?? "not-provided"
		const location = this.getConfiguredLocation() ?? "not-provided"
		const apiKey = this.options.geminiApiKey ?? "not-provided"

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

		this.client = this.options.vertexJsonCredentials
			? new GoogleGenAI({
					vertexai: true,
					project,
					location,
					googleAuthOptions: {
						credentials: safeJsonParse<JWTInput>(this.options.vertexJsonCredentials, undefined),
					},
				})
			: this.options.vertexKeyFile
				? new GoogleGenAI({
						vertexai: true,
						project,
						location,
						googleAuthOptions: { keyFile: this.options.vertexKeyFile },
					})
				: this.isVertex
					? new GoogleGenAI({ vertexai: true, project, location })
					: new GoogleGenAI({ apiKey })
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

		return new GoogleGenAI({
			vertexai: true,
			project: projectId,
			location,
		})
	}

	private async getRequestContext(model: string): Promise<GeminiRequestContext> {
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

		const httpOptions: GenerateContentConfig["httpOptions"] = {
			baseUrl: this.vertexGatewaySettings.gatewayBaseUrl,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(route?.extraHeaders ?? {}),
			},
		}

		return { client, model: routedModel, httpOptions }
	}

	private getOrCreateVertexGatewayClient(projectId: string, location: string): GoogleGenAI {
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

	private mergeHttpOptions(
		baseHttpOptions: GenerateContentConfig["httpOptions"],
		overrideHttpOptions: GenerateContentConfig["httpOptions"],
	): GenerateContentConfig["httpOptions"] {
		if (!baseHttpOptions && !overrideHttpOptions) {
			return undefined
		}

		const mergedHeaders =
			baseHttpOptions?.headers || overrideHttpOptions?.headers
				? {
						...(baseHttpOptions?.headers ?? {}),
						...(overrideHttpOptions?.headers ?? {}),
					}
				: undefined

		return {
			...(baseHttpOptions ?? {}),
			...(overrideHttpOptions ?? {}),
			...(mergedHeaders ? { headers: mergedHeaders } : {}),
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		// Reset per-request metadata that we persist into apiConversationHistory.
		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		// For hybrid/budget reasoning models (e.g. Gemini 2.5 Pro), respect user-configured
		// modelMaxTokens so the ThinkingBudget slider can control the cap. For effort-only or
		// standard models (like gemini-3-pro-preview), ignore any stale modelMaxTokens and
		// default to the model's computed maxTokens from getModelMaxOutputTokens.
		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		const maxOutputTokens = isHybridReasoningModel
			? (this.options.modelMaxTokens ?? maxTokens ?? undefined)
			: (maxTokens ?? undefined)

		// Gemini 3 validates thought signatures for tool/function calling steps.
		// We must round-trip the signature when tools are in use, even if the user chose
		// a minimal thinking level (or thinkingConfig is otherwise absent).
		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		// The message list can include provider-specific meta entries such as
		// `{ type: "reasoning", ... }` that are intended only for providers like
		// openai-native. Gemini should never see those; they are not valid
		// Anthropic.MessageParam values and will cause failures (e.g. missing
		// `content` for the converter). Filter them out here.
		type ReasoningMetaLike = { type?: string }

		const geminiMessages = messages.filter((message): message is Anthropic.Messages.MessageParam => {
			const meta = message as ReasoningMetaLike
			if (meta.type === "reasoning") {
				return false
			}
			return true
		})

		// Build a map of tool IDs to names from previous messages
		// This is needed because Anthropic's tool_result blocks only contain the ID,
		// but Gemini requires the name in functionResponse
		const toolIdToName = new Map<string, string>()
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "tool_use") {
						toolIdToName.set(block.id, block.name)
					}
				}
			}
		}

		const contents = geminiMessages
			.map((message) => convertAnthropicMessageToGemini(message, { includeThoughtSignatures, toolIdToName }))
			.flat()

		// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS).
		// Google built-in tools (Grounding, URL Context) are mutually exclusive
		// with function declarations in the Gemini API, so we always use
		// function declarations when tools are provided.
		const tools: GenerateContentConfig["tools"] = [
			{
				functionDeclarations: (metadata?.tools ?? []).map((tool) => ({
					name: (tool as any).function.name,
					description: (tool as any).function.description,
					parametersJsonSchema: (tool as any).function.parameters,
				})),
			},
		]

		// Determine temperature respecting model capabilities and defaults:
		// - If supportsTemperature is explicitly false, ignore user overrides
		//   and pin to the model's defaultTemperature (or omit if undefined).
		// - Otherwise, allow the user setting to override, falling back to model default,
		//   then to 1 for Gemini provider default.
		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		const config: GenerateContentConfig = {
			systemInstruction,
			httpOptions: this.options.googleGeminiBaseUrl ? { baseUrl: this.options.googleGeminiBaseUrl } : undefined,
			thinkingConfig,
			maxOutputTokens,
			temperature: temperatureConfig,
			...(tools.length > 0 ? { tools } : {}),
		}

		// Handle allowedFunctionNames for mode-restricted tool access.
		// When provided, all tool definitions are passed to the model (so it can reference
		// historical tool calls in conversation), but only the specified tools can be invoked.
		// This takes precedence over tool_choice to ensure mode restrictions are honored.
		if (metadata?.allowedFunctionNames && metadata.allowedFunctionNames.length > 0) {
			config.toolConfig = {
				functionCallingConfig: {
					// Use ANY mode to allow calling any of the allowed functions
					mode: FunctionCallingConfigMode.ANY,
					allowedFunctionNames: metadata.allowedFunctionNames,
				},
			}
		} else if (metadata?.tool_choice) {
			const choice = metadata.tool_choice
			let mode: FunctionCallingConfigMode
			let allowedFunctionNames: string[] | undefined

			if (choice === "auto") {
				mode = FunctionCallingConfigMode.AUTO
			} else if (choice === "none") {
				mode = FunctionCallingConfigMode.NONE
			} else if (choice === "required") {
				// "required" means the model must call at least one tool; Gemini uses ANY for this.
				mode = FunctionCallingConfigMode.ANY
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				mode = FunctionCallingConfigMode.ANY
				allowedFunctionNames = [choice.function.name]
			} else {
				// Fall back to AUTO for unknown values to avoid unintentionally broadening tool access.
				mode = FunctionCallingConfigMode.AUTO
			}

			config.toolConfig = {
				functionCallingConfig: {
					mode,
					...(allowedFunctionNames ? { allowedFunctionNames } : {}),
				},
			}
		}

		let didRetryForGatewayAuth = false

		while (true) {
			const requestContext = await this.getRequestContext(model)
			const params: GenerateContentParameters = {
				model: requestContext.model,
				contents,
				config: {
					...config,
					httpOptions: this.mergeHttpOptions(config.httpOptions, requestContext.httpOptions),
				},
			}

			let emittedAnyStreamChunk = false

			try {
				if (this.isVertex && this.options.vertexStreamingEnabled === false) {
					const result = await requestContext.client.models.generateContent(params)

					let toolCallCounter = 0
					let hasContent = false
					let hasReasoning = false
					const candidate = result.candidates?.[0]

					if (result.responseId) {
						this.lastResponseId = result.responseId
					}

					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts as Array<{
							thought?: boolean
							text?: string
							thoughtSignature?: string
							functionCall?: { name: string; args?: Record<string, unknown> }
						}>) {
							const thoughtSignature = part.thoughtSignature
							if (includeThoughtSignatures && thoughtSignature) {
								this.lastThoughtSignature = thoughtSignature
							}

							if (part.thought) {
								if (part.text) {
									hasReasoning = true
									yield { type: "reasoning", text: part.text }
								}
							} else if (part.functionCall) {
								hasContent = true
								const callId = `${part.functionCall.name}-${toolCallCounter}`
								yield {
									type: "tool_call",
									id: callId,
									name: part.functionCall.name,
									arguments: JSON.stringify(part.functionCall.args ?? {}),
								}
								toolCallCounter++
							} else if (part.text) {
								hasContent = true
								yield { type: "text", text: part.text }
							}
						}
					} else if (result.text) {
						hasContent = true
						yield { type: "text", text: result.text }
					}

					if (candidate?.groundingMetadata) {
						const sources = this.extractGroundingSources(candidate.groundingMetadata)
						if (sources.length > 0) {
							yield { type: "grounding", sources }
						}
					}

					if (result.usageMetadata) {
						const inputTokens = result.usageMetadata.promptTokenCount ?? 0
						const outputTokens = result.usageMetadata.candidatesTokenCount ?? 0
						const cacheReadTokens = result.usageMetadata.cachedContentTokenCount
						const reasoningTokens = result.usageMetadata.thoughtsTokenCount

						yield {
							type: "usage",
							inputTokens,
							outputTokens,
							cacheReadTokens,
							reasoningTokens,
							totalCost: this.calculateCost({
								info,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								reasoningTokens,
							}),
						}
					}

					if (!hasContent && !hasReasoning) {
						const finishReason = candidate?.finishReason
						if (finishReason === "MAX_TOKENS") {
							yield { type: "text", text: "[Response truncated due to max tokens limit]" }
						}
					}

					return
				}

				const result = await requestContext.client.models.generateContentStream(params)

				let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
				let pendingGroundingMetadata: GroundingMetadata | undefined
				let finalResponse: { responseId?: string } | undefined
				let finishReason: string | undefined

				let toolCallCounter = 0
				let hasContent = false
				let hasReasoning = false

				for await (const chunk of result) {
					emittedAnyStreamChunk = true

					// Track the final structured response (per SDK pattern: candidate.finishReason)
					if (chunk.candidates && chunk.candidates[0]?.finishReason) {
						finalResponse = chunk as { responseId?: string }
						finishReason = chunk.candidates[0].finishReason
					}
					// Process candidates and their parts to separate thoughts from content
					if (chunk.candidates && chunk.candidates.length > 0) {
						const candidate = chunk.candidates[0]

						if (candidate.groundingMetadata) {
							pendingGroundingMetadata = candidate.groundingMetadata
						}

						if (candidate.content && candidate.content.parts) {
							for (const part of candidate.content.parts as Array<{
								thought?: boolean
								text?: string
								thoughtSignature?: string
								functionCall?: { name: string; args: Record<string, unknown> }
							}>) {
								// Capture thought signatures so they can be persisted into API history.
								const thoughtSignature = part.thoughtSignature
								// Persist thought signatures so they can be round-tripped in the next step.
								// Gemini 3 requires this during tool calling; other Gemini thinking models
								// benefit from it for continuity.
								if (includeThoughtSignatures && thoughtSignature) {
									this.lastThoughtSignature = thoughtSignature
								}

								if (part.thought) {
									// This is a thinking/reasoning part
									if (part.text) {
										hasReasoning = true
										yield { type: "reasoning", text: part.text }
									}
								} else if (part.functionCall) {
									hasContent = true
									// Gemini sends complete function calls in a single chunk
									// Emit as partial chunks for consistent handling with NativeToolCallParser
									const callId = `${part.functionCall.name}-${toolCallCounter}`
									const args = JSON.stringify(part.functionCall.args)

									// Emit name first
									yield {
										type: "tool_call_partial",
										index: toolCallCounter,
										id: callId,
										name: part.functionCall.name,
										arguments: undefined,
									}

									// Then emit arguments
									yield {
										type: "tool_call_partial",
										index: toolCallCounter,
										id: callId,
										name: undefined,
										arguments: args,
									}

									toolCallCounter++
								} else {
									// This is regular content
									if (part.text) {
										hasContent = true
										yield { type: "text", text: part.text }
									}
								}
							}
						}
					}

					// Fallback to the original text property if no candidates structure
					else if (chunk.text) {
						hasContent = true
						yield { type: "text", text: chunk.text }
					}

					if (chunk.usageMetadata) {
						lastUsageMetadata = chunk.usageMetadata
					}
				}

				if (finalResponse?.responseId) {
					// Capture responseId so Task.addToApiConversationHistory can store it
					// alongside the assistant message in api_history.json.
					this.lastResponseId = finalResponse.responseId
				}

				if (pendingGroundingMetadata) {
					const sources = this.extractGroundingSources(pendingGroundingMetadata)
					if (sources.length > 0) {
						yield { type: "grounding", sources }
					}
				}

				if (lastUsageMetadata) {
					const inputTokens = lastUsageMetadata.promptTokenCount ?? 0
					const outputTokens = lastUsageMetadata.candidatesTokenCount ?? 0
					const cacheReadTokens = lastUsageMetadata.cachedContentTokenCount
					const reasoningTokens = lastUsageMetadata.thoughtsTokenCount

					yield {
						type: "usage",
						inputTokens,
						outputTokens,
						cacheReadTokens,
						reasoningTokens,
						totalCost: this.calculateCost({
							info,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							reasoningTokens,
						}),
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

				const errorMessage = error instanceof Error ? error.message : String(error)
				const apiError = new ApiProviderError(
					errorMessage,
					this.providerName,
					requestContext.model,
					"createMessage",
				)
				TelemetryService.instance.captureException(apiError)

				if (error instanceof Error) {
					throw new Error(t("common:errors.gemini.generate_stream", { error: error.message }))
				}

				throw error
			}
		}
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id = modelId && modelId in geminiModels ? (modelId as GeminiModelId) : geminiDefaultModelId
		let info: ModelInfo = geminiModels[id]

		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		// Gemini models perform better with the edit tool instead of apply_diff.
		info = {
			...info,
			excludedTools: [...new Set([...(info.excludedTools || []), "apply_diff"])],
			includedTools: [...new Set([...(info.includedTools || []), "edit"])],
		}

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Gemini's API does not have this
		// suffix.
		return { id: id.endsWith(":thinking") ? id.replace(":thinking", "") : id, info, ...params }
	}

	private extractGroundingSources(groundingMetadata?: GroundingMetadata): GroundingSource[] {
		const chunks = groundingMetadata?.groundingChunks

		if (!chunks) {
			return []
		}

		return chunks
			.map((chunk): GroundingSource | null => {
				const uri = chunk.web?.uri
				const title = chunk.web?.title || uri || "Unknown Source"

				if (uri) {
					return {
						title,
						url: uri,
					}
				}
				return null
			})
			.filter((source): source is GroundingSource => source !== null)
	}

	private extractCitationsOnly(groundingMetadata?: GroundingMetadata): string | null {
		const sources = this.extractGroundingSources(groundingMetadata)

		if (sources.length === 0) {
			return null
		}

		const citationLinks = sources.map((source, i) => `[${i + 1}](${source.url})`)
		return citationLinks.join(", ")
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: model, info } = this.getModel()
		let didRetryForGatewayAuth = false

		while (true) {
			const requestContext = await this.getRequestContext(model)

			const supportsTemperature = info.supportsTemperature !== false
			const temperatureConfig: number | undefined = supportsTemperature
				? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
				: info.defaultTemperature

			const promptConfig: GenerateContentConfig = {
				httpOptions: this.mergeHttpOptions(
					this.options.googleGeminiBaseUrl ? { baseUrl: this.options.googleGeminiBaseUrl } : undefined,
					requestContext.httpOptions,
				),
				temperature: temperatureConfig,
			}

			const request = {
				model: requestContext.model,
				contents: [{ role: "user", parts: [{ text: prompt }] }],
				config: promptConfig,
			}

			try {
				const result = await requestContext.client.models.generateContent(request)

				let text = result.text ?? ""

				const candidate = result.candidates?.[0]
				if (candidate?.groundingMetadata) {
					const citations = this.extractCitationsOnly(candidate.groundingMetadata)
					if (citations) {
						text += `\n\n${t("common:errors.gemini.sources")} ${citations}`
					}
				}

				return text
			} catch (error) {
				if (!didRetryForGatewayAuth && (await this.shouldRetryWithRefreshedGatewayToken(error))) {
					didRetryForGatewayAuth = true
					continue
				}

				const errorMessage = error instanceof Error ? error.message : String(error)
				const apiError = new ApiProviderError(
					errorMessage,
					this.providerName,
					requestContext.model,
					"completePrompt",
				)
				TelemetryService.instance.captureException(apiError)

				if (error instanceof Error) {
					throw new Error(t("common:errors.gemini.generate_complete_prompt", { error: error.message }))
				}

				throw error
			}
		}
	}

	public getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	public getResponseId(): string | undefined {
		return this.lastResponseId
	}

	public calculateCost({
		info,
		inputTokens,
		outputTokens,
		cacheReadTokens = 0,
		reasoningTokens = 0,
	}: {
		info: ModelInfo
		inputTokens: number
		outputTokens: number
		cacheReadTokens?: number
		reasoningTokens?: number
	}) {
		// For models with tiered pricing, prices might only be defined in tiers
		let inputPrice = info.inputPrice
		let outputPrice = info.outputPrice
		let cacheReadsPrice = info.cacheReadsPrice

		// If there's tiered pricing then adjust the input and output token prices
		// based on the input tokens used.
		if (info.tiers) {
			const tier = info.tiers.find((tier) => inputTokens <= tier.contextWindow)

			if (tier) {
				inputPrice = tier.inputPrice ?? inputPrice
				outputPrice = tier.outputPrice ?? outputPrice
				cacheReadsPrice = tier.cacheReadsPrice ?? cacheReadsPrice
			}
		}

		// Check if we have the required prices after considering tiers
		if (!inputPrice || !outputPrice) {
			return undefined
		}

		// cacheReadsPrice is optional - if not defined, treat as 0
		if (!cacheReadsPrice) {
			cacheReadsPrice = 0
		}

		// Subtract the cached input tokens from the total input tokens.
		const uncachedInputTokens = inputTokens - cacheReadTokens

		// Bill both completion and reasoning ("thoughts") tokens as output.
		const billedOutputTokens = outputTokens + reasoningTokens

		let cacheReadCost = cacheReadTokens > 0 ? cacheReadsPrice * (cacheReadTokens / 1_000_000) : 0

		const inputTokensCost = inputPrice * (uncachedInputTokens / 1_000_000)
		const outputTokensCost = outputPrice * (billedOutputTokens / 1_000_000)
		const totalCost = inputTokensCost + outputTokensCost + cacheReadCost

		const trace: Record<string, { price: number; tokens: number; cost: number }> = {
			input: { price: inputPrice, tokens: uncachedInputTokens, cost: inputTokensCost },
			output: { price: outputPrice, tokens: billedOutputTokens, cost: outputTokensCost },
		}

		if (cacheReadTokens > 0) {
			trace.cacheRead = { price: cacheReadsPrice, tokens: cacheReadTokens, cost: cacheReadCost }
		}

		return totalCost
	}
}
