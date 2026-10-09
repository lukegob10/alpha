import { GoogleGenAI } from "@google/genai"
import { t } from "../../../i18n"
import { BATCH_SEGMENT_THRESHOLD, GEMINI_MAX_ITEM_TOKENS, MAX_BATCH_RETRIES } from "../constants"
import type {
	IEmbedder,
	EmbeddingResponse,
	EmbedderInfo,
	EmbeddingProgress,
	EmbeddingPriority,
} from "../interfaces/embedder"
import { EmbeddingRequestQueue } from "../shared/embedding-request-queue"
import { withEmbeddingTimeout } from "../shared/embedding-request"
import { googleEmbeddingInput } from "../shared/google-embedding"
import { validateEmbeddingBatch } from "../shared/embedding-input"
import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../shared/embedding-rate-limiter"
import {
	EmbeddingRequestError,
	getEmbeddingStatus,
	getEmbeddingRetryDelayMs,
	isRetryableEmbeddingError,
} from "../shared/embedding-retry"
import { formatEmbeddingError, withValidationErrorHandling } from "../shared/validation-helpers"

/** Synchronous Gemini Developer API batches, with one ordered vector per source chunk. */
export class GeminiEmbedder implements IEmbedder {
	private readonly client: GoogleGenAI
	private readonly requests = new EmbeddingRequestQueue(2)
	private readonly rateLimiter: EmbeddingRateLimiter

	constructor(
		apiKey: string,
		private readonly modelId = "gemini-embedding-001",
		embeddingRateLimitSeconds?: number,
	) {
		if (!apiKey.trim()) throw new Error(t("embeddings:serviceFactory.geminiConfigMissing"))
		this.client = new GoogleGenAI({ apiKey })
		this.rateLimiter = new EmbeddingRateLimiter((embeddingRateLimitSeconds ?? 0) * 1000)
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "gemini", preferredBatchSize: BATCH_SEGMENT_THRESHOLD, managesRateLimit: true }
	}

	async createEmbeddings(
		texts: string[],
		model = this.modelId,
		purpose: "document" | "query" = "document",
		signal?: AbortSignal,
		onProgress?: (progress: EmbeddingProgress) => void,
		priority: EmbeddingPriority = purpose === "query" ? "query" : "bulk",
	): Promise<EmbeddingResponse> {
		signal?.throwIfAborted()
		const maxItemTokens = model.includes("embedding-2") ? 8192 : GEMINI_MAX_ITEM_TOKENS
		const batches: string[][] = []
		let batch: string[] = []
		let batchTokens = 0
		for (const [index, text] of texts.entries()) {
			const tokens = Math.ceil(text.length / 4)
			if (tokens > maxItemTokens) {
				throw new Error(
					t("embeddings:textExceedsTokenLimit", { index, itemTokens: tokens, maxTokens: maxItemTokens }),
				)
			}
			// Local payload and memory bounds apply even when a caller supplies a whole large file.
			if (batch.length >= BATCH_SEGMENT_THRESHOLD || (batch.length > 0 && batchTokens + tokens > 20_000)) {
				batches.push(batch)
				batch = []
				batchTokens = 0
			}
			batch.push(text)
			batchTokens += tokens
		}
		if (batch.length > 0) batches.push(batch)
		const results: EmbeddingResponse[] = new Array(batches.length)
		let nextIndex = 0
		let failed = false
		const workers = await Promise.allSettled(
			Array.from({ length: Math.min(2, batches.length) }, async () => {
				while (!failed && nextIndex < batches.length) {
					const index = nextIndex++
					try {
						onProgress?.({ stage: "queued" })
						results[index] = await this.requests.run(
							priority,
							() => this.embedBatch(batches[index], model, purpose, signal, onProgress, priority),
							signal,
						)
					} catch (error) {
						failed = true
						throw error
					}
				}
			}),
		)
		const failure = workers.find((worker) => worker.status === "rejected")
		if (failure?.status === "rejected") throw failure.reason
		return {
			embeddings: results.flatMap((result) => result.embeddings),
			usage: {
				promptTokens: results.reduce((count, result) => count + (result.usage?.promptTokens ?? 0), 0),
				totalTokens: results.reduce((count, result) => count + (result.usage?.totalTokens ?? 0), 0),
			},
		}
	}

	private async embedBatch(
		texts: string[],
		model: string,
		purpose: "document" | "query",
		signal?: AbortSignal,
		onProgress?: (progress: EmbeddingProgress) => void,
		priority: EmbeddingPriority = purpose === "query" ? "query" : "bulk",
	): Promise<EmbeddingResponse> {
		const input = googleEmbeddingInput(texts, model, purpose)
		for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
			signal?.throwIfAborted()
			try {
				// Account for every input, so batching does not multiply the configured quota budget.
				onProgress?.({ stage: "queued" })
				await this.rateLimiter.wait(
					signal,
					texts.length,
					(waitMs) => onProgress?.({ stage: "queued", waitMs }),
					priority,
				)
				onProgress?.({ stage: "request" })
				const response = await withEmbeddingTimeout(
					(requestSignal) =>
						this.client.models.embedContent({
							model,
							...input,
							config: { ...input.config, abortSignal: requestSignal },
						}),
					signal,
				)
				signal?.throwIfAborted()
				const embeddings = (response.embeddings ?? []).map((embedding) => embedding.values ?? [])
				validateEmbeddingBatch(embeddings, texts.length)
				const tokens = texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0)
				return { embeddings, usage: { promptTokens: tokens, totalTokens: tokens } }
			} catch (error) {
				signal?.throwIfAborted()
				const retryDelayMs = getEmbeddingRetryDelayMs(error, attempt)
				if (getEmbeddingStatus(error) === 429) this.rateLimiter.defer(retryDelayMs)
				if (attempt < MAX_BATCH_RETRIES - 1 && isRetryableEmbeddingError(error)) {
					onProgress?.({ stage: "retry", waitMs: retryDelayMs })
					await waitForEmbeddingDelay(retryDelayMs, signal)
					continue
				}
				throw new EmbeddingRequestError(formatEmbeddingError(error, attempt + 1))
			}
		}
		throw new Error(t("embeddings:validation.invalidResponse"))
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			await this.createEmbeddings(["test"])
			return { valid: true }
		}, "gemini")
	}
}
