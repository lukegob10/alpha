import { INITIAL_RETRY_DELAY_MS } from "../constants"

/** The adapter has settled its retry budget; scanner storage retries must not start it again. */
export class EmbeddingRequestError extends Error {
	constructor(error: Error) {
		super(error.message, { cause: error })
		this.name = "EmbeddingRequestError"
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function getEmbeddingStatus(error: unknown): number | undefined {
	const value = record(error)
	const response = record(value?.response)
	for (const status of [value?.status, value?.statusCode, value?.code, response?.status]) {
		const parsed = typeof status === "number" ? status : typeof status === "string" ? Number(status) : NaN
		if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
	}
	return undefined
}

export function isRetryableEmbeddingError(error: unknown): boolean {
	const status = getEmbeddingStatus(error)
	if (status !== undefined) return status === 429 || status >= 500
	return /rate limit|too many requests|temporarily unavailable|timeout/i.test(
		error instanceof Error ? error.message : String(error),
	)
}

export function getEmbeddingRetryDelayMs(error: unknown, attempt: number): number {
	const value = record(error)
	const response = record(value?.response)
	const headers = response?.headers ?? value?.headers
	const headerRecord = record(headers)
	const getter = headerRecord?.get
	const retryAfter: unknown =
		typeof getter === "function" ? getter.call(headers, "retry-after") : headerRecord?.["retry-after"]
	if (typeof retryAfter === "string") {
		const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN
		if (Number.isFinite(seconds * 1000)) return seconds * 1000
		const retryAt = Date.parse(retryAfter)
		if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now())
	}
	// Google SDK ApiError messages contain the JSON error envelope, including RetryInfo.
	let envelope = record(response?.data) ?? value
	if (typeof value?.message === "string") {
		try {
			envelope = record(JSON.parse(value.message)) ?? envelope
		} catch {
			// Non-JSON provider messages have no structured retry delay.
		}
	}
	const details = record(envelope?.error)?.details ?? envelope?.details
	if (Array.isArray(details)) {
		for (const detail of details) {
			const info = record(detail)
			if (info?.["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") continue
			const duration =
				typeof info.retryDelay === "string" ? info.retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : undefined
			if (duration && Number.isFinite(Number(duration[1]) * 1000)) return Number(duration[1]) * 1000
		}
	}
	return (getEmbeddingStatus(error) === 429 ? 5000 : INITIAL_RETRY_DELAY_MS) * 2 ** attempt
}
