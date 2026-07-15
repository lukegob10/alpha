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

export function parseRetryAfterMs(headers: unknown, now = Date.now()): number {
	const source = headers as { get?: (name: string) => unknown; [key: string]: unknown } | undefined
	const read = (name: string): unknown =>
		typeof source?.get === "function"
			? source.get(name)
			: (source?.[name] ?? source?.[name.toLowerCase()] ?? source?.[name.toUpperCase()])
	const retryAfter = read("retry-after")
	if (retryAfter !== undefined && retryAfter !== null) {
		const seconds = Number(retryAfter)
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
		const date = Date.parse(String(retryAfter))
		if (Number.isFinite(date)) return Math.max(0, date - now)
	}
	const reset = Number(read("x-ratelimit-reset"))
	if (!Number.isFinite(reset) || reset <= 0) return 0
	return Math.max(0, (reset > 10_000_000_000 ? reset : reset * 1_000) - now)
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
