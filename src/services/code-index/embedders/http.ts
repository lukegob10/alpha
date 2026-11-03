import { embeddingModelProfiles, type EmbedderProvider } from "@alpha-code/types"
import { createBedrockFetch } from "../../../api/providers/bedrock"
import { t } from "../../../i18n"
import type { EmbeddingConnectionOptions } from "../interfaces/config"
import type {
	IEmbedder,
	EmbedderInfo,
	EmbeddingResponse,
	EmbeddingPriority,
	EmbeddingProgress,
} from "../interfaces/embedder"
import { EmbeddingRequestQueue } from "../shared/embedding-request-queue"
import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../shared/embedding-rate-limiter"
import { withEmbeddingTimeout } from "../shared/embedding-request"
import { validateEmbeddingBatch } from "../shared/embedding-input"
import {
	EmbeddingRequestError,
	getEmbeddingStatus,
	getEmbeddingRetryDelayMs,
	isRetryableEmbeddingError,
} from "../shared/embedding-retry"
import { withValidationErrorHandling, formatEmbeddingError } from "../shared/validation-helpers"
import { BATCH_SEGMENT_THRESHOLD, MAX_BATCH_RETRIES } from "../constants"

type HttpProvider = Exclude<EmbedderProvider, "vertex" | "gemini">
type ResponseBody = {
	data?: { index: number; embedding: number[] }[]
	embeddings?: { float?: number[][] }
	usage?: { prompt_tokens?: number; total_tokens?: number }
}

/** Dedicated embeddings endpoints share the existing indexing queue, retry, cancellation, and quota boundaries. */
export class HttpEmbedder implements IEmbedder {
	private readonly queue = new EmbeddingRequestQueue(2)
	private readonly limiter: EmbeddingRateLimiter
	private readonly fetch: typeof fetch
	private readonly endpoint: string
	constructor(
		private readonly provider: HttpProvider,
		private readonly model: string,
		private readonly options: EmbeddingConnectionOptions,
		rateLimitSeconds?: number,
		private readonly expectedDimension?: number,
	) {
		this.limiter = new EmbeddingRateLimiter((rateLimitSeconds ?? 0) * 1000)
		if (provider === "bedrock") {
			if (model !== "cohere.embed-v4:0") throw new Error(t("embeddings:serviceFactory.embeddingModelMissing"))
			const region = options.region || "us-east-1"
			if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region))
				throw new Error(t("embeddings:serviceFactory.bedrockRegionMissing"))
			this.endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`
			this.fetch = createBedrockFetch(
				{
					awsRegion: region,
					awsUseProfile: Boolean(options.profile),
					awsProfile: options.profile,
					awsUseApiKey: Boolean(options.apiKey) && !options.profile,
					awsApiKey: options.apiKey,
				},
				region,
			)
		} else {
			const base =
				provider === "openai-native"
					? "https://api.openai.com/v1"
					: provider === "openrouter"
						? "https://openrouter.ai/api/v1"
						: options.baseUrl
			if (!base) throw new Error(t("embeddings:serviceFactory.compatibleUrlMissing"))
			const url = new URL(base)
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
				throw new Error(t("embeddings:serviceFactory.compatibleUrlMissing"))
			this.endpoint = `${url.toString().replace(/\/+$/, "")}/embeddings`
			this.fetch = (input, init) => globalThis.fetch(input, init)
		}
	}
	get embedderInfo(): EmbedderInfo {
		return { name: this.provider, preferredBatchSize: BATCH_SEGMENT_THRESHOLD, managesRateLimit: true }
	}
	async createEmbeddings(
		texts: string[],
		model = this.model,
		purpose: "document" | "query" = "document",
		signal?: AbortSignal,
		progress?: (progress: EmbeddingProgress) => void,
		priority: EmbeddingPriority = purpose === "query" ? "query" : "bulk",
	): Promise<EmbeddingResponse> {
		signal?.throwIfAborted()
		if (this.provider === "bedrock" && model !== this.model)
			throw new Error(t("embeddings:serviceFactory.embeddingModelMissing"))
		const profile = embeddingModelProfiles[this.provider]?.[model]
		const prefix = purpose === "query" ? profile?.queryPrefix : profile?.documentPrefix
		const inputs = texts.map((text) => `${prefix ?? ""}${text}`)
		for (const [index, text] of inputs.entries()) {
			if (!text.trim()) throw new Error(t("embeddings:validation.invalidResponse"))
			const itemTokens = Math.ceil(text.length / 4)
			if (itemTokens > 8191)
				throw new Error(t("embeddings:textExceedsTokenLimit", { index, itemTokens, maxTokens: 8191 }))
		}
		const batches: string[][] = []
		let batch: string[] = [],
			tokens = 0
		for (const text of inputs) {
			const count = Math.ceil(text.length / 4)
			if (batch.length >= BATCH_SEGMENT_THRESHOLD || (batch.length && tokens + count > 40000)) {
				batches.push(batch)
				batch = []
				tokens = 0
			}
			batch.push(text)
			tokens += count
		}
		if (batch.length) batches.push(batch)
		const results: EmbeddingResponse[] = new Array(batches.length)
		let next = 0,
			failed = false
		const workers = await Promise.allSettled(
			Array.from({ length: Math.min(2, batches.length) }, async () => {
				while (!failed && next < batches.length) {
					const index = next++
					try {
						results[index] = await this.queue.run(
							priority,
							() => this.request(batches[index], model, purpose, signal, progress, priority),
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
				promptTokens: results.reduce((n, r) => n + (r.usage?.promptTokens ?? 0), 0),
				totalTokens: results.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0),
			},
		}
	}
	private async request(
		input: string[],
		model: string,
		purpose: "document" | "query",
		signal: AbortSignal | undefined,
		progress: ((progress: EmbeddingProgress) => void) | undefined,
		priority: EmbeddingPriority,
	): Promise<EmbeddingResponse> {
		for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
			signal?.throwIfAborted()
			try {
				progress?.({ stage: "queued" })
				await this.limiter.wait(
					signal,
					input.length,
					(waitMs) => progress?.({ stage: "queued", waitMs }),
					priority,
				)
				progress?.({ stage: "request" })
				const body =
					this.provider === "bedrock"
						? {
								texts: input,
								input_type: purpose === "query" ? "search_query" : "search_document",
								embedding_types: ["float"],
								output_dimension: 1536,
								truncate: "NONE",
							}
						: { input, model, encoding_format: "float" }
				const result = await withEmbeddingTimeout(async (requestSignal) => {
					const response = await this.fetch(this.endpoint, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...(this.provider !== "bedrock" && this.options.apiKey
								? { Authorization: `Bearer ${this.options.apiKey}` }
								: {}),
						},
						body: JSON.stringify(body),
						signal: requestSignal,
					})
					if (!response.ok)
						throw Object.assign(new Error(`Embedding request failed (HTTP ${response.status}).`), {
							status: response.status,
							headers: response.headers,
						})
					return (await response.json()) as ResponseBody
				}, signal)
				signal?.throwIfAborted()
				let embeddings: number[][]
				if (this.provider === "bedrock") embeddings = result.embeddings?.float ?? []
				else {
					const ordered = [...(result.data ?? [])].sort((a, b) => a.index - b.index)
					if (ordered.some((item, index) => item.index !== index))
						throw new Error(t("embeddings:validation.invalidResponse"))
					embeddings = ordered.map((item) => item.embedding)
				}
				validateEmbeddingBatch(embeddings, input.length)
				const dimension = embeddingModelProfiles[this.provider]?.[model]?.dimension ?? this.expectedDimension
				if (dimension && embeddings.some((vector) => vector.length !== dimension))
					throw new Error(t("embeddings:validation.invalidResponse"))
				return {
					embeddings,
					usage: {
						promptTokens: result.usage?.prompt_tokens ?? 0,
						totalTokens: result.usage?.total_tokens ?? 0,
					},
				}
			} catch (error) {
				signal?.throwIfAborted()
				const delay = getEmbeddingRetryDelayMs(error, attempt)
				if (getEmbeddingStatus(error) === 429) this.limiter.defer(delay)
				if (attempt < MAX_BATCH_RETRIES - 1 && isRetryableEmbeddingError(error)) {
					progress?.({ stage: "retry", waitMs: delay })
					await waitForEmbeddingDelay(delay, signal)
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
		}, this.provider)
	}
}
