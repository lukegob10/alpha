import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type ModelInfo, stellarDefaultModelId, stellarModels } from "@alpha-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { getModelParams } from "../transform/model-params"
import type { ApiStream } from "../transform/stream"
import type { ApiHandlerCreateMessageMetadata } from "../index"

import { DEFAULT_HEADERS } from "./constants"
import { OpenAiHandler } from "./openai"
import { HelixTokenManager, type HelixParseMode } from "./utils/helix-token-manager"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { configurePemCaTransport } from "./utils/vertex-gateway-transport"

export const DEFAULT_STELLAR_HELIX_COMMAND = "helix auth access-token print -a"

type StellarSettings = {
	baseUrl: string
	pemCaBundlePath: string
	helixCommand: string
	helixParseMode: HelixParseMode
	helixTokenKey: string
	refreshIntervalMinutes: number
}

export class StellarHandler extends OpenAiHandler {
	private readonly stellarSettings: StellarSettings
	private readonly helixTokenManager: HelixTokenManager
	private transportSetupPromise?: Promise<void>
	private activeToken?: string

	constructor(options: ApiHandlerOptions) {
		const settings = resolveStellarSettings(options)
		const modelId = options.apiModelId?.trim() || stellarDefaultModelId
		const modelInfo = getStellarModelInfo(modelId)

		// OpenAiHandler owns the OpenAI chat-completions implementation. The placeholder
		// key is replaced with a Helix token before the first request is sent.
		super({
			...options,
			modelTemperature: options.modelTemperature ?? modelInfo.defaultTemperature,
			openAiBaseUrl: settings.baseUrl,
			openAiApiKey: "helix-token-pending",
			openAiModelId: modelId,
			openAiCustomModelInfo: modelInfo,
			openAiStreamingEnabled: options.stellarStreamingEnabled ?? true,
		})

		this.stellarSettings = settings
		this.helixTokenManager = HelixTokenManager.getOrCreate({
			helixCommand: settings.helixCommand,
			helixParseMode: settings.helixParseMode,
			helixTokenKey: settings.helixTokenKey,
			refreshIntervalMinutes: settings.refreshIntervalMinutes,
		})
	}

	override getModel() {
		const id = this.options.openAiModelId?.trim() || stellarDefaultModelId
		const info = getStellarModelInfo(id)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 0.7,
		})

		return { id, info, ...params }
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

				throw asStellarError(error)
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

				throw asStellarError(error)
			}
		}
	}

	private async prepareClient(forceTokenRefresh: boolean): Promise<void> {
		if (!this.transportSetupPromise) {
			this.transportSetupPromise = configurePemCaTransport(this.stellarSettings.pemCaBundlePath, "Stellar").then(
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
			baseURL: this.stellarSettings.baseUrl,
			apiKey: token,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: getApiRequestTimeout(),
		})
	}
}

function resolveStellarSettings(options: ApiHandlerOptions): StellarSettings {
	const baseUrl = requireSetting(options.stellarBaseUrl, "stellarBaseUrl")
	const pemCaBundlePath = requireSetting(options.stellarPemCaBundlePath, "stellarPemCaBundlePath")
	const helixCommand = options.stellarHelixCommand?.trim() || DEFAULT_STELLAR_HELIX_COMMAND

	let normalizedBaseUrl: string
	try {
		normalizedBaseUrl = new URL(baseUrl).toString()
	} catch {
		throw new Error("Invalid Stellar base URL. Expected a valid absolute URL.")
	}

	return {
		baseUrl: normalizedBaseUrl,
		pemCaBundlePath,
		helixCommand,
		helixParseMode: options.stellarHelixParseMode === "json_field" ? "json_field" : "raw_stdout",
		helixTokenKey: options.stellarHelixTokenKey?.trim() || "access_token",
		refreshIntervalMinutes: normalizeRefreshInterval(options.stellarTokenRefreshMinutes),
	}
}

function requireSetting(value: string | undefined, field: string): string {
	const normalized = value?.trim()
	if (!normalized) {
		throw new Error(`Missing required Stellar setting: ${field}`)
	}

	return normalized
}

function normalizeRefreshInterval(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return 10
	}

	return Math.max(1, Math.floor(value as number))
}

function getStellarModelInfo(modelId: string): ModelInfo {
	return stellarModels[modelId as keyof typeof stellarModels] ?? stellarModels[stellarDefaultModelId]
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

function asStellarError(error: unknown): Error {
	if (!(error instanceof Error)) {
		return new Error(`Stellar completion error: ${String(error)}`)
	}

	const message = error.message.replace(/^(?:OpenAI completion error:\s*)+/, "")
	const wrapped = new Error(`Stellar completion error: ${message}`)
	const errorRecord = error as Error & { status?: unknown; code?: unknown; errorDetails?: unknown }
	const wrappedRecord = wrapped as Error & { status?: unknown; code?: unknown; errorDetails?: unknown }

	wrappedRecord.status = errorRecord.status
	wrappedRecord.code = errorRecord.code
	wrappedRecord.errorDetails = errorRecord.errorDetails

	return wrapped
}
