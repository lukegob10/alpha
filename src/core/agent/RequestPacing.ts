export interface RequestPacingLimits {
	requestsPerMinute?: number
	tokensPerMinute?: number
	minimumSpacingMs?: number
}
export interface RequestReservation {
	estimatedInputTokens: number
	reservedOutputTokens: number
	retry: boolean
}

export class TokenAwareRequestPacer {
	private nextRequestAt = 0
	private nextTokenAt = 0
	private retryUntil = 0
	reserve(now: number, request: RequestReservation, limits: RequestPacingLimits): number {
		const requestSpacing = limits.requestsPerMinute ? 60_000 / limits.requestsPerMinute : 0
		const tokenSpacing = limits.tokensPerMinute
			? ((request.estimatedInputTokens + request.reservedOutputTokens) / limits.tokensPerMinute) * 60_000
			: 0
		const availableAt = Math.max(now, this.nextRequestAt, this.nextTokenAt, this.retryUntil)
		const delayMs = Math.max(0, Math.ceil(availableAt - now))
		this.nextRequestAt = availableAt + Math.max(requestSpacing, limits.minimumSpacingMs ?? 0)
		this.nextTokenAt = availableAt + tokenSpacing
		return delayMs
	}
	observeRetryAfter(now: number, retryAfterMs: number): void {
		this.retryUntil = Math.max(this.retryUntil, now + Math.max(0, retryAfterMs))
	}
}

export interface RequestUsageBreakdown {
	initial: { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }
	retry: { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

function readHeader(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined
	const source = headers as Record<string, unknown>
	let value: unknown
	if (typeof source.get === "function") {
		try {
			value = source.get(name)
		} catch {
			// A malformed header accessor must not replace the original provider error.
			return undefined
		}
	} else {
		for (const [key, candidate] of Object.entries(source)) {
			if (key.toLowerCase() === name && typeof candidate === "string" && !/[^\t\x20-\x7e]/.test(candidate)) {
				value = candidate
			}
		}
	}
	// Retry advice uses HTTP header values, not arbitrary JS numeric coercion.
	if (typeof value !== "string" || /[^\t\x20-\x7e]/.test(value)) return undefined
	return value.trim()
}

const HTTP_DATE_PATTERN =
	/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+day, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/

function safeDelayMs(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.ceil(value) : undefined
}

/** Absence is distinct from valid zero advice when falling back between error/header envelopes. */
export function readRetryAfterMs(headers: unknown, now = Date.now()): number | undefined {
	const retryAfter = readHeader(headers, "retry-after")
	if (retryAfter !== undefined) {
		if (/^\d+$/.test(retryAfter)) {
			const delay = safeDelayMs(Number(retryAfter) * 1_000)
			if (delay !== undefined) return delay
		} else if (HTTP_DATE_PATTERN.test(retryAfter)) {
			// The obsolete asctime HTTP form is also GMT, never the extension host's local timezone.
			const date = retryAfter.endsWith(" GMT") ? retryAfter : `${retryAfter} GMT`
			const delay = safeDelayMs(Math.max(0, Date.parse(date) - now))
			if (delay !== undefined) return delay
		}
	}
	// Retain Alpha's existing reset-epoch fallback for compatible endpoints.
	const resetHeader = readHeader(headers, "x-ratelimit-reset")
	if (resetHeader === undefined || !/^\d+$/.test(resetHeader)) return undefined
	const reset = Number(resetHeader)
	if (!Number.isFinite(reset) || reset <= 0) return undefined
	return safeDelayMs(Math.max(0, (reset > 10_000_000_000 ? reset : reset * 1_000) - now))
}

export function parseRetryAfterMs(headers: unknown, now = Date.now()): number {
	return readRetryAfterMs(headers, now) ?? 0
}
export function recordRequestUsage(
	report: RequestUsageBreakdown,
	retry: boolean,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
): RequestUsageBreakdown {
	const lane = retry ? "retry" : "initial"
	return {
		...report,
		[lane]: {
			requests: report[lane].requests + 1,
			inputTokens: report[lane].inputTokens + inputTokens,
			outputTokens: report[lane].outputTokens + outputTokens,
			cacheReadTokens: (report[lane].cacheReadTokens ?? 0) + cacheReadTokens,
		},
	}
}

export class AgentStoppingRules {
	private counts = new Map<string, number>()
	shouldStop(kind: "read" | "failed_command" | "verification" | "delegation", signature: string): boolean {
		const count = this.counts.get(`${kind}:${signature}`) ?? 0
		return count >= (kind === "read" ? 3 : 2)
	}
	record(kind: "read" | "failed_command" | "verification" | "delegation", signature: string): boolean {
		const key = `${kind}:${signature}`
		const count = (this.counts.get(key) ?? 0) + 1
		this.counts.set(key, count)
		return count >= (kind === "read" ? 3 : 2)
	}
}
