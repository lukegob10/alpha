import {
	AGENT_RETRY_CATEGORIES,
	AgentRetryPolicy,
	DEFAULT_AGENT_RETRY_POLICY,
	delayWithAbort,
} from "../AgentRetryPolicy"

describe("AgentRetryPolicy", () => {
	it("uses stable bounded defaults", () => {
		const policy = new AgentRetryPolicy()

		expect(DEFAULT_AGENT_RETRY_POLICY).toEqual({
			maxAttempts: 4,
			maxElapsedMs: 90_000,
			baseDelayMs: 1_000,
			maxDelayMs: 30_000,
			jitter: "full",
			maxAttemptsByCategory: {
				transport: 4,
				"rate-limit": 4,
				context: 4,
				"empty-response": 2,
			},
		})
		expect(policy.maxAttempts).toBe(DEFAULT_AGENT_RETRY_POLICY.maxAttempts)
		expect(policy.maxElapsedMs).toBe(DEFAULT_AGENT_RETRY_POLICY.maxElapsedMs)
		expect(policy.baseDelayMs).toBe(DEFAULT_AGENT_RETRY_POLICY.baseDelayMs)
		expect(policy.maxDelayMs).toBe(DEFAULT_AGENT_RETRY_POLICY.maxDelayMs)
		expect(policy.jitter).toBe(DEFAULT_AGENT_RETRY_POLICY.jitter)
		expect(Object.isFrozen(DEFAULT_AGENT_RETRY_POLICY)).toBe(true)
	})

	it.each(AGENT_RETRY_CATEGORIES)("retries %s until its attempt budget is exhausted", (category) => {
		const policy = new AgentRetryPolicy({ maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: "none" })

		expect(policy.shouldRetry(category, 1)).toBe(true)
		expect(policy.isExhausted(category, 1)).toBe(false)
		expect(policy.decide({ category, attempt: 1 })).toMatchObject({
			category,
			attempt: 1,
			shouldRetry: true,
			exhausted: false,
			delayMs: 10,
			nextAttempt: 2,
		})

		expect(policy.shouldRetry(category, 2)).toBe(false)
		expect(policy.isExhausted(category, 2)).toBe(true)
		expect(policy.decide({ category, attempt: 2 })).toMatchObject({
			shouldRetry: false,
			exhausted: true,
			delayMs: 0,
			nextAttempt: 3,
		})
	})

	it("caps exponential delay and provider retry-after hints", () => {
		const policy = new AgentRetryPolicy({
			maxAttempts: 5,
			baseDelayMs: 100,
			maxDelayMs: 250,
			random: () => 1,
		})

		expect(policy.getDelayMs(1)).toBe(100)
		expect(policy.getDelayMs(2)).toBe(200)
		expect(policy.getDelayMs(3)).toBe(250)
		expect(policy.getDelayMs(1, 500)).toBe(250)
		expect(policy.getDelayMs(1, -10)).toBe(100)
	})

	it("uses injectable full jitter and refuses replay after semantic output", () => {
		const policy = new AgentRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 30_000, random: () => 0.25 })

		expect(policy.getDelayMs(1)).toBe(250)
		expect(policy.decide({ category: "transport", attempt: 1, hasSemanticOutput: true })).toMatchObject({
			shouldRetry: false,
			exhausted: true,
			delayMs: 0,
			reason: "semantic-output",
		})
	})

	it("enforces the elapsed retry budget before scheduling another attempt", () => {
		const policy = new AgentRetryPolicy({
			maxElapsedMs: 1_000,
			baseDelayMs: 500,
			maxDelayMs: 2_000,
			jitter: "none",
		})

		expect(policy.decide({ category: "transport", attempt: 1, elapsedMs: 400 })).toMatchObject({
			shouldRetry: true,
			delayMs: 500,
		})
		expect(policy.decide({ category: "transport", attempt: 1, elapsedMs: 500 })).toMatchObject({
			shouldRetry: true,
			delayMs: 500,
		})
		expect(policy.decide({ category: "transport", attempt: 1, elapsedMs: 501 })).toMatchObject({
			shouldRetry: false,
			reason: "elapsed-budget",
		})
	})

	it("supports category-specific attempt budgets", () => {
		const policy = new AgentRetryPolicy({
			maxAttempts: 4,
			maxAttemptsByCategory: { context: 1 },
		})

		expect(policy.getMaxAttempts("transport")).toBe(4)
		expect(policy.getMaxAttempts("context")).toBe(1)
		expect(policy.shouldRetry("context", 1)).toBe(false)
	})

	it("never lets a category budget exceed the global attempt limit", () => {
		const policy = new AgentRetryPolicy({
			maxAttempts: 2,
			maxAttemptsByCategory: { transport: 99, context: Number.POSITIVE_INFINITY, "empty-response": 0 },
		})

		for (const category of AGENT_RETRY_CATEGORIES) {
			expect(policy.getMaxAttempts(category)).toBeLessThanOrEqual(policy.maxAttempts)
		}
		expect(policy.getMaxAttempts("transport")).toBe(2)
		expect(policy.getMaxAttempts("context")).toBe(2)
		expect(policy.getMaxAttempts("empty-response")).toBe(1)
	})

	describe("delayWithAbort", () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it("rejects promptly when cancellation occurs during the delay", async () => {
			vi.useFakeTimers()
			const controller = new AbortController()
			const pending = delayWithAbort(10_000, controller.signal)
			const abortReason = new Error("cancelled")

			controller.abort(abortReason)

			await expect(pending).rejects.toBe(abortReason)
			expect(vi.getTimerCount()).toBe(0)
		})

		it("rejects immediately when the signal is already aborted", async () => {
			const controller = new AbortController()
			const abortReason = new Error("already cancelled")
			controller.abort(abortReason)

			await expect(delayWithAbort(10_000, controller.signal)).rejects.toBe(abortReason)
		})
	})
})
