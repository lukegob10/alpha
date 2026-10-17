import { readRetryAfterMs } from "../RequestPacing"

describe("readRetryAfterMs", () => {
	it("parses retry-after seconds, dates, and reset epochs", () => {
		expect(readRetryAfterMs({ "retry-after": "2" }, 1_000)).toBe(2_000)
		expect(readRetryAfterMs(new Headers({ "retry-after": new Date(6_000).toUTCString() }), 1_000)).toBe(5_000)
		expect(readRetryAfterMs({ "x-ratelimit-reset": "6" }, 1_000)).toBe(5_000)
	})
	it("reads header names without case sensitivity and uses the last duplicate spelling", () => {
		expect(readRetryAfterMs({ "Retry-After": "12" })).toBe(12_000)
		expect(readRetryAfterMs({ "Retry-After": "5", "retry-after": "30" })).toBe(30_000)
		expect(readRetryAfterMs({ "Retry-After": "5", "retry-after": "\n30\n" })).toBe(5_000)
	})
	it.each(["", " ", "\n5\n", "-1", "1.5", "1e3", "0x10", true, ["5"], {}, "99999999999999999999999999"])(
		"ignores malformed retry-after advice %j",
		(retryAfter) => {
			expect(readRetryAfterMs({ "retry-after": retryAfter })).toBeUndefined()
		},
	)
	it("accepts HTTP whitespace and keeps a past server date at zero", () => {
		expect(readRetryAfterMs({ "retry-after": "\t5\t" })).toBe(5_000)
		expect(readRetryAfterMs({ "retry-after": new Date(0).toUTCString() }, 1_000)).toBe(0)
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
})
