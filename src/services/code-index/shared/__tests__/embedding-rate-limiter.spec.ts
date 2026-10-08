import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../embedding-rate-limiter"

describe("EmbeddingRateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("allows the first request immediately", async () => {
		const limiter = new EmbeddingRateLimiter(1000)

		await expect(limiter.wait()).resolves.toBeUndefined()
	})

	it("delays subsequent request starts", async () => {
		const limiter = new EmbeddingRateLimiter(1000)

		await limiter.wait()

		let resolved = false
		const secondWait = limiter.wait().then(() => {
			resolved = true
		})

		await vi.advanceTimersByTimeAsync(999)
		expect(resolved).toBe(false)

		await vi.advanceTimersByTimeAsync(1)
		await secondWait
		expect(resolved).toBe(true)
	})

	it("serializes concurrent waiters", async () => {
		const limiter = new EmbeddingRateLimiter(1000)

		await limiter.wait()

		let secondResolved = false
		let thirdResolved = false
		const secondWait = limiter.wait().then(() => {
			secondResolved = true
		})
		const thirdWait = limiter.wait().then(() => {
			thirdResolved = true
		})

		await vi.advanceTimersByTimeAsync(1000)
		await secondWait
		expect(secondResolved).toBe(true)
		expect(thirdResolved).toBe(false)

		await vi.advanceTimersByTimeAsync(1000)
		await thirdWait
		expect(thirdResolved).toBe(true)
	})

	it("does not delay when disabled", async () => {
		const limiter = new EmbeddingRateLimiter(0)

		await limiter.wait()
		await expect(limiter.wait()).resolves.toBeUndefined()
	})

	it("spaces starts when the clock begins at zero", async () => {
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(1000)
		const starts: number[] = []
		const run = Promise.all(
			[limiter.wait(), limiter.wait(), limiter.wait()].map((wait) => wait.then(() => starts.push(Date.now()))),
		)
		await vi.runAllTimersAsync()
		await run
		expect(starts).toEqual([0, 1000, 2000])
	})

	it("applies and extends provider cooldowns to waiting requests", async () => {
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(1000)
		await limiter.wait()
		let started = false
		const pending = limiter.wait().then(() => {
			started = true
		})
		await vi.advanceTimersByTimeAsync(500)
		limiter.defer(3000)
		await vi.advanceTimersByTimeAsync(1000)
		limiter.defer(4000)
		await vi.advanceTimersByTimeAsync(3999)
		expect(started).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(started).toBe(true)
		expect(Date.now()).toBe(5500)
	})

	it("cancels a waiter promptly without reserving a start or poisoning the queue", async () => {
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(1000)
		await limiter.wait()
		const controller = new AbortController()
		const cancelled = expect(limiter.wait(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(100)
		controller.abort()
		await cancelled
		const next = limiter.wait()
		await vi.runAllTimersAsync()
		await next
		expect(Date.now()).toBe(1000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("honors cooldowns even with request spacing disabled", async () => {
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(0)
		limiter.defer(5000)
		const pending = limiter.wait()
		await vi.runAllTimersAsync()
		await pending
		expect(Date.now()).toBe(5000)
	})

	it("cancels a queued caller while an unrelated cooldown waiter remains pending", async () => {
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(0)
		limiter.defer(5000)
		const first = limiter.wait()
		const controller = new AbortController()
		const rejected = expect(limiter.wait(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		controller.abort()
		await rejected
		expect(Date.now()).toBe(0)
		await vi.runAllTimersAsync()
		await first
		await limiter.wait()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("honors delays beyond the native timer limit without wrapping to one millisecond", async () => {
		vi.setSystemTime(0)
		const wait = waitForEmbeddingDelay(2_147_483_647 + 5000)
		await vi.runAllTimersAsync()
		await wait
		expect(Date.now()).toBe(2_147_483_647 + 5000)
	})
})
