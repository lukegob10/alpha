import { EmbeddingRateLimiter } from "../embedding-rate-limiter"

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
})
