import type { AssistantMessageMetadata, GeminiResponse, VscodeLmThinking } from "@alpha-code/types"

/**
 * The stream boundary is intentionally provider-neutral. Providers that have
 * not opted into lifecycle reporting may continue to emit the legacy chunks
 * below; canonical providers additionally emit one `outcome` chunk before the
 * generator closes (or before rethrowing a legacy-compatible error).
 */
export type ApiStream = AsyncGenerator<ApiStreamChunk>

export type ApiStreamOutcomeStatus = "completed" | "failed" | "incomplete" | "cancelled"

export type ApiTimeoutScope = "provider_idle" | "request_deadline" | "retry_deadline" | "compaction_deadline"
export type ApiDeadlineScope = Exclude<ApiTimeoutScope, "provider_idle">

/** Stable request-scoped metadata shared by provider transports. */
export interface ApiStreamRequestMetadata {
	/** Abort the request and any pending stream read. */
	signal?: AbortSignal
	/** Absolute deadline in epoch milliseconds (Date is accepted for callers that already use Date values). */
	deadline?: number | Date
	/** Owner of an explicit absolute deadline; idle guards do not set this field. */
	deadlineScope?: ApiDeadlineScope
	/** Stable logical request identifier. */
	requestId?: string
	/** Stable attempt identifier for retries of one logical request. */
	attemptId?: string
}

/** Capabilities are additive so existing providers can retain their legacy behavior. */
export interface ApiStreamCapabilities {
	/** The provider emits an explicit terminal `outcome` chunk. */
	lifecycle?: boolean
	/** The provider can observe and propagate request cancellation. */
	cancellation?: boolean
}

export interface ApiStreamErrorMetadata {
	/** Provider/API error code, when available. */
	code?: string
	/** HTTP or provider status, when available. */
	status?: number
	statusCode?: number
	/** Whether retrying the same logical request is safe. */
	retryable?: boolean
	/** Provider phase that produced the error. */
	phase?: string
	/** Correlation IDs copied from request metadata or provider response metadata. */
	requestId?: string
	attemptId?: string
	/** True when semantic model output was observed before the error. */
	semanticOutputObserved?: boolean
	/** The bounded operation that expired, independent of provider error text. */
	timeoutScope?: ApiTimeoutScope
	/** Provider-specific metadata retained without widening the common contract. */
	metadata?: Record<string, unknown>
}

/** A canonical terminal record. `terminal: false` identifies EOF without a terminal provider event. */
export interface ApiStreamOutcomeChunk extends ApiStreamRequestMetadata {
	type: "outcome"
	status: ApiStreamOutcomeStatus
	terminal: boolean
	/** True when text/reasoning/tool output was observed before this outcome. */
	semanticOutputObserved: boolean
	/** True when this response ended normally but the agent turn needs another model request. */
	requiresContinuation?: boolean
	reason?: string
	retryable?: boolean
	phase?: string
}

/** Optional non-terminal lifecycle marker for adapters that need phase visibility. */
export interface ApiStreamLifecycleChunk extends ApiStreamRequestMetadata {
	type: "lifecycle"
	phase: string
	status?: "starting" | "streaming" | "terminal"
}

export type ApiStreamChunk =
	| ApiStreamTextChunk
	| ApiStreamMessageMetadataChunk
	| ApiStreamUsageChunk
	| ApiStreamReasoningChunk
	| ApiStreamThinkingCompleteChunk
	| ApiStreamGroundingChunk
	| ApiStreamToolCallChunk
	| ApiStreamToolCallStartChunk
	| ApiStreamToolCallDeltaChunk
	| ApiStreamToolCallEndChunk
	| ApiStreamToolCallPartialChunk
	| ApiStreamLifecycleChunk
	| ApiStreamOutcomeChunk
	| ApiStreamError

export interface ApiStreamError {
	type: "error"
	error: string
	message: string
	/** Optional normalized provider metadata. */
	code?: string
	status?: number
	statusCode?: number
	retryable?: boolean
	phase?: string
	requestId?: string
	attemptId?: string
	semanticOutputObserved?: boolean
	timeoutScope?: ApiTimeoutScope
	metadata?: Record<string, unknown>
}

/** Inputs accepted by the request-signal helper. Kept structural to avoid a
 * dependency from the transform layer back to the API handler interface. */
export type ApiStreamRequestControl = Pick<ApiStreamRequestMetadata, "signal" | "deadline" | "deadlineScope">

export interface LinkedAbortController {
	controller: AbortController
	signal: AbortSignal
	/** Remove listeners/timers once a request has settled. */
	dispose(): void
}

/** Error used when a request reaches its caller-supplied deadline. */
export class ApiStreamDeadlineError extends Error {
	override readonly name = "ApiStreamDeadlineError"
	readonly code = "ProviderTimeout"
	readonly retryable = false

	constructor(
		message: string | undefined = undefined,
		readonly timeoutScope: ApiDeadlineScope = "request_deadline",
	) {
		super(
			message ??
				(timeoutScope === "retry_deadline"
					? "Automatic retry deadline exceeded"
					: timeoutScope === "compaction_deadline"
						? "Context compaction deadline exceeded"
						: "Provider request deadline exceeded"),
		)
	}
}

/**
 * Link a caller signal to a provider-owned controller and optionally enforce an
 * absolute deadline. This lets SDK and manual-fetch paths share one signal,
 * while preserving the provider's existing internal abort checks.
 */
export function createLinkedAbortController(options: ApiStreamRequestControl = {}): LinkedAbortController {
	const controller = new AbortController()
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined
	let disposed = false

	const abortFromSignal = () => {
		if (!controller.signal.aborted) {
			controller.abort(options.signal?.reason)
		}
	}

	if (options.signal) {
		if (options.signal.aborted) {
			abortFromSignal()
		} else {
			options.signal.addEventListener("abort", abortFromSignal, { once: true })
		}
	}

	if (options.deadline !== undefined && !controller.signal.aborted) {
		const deadlineMs = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline
		if (Number.isFinite(deadlineMs)) {
			const delay = deadlineMs - Date.now()
			const abortAtDeadline = () => {
				if (!controller.signal.aborted) {
					controller.abort(new ApiStreamDeadlineError(undefined, options.deadlineScope))
				}
			}
			// An elapsed deadline is an admission barrier. A zero-delay timer would
			// still let an SDK dispatch before the next event-loop turn.
			if (delay <= 0) abortAtDeadline()
			else deadlineTimer = setTimeout(abortAtDeadline, delay)
		}
	}

	return {
		controller,
		signal: controller.signal,
		dispose: () => {
			if (disposed) return
			disposed = true
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
			if (options.signal) options.signal.removeEventListener("abort", abortFromSignal)
		},
	}
}

/** True for caller cancellation, provider aborts, and deadline-triggered aborts. */
export function isApiStreamAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true
	if (!error || typeof error !== "object") return false
	const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
	const name = typeof candidate.name === "string" ? candidate.name : ""
	const code = typeof candidate.code === "string" ? candidate.code : ""
	const message = typeof candidate.message === "string" ? candidate.message : ""
	return (
		name === "AbortError" ||
		name === "TimeoutError" ||
		name === "ApiStreamDeadlineError" ||
		code === "ABORT_ERR" ||
		code === "ERR_ABORTED" ||
		/\b(abort(?:ed|ing)?|cancel(?:led|ed)?|deadline exceeded|tim(?:e|ed)[ -]?out)\b/i.test(message)
	)
}

/** Semantic model output is distinct from usage, status, and structural events. */
export function isApiStreamSemanticChunk(chunk: ApiStreamChunk): boolean {
	// Host-only completion/signature parts carry replay state, not visible output.
	if (
		chunk.type === "reasoning" &&
		(chunk.vscodeLmThinking !== undefined || chunk.geminiResponse !== undefined) &&
		chunk.text.length === 0
	)
		return false
	return (
		chunk.type === "text" ||
		chunk.type === "reasoning" ||
		chunk.type === "tool_call" ||
		chunk.type === "tool_call_start" ||
		chunk.type === "tool_call_delta" ||
		chunk.type === "tool_call_end" ||
		chunk.type === "tool_call_partial"
	)
}

export interface ApiStreamOutcomeInput extends ApiStreamRequestMetadata {
	status: ApiStreamOutcomeStatus
	terminal?: boolean
	semanticOutputObserved?: boolean
	requiresContinuation?: boolean
	reason?: string
	retryable?: boolean
	phase?: string
}

/** Construct a normalized outcome without copying undefined metadata. */
export function createApiStreamOutcome(input: ApiStreamOutcomeInput): ApiStreamOutcomeChunk {
	return {
		type: "outcome",
		status: input.status,
		terminal: input.terminal ?? true,
		semanticOutputObserved: input.semanticOutputObserved ?? false,
		...(input.requiresContinuation !== undefined ? { requiresContinuation: input.requiresContinuation } : {}),
		...(input.reason !== undefined ? { reason: input.reason } : {}),
		...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
		...(input.phase !== undefined ? { phase: input.phase } : {}),
		...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
		...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
	}
}

export interface ApiStreamErrorInput extends ApiStreamRequestMetadata, ApiStreamErrorMetadata {
	error?: string
	message: string
}

/** Construct a normalized error chunk while preserving retry/correlation metadata. */
export function createApiStreamError(input: ApiStreamErrorInput): ApiStreamError {
	return {
		type: "error",
		error: input.error ?? input.code ?? "StreamError",
		message: input.message,
		...(input.code !== undefined ? { code: input.code } : {}),
		...(input.status !== undefined ? { status: input.status } : {}),
		...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
		...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
		...(input.phase !== undefined ? { phase: input.phase } : {}),
		...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
		...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
		...(input.semanticOutputObserved !== undefined ? { semanticOutputObserved: input.semanticOutputObserved } : {}),
		...(input.timeoutScope !== undefined ? { timeoutScope: input.timeoutScope } : {}),
		...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
	}
}

/** Extract bounded error text without serializing arbitrary provider payloads. */
export function getApiStreamErrorMessage(value: unknown, fallback = "Provider stream error"): string {
	let current = value
	// SDK error envelopes may nest or refer back to one another. A fixed depth
	// keeps malformed remote errors from overflowing the extension-host stack.
	for (let depth = 0; depth < 8; depth++) {
		if (typeof current === "string" && current.length > 0) return current.slice(0, 4_096)
		if (!current || typeof current !== "object") break
		const candidate = current as { message?: unknown; error?: unknown; detail?: unknown }
		if (typeof candidate.message === "string" && candidate.message.length > 0) {
			return candidate.message.slice(0, 4_096)
		}
		if (typeof candidate.detail === "string" && candidate.detail.length > 0) {
			return candidate.detail.slice(0, 4_096)
		}
		current = candidate.error
	}
	return fallback.slice(0, 4_096)
}

/**
 * Preserve only common scalar error metadata. SDK payloads can contain request
 * bodies, credentials, cycles and custom serializers; never copy them into
 * diagnostics or canonical error records. The result is bounded and JSON-safe.
 */
export function normalizeApiStreamErrorMetadata(
	value: unknown,
	request: Pick<ApiStreamRequestMetadata, "requestId" | "attemptId"> = {},
	defaults: Pick<ApiStreamErrorMetadata, "phase" | "semanticOutputObserved"> = {},
): ApiStreamErrorMetadata {
	const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
	const nested = source.error && typeof source.error === "object" ? (source.error as Record<string, unknown>) : {}
	const getNumber = (...values: unknown[]) =>
		values.find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate))
	const getString = (...values: unknown[]) =>
		values.find((candidate): candidate is string => typeof candidate === "string" && candidate.length <= 256)
	const getBoolean = (...values: unknown[]) =>
		values.find((candidate): candidate is boolean => typeof candidate === "boolean")
	const status = getNumber(source.status, source.statusCode, nested.status, nested.statusCode)
	const statusCode = getNumber(source.statusCode, nested.statusCode)
	const code = getString(source.code, source.error_code, nested.code, nested.type)
	const phase = getString(source.phase, nested.phase, defaults.phase)
	const requestId = getString(request.requestId)
	const attemptId = getString(request.attemptId)
	const retryable = getBoolean(
		source.retryable,
		nested.retryable,
		// Conservative defaults: common transient HTTP responses are retryable,
		// but cancellation and malformed/user errors are not.
		status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500),
	)
	const semanticOutputObserved = getBoolean(
		source.semanticOutputObserved,
		nested.semanticOutputObserved,
		defaults.semanticOutputObserved,
	)
	const timeoutScope = getString(source.timeoutScope, nested.timeoutScope)
	const knownTimeoutScope =
		timeoutScope === "provider_idle" ||
		timeoutScope === "request_deadline" ||
		timeoutScope === "retry_deadline" ||
		timeoutScope === "compaction_deadline"
			? timeoutScope
			: undefined

	return {
		...(code !== undefined ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		...(statusCode !== undefined ? { statusCode } : {}),
		...(retryable !== undefined ? { retryable } : {}),
		...(phase !== undefined ? { phase } : {}),
		...(requestId !== undefined ? { requestId } : {}),
		...(attemptId !== undefined ? { attemptId } : {}),
		...(semanticOutputObserved !== undefined ? { semanticOutputObserved } : {}),
		...(knownTimeoutScope !== undefined ? { timeoutScope: knownTimeoutScope } : {}),
	}
}

/**
 * Iterate an async source while making a caller abort observable even when the
 * source is stalled in `next()`. A pending `next()` is deliberately left to
 * the source's own cleanup; Promise.race attaches a rejection handler so a
 * late source failure cannot become an unhandled rejection.
 */
export async function* iterateApiStreamWithAbort<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]()
	let finished = false
	try {
		while (!finished) {
			if (signal?.aborted) break
			const nextPromise = iterator.next()
			const result = signal
				? await Promise.race([
						Promise.resolve(nextPromise),
						new Promise<IteratorResult<T>>((resolve) => {
							if (signal.aborted) {
								resolve({ done: true, value: undefined as T })
								return
							}
							const onAbort = () => resolve({ done: true, value: undefined as T })
							signal.addEventListener("abort", onAbort, { once: true })
							// Attach both fulfillment and rejection handlers. A stalled/late
							// provider iterator must not turn cancellation into an unhandled
							// rejection after this adapter has already completed.
							Promise.resolve(nextPromise).then(
								() => signal.removeEventListener("abort", onAbort),
								() => signal.removeEventListener("abort", onAbort),
							)
						}),
					])
				: await nextPromise
			if (result.done) {
				finished = true
				break
			}
			yield result.value
		}
	} finally {
		finished = true
		if (typeof iterator.return === "function") {
			try {
				// Do not await return(): some SDKs leave a pending next() until
				// their transport observes the abort. The caller still gets the
				// canonical cancelled outcome immediately.
				const returnPromise = iterator.return()
				Promise.resolve(returnPromise).catch(() => undefined)
			} catch {
				// Abort/consumer cleanup must not mask the canonical outcome.
			}
		}
	}
}

/**
 * Race one pending transport read against cancellation. Unlike awaiting a
 * ReadableStream reader directly, this returns promptly for a stalled test
 * double or SDK whose abort handling is not cooperative; the transport's
 * own signal still performs eventual cleanup.
 */
export async function raceApiStreamAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (!signal) return await promise
	if (signal.aborted) {
		// The caller has already started this operation. Its late rejection still
		// needs an owner when cancellation prevents us from awaiting the result.
		Promise.resolve(promise).catch(() => undefined)
		return undefined
	}

	let onAbort: (() => void) | undefined
	const abortPromise = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined)
		signal.addEventListener("abort", onAbort, { once: true })
	})
	try {
		return await Promise.race([Promise.resolve(promise), abortPromise])
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort)
		// Consume late transport failures after cancellation.
		Promise.resolve(promise).catch(() => undefined)
	}
}

export interface ApiStreamTextChunk extends AssistantMessageMetadata {
	type: "text"
	text: string
}

/** Source message metadata supplied before text or finalized after its visible deltas. */
export interface ApiStreamMessageMetadataChunk extends AssistantMessageMetadata {
	type: "message_metadata"
}

/**
 * Reasoning/thinking chunk from the API stream.
 * For Anthropic extended thinking, this may include a signature field
 * which is required for passing thinking blocks back to the API during tool use.
 */
export interface ApiStreamReasoningChunk {
	type: "reasoning"
	text: string
	/** Original Gemini parts retain signatures on their exact provider positions. */
	geminiResponse?: GeminiResponse
	/** Original VS Code host part; display text is a separate projection. */
	vscodeLmThinking?: VscodeLmThinking
	/**
	 * Signature for the thinking block (Anthropic extended thinking).
	 * When present, this indicates a complete thinking block that should be
	 * preserved for tool use continuations. The signature is used to verify
	 * that thinking blocks were generated by Claude.
	 */
	signature?: string
	/** Opaque reasoning state retained for provider-history replay. */
	encryptedContent?: string
	/** Opaque Anthropic redacted thinking, preserved unchanged and never displayed. */
	redactedData?: string
	id?: string
	summary?: unknown[]
	/** Position in a provider's ordered output, including text and tools. */
	outputIndex?: number
}

/**
 * Signals completion of a thinking block with its verification signature.
 * Used by Anthropic extended thinking to pass the signature needed for
 * tool use continuations and caching.
 */
export interface ApiStreamThinkingCompleteChunk {
	type: "thinking_complete"
	/**
	 * Cryptographic signature that verifies this thinking block was generated by Claude.
	 * Must be preserved and passed back to the API when continuing conversations with tool use.
	 */
	signature: string
	/** The reasoning block being sealed; omitted by legacy sequential adapters. */
	outputIndex?: number
}

/** Additive usage increments; adapters must subtract earlier cumulative provider snapshots. */
export interface ApiStreamUsageChunk {
	type: "usage"
	usageSource?: "provider" | "estimate" | "unknown"
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	reasoningTokens?: number
	totalCost?: number
}

export interface ApiStreamGroundingChunk {
	type: "grounding"
	sources: GroundingSource[]
}

export interface ApiStreamToolCallChunk {
	type: "tool_call"
	id: string
	name: string
	arguments: string
	/** Position in a provider's ordered output, including text and reasoning. */
	outputIndex?: number
	/** Complete provider parts sealed atomically with this accepted Gemini call. */
	geminiResponse?: GeminiResponse
}

export interface ApiStreamToolCallStartChunk {
	type: "tool_call_start"
	id: string
	name: string
}

export interface ApiStreamToolCallDeltaChunk {
	type: "tool_call_delta"
	id: string
	delta: string
}

export interface ApiStreamToolCallEndChunk {
	type: "tool_call_end"
	id: string
	/** Complete provider parts sealed atomically with this accepted Gemini call. */
	geminiResponse?: GeminiResponse
}

/**
 * Raw tool call chunk from the API stream.
 * Providers emit this simple format; NativeToolCallParser handles all state management
 * (tracking, buffering, emitting start/delta/end events).
 */
export interface ApiStreamToolCallPartialChunk {
	type: "tool_call_partial"
	index: number
	id?: string
	name?: string
	arguments?: string
}

export interface GroundingSource {
	title: string
	url: string
	snippet?: string
}
