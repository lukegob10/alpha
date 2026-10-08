import { getEmbeddingRetryDelayMs, getEmbeddingStatus, isRetryableEmbeddingError } from "../embedding-retry"

describe("embedding retry policy", () => {
	it.each(["headers", "response"])("honors numeric Retry-After in %s", (source) => {
		const headers = new Headers({ "Retry-After": "2.5" })
		expect(getEmbeddingRetryDelayMs(source === "headers" ? { headers } : { response: { headers } }, 0)).toBe(2500)
	})
	it("honors gateway header containers with a bound getter", () => {
		const headers = {
			values: new Map([["retry-after", "4"]]),
			get(name: string) {
				return this.values.get(name)
			},
		}
		expect(getEmbeddingRetryDelayMs({ response: { headers } }, 0)).toBe(4000)
	})
	it.each(["header", "retry-info"])("ignores overflowing provider delays from %s", (source) => {
		const seconds = "9".repeat(308)
		const error =
			source === "header"
				? { status: 429, headers: { "retry-after": seconds } }
				: {
						status: 429,
						details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${seconds}s` }],
					}
		expect(getEmbeddingRetryDelayMs(error, 0)).toBe(5000)
	})
	it("honors HTTP-date Retry-After", () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date("2026-10-07T20:00:00Z"))
			expect(getEmbeddingRetryDelayMs({ headers: { "retry-after": "Wed, 07 Oct 2026 20:00:05 GMT" } }, 0)).toBe(
				5000,
			)
		} finally {
			vi.useRealTimers()
		}
	})
	it("extracts a fractional Google RetryInfo duration from SDK JSON messages", () => {
		const error = new Error(
			JSON.stringify({
				error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.25s" }] },
			}),
		)
		expect(getEmbeddingRetryDelayMs(error, 0)).toBe(3250)
	})
	it("uses bounded attempts with exponential backoff only for transient failures", () => {
		expect(getEmbeddingRetryDelayMs({ status: 429 }, 2)).toBe(20_000)
		expect(getEmbeddingRetryDelayMs({ statusCode: 503 }, 1)).toBe(1000)
		expect(getEmbeddingStatus({ code: "429" })).toBe(429)
		expect(isRetryableEmbeddingError({ response: { status: 401 }, message: "timeout" })).toBe(false)
		expect(isRetryableEmbeddingError({ status: 503 })).toBe(true)
	})
})
