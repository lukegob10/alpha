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
	initial: { requests: number; inputTokens: number; outputTokens: number }
	retry: { requests: number; inputTokens: number; outputTokens: number }
}
export function recordRequestUsage(
	report: RequestUsageBreakdown,
	retry: boolean,
	inputTokens: number,
	outputTokens: number,
): RequestUsageBreakdown {
	const lane = retry ? "retry" : "initial"
	return {
		...report,
		[lane]: {
			requests: report[lane].requests + 1,
			inputTokens: report[lane].inputTokens + inputTokens,
			outputTokens: report[lane].outputTokens + outputTokens,
		},
	}
}

export class AgentStoppingRules {
	private counts = new Map<string, number>()
	record(kind: "read" | "failed_command" | "verification" | "delegation", signature: string): boolean {
		const key = `${kind}:${signature}`
		const count = (this.counts.get(key) ?? 0) + 1
		this.counts.set(key, count)
		return count >= (kind === "read" ? 3 : 2)
	}
}
