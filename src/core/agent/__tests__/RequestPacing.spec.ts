import {
	AgentStoppingRules,
	TokenAwareRequestPacer,
	parseRetryAfterMs,
	readRetryAfterMs,
	recordRequestUsage,
} from "../RequestPacing"
describe("request pacing and stopping", () => {
	it("paces by the stricter token or request budget while retaining a minimum floor", () => {
		const pacer = new TokenAwareRequestPacer()
		expect(
			pacer.reserve(
				0,
				{ estimatedInputTokens: 500, reservedOutputTokens: 500, retry: false },
				{ requestsPerMinute: 60, tokensPerMinute: 30_000, minimumSpacingMs: 100 },
			),
		).toBe(0)
		expect(
			pacer.reserve(
				0,
				{ estimatedInputTokens: 500, reservedOutputTokens: 500, retry: false },
				{ requestsPerMinute: 60, tokensPerMinute: 30_000, minimumSpacingMs: 100 },
			),
		).toBe(2_000)
	})
	it("honors observed retry-after windows", () => {
		const pacer = new TokenAwareRequestPacer()
		pacer.observeRetryAfter(1_000, 5_000)
		expect(pacer.reserve(2_000, { estimatedInputTokens: 1, reservedOutputTokens: 1, retry: true }, {})).toBe(4_000)
	})
	it("parses retry-after seconds, dates, and reset epochs", () => {
		expect(parseRetryAfterMs({ "retry-after": "2" }, 1_000)).toBe(2_000)
		expect(parseRetryAfterMs(new Headers({ "retry-after": new Date(6_000).toUTCString() }), 1_000)).toBe(5_000)
		expect(parseRetryAfterMs({ "x-ratelimit-reset": "6" }, 1_000)).toBe(5_000)
	})
	it("reads header names without case sensitivity and uses the last duplicate spelling", () => {
		expect(parseRetryAfterMs({ "Retry-After": "12" })).toBe(12_000)
		expect(parseRetryAfterMs({ "Retry-After": "5", "retry-after": "30" })).toBe(30_000)
		expect(parseRetryAfterMs({ "Retry-After": "5", "retry-after": "\n30\n" })).toBe(5_000)
	})
	it.each(["", " ", "\n5\n", "-1", "1.5", "1e3", "0x10", true, ["5"], {}, "99999999999999999999999999"])(
		"ignores malformed retry-after advice %j",
		(retryAfter) => {
			expect(parseRetryAfterMs({ "retry-after": retryAfter })).toBe(0)
		},
	)
	it("accepts HTTP whitespace and keeps a past server date at zero", () => {
		expect(parseRetryAfterMs({ "retry-after": "\t5\t" })).toBe(5_000)
		expect(parseRetryAfterMs({ "retry-after": new Date(0).toUTCString() }, 1_000)).toBe(0)
	})
	it("distinguishes valid zero advice from missing or malformed headers", () => {
		expect(readRetryAfterMs({ "retry-after": "0" })).toBe(0)
		expect(readRetryAfterMs({ "retry-after": "bad" })).toBeUndefined()
		expect(readRetryAfterMs(undefined)).toBeUndefined()
		expect(
			readRetryAfterMs({
				get: () => {
					throw new Error("invalid header access")
				},
			}),
		).toBeUndefined()
	})
	it.each(["Sun, 06 Nov 1994 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994"])(
		"accepts HTTP date syntax %s",
		(date) => {
			const expected = Date.UTC(1994, 10, 6, 8, 49, 37)
			expect(readRetryAfterMs({ "retry-after": date }, expected - 10_000)).toBe(10_000)
		},
	)
	it("reports initial and retry usage separately", () => {
		const empty = {
			initial: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
			retry: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
		}
		const report = recordRequestUsage(recordRequestUsage(empty, false, 10, 2), true, 10, 1)
		expect(report).toEqual({
			initial: { requests: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
			retry: { requests: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 },
		})
	})
	it("stops repeated reads later than repeated failures", () => {
		const rules = new AgentStoppingRules()
		expect(rules.record("read", "a")).toBe(false)
		expect(rules.record("read", "a")).toBe(false)
		expect(rules.record("read", "a")).toBe(true)
		expect(rules.record("failed_command", "x")).toBe(false)
		expect(rules.record("failed_command", "x")).toBe(true)
	})
})
