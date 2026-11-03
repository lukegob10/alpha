import { assertNativeVertexSettings } from "../../../api/providers/utils/native-vertex-settings"
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

type EmbedRequestContext = {
	client: GoogleGenAI
	model: string
	httpOptions?: EmbedContentConfig["httpOptions"]
}

/** Standard Google Cloud Vertex embeddings through ADC or explicit Google credentials. */
export class VertexGeminiEmbedder implements IEmbedder {
	private static readonly DEFAULT_MODEL = "gemini-embedding-001"
	private readonly client: GoogleGenAI
	private readonly requestConcurrency: number
	private readonly embeddingRequests: EmbeddingRequestQueue
	private readonly embeddingRateLimiter: EmbeddingRateLimiter
	private readonly modelId: string
	private readonly options: ProviderSettings

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
		assertNativeVertexSettings(options)

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

	private async getRequestContext(model: string): Promise<EmbedRequestContext> {
		return { client: this.client, model }
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
		let lastError: unknown
		let requestAttempts = 0

		for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
			signal?.throwIfAborted()
			const input = googleEmbeddingInput(texts, selectedModel, purpose)
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
