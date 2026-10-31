// pnpm exec vitest run packages/core/src/message-utils/__tests__/consolidateTokenUsage.spec.ts

import type { AlphaMessage } from "@alpha-code/types"

import { consolidateTokenUsage, hasTokenUsageChanged, hasToolUsageChanged } from "../consolidateTokenUsage.js"
import { consolidateApiRequests } from "../consolidateApiRequests.js"
import { consolidateCommands } from "../consolidateCommands.js"

describe("consolidateTokenUsage", () => {
	it("reuses completed payload parsing through tail updates without changing totals or context ordering", () => {
		const first: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "api_req_started",
			text: '{\r\n"tokensIn":10,"tokensOut":2,"cost":1\r\n}',
		}
		const second: AlphaMessage = { ...first, ts: 2, text: JSON.stringify({ tokensIn: 20, tokensOut: 3, cost: 2 }) }
		const parse = vi.spyOn(JSON, "parse")
		try {
			const expected = consolidateTokenUsage([first, second])
			parse.mockClear()
			for (let frame = 0; frame < 20; frame++) {
				expect(
					consolidateTokenUsage([
						first,
						second,
						{ ts: 3, type: "say", say: "text", text: `tail ${frame}`, partial: true },
					]),
				).toEqual(expected)
			}
			expect(parse.mock.calls).toHaveLength(0)
			expect(consolidateTokenUsage([second, first])).toMatchObject({ totalTokensIn: 30, contextTokens: 12 })
			first.text = JSON.stringify({ tokensIn: 30, tokensOut: 4, cost: 3 })
			expect(consolidateTokenUsage([first, second])).toMatchObject({ totalTokensIn: 50, totalCost: 5 })
			expect(parse).toHaveBeenCalledWith(first.text)
			const reloaded = JSON.parse(JSON.stringify([first, second])) as AlphaMessage[]
			parse.mockClear()
			expect(consolidateTokenUsage(reloaded)).toEqual(consolidateTokenUsage([first, second]))
			expect(parse.mock.calls).toHaveLength(2)
			parse.mockClear()
			second.partial = true
			consolidateTokenUsage([first, second])
			consolidateTokenUsage([first, second])
			expect(parse.mock.calls.filter(([text]) => text === second.text)).toHaveLength(4)
		} finally {
			parse.mockRestore()
		}
	})

	it.each([false, true])(
		"keeps completed consolidation payload work bounded while the tail streams (legacy=%s)",
		(legacy) => {
			const messages: AlphaMessage[] = []
			for (let index = 0; index < 100; index++) {
				const ts = index * 10
				messages.push(
					{
						ts,
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({ tokensIn: 10, tokensOut: 2, cost: 1 }),
					},
					{ ts: ts + 1, type: "ask", ask: "use_mcp_server", text: '{"server":"fixture"}', isAnswered: true },
					{ ts: ts + 2, type: "say", say: "mcp_server_response", text: "result\r\ncontent" },
				)
				if (legacy) messages.push({ ts: ts + 3, type: "say", say: "api_req_finished", text: '{"cost":2}' })
			}
			const project = (history: AlphaMessage[]) =>
				consolidateTokenUsage(consolidateApiRequests(consolidateCommands(history)))
			const expected = project(messages)
			expect(expected).toMatchObject({
				totalTokensIn: 1_000,
				totalTokensOut: 200,
				totalCost: legacy ? 200 : 100,
				contextTokens: 12,
			})
			const parse = vi.spyOn(JSON, "parse")
			try {
				for (let frame = 0; frame < 60; frame++) {
					expect(
						project([
							...messages,
							{ ts: 2000, type: "say", say: "text", text: `tail ${frame}`, partial: true },
						]),
					).toEqual(expected)
				}
				expect(parse.mock.calls).toHaveLength(0)
			} finally {
				parse.mockRestore()
			}
		},
	)

	it("counts synopsis usage without changing the agent context window size", () => {
		const result = consolidateTokenUsage([
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1000, tokensOut: 100 }) },
			{
				ts: 2,
				type: "say",
				say: "reasoning",
				text: "Original reasoning",
				reasoningSummary: "A synopsis.",
				reasoningSummaryUsage: { tokensIn: 20, tokensOut: 10, cacheWrites: 0, cacheReads: 5, cost: 0.002 },
			},
		])
		expect(result).toMatchObject({
			totalTokensIn: 1020,
			totalTokensOut: 110,
			totalCacheReads: 5,
			totalCost: 0.002,
			contextTokens: 1100,
		})
	})
	// Helper function to create a basic api_req_started message
	const createApiReqMessage = (
		ts: number,
		data: {
			tokensIn?: number
			tokensOut?: number
			cacheWrites?: number
			cacheReads?: number
			cost?: number
		},
	): AlphaMessage => ({
		ts,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify(data),
	})

	describe("basic token accumulation", () => {
		it("should accumulate tokens from a single message", () => {
			const messages: AlphaMessage[] = [createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cost: 0.01 })]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(100)
			expect(result.totalTokensOut).toBe(50)
			expect(result.totalCost).toBe(0.01)
		})

		it("should accumulate tokens from multiple messages", () => {
			const messages: AlphaMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cost: 0.01 }),
				createApiReqMessage(1001, { tokensIn: 200, tokensOut: 100, cost: 0.02 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(300)
			expect(result.totalTokensOut).toBe(150)
			expect(result.totalCost).toBeCloseTo(0.03)
		})

		it("should handle cache writes and reads", () => {
			const messages: AlphaMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50, cacheWrites: 500, cacheReads: 200 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalCacheWrites).toBe(500)
			expect(result.totalCacheReads).toBe(200)
		})

		it("should handle empty messages array", () => {
			const result = consolidateTokenUsage([])

			expect(result.totalTokensIn).toBe(0)
			expect(result.totalTokensOut).toBe(0)
			expect(result.totalCost).toBe(0)
			expect(result.contextTokens).toBe(0)
		})
	})

	describe("context tokens calculation", () => {
		it("should calculate context tokens from the last API request", () => {
			const messages: AlphaMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				createApiReqMessage(1001, { tokensIn: 200, tokensOut: 100 }),
			]

			const result = consolidateTokenUsage(messages)

			// Context tokens = tokensIn + tokensOut from last message
			expect(result.contextTokens).toBe(300) // 200 + 100
		})

		it("should handle condense_context messages for context tokens", () => {
			const messages: AlphaMessage[] = [
				createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
				{
					ts: 1001,
					type: "say",
					say: "condense_context",
					contextCondense: { newContextTokens: 5000, cost: 0.05 },
				} as AlphaMessage,
			]

			const result = consolidateTokenUsage(messages)

			expect(result.contextTokens).toBe(5000)
			expect(result.totalCost).toBeCloseTo(0.05)
		})

		it.each([0, 300])("restores the latest completed truncation baseline of %s tokens", (newContextTokens) => {
			const messages: AlphaMessage[] = [
				createApiReqMessage(1000, { tokensIn: 1900, tokensOut: 0, cost: 0.01 }),
				{
					ts: 1001,
					type: "say",
					say: "sliding_window_truncation",
					contextTruncation: {
						truncationId: "saved-truncation",
						messagesRemoved: 6,
						prevContextTokens: 1900,
						newContextTokens,
					},
				},
				createApiReqMessage(1002, {}),
			]

			expect(consolidateTokenUsage(JSON.parse(JSON.stringify(messages)))).toMatchObject({
				contextTokens: newContextTokens,
				totalTokensIn: 1900,
				totalTokensOut: 0,
				totalCost: 0.01,
			})
			expect(
				consolidateTokenUsage([...messages, createApiReqMessage(1003, { tokensIn: 400, tokensOut: 50 })])
					.contextTokens,
			).toBe(450)
		})

		it.each([
			{ newContextTokens: 300, partial: true },
			{ newContextTokens: NaN, partial: false },
			{ newContextTokens: Infinity, partial: false },
			{ newContextTokens: -1, partial: false },
		])("ignores an incomplete or invalid truncation baseline: %j", ({ newContextTokens, partial }) => {
			expect(
				consolidateTokenUsage([
					createApiReqMessage(1000, { tokensIn: 100, tokensOut: 50 }),
					{
						ts: 1001,
						type: "say",
						say: "sliding_window_truncation",
						partial,
						contextTruncation: {
							truncationId: "pending-truncation",
							messagesRemoved: 2,
							prevContextTokens: 150,
							newContextTokens,
						},
					},
				]).contextTokens,
			).toBe(150)
		})
	})

	describe("invalid data handling", () => {
		it("should handle messages with invalid JSON", () => {
			const messages: AlphaMessage[] = [{ ts: 1000, type: "say", say: "api_req_started", text: "invalid json" }]

			// Should not throw
			const result = consolidateTokenUsage(messages)
			expect(result.totalTokensIn).toBe(0)
		})

		it("should skip non-api_req_started messages", () => {
			const messages: AlphaMessage[] = [
				{ ts: 1000, type: "say", say: "text", text: "hello" },
				createApiReqMessage(1001, { tokensIn: 100, tokensOut: 50 }),
			]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(100)
			expect(result.totalTokensOut).toBe(50)
		})

		it("should handle missing token values", () => {
			const messages: AlphaMessage[] = [createApiReqMessage(1000, { cost: 0.01 })]

			const result = consolidateTokenUsage(messages)

			expect(result.totalTokensIn).toBe(0)
			expect(result.totalTokensOut).toBe(0)
			expect(result.totalCost).toBe(0.01)
		})
	})
})

describe("hasTokenUsageChanged", () => {
	it("should return true when snapshot is undefined", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, undefined)).toBe(true)
	})

	it("should return false when values are the same", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		const snapshot = { ...current }

		expect(hasTokenUsageChanged(current, snapshot)).toBe(false)
	})

	it("should return true when totalTokensIn changes", () => {
		const current = {
			totalTokensIn: 200,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}
		const snapshot = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when totalCost changes", () => {
		const current = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.02,
			contextTokens: 150,
		}
		const snapshot = {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
		}

		expect(hasTokenUsageChanged(current, snapshot)).toBe(true)
	})
})

describe("hasToolUsageChanged", () => {
	it("should return true when snapshot is undefined", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, undefined)).toBe(true)
	})

	it("should return false when values are the same", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(false)
	})

	it("should return true when a tool is added", () => {
		const current = {
			read_file: { attempts: 1, failures: 0 },
			write_to_file: { attempts: 1, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when attempts change", () => {
		const current = {
			read_file: { attempts: 2, failures: 0 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})

	it("should return true when failures change", () => {
		const current = {
			read_file: { attempts: 1, failures: 1 },
		}
		const snapshot = {
			read_file: { attempts: 1, failures: 0 },
		}

		expect(hasToolUsageChanged(current, snapshot)).toBe(true)
	})
})
