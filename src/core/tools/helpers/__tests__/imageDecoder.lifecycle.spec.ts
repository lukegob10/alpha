import type { Mock } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface FakeWorker {
	emit(event: string, ...args: unknown[]): boolean
	listenerCount(event: string): number
	postMessage: Mock<(value: unknown) => void>
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
			postMessage = vi.fn<(value: unknown) => void>()
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

describe("image decoder worker lifecycle", () => {
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

	it("caps active and pending jobs and rejects overflow without spawning", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		const jobs = Array.from({ length: 10 }, () => isImageContentDecodable(Uint8Array.of(1), ".png"))
		expect(workers.instances).toHaveLength(2)
		await expect(isImageContentDecodable(Uint8Array.of(1), ".png")).rejects.toThrow("imageDecodeBusy")
		expect(workers.instances).toHaveLength(2)

		for (let index = 0; index < jobs.length; index++) {
			const worker = await workerAt(index)
			worker.emit("message", { kind: "original", sourceExtension: ".png" })
			await expect(jobs[index]).resolves.toBe(true)
			expect(worker.terminate).toHaveBeenCalledOnce()
		}
		expect(workers.instances).toHaveLength(10)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("removes a queued cancelled job without starting a worker", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		const first = isImageContentDecodable(Uint8Array.of(1), ".png")
		const second = isImageContentDecodable(Uint8Array.of(1), ".png")
		const controller = new AbortController()
		const queued = isImageContentDecodable(Uint8Array.of(1), ".png", controller.signal)
		const cancelled = expect(queued).rejects.toThrow("queued cancelled")
		controller.abort(new Error("queued cancelled"))
		await cancelled
		workers.instances[0].emit("message", { kind: "original", sourceExtension: ".png" })
		workers.instances[1].emit("message", { kind: "original", sourceExtension: ".png" })
		await Promise.all([first, second])

		expect(workers.instances).toHaveLength(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("waits for active cancellation termination before admitting its queued replacement", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		const controller = new AbortController()
		const cancelled = isImageContentDecodable(Uint8Array.of(1), ".png", controller.signal)
		const cancelledAssertion = expect(cancelled).rejects.toThrow("active cancelled")
		const sibling = isImageContentDecodable(Uint8Array.of(1), ".png")
		const replacement = isImageContentDecodable(Uint8Array.of(1), ".png")
		const termination = deferred<number>()
		const entered = deferred<void>()
		workers.instances[0].terminate.mockImplementation(() => {
			entered.resolve()
			return termination.promise
		})

		controller.abort(new Error("active cancelled"))
		await entered.promise
		expect(workers.instances).toHaveLength(2)
		const replacementWorker = workerAt(2)
		termination.resolve(0)
		await cancelledAssertion
		;(await replacementWorker).emit("message", { kind: "original", sourceExtension: ".png" })
		workers.instances[1].emit("message", { kind: "original", sourceExtension: ".png" })
		await Promise.all([sibling, replacement])
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["message", "error", "exit", "timeout"])("settles once and releases resources after %s", async (event) => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		const settled = vi.fn()
		const job = isImageContentDecodable(Uint8Array.of(1), ".png").then(
			(value) => settled({ value }),
			(error: Error) => settled({ error: error.message }),
		)
		const worker = workers.instances[0]
		if (event === "message") worker.emit("message", { kind: "original", sourceExtension: ".png" })
		else if (event === "error") worker.emit("error", new Error("decoder failed"))
		else if (event === "exit") worker.emit("exit", 1)
		else await vi.advanceTimersByTimeAsync(5_000)
		worker.emit("exit", 0)
		await job

		expect(settled).toHaveBeenCalledOnce()
		expect(worker.terminate).toHaveBeenCalledOnce()
		for (const name of ["message", "error", "exit"]) expect(worker.listenerCount(name)).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
		expect(settled).toHaveBeenCalledWith(
			event === "message" ? { value: true } : { error: expect.stringContaining("imageDecode") },
		)
	})

	it.each(["message", "cancel", "timeout", "error"])(
		"handles queued errors while termination after %s is pending",
		async (event) => {
			const { isImageContentDecodable } = await import("../imageDecoder")
			const controller = new AbortController()
			const settled = vi.fn()
			const job = isImageContentDecodable(Uint8Array.of(1), ".png", controller.signal).then(
				(value) => settled({ value }),
				(error: Error) => settled({ error: error.message }),
			)
			const worker = workers.instances[0]
			const termination = deferred<number>()
			const entered = deferred<void>()
			worker.terminate.mockImplementation(() => {
				entered.resolve()
				return termination.promise
			})

			if (event === "message") worker.emit("message", { kind: "original", sourceExtension: ".png" })
			else if (event === "cancel") controller.abort(new Error("active cancelled"))
			else if (event === "error") worker.emit("error", new Error("initial decoder failure"))
			else await vi.advanceTimersByTimeAsync(5_000)
			await entered.promise

			try {
				expect(settled).not.toHaveBeenCalled()
				expect(() => worker.emit("error", new Error("queued error during termination"))).not.toThrow()
				expect(() => worker.emit("error", new Error("another queued error before exit"))).not.toThrow()
				expect(worker.terminate).toHaveBeenCalledOnce()
				expect(settled).not.toHaveBeenCalled()
			} finally {
				// Node's exit is final and fulfills terminate(); no events are emitted after this point.
				worker.emit("exit", 1)
				termination.resolve(1)
				await job
			}

			const expected =
				event === "message"
					? { value: true }
					: { error: event === "cancel" ? "active cancelled" : expect.stringContaining("imageDecode") }
			expect(settled).toHaveBeenCalledExactlyOnceWith(expected)
			expect(worker.terminate).toHaveBeenCalledOnce()
			for (const name of ["message", "error", "exit"]) expect(worker.listenerCount(name)).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it("cleans up when posting the decode request throws", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		workers.onSpawn = (worker) => {
			worker.postMessage.mockImplementation(() => {
				throw new Error("private structured clone detail")
			})
		}

		await expect(isImageContentDecodable(Uint8Array.of(1), ".png")).rejects.toThrow("imageDecodeUnavailable")
		expect(workers.instances[0].terminate).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("localizes synchronous worker construction failure without leaking a slot", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		workers.startError = new Error("private worker path detail")

		await expect(isImageContentDecodable(Uint8Array.of(1), ".png")).rejects.toThrow("imageDecodeUnavailable")
		workers.startError = undefined
		const next = isImageContentDecodable(Uint8Array.of(1), ".png")
		workers.instances[0].emit("message", { kind: "original", sourceExtension: ".png" })
		await expect(next).resolves.toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})
})
