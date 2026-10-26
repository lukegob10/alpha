import type { AlphaMessage } from "@alpha-code/types"
import { consolidateTokenUsage } from "../consolidateTokenUsage.js"

describe("failed context summary accounting", () => {
	const api = (): AlphaMessage => ({
		ts: 1,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({ tokensIn: 100, tokensOut: 20, cacheWrites: 3, cacheReads: 4, cost: 2 }),
	})
	const failure = (ts: number, cost?: number): AlphaMessage => ({
		ts,
		type: "say",
		say: "condense_context_error",
		text: "Summary unavailable",
		...(cost === undefined ? {} : { contextCondenseErrorCost: cost }),
	})
	it("charges a returned failed summary once and preserves the latest agent context estimate", () => {
		const rows = [api(), failure(2, 0.01)]
		const expected = {
			totalTokensIn: 100,
			totalTokensOut: 20,
			totalCacheWrites: 3,
			totalCacheReads: 4,
			totalCost: 2.01,
			contextTokens: 120,
		}
		expect(consolidateTokenUsage(rows)).toEqual(expected)
		expect(consolidateTokenUsage(rows)).toEqual(expected)
		expect(consolidateTokenUsage(JSON.parse(JSON.stringify(rows)))).toEqual(expected)
	})
	it("accepts old failure rows with unknown cost without inventing a charge", () => {
		expect(consolidateTokenUsage([api(), failure(2)])).toMatchObject({ totalCost: 2, contextTokens: 120 })
	})
	it("charges each independent failed attempt and a successful compaction without double charging", () => {
		const rows: AlphaMessage[] = [
			api(),
			failure(2, 0.01),
			failure(3, 0.02),
			{
				ts: 4,
				type: "say",
				say: "condense_context",
				contextCondense: { cost: 0.03, prevContextTokens: 120, newContextTokens: 70, summary: "Earlier work" },
			},
			failure(5, 0.04),
		]
		expect(consolidateTokenUsage(rows).totalCost).toBeCloseTo(2.1)
		expect(consolidateTokenUsage(rows)).toMatchObject({
			contextTokens: 70,
			totalTokensIn: 100,
			totalTokensOut: 20,
			totalCacheWrites: 3,
			totalCacheReads: 4,
		})
	})
	it("charges a summary failure carried by successful fallback without an error row", () => {
		const rows: AlphaMessage[] = [
			api(),
			{
				ts: 2,
				type: "say",
				say: "sliding_window_truncation",
				contextCondenseErrorCost: 0.01,
				contextTruncation: {
					truncationId: "fallback-1",
					messagesRemoved: 2,
					prevContextTokens: 120,
					newContextTokens: 70,
				},
			},
		]
		expect(consolidateTokenUsage(rows)).toMatchObject({ totalCost: 2.01, contextTokens: 70 })
		expect(rows.some((row) => row.say === "condense_context_error")).toBe(false)
	})
	it.each([NaN, Infinity, -1])("ignores invalid persisted failure cost %s", (cost) => {
		expect(consolidateTokenUsage([api(), failure(2, cost)])).toMatchObject({ totalCost: 2, contextTokens: 120 })
	})
	it("only charges completed failure rows, not partial, unrelated, or successful rows", () => {
		const rows: AlphaMessage[] = [
			api(),
			{ ...failure(2, 8), partial: true },
			{ ...failure(3, 8), say: "text" },
			{ ...failure(4, 8), type: "ask", ask: "command" },
			{
				...failure(5, 8),
				say: "condense_context",
				contextCondense: {
					cost: 0.03,
					prevContextTokens: 120,
					newContextTokens: 70,
					summary: "Earlier work",
				},
			},
		]
		expect(consolidateTokenUsage(rows)).toMatchObject({ totalCost: 2.03, contextTokens: 70 })
	})
})
