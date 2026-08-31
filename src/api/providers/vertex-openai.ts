import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type ModelInfo, openAiModelInfoSaneDefaults, vertexModels } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import type { ApiStream } from "../transform/stream"

import { DEFAULT_HEADERS } from "./constants"
import { OpenAiHandler } from "./openai"
import { HelixTokenManager, type HelixParseMode } from "./utils/helix-token-manager"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { configureVertexGatewayTransport } from "./utils/vertex-gateway-transport"

type VertexGatewayRouteTarget = {
	projectId?: string
	location?: string
	modelOverride?: string
	extraHeaders?: Record<string, string>
}

type VertexOpenAiSettings = {
	baseUrl: string
	pemCaBundlePath: string
	helixCommand: string
	helixParseMode: HelixParseMode
	helixTokenKey: string
	refreshIntervalMinutes: number
	extraHeaders?: Record<string, string>
}

/**
 * Handles Vertex partner models that use Google's OpenAI-compatible
 * `endpoints/openapi/chat/completions` endpoint (for example, xAI Grok).
 */
export class VertexOpenAiHandler extends OpenAiHandler {
	private readonly vertexSettings: VertexOpenAiSettings
	private readonly helixTokenManager: HelixTokenManager
	private transportSetupPromise?: Promise<void>
	private activeToken?: string

	constructor(options: ApiHandlerOptions) {
		const selectedModelId = options.apiModelId?.trim()
		if (!selectedModelId) {
			throw new Error("Missing required Vertex OpenAI-compatible model ID.")
		}

		const route = resolveVertexGatewayRoute(options, selectedModelId)
		const routedModelId = route.modelOverride ?? selectedModelId
		const modelInfo = getVertexOpenAiModelInfo(selectedModelId)
		const settings = resolveVertexOpenAiSettings(options, route)

		// OpenAiHandler owns chat-completions message conversion and tool streaming.
		// The placeholder key is replaced with a Helix bearer token before a request.
		super({
			...options,
			modelTemperature: options.modelTemperature ?? modelInfo.defaultTemperature,
			openAiBaseUrl: settings.baseUrl,
			openAiApiKey: "helix-token-pending",
			openAiHeaders: settings.extraHeaders,
			openAiModelId: routedModelId,
			openAiCustomModelInfo: modelInfo,
			openAiStreamingEnabled: options.vertexStreamingEnabled ?? true,
		})

		this.vertexSettings = settings
		this.helixTokenManager = HelixTokenManager.getOrCreate({
			helixCommand: settings.helixCommand,
			helixParseMode: settings.helixParseMode,
			helixTokenKey: settings.helixTokenKey,
			refreshIntervalMinutes: settings.refreshIntervalMinutes,
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		let didRetryForAuth = false

		while (true) {
			let emittedChunk = false

			try {
				await this.prepareClient(didRetryForAuth)

				for await (const chunk of super.createMessage(systemPrompt, messages, metadata)) {
					emittedChunk = true
					yield chunk
				}

				return
			} catch (error) {
				if (!didRetryForAuth && !emittedChunk && isAuthenticationFailure(error)) {
					didRetryForAuth = true
					continue
				}

				throw asVertexOpenAiError(error)
			}
		}
	}

	override async completePrompt(prompt: string): Promise<string> {
		let didRetryForAuth = false

		while (true) {
			try {
				await this.prepareClient(didRetryForAuth)
				return await super.completePrompt(prompt)
			} catch (error) {
				if (!didRetryForAuth && isAuthenticationFailure(error)) {
					didRetryForAuth = true
					continue
				}

				throw asVertexOpenAiError(error)
			}
		}
	}

	private async prepareClient(forceTokenRefresh: boolean): Promise<void> {
		if (!this.transportSetupPromise) {
			this.transportSetupPromise = configureVertexGatewayTransport(this.vertexSettings.pemCaBundlePath).then(
				() => undefined,
			)
		}

		await this.transportSetupPromise

		const token = forceTokenRefresh
			? await this.helixTokenManager.forceRefreshToken()
			: await this.helixTokenManager.getToken()

		if (token === this.activeToken) {
			return
		}

		this.activeToken = token
		this.client = new OpenAI({
			baseURL: this.vertexSettings.baseUrl,
			apiKey: token,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...(this.vertexSettings.extraHeaders ?? {}),
			},
			timeout: getApiRequestTimeout(),
		})
	}
}

function resolveVertexOpenAiSettings(
	options: ApiHandlerOptions,
	route: VertexGatewayRouteTarget,
): VertexOpenAiSettings {
	const gatewayBaseUrl = getGatewaySetting(options.gatewayBaseUrl, options.vertexGatewayBaseUrl)
	const projectId = route.projectId ?? getGatewaySetting(options.projectId, options.vertexProjectId)
	const location = route.location ?? getGatewaySetting(options.location, options.vertexRegion)
	const pemCaBundlePath = getGatewaySetting(options.pemCaBundlePath, options.vertexGatewayCaBundlePath)
	const helixCommand = getGatewaySetting(options.helixCommand, options.vertexGatewayHelixCommand)

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

	return {
		baseUrl: buildVertexOpenAiBaseUrl(gatewayBaseUrl!, projectId!, location!),
		pemCaBundlePath: pemCaBundlePath!,
		helixCommand: helixCommand!,
		helixParseMode: options.helixParseMode === "json_field" ? "json_field" : "raw_stdout",
		helixTokenKey: options.helixTokenKey?.trim() || "access_token",
		refreshIntervalMinutes: normalizeRefreshInterval(
			options.refreshIntervalMinutes ?? options.vertexGatewayTokenRefreshMinutes,
		),
		extraHeaders: route.extraHeaders,
	}
}

function buildVertexOpenAiBaseUrl(gatewayBaseUrl: string, projectId: string, location: string): string {
	let parsedBaseUrl: URL
	try {
		parsedBaseUrl = new URL(gatewayBaseUrl)
	} catch {
		throw new Error("Invalid Vertex gatewayBaseUrl. Expected a valid absolute URL.")
	}

	const configuredPath = parsedBaseUrl.pathname === "/" ? "/v1" : parsedBaseUrl.pathname.replace(/\/+$/, "")
	parsedBaseUrl.pathname = `${configuredPath}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/endpoints/openapi`
	parsedBaseUrl.hash = ""

	return parsedBaseUrl.toString().replace(/\/$/, "")
}

function resolveVertexGatewayRoute(options: ApiHandlerOptions, modelId: string): VertexGatewayRouteTarget {
	const rawRoutingMap = options.modelRoutingMap ?? options.vertexGatewayModelRoutingMap
	if (!rawRoutingMap || (typeof rawRoutingMap === "string" && !rawRoutingMap.trim())) {
		return {}
	}

	let routingMap: unknown = rawRoutingMap
	if (typeof rawRoutingMap === "string") {
		try {
			routingMap = JSON.parse(rawRoutingMap)
		} catch {
			throw new Error("Invalid modelRoutingMap JSON for Vertex gateway configuration.")
		}
	}

	if (!routingMap || typeof routingMap !== "object" || Array.isArray(routingMap)) {
		throw new Error("Invalid modelRoutingMap. Expected an object keyed by model name.")
	}

	const routeValue = (routingMap as Record<string, unknown>)[modelId]
	if (routeValue === undefined) {
		return {}
	}

	if (typeof routeValue === "string") {
		const modelOverride = routeValue.trim()
		return modelOverride ? { modelOverride } : {}
	}

	if (!routeValue || typeof routeValue !== "object" || Array.isArray(routeValue)) {
		throw new Error(`Invalid modelRoutingMap entry for "${modelId}".`)
	}

	const routeRecord = routeValue as Record<string, unknown>
	const route: VertexGatewayRouteTarget = {}

	for (const field of ["projectId", "location", "modelOverride"] as const) {
		const value = routeRecord[field]
		if (typeof value === "string" && value.trim()) {
			route[field] = value.trim()
		}
	}

	if (routeRecord.extraHeaders !== undefined) {
		if (
			!routeRecord.extraHeaders ||
			typeof routeRecord.extraHeaders !== "object" ||
			Array.isArray(routeRecord.extraHeaders)
		) {
			throw new Error(`Invalid extraHeaders for modelRoutingMap entry "${modelId}".`)
		}

		route.extraHeaders = Object.fromEntries(
			Object.entries(routeRecord.extraHeaders as Record<string, unknown>)
				.filter(
					(entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === "string",
				)
				.map(([key, value]) => [key.trim(), value]),
		)
	}

	return route
}

function getGatewaySetting(primary: string | undefined, legacy: string | undefined): string | undefined {
	const value = primary ?? legacy
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeRefreshInterval(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return 10
	}

	return Math.max(1, Math.floor(value as number))
}

function getVertexOpenAiModelInfo(modelId: string): ModelInfo {
	return vertexModels[modelId as keyof typeof vertexModels] ?? openAiModelInfoSaneDefaults
}

function isAuthenticationFailure(error: unknown): boolean {
	if (error && typeof error === "object") {
		const errorRecord = error as Record<string, unknown>
		const response =
			errorRecord.response && typeof errorRecord.response === "object"
				? (errorRecord.response as Record<string, unknown>)
				: undefined
		const statusCandidates = [errorRecord.status, errorRecord.statusCode, errorRecord.code, response?.status]

		for (const candidate of statusCandidates) {
			const status = typeof candidate === "string" ? Number.parseInt(candidate, 10) : candidate
			if (status === 401 || status === 403) {
				return true
			}
		}
	}

	const message = error instanceof Error ? error.message : String(error)
	return /\b401\b|\b403\b|unauthorized|forbidden|authentication|permission denied|invalid token/i.test(message)
}

function asVertexOpenAiError(error: unknown): Error {
	if (!(error instanceof Error)) {
		return new Error(`Vertex OpenAI-compatible completion error: ${String(error)}`)
	}

	const message = error.message.replace(/^(?:OpenAI completion error:\s*)+/, "")
	const wrapped = new Error(`Vertex OpenAI-compatible completion error: ${message}`)
	const errorRecord = error as Error & { status?: unknown; code?: unknown; errorDetails?: unknown }
	const wrappedRecord = wrapped as Error & { status?: unknown; code?: unknown; errorDetails?: unknown }

	wrappedRecord.status = errorRecord.status
	wrappedRecord.code = errorRecord.code
	wrappedRecord.errorDetails = errorRecord.errorDetails

	return wrapped
}
