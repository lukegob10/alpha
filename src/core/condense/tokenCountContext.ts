import crypto from "crypto"

import Anthropic from "@anthropic-ai/sdk"

import type { ApiHandler, ApiHandlerCountTokensMetadata } from "../../api"

export const DEFAULT_REMOTE_TOKENIZER_ALLOWANCE_MS = 5_000
export const DEFAULT_TOKEN_COUNT_CACHE_ENTRIES = 512

export type CreateTokenCountContextOptions = {
	signal?: AbortSignal
	/** Absolute deadline for remote/native tokenizer work. Clamped to the operation maximum. */
	remoteDeadline?: number | Date
	/** Primarily injectable for deterministic tests; never exceeds the production maximum. */
	remoteAllowanceMs?: number
	maxCacheEntries?: number
}

/**
 * One context-preparation operation owns one remote-tokenizer allowance. Exact
 * counts are cached by model and a hash of the exact blocks, while raw prompt
 * content is never retained by the cache.
 */
export interface TokenCountContext {
	readonly signal?: AbortSignal
	readonly remoteDeadline: number
	countTokens(content: Anthropic.Messages.ContentBlockParam[], apiHandler?: ApiHandler): Promise<number>
}

const REMOTE_COUNT_TIMED_OUT = Symbol("remote-count-timed-out")

function normalizeRemoteAllowance(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_REMOTE_TOKENIZER_ALLOWANCE_MS
	return Math.min(DEFAULT_REMOTE_TOKENIZER_ALLOWANCE_MS, Math.max(0, value))
}

function normalizeRemoteDeadline(value: number | Date | undefined, latestDeadline: number): number {
	if (value === undefined) return latestDeadline
	const numeric = value instanceof Date ? value.getTime() : value
	return Number.isFinite(numeric) ? Math.min(numeric, latestDeadline) : latestDeadline
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted()
}

function getAbortReason(signal: AbortSignal): unknown {
	try {
		signal.throwIfAborted()
	} catch (error) {
		return error
	}
	return new DOMException("The operation was aborted", "AbortError")
}

function containsImage(content: Anthropic.Messages.ContentBlockParam[]): boolean {
	return content.some((block) => {
		if (block.type === "image") return true
		if (block.type !== "tool_result" || !Array.isArray(block.content)) return false
		return block.content.some((part) => part.type === "image")
	})
}

function hasCountablePayload(content: Anthropic.Messages.ContentBlockParam[]): boolean {
	return content.some((block) => block.type !== "text" || block.text.length > 0)
}

function serializeContent(content: Anthropic.Messages.ContentBlockParam[]): string | undefined {
	try {
		return JSON.stringify(content)
	} catch {
		return undefined
	}
}

/**
 * A timeout fallback must err high. JSON's UTF-8 byte length is a safe text
 * ceiling for normal tokenizer vocabularies and also accounts for block/type
 * envelopes, tool inputs, schemas already encoded as text, and opaque state.
 * Media is provider-dependent, so any image raises the floor to a full context.
 */
function getConservativeLocalCount(
	content: Anthropic.Messages.ContentBlockParam[],
	apiHandler: ApiHandler,
	serializedContent?: string,
): number {
	if (content.length === 0) return 0
	let contextWindow = 0
	try {
		const configuredWindow = apiHandler.getModel().info.contextWindow
		if (Number.isFinite(configuredWindow) && configuredWindow > 0) contextWindow = Math.ceil(configuredWindow)
	} catch {
		// Malformed handlers fall through to the strongest safe local floor below.
	}
	const serialized = serializedContent ?? serializeContent(content)
	if (serialized === undefined) return contextWindow || Number.MAX_SAFE_INTEGER
	const byteEstimate = Math.max(1, new TextEncoder().encode(serialized).byteLength)
	if (!containsImage(content)) return byteEstimate
	return contextWindow > 0 ? Math.max(byteEstimate, contextWindow) : Number.MAX_SAFE_INTEGER
}

class OperationTokenCountContext implements TokenCountContext {
	readonly signal?: AbortSignal
	readonly remoteDeadline: number

	private readonly cache = new Map<string, number>()
	private readonly handlerIds = new WeakMap<ApiHandler, number>()
	private readonly maxCacheEntries: number
	private readonly defaultApiHandler: ApiHandler
	private nextHandlerId = 1
	private remoteAllowanceExhausted = false
	private remoteLane: Promise<void> = Promise.resolve()

	constructor(apiHandler: ApiHandler, options: CreateTokenCountContextOptions) {
		this.defaultApiHandler = apiHandler
		this.signal = options.signal
		const now = Date.now()
		const latestDeadline = now + normalizeRemoteAllowance(options.remoteAllowanceMs)
		this.remoteDeadline = normalizeRemoteDeadline(options.remoteDeadline, latestDeadline)
		this.maxCacheEntries = Number.isFinite(options.maxCacheEntries)
			? Math.min(DEFAULT_TOKEN_COUNT_CACHE_ENTRIES, Math.max(0, Math.floor(options.maxCacheEntries ?? 0)))
			: DEFAULT_TOKEN_COUNT_CACHE_ENTRIES
	}

	async countTokens(
		content: Anthropic.Messages.ContentBlockParam[],
		apiHandler = this.defaultApiHandler,
	): Promise<number> {
		throwIfAborted(this.signal)
		if (!hasCountablePayload(content)) return 0

		const serializedContent = serializeContent(content)
		if (serializedContent === undefined) {
			const fallback = getConservativeLocalCount(content, apiHandler)
			throwIfAborted(this.signal)
			return fallback
		}
		// Count the same immutable wire representation used for the cache key. A
		// caller mutating its live block objects while the provider awaits cannot
		// poison an earlier workload's cached result.
		const stableContent = JSON.parse(serializedContent) as Anthropic.Messages.ContentBlockParam[]
		const modelIdentity = this.getModelIdentity(apiHandler)
		const cacheKey = this.getCacheKey(apiHandler, modelIdentity, serializedContent)
		const cached = this.getCached(cacheKey)
		if (cached !== undefined) {
			throwIfAborted(this.signal)
			return cached
		}

		if (this.remoteAllowanceExhausted || Date.now() >= this.remoteDeadline) {
			this.remoteAllowanceExhausted = true
			const fallback = getConservativeLocalCount(stableContent, apiHandler, serializedContent)
			throwIfAborted(this.signal)
			return fallback
		}

		return this.runInRemoteLane(async () => {
			throwIfAborted(this.signal)
			if (modelIdentity !== this.getModelIdentity(apiHandler)) {
				return getConservativeLocalCount(stableContent, apiHandler, serializedContent)
			}
			// A preceding caller may have counted this exact workload while this
			// one waited for the operation's single remote lane.
			const queuedCached = this.getCached(cacheKey)
			if (queuedCached !== undefined) return queuedCached

			if (this.remoteAllowanceExhausted || Date.now() >= this.remoteDeadline) {
				this.remoteAllowanceExhausted = true
				return getConservativeLocalCount(stableContent, apiHandler, serializedContent)
			}

			const metadata: ApiHandlerCountTokensMetadata = {
				signal: this.signal,
				remoteDeadline: this.remoteDeadline,
			}
			throwIfAborted(this.signal)
			const result = await this.waitForProviderCount(apiHandler.countTokens(stableContent, metadata))
			throwIfAborted(this.signal)

			if (result === REMOTE_COUNT_TIMED_OUT || Date.now() >= this.remoteDeadline) {
				this.remoteAllowanceExhausted = true
				return getConservativeLocalCount(stableContent, apiHandler, serializedContent)
			}

			if (!Number.isFinite(result) || result <= 0) {
				// Invalid native counts are not evidence of a timeout. Preserve a
				// non-finite failure signal so compaction cannot accept an unsafe result.
				return Number.NaN
			}

			const normalized = Math.ceil(result)
			if (modelIdentity !== this.getModelIdentity(apiHandler)) {
				return getConservativeLocalCount(stableContent, apiHandler, serializedContent)
			}
			this.setCached(cacheKey, normalized)
			throwIfAborted(this.signal)
			return normalized
		})
	}

	private getModelIdentity(apiHandler: ApiHandler): string {
		try {
			return apiHandler.getModel().id
		} catch {
			return "<unknown-model>"
		}
	}

	private getCacheKey(apiHandler: ApiHandler, modelIdentity: string, serializedContent: string): string {
		let handlerId = this.handlerIds.get(apiHandler)
		if (handlerId === undefined) {
			handlerId = this.nextHandlerId++
			this.handlerIds.set(apiHandler, handlerId)
		}
		const digest = crypto.createHash("sha256").update(serializedContent).digest("base64url")
		return `${handlerId}:${modelIdentity}:${digest}`
	}

	private getCached(key: string): number | undefined {
		const cached = this.cache.get(key)
		if (cached === undefined) return undefined
		this.cache.delete(key)
		this.cache.set(key, cached)
		return cached
	}

	private setCached(key: string, value: number): void {
		if (this.maxCacheEntries === 0) return
		this.cache.delete(key)
		this.cache.set(key, value)
		while (this.cache.size > this.maxCacheEntries) {
			const oldest = this.cache.keys().next().value as string | undefined
			if (oldest === undefined) break
			this.cache.delete(oldest)
		}
	}

	private runInRemoteLane<T>(work: () => Promise<T>): Promise<T> {
		const scheduled = this.remoteLane.then(work)
		this.remoteLane = scheduled.then(
			() => undefined,
			() => undefined,
		)
		return scheduled
	}

	private waitForProviderCount(providerCount: Promise<number>): Promise<number | typeof REMOTE_COUNT_TIMED_OUT> {
		const remaining = Math.max(0, this.remoteDeadline - Date.now())
		if (remaining === 0) {
			providerCount.catch(() => undefined)
			return Promise.resolve(REMOTE_COUNT_TIMED_OUT)
		}

		return new Promise((resolve, reject) => {
			let settled = false
			const finish = (callback: () => void) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				this.signal?.removeEventListener("abort", onAbort)
				callback()
			}
			const onAbort = () => finish(() => reject(getAbortReason(this.signal!)))
			const timer = setTimeout(() => finish(() => resolve(REMOTE_COUNT_TIMED_OUT)), remaining)
			this.signal?.addEventListener("abort", onAbort, { once: true })
			if (this.signal?.aborted) onAbort()

			providerCount.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			)
		})
	}
}

export function createTokenCountContext(
	apiHandler: ApiHandler,
	options: CreateTokenCountContextOptions = {},
): TokenCountContext {
	return new OperationTokenCountContext(apiHandler, options)
}
