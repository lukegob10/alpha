import { getEventListeners } from "node:events"
import type { Mock } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CommandOutputSearchBatch, CommandOutputSearchBatchResult } from "../commandOutputSearch"

interface FakeWorker {
	emit(event: string, ...args: unknown[]): boolean
	listenerCount(event: string): number
	postMessage: Mock<(value: CommandOutputSearchBatch) => void>
	terminate: Mock<() => Promise<number>>
}

const workers = vi.hoisted(() => ({
	instances: [] as FakeWorker[],
	startError: undefined as Error | undefined,
	onSpawn: undefined as ((worker: FakeWorker, index: number) => void) | undefined,
}))

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events")
	return {
		Worker: class extends EventEmitter {
			postMessage = vi.fn<(value: CommandOutputSearchBatch) => void>()
			terminate = vi.fn(async () => 0)
			constructor() {
				super()
				if (workers.startError) throw workers.startError
				workers.instances.push(this)
				workers.onSpawn?.(this, workers.instances.length - 1)
			}
		},
	}
})

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

const batch: CommandOutputSearchBatch = {
	lines: ["matching line"],
	firstLineNumber: 1,
	remainingBytes: 1024,
	hasMatches: false,
}
const matched: CommandOutputSearchBatchResult = { matchedLineIndices: [0], processedLineCount: 1 }

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function workerAt(index: number): Promise<FakeWorker> {
	if (workers.instances[index]) return Promise.resolve(workers.instances[index])
	return new Promise((resolve) => {
		workers.onSpawn = (worker, spawnedIndex) => {
			if (spawnedIndex === index) {
				workers.onSpawn = undefined
				resolve(worker)
			}
		}
	})
}

function expectReleased(worker: FakeWorker) {
	expect(worker.terminate).toHaveBeenCalledOnce()
	for (const event of ["message", "error", "exit"]) expect(worker.listenerCount(event)).toBe(0)
}

describe("command output search worker lifecycle", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.useFakeTimers()
		workers.instances.length = 0
		workers.startError = undefined
		workers.onSpawn = undefined
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("caps active and queued searches and rejects overflow before starting work", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const jobs = Array.from({ length: 10 }, () =>
			withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch)),
		)
		expect(workers.instances).toHaveLength(2)
		await expect(withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))).rejects.toThrow(
			"commandOutputSearch.busy",
		)

		for (let index = 0; index < jobs.length; index++) {
			const worker = await workerAt(index)
			worker.emit("message", matched)
			await expect(jobs[index]).resolves.toEqual(matched)
			expectReleased(worker)
		}
		expect(workers.instances).toHaveLength(10)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("removes a queued cancellation without starting a worker or retaining its abort listener", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const first = withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))
		const second = withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))
		const controller = new AbortController()
		const reason = new Error("queued cancellation")
		const queued = withCommandOutputSearch("line", controller.signal, (matcher) => matcher.testBatch(batch))
		const cancelled = expect(queued).rejects.toBe(reason)
		controller.abort(reason)
		await cancelled
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		workers.instances[0].emit("message", matched)
		workers.instances[1].emit("message", matched)
		await Promise.all([first, second])
		expect(workers.instances).toHaveLength(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("expires queued work without opening an artifact or spawning a worker", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const release = deferred<void>()
		const first = withCommandOutputSearch("line", undefined, () => release.promise)
		const second = withCommandOutputSearch("line", undefined, () => release.promise)
		const operation = vi.fn(() => Promise.resolve())
		const controller = new AbortController()
		const queued = withCommandOutputSearch("line", controller.signal, operation)
		const expired = expect(queued).rejects.toThrow("commandOutputSearch.busy")

		await vi.advanceTimersByTimeAsync(5_000)
		await expired
		expect(operation).not.toHaveBeenCalled()
		expect(workers.instances).toHaveLength(2)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		release.resolve()
		await Promise.all([first, second])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("waits for active cancellation termination before admitting a queued search", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const controller = new AbortController()
		const reason = new Error("active cancellation")
		const cancelled = withCommandOutputSearch("line", controller.signal, (matcher) => matcher.testBatch(batch))
		const cancelledAssertion = expect(cancelled).rejects.toBe(reason)
		const sibling = withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))
		const replacement = withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))
		const termination = deferred<number>()
		const entered = deferred<void>()
		const worker = workers.instances[0]
		worker.terminate.mockImplementation(() => {
			entered.resolve()
			return termination.promise
		})

		controller.abort(reason)
		await entered.promise
		expect(workers.instances).toHaveLength(2)
		expect(() => worker.emit("error", new Error("error drained during termination"))).not.toThrow()
		const replacementWorker = workerAt(2)
		worker.emit("exit", 1)
		termination.resolve(1)
		await cancelledAssertion
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		;(await replacementWorker).emit("message", matched)
		workers.instances[1].emit("message", matched)
		await Promise.all([sibling, replacement])
		expectReleased(worker)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("terminates immediately on cancellation while artifact cleanup is still pending", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const controller = new AbortController()
		const reason = new Error("cancel during matching")
		const cleanupEntered = deferred<void>()
		const cleanup = deferred<void>()
		const settled = vi.fn()
		const job = withCommandOutputSearch("line", controller.signal, async (matcher) => {
			try {
				return await matcher.testBatch(batch)
			} finally {
				cleanupEntered.resolve()
				await cleanup.promise
			}
		}).then(settled, (error: unknown) => settled(error))

		controller.abort(reason)
		await cleanupEntered.promise
		expect(workers.instances[0].terminate).toHaveBeenCalledOnce()
		expect(settled).not.toHaveBeenCalled()
		expect(() => workers.instances[0].emit("error", new Error("drained worker error"))).not.toThrow()
		cleanup.resolve()
		await job
		expect(settled).toHaveBeenCalledExactlyOnceWith(reason)
		expectReleased(workers.instances[0])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("bounds candidate count, decoded bytes and individual line size before posting", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		for (const lines of [
			["a".repeat(65_537)],
			Array<string>(65_537).fill(""),
			Array<string>(5).fill("a".repeat(65_536)),
		]) {
			await expect(
				withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch({ ...batch, lines })),
			).rejects.toThrow("commandOutputSearch.unavailable")
		}
		for (const worker of workers.instances) {
			expect(worker.postMessage).not.toHaveBeenCalled()
			expectReleased(worker)
		}
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["message", "error", "exit", "timeout", "invalid"])(
		"settles once and releases worker resources after %s",
		async (event) => {
			const { withCommandOutputSearch } = await import("../commandOutputSearch")
			const settled = vi.fn()
			const job = withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch)).then(
				(value) => settled({ value }),
				(error: Error) => settled({ error: error.message }),
			)
			const worker = workers.instances[0]
			if (event === "message") worker.emit("message", matched)
			else if (event === "error") worker.emit("error", new Error("worker failed"))
			else if (event === "exit") worker.emit("exit", 1)
			else if (event === "invalid") worker.emit("message", { processedLineCount: 1, matchedLineIndices: [1] })
			else await vi.advanceTimersByTimeAsync(1_000)
			await job
			worker.emit("exit", 0)

			expect(settled).toHaveBeenCalledExactlyOnceWith(
				event === "message"
					? { value: matched }
					: { error: `tools:commandOutputSearch.${event === "timeout" ? "timeout" : "unavailable"}` },
			)
			expectReleased(worker)
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it("propagates the total deadline to a pending artifact operation between batches", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		const entered = deferred<void>()
		let ownedSignal!: AbortSignal
		const job = withCommandOutputSearch("line", undefined, async (_matcher, signal) => {
			ownedSignal = signal
			entered.resolve()
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		})
		const expired = expect(job).rejects.toThrow("commandOutputSearch.timeout")
		await entered.promise
		await vi.advanceTimersByTimeAsync(30_000)
		await expired
		expect(ownedSignal.aborted).toBe(true)
		expectReleased(workers.instances[0])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reclaims its slot after synchronous worker startup or message failures", async () => {
		const { withCommandOutputSearch } = await import("../commandOutputSearch")
		workers.startError = new Error("private worker path")
		await expect(withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))).rejects.toThrow(
			"commandOutputSearch.unavailable",
		)
		workers.startError = undefined
		workers.onSpawn = (worker) => {
			worker.postMessage.mockImplementation(() => {
				throw new Error("private structured clone detail")
			})
		}
		await expect(withCommandOutputSearch("line", undefined, (matcher) => matcher.testBatch(batch))).rejects.toThrow(
			"commandOutputSearch.unavailable",
		)
		expectReleased(workers.instances[0])
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each([false, true])(
		"reports worker cleanup failure without masking a primary error: %s",
		async (primaryFails) => {
			const { withCommandOutputSearch } = await import("../commandOutputSearch")
			const primary = new Error("artifact read failed")
			workers.onSpawn = (worker) => {
				worker.terminate.mockRejectedValue(new Error("private worker detail"))
			}
			const job = withCommandOutputSearch("line", undefined, async () => {
				if (primaryFails) throw primary
				return "done"
			})
			await expect(job).rejects.toMatchObject({
				message: primaryFails
					? "artifact read failed; tools:commandOutputSearch.cleanup"
					: "tools:commandOutputSearch.cleanup",
				...(primaryFails ? { cause: primary, errors: [primary, expect.any(Error)] } : {}),
			})
			expectReleased(workers.instances[0])
			expect(vi.getTimerCount()).toBe(0)
		},
	)
})
