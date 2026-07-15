import { AgentStoppingRules, TokenAwareRequestPacer, recordRequestUsage } from "../RequestPacing"
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
	it("reports initial and retry usage separately", () => {
		const empty = {
			initial: { requests: 0, inputTokens: 0, outputTokens: 0 },
			retry: { requests: 0, inputTokens: 0, outputTokens: 0 },
		}
		const report = recordRequestUsage(recordRequestUsage(empty, false, 10, 2), true, 10, 1)
		expect(report).toEqual({
			initial: { requests: 1, inputTokens: 10, outputTokens: 2 },
			retry: { requests: 1, inputTokens: 10, outputTokens: 1 },
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
