import type { Anthropic } from "@anthropic-ai/sdk"

const { createPool, localCount } = vi.hoisted(() => ({ createPool: vi.fn(), localCount: vi.fn() }))

vi.mock("workerpool", () => ({ default: { pool: createPool } }))
vi.mock("../tiktoken", () => ({ tiktoken: localCount }))

const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Token counting fixture" }]

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

function workerPool() {
	return {
		maxQueueSize: 10,
		exec: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, count: 7 }),
		terminate: vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue(undefined),
	}
}

describe("token-count worker ownership", () => {
	let countTokens: typeof import("../countTokens").countTokens

	beforeEach(async () => {
		vi.resetModules()
		vi.resetAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
		localCount.mockResolvedValue(11)
		const module = await import("../countTokens")
		countTokens = module.countTokens
	})

	afterEach(() => vi.restoreAllMocks())

	it("keeps one bounded worker pool for healthy counts", async () => {
		const pool = workerPool()
		createPool.mockReturnValue(pool)

		expect(await countTokens(content)).toBe(7)
		expect(await countTokens(content)).toBe(7)

		expect(createPool).toHaveBeenCalledOnce()
		expect(createPool).toHaveBeenCalledWith(expect.stringContaining("countTokens.js"), {
			maxWorkers: 1,
			maxQueueSize: 10,
		})
		expect(pool.exec).toHaveBeenCalledTimes(2)
		expect(pool.exec).toHaveBeenCalledWith("countTokens", [content])
		expect(pool.terminate).not.toHaveBeenCalled()
		expect(localCount).not.toHaveBeenCalled()
	})

	it("keeps a healthy pool after its queue rejects a count", async () => {
		const pool = workerPool()
		pool.exec.mockImplementationOnce(() => {
			throw new Error("Max queue size of 10 reached")
		})
		createPool.mockReturnValue(pool)

		expect(await countTokens(content)).toBe(11)
		expect(await countTokens(content)).toBe(7)

		expect(createPool).toHaveBeenCalledOnce()
		expect(pool.exec).toHaveBeenCalledTimes(2)
		expect(pool.terminate).not.toHaveBeenCalled()
		expect(localCount).toHaveBeenCalledOnce()
	})

	it("retires a failed pool before allowing a later worker count", async () => {
		const pool = workerPool()
		const replacement = workerPool()
		const retirement = deferred<void>()
		const retirementStarted = deferred<void>()
		pool.exec.mockRejectedValueOnce(new Error("Worker crashed"))
		pool.terminate.mockImplementationOnce(() => {
			retirementStarted.resolve()
			return retirement.promise
		})
		createPool.mockReturnValueOnce(pool).mockReturnValue(replacement)

		const failed = countTokens(content)
		await retirementStarted.promise
		expect(pool.terminate).toHaveBeenCalledWith(true)
		expect(await countTokens(content)).toBe(11)
		expect(createPool).toHaveBeenCalledOnce()
		retirement.resolve()
		expect(await failed).toBe(11)
		expect(await countTokens(content)).toBe(7)

		expect(createPool).toHaveBeenCalledTimes(2)
		expect(pool.terminate).toHaveBeenCalledOnce()
		expect(replacement.exec).toHaveBeenCalledOnce()
		expect(replacement.terminate).not.toHaveBeenCalled()
	})

	it("does not let a late failure from a retired pool retire its replacement", async () => {
		const pool = workerPool()
		const replacement = workerPool()
		const firstJob = deferred<unknown>()
		const lateJob = deferred<unknown>()
		pool.exec.mockReturnValueOnce(firstJob.promise).mockReturnValueOnce(lateJob.promise)
		createPool.mockReturnValueOnce(pool).mockReturnValue(replacement)

		const first = countTokens(content)
		const late = countTokens(content)
		firstJob.reject(new Error("Worker crashed"))
		expect(await first).toBe(11)
		expect(await countTokens(content)).toBe(7)
		lateJob.reject(new Error("Pool terminated"))
		expect(await late).toBe(11)
		expect(await countTokens(content)).toBe(7)

		expect(createPool).toHaveBeenCalledTimes(2)
		expect(pool.terminate).toHaveBeenCalledOnce()
		expect(replacement.exec).toHaveBeenCalledTimes(2)
		expect(replacement.terminate).not.toHaveBeenCalled()
	})

	it.each([
		{ success: false, error: "Encoding failed" },
		{ success: true, count: "invalid" },
	])("retires a pool returning invalid worker evidence: %s", async (result) => {
		const pool = workerPool()
		pool.exec.mockResolvedValueOnce(result)
		createPool.mockReturnValue(pool)

		expect(await countTokens(content)).toBe(11)
		expect(pool.terminate).toHaveBeenCalledOnce()
		expect(pool.terminate).toHaveBeenCalledWith(true)
	})

	it("handles pool cleanup rejection without keeping the permanent fallback", async () => {
		const pool = workerPool()
		const replacement = workerPool()
		pool.exec.mockRejectedValueOnce(new Error("Worker crashed"))
		pool.terminate.mockRejectedValueOnce(new Error("Termination failed"))
		createPool.mockReturnValueOnce(pool).mockReturnValue(replacement)

		expect(await countTokens(content)).toBe(11)
		expect(await countTokens(content)).toBe(7)

		expect(pool.terminate).toHaveBeenCalledOnce()
		expect(createPool).toHaveBeenCalledTimes(2)
		expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: "Termination failed" }))
	})

	it("keeps explicit local counts independent of worker creation and retirement", async () => {
		const pool = workerPool()
		createPool.mockReturnValue(pool)

		expect(await countTokens(content, { useWorker: false })).toBe(11)
		expect(createPool).not.toHaveBeenCalled()
		expect(await countTokens(content)).toBe(7)
		expect(await countTokens(content, { useWorker: false })).toBe(11)
		expect(await countTokens(content)).toBe(7)

		expect(createPool).toHaveBeenCalledOnce()
		expect(pool.exec).toHaveBeenCalledTimes(2)
		expect(pool.terminate).not.toHaveBeenCalled()
		expect(localCount).toHaveBeenCalledTimes(2)
	})
})
