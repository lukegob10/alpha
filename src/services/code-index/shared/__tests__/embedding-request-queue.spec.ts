import pLimit from "p-limit"
import { EmbeddingRequestQueue } from "../embedding-request-queue"
import { EmbeddingRateLimiter } from "../embedding-rate-limiter"

describe("embedding admission", () => {
	afterEach(() => vi.useRealTimers())

	it("reserves search capacity, caps edit fan-out, and promptly removes superseded work", async () => {
		vi.useFakeTimers()
		const queue = new EmbeddingRequestQueue(16)
		let bulkStarted = 0
		let editsStarted = 0
		const hold = () => new Promise<void>((resolve) => setTimeout(resolve, 100))
		const bulk = Array.from({ length: 20 }, () =>
			queue.run("bulk", async () => {
				bulkStarted++
				await hold()
			}),
		)
		await Promise.resolve()
		expect(bulkStarted).toBe(15)
		const query = queue.run("query", async () => "ready")
		expect(await query).toBe("ready")
		const abort = new AbortController()
		const cancelled = queue.run(
			"incremental",
			async () => {
				throw new Error("Must not run")
			},
			abort.signal,
		)
		const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
		abort.abort()
		await rejection
		await vi.runAllTimersAsync()
		await Promise.all(bulk)
		const edits = Array.from({ length: 10 }, () =>
			queue.run("incremental", async () => {
				editsStarted++
				await hold()
			}),
		)
		await Promise.resolve()
		expect(editsStarted).toBe(2)
		await vi.runAllTimersAsync()
		await Promise.all(edits)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("prioritizes at quota admission while honoring shared cooldown and fairness", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const limiter = new EmbeddingRateLimiter(100)
		await limiter.wait()
		const started: string[] = []
		const bulk = limiter.wait().then(() => started.push("bulk"))
		const queries = Array.from({ length: 10 }, (_, index) =>
			limiter.wait(undefined, 1, undefined, "query").then(() => started.push(`query-${index}`)),
		)
		limiter.defer(1000)
		await vi.advanceTimersByTimeAsync(999)
		expect(started).toEqual([])
		await vi.runAllTimersAsync()
		await Promise.all([bulk, ...queries])
		expect(started[0]).toBe("query-0")
		expect(started.indexOf("bulk")).toBe(8)
		expect(Date.now()).toBe(2000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("releases a cancelled quota waiter and its timer without spending another start", async () => {
		vi.useFakeTimers()
		const limiter = new EmbeddingRateLimiter(1000)
		await limiter.wait()
		const abort = new AbortController()
		const pending = limiter.wait(abort.signal)
		const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" })
		abort.abort()
		await rejection
		expect(vi.getTimerCount()).toBe(0)
	})
	it("bounds admission and pacing queues without losing accepted requests", async () => {
		vi.useFakeTimers()
		const queue = new EmbeddingRequestQueue(2)
		const operation = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
		const accepted = Array.from({ length: 258 }, () => queue.run("bulk", operation))
		await expect(queue.run("query", operation)).rejects.toBeInstanceOf(Error)
		await vi.runAllTimersAsync()
		await Promise.all(accepted)
		const limiter = new EmbeddingRateLimiter(1)
		await limiter.wait()
		const starts = Array.from({ length: 256 }, () => limiter.wait())
		await expect(limiter.wait()).rejects.toBeInstanceOf(Error)
		await vi.runAllTimersAsync()
		await Promise.all(starts)
		expect(vi.getTimerCount()).toBe(0)
	})
	it("releases timers when wait-progress reporting cancels its own request", async () => {
		vi.useFakeTimers()
		const limiter = new EmbeddingRateLimiter(1000)
		await limiter.wait()
		const abort = new AbortController()
		await expect(limiter.wait(abort.signal, 1, () => abort.abort())).rejects.toMatchObject({ name: "AbortError" })
		expect(vi.getTimerCount()).toBe(0)
	})
	it("rejects a failed progress observer and permits subsequent requests", async () => {
		vi.useFakeTimers()
		const limiter = new EmbeddingRateLimiter(1000)
		await limiter.wait()
		const error = new Error("observer failed")
		await expect(
			limiter.wait(undefined, 1, () => {
				throw error
			}),
		).rejects.toBe(error)
		await vi.advanceTimersByTimeAsync(1000)
		let ready = false
		const next = limiter.wait().then(() => {
			ready = true
		})
		await vi.advanceTimersByTimeAsync(0)
		try {
			expect(ready).toBe(true)
		} finally {
			await vi.runAllTimersAsync()
			await next
		}
		expect(vi.getTimerCount()).toBe(0)
	})

	it("records bulk and search latency against the previous FIFO admission on the same workload", async () => {
		vi.useFakeTimers()
		const samples = []
		for (const strategy of ["fifo", "priority"] as const) {
			for (let sample = 0; sample < 5; sample++) {
				vi.setSystemTime(0)
				const fifo = pLimit(16)
				const queue = new EmbeddingRequestQueue(16)
				const request = () => new Promise<void>((resolve) => setTimeout(resolve, 100))
				const jobs = Array.from({ length: 100 }, () =>
					strategy === "fifo" ? fifo(request) : queue.run("bulk", request),
				)
				const query = strategy === "fifo" ? fifo(request) : queue.run("query", request)
				let queryMs = 0
				void query.then(() => {
					queryMs = Date.now()
				})
				await vi.runAllTimersAsync()
				await Promise.all([...jobs, query])
				samples.push({ strategy, sample, queryMs, bulkMs: Date.now(), requests: 101 })
				expect(queryMs).toBe(strategy === "fifo" ? 700 : 100)
				expect(Date.now()).toBe(700)
			}
		}
		console.info(
			"EMBEDDING_ADMISSION_BENCHMARK",
			JSON.stringify({ requests: 101, latencyMs: 100, concurrency: 16, samples }),
		)
	})
})
