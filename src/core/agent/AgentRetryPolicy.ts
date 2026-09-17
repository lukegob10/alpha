/**
 * The small, provider-neutral set of failures that may be retried by an
 * agent turn. Provider adapters should map their native errors to one of
 * these categories before consulting the policy.
 */
export const AGENT_RETRY_CATEGORIES = ["transport", "rate-limit", "context", "empty-response"] as const

export type AgentRetryCategory = (typeof AGENT_RETRY_CATEGORIES)[number]

export function isAgentRetryCategory(value: unknown): value is AgentRetryCategory {
	return typeof value === "string" && (AGENT_RETRY_CATEGORIES as readonly string[]).includes(value)
}

export interface AgentRetryPolicyOptions {
	/** Maximum number of provider attempts, including the initial attempt. */
	maxAttempts?: number
	/** Maximum elapsed time allowed for the retry sequence, in milliseconds. */
	maxElapsedMs?: number
	/** Delay before retrying the first failed attempt. */
	baseDelayMs?: number
	/** Hard upper bound for exponential and provider-requested delays. */
	maxDelayMs?: number
	/** Jitter strategy for exponential backoff. */
	jitter?: "none" | "full"
	/** Injectable source for deterministic tests and controlled runtimes. */
	random?: () => number
	/** Optional category-specific attempt budgets. */
	maxAttemptsByCategory?: Partial<Record<AgentRetryCategory, number>>
}

export interface AgentRetryPolicyDefaults {
	readonly maxAttempts: number
	readonly maxElapsedMs: number
	readonly baseDelayMs: number
	readonly maxDelayMs: number
	readonly jitter: "none" | "full"
	readonly maxAttemptsByCategory: Readonly<Record<AgentRetryCategory, number>>
}

/**
 * Conservative defaults shared by callers that do not have a provider
 * specific policy. The attempt and elapsed budgets are fixed, and full jitter
 * keeps synchronized callers from retrying in lockstep. Tests can inject a
 * deterministic random source.
 */
export const DEFAULT_AGENT_RETRY_POLICY: AgentRetryPolicyDefaults = Object.freeze({
	maxAttempts: 4,
	maxElapsedMs: 90_000,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	jitter: "full" as const,
	maxAttemptsByCategory: Object.freeze({
		transport: 4,
		"rate-limit": 4,
		context: 4,
		"empty-response": 2,
	}),
})

export interface AgentRetryRequest {
	category: AgentRetryCategory
	/** One-based number of the attempt that just failed. */
	attempt: number
	/** Optional provider hint in milliseconds, such as HTTP Retry-After. */
	retryAfterMs?: number
	/** Elapsed retry-sequence time at the failed attempt, in milliseconds. */
	elapsedMs?: number
	/** Semantic output has already been observed and must never be replayed. */
	hasSemanticOutput?: boolean
}

export type AgentRetryExhaustionReason = "attempts" | "elapsed-budget" | "semantic-output"

export interface AgentRetryDecision {
	category: AgentRetryCategory
	/** One-based number of the attempt that just failed. */
	attempt: number
	/** Whether the caller should wait and issue another provider attempt. */
	shouldRetry: boolean
	/** True when the category's attempt budget or another hard guard was consumed. */
	exhausted: boolean
	/** Delay before the next attempt, or zero when exhausted. */
	delayMs: number
	/** One-based number to use for the next attempt. */
	nextAttempt: number
	/** Why another attempt was denied, when exhausted. */
	reason?: AgentRetryExhaustionReason
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.floor(value))
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.max(0, value)
}

function normalizeAttempt(attempt: number): number {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new RangeError("Retry attempt must be a one-based positive integer")
	}
	return attempt
}

function normalizeRetryAfterMs(retryAfterMs: number | undefined): number {
	if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) return 0
	return Math.max(0, Math.ceil(retryAfterMs))
}

function normalizeElapsedMs(elapsedMs: number | undefined): number {
	if (elapsedMs === undefined || !Number.isFinite(elapsedMs)) return 0
	return Math.max(0, elapsedMs)
}

function normalizeRandomValue(random: number): number {
	if (!Number.isFinite(random)) return 0
	return Math.min(1, Math.max(0, random))
}

/**
 * A bounded retry decision maker. It has no provider or UI dependencies, so
 * adapters can use the same attempt and delay semantics for every provider.
 */
export class AgentRetryPolicy {
	readonly maxAttempts: number
	readonly maxElapsedMs: number
	readonly baseDelayMs: number
	readonly maxDelayMs: number
	readonly jitter: "none" | "full"
	readonly maxAttemptsByCategory: Readonly<Record<AgentRetryCategory, number>>

	private readonly random: () => number

	constructor(options: AgentRetryPolicyOptions = {}) {
		this.maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_AGENT_RETRY_POLICY.maxAttempts)
		this.maxElapsedMs = normalizeNonNegativeNumber(options.maxElapsedMs, DEFAULT_AGENT_RETRY_POLICY.maxElapsedMs)
		this.baseDelayMs = normalizeNonNegativeNumber(options.baseDelayMs, DEFAULT_AGENT_RETRY_POLICY.baseDelayMs)
		this.maxDelayMs = normalizeNonNegativeNumber(options.maxDelayMs, DEFAULT_AGENT_RETRY_POLICY.maxDelayMs)
		this.jitter = options.jitter ?? DEFAULT_AGENT_RETRY_POLICY.jitter
		this.random = options.random ?? Math.random

		const categoryBudgets = Object.fromEntries(
			AGENT_RETRY_CATEGORIES.map((category) => [
				category,
				Math.min(
					this.maxAttempts,
					normalizePositiveInteger(
						options.maxAttemptsByCategory?.[category],
						options.maxAttempts === undefined
							? (DEFAULT_AGENT_RETRY_POLICY.maxAttemptsByCategory[category] ?? this.maxAttempts)
							: this.maxAttempts,
					),
				),
			]),
		) as Record<AgentRetryCategory, number>
		this.maxAttemptsByCategory = Object.freeze(categoryBudgets)
	}

	/** Return the effective attempt budget for a category. */
	getMaxAttempts(category: AgentRetryCategory): number {
		this.assertCategory(category)
		return this.maxAttemptsByCategory[category]
	}

	/** Return true when another attempt is allowed after a failed attempt. */
	shouldRetry(category: AgentRetryCategory, attempt: number): boolean
	shouldRetry(request: AgentRetryRequest): boolean
	shouldRetry(categoryOrRequest: AgentRetryCategory | AgentRetryRequest, attempt?: number): boolean {
		return !this.decide(this.toRequest(categoryOrRequest, attempt)).exhausted
	}

	/** Return true when a failed attempt consumed a hard retry guard. */
	isExhausted(category: AgentRetryCategory, attempt: number): boolean
	isExhausted(request: AgentRetryRequest): boolean
	isExhausted(categoryOrRequest: AgentRetryCategory | AgentRetryRequest, attempt?: number): boolean {
		return this.decide(this.toRequest(categoryOrRequest, attempt)).exhausted
	}

	/**
	 * Calculate an exponential delay. Full jitter samples from zero through the
	 * exponential ceiling. A provider hint can lengthen the delay, but neither
	 * value can exceed the policy cap.
	 */
	getDelayMs(attempt: number, retryAfterMs?: number): number {
		const normalizedAttempt = normalizeAttempt(attempt)
		const exponent = normalizedAttempt - 1
		const exponentialCeiling = this.baseDelayMs * 2 ** exponent
		const boundedCeiling = Math.min(
			this.maxDelayMs,
			Number.isFinite(exponentialCeiling) ? exponentialCeiling : this.maxDelayMs,
		)
		const exponentialDelay =
			this.jitter === "full" ? boundedCeiling * normalizeRandomValue(this.random()) : boundedCeiling
		return Math.min(this.maxDelayMs, Math.max(exponentialDelay, normalizeRetryAfterMs(retryAfterMs)))
	}

	/** Resolve retry/exhaustion, output guards, and delay in one stable result. */
	decide(request: AgentRetryRequest): AgentRetryDecision {
		const attempt = normalizeAttempt(request.attempt)
		this.assertCategory(request.category)

		let reason: AgentRetryExhaustionReason | undefined
		let delayMs = 0
		if (request.hasSemanticOutput) {
			reason = "semantic-output"
		} else if (attempt >= this.getMaxAttempts(request.category)) {
			reason = "attempts"
		} else {
			const elapsedMs = normalizeElapsedMs(request.elapsedMs)
			if (elapsedMs >= this.maxElapsedMs) {
				reason = "elapsed-budget"
			} else {
				delayMs = this.getDelayMs(attempt, request.retryAfterMs)
				if (elapsedMs + delayMs > this.maxElapsedMs) reason = "elapsed-budget"
			}
		}

		const exhausted = reason !== undefined
		return Object.freeze({
			category: request.category,
			attempt,
			shouldRetry: !exhausted,
			exhausted,
			delayMs: exhausted ? 0 : delayMs,
			nextAttempt: attempt + 1,
			...(reason ? { reason } : {}),
		})
	}

	private toRequest(categoryOrRequest: AgentRetryCategory | AgentRetryRequest, attempt?: number): AgentRetryRequest {
		if (typeof categoryOrRequest === "object") return categoryOrRequest
		if (attempt === undefined) throw new RangeError("Retry attempt is required")
		return { category: categoryOrRequest, attempt }
	}

	private assertCategory(category: AgentRetryCategory): void {
		if (!isAgentRetryCategory(category)) {
			throw new TypeError(`Unsupported agent retry category: ${String(category)}`)
		}
	}
}

function getAbortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason
	const error = new Error("The operation was aborted")
	error.name = "AbortError"
	return error
}

/**
 * Wait for a bounded retry delay while responding promptly to cancellation.
 * When a signal is aborted, the promise rejects with its reason so callers can
 * preserve the host's cancellation taxonomy.
 */
export function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(getAbortReason(signal))

	const normalizedDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.ceil(delayMs)) : 0
	if (normalizedDelayMs === 0) return Promise.resolve()

	return new Promise<void>((resolve, reject) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined

		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
		const finish = () => {
			if (settled) return
			settled = true
			cleanup()
			resolve()
		}
		const onAbort = () => {
			if (settled) return
			settled = true
			cleanup()
			reject(getAbortReason(signal!))
		}

		timer = setTimeout(finish, normalizedDelayMs)
		signal?.addEventListener("abort", onAbort, { once: true })
		// Cover a signal that aborted between the initial check and listener setup.
		if (signal?.aborted) onAbort()
	})
}
