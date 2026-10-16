import { alphaMessageSchema } from "../message.js"

describe("failed context summary cost metadata", () => {
	const legacy = { ts: 1, type: "say", say: "condense_context_error", text: "Summary unavailable" }
	test("accepts old errors and preserves typed cost over JSON reload", () => {
		expect(alphaMessageSchema.parse(legacy)).toEqual(legacy)
		const row = { ...legacy, contextCondenseErrorCost: 0.01 }
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row)
		expect(alphaMessageSchema.parse({ ...row, partial: false })).toEqual({ ...row, partial: false })
		expect(alphaMessageSchema.parse({ ...row, contextCondenseErrorCost: 0 })).toEqual({
			...row,
			contextCondenseErrorCost: 0,
		})
	})
	test("accepts known failed-summary cost on a completed successful fallback receipt", () => {
		const row = {
			ts: 1,
			type: "say",
			say: "sliding_window_truncation",
			contextCondenseErrorCost: 0.01,
			contextTruncation: {
				truncationId: "fallback-1",
				messagesRemoved: 2,
				prevContextTokens: 120,
				newContextTokens: 70,
			},
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row)
		expect(alphaMessageSchema.safeParse({ ...row, partial: true }).success).toBe(false)
	})
	test.each([-1, NaN, Infinity, -Infinity, "0.01", null])("rejects invalid cost %s", (contextCondenseErrorCost) => {
		expect(alphaMessageSchema.safeParse({ ...legacy, contextCondenseErrorCost }).success).toBe(false)
	})
	test.each([{ say: "text" }, { say: "condense_context" }, { type: "ask", ask: "command" }, { partial: true }])(
		"restricts usage to completed error rows: %s",
		(override) => {
			expect(
				alphaMessageSchema.safeParse({ ...legacy, ...override, contextCondenseErrorCost: 0.01 }).success,
			).toBe(false)
		},
	)
})
