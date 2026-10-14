import { EventEmitter, getEventListeners } from "events"
import * as path from "path"

import { AgentControlLockWaiter } from "../AgentControlLockWaiter"

const { watch } = vi.hoisted(() => ({ watch: vi.fn() }))

vi.mock("fs", async () => ({
	...(await vi.importActual<typeof import("fs")>("fs")),
	watch,
}))

class TestWatcher extends EventEmitter {
	close = vi.fn(() => this.emit("close"))
}

describe("AgentControlLockWaiter", () => {
	const lockName = "agent_control.json.transaction.lock"
	const lockPath = path.join("storage", lockName)
	let watcher: TestWatcher
	let waiters: AgentControlLockWaiter[]

	const createWaiter = () => {
		const waiter = new AgentControlLockWaiter(lockPath)
		waiters.push(waiter)
		return waiter
	}

	beforeEach(() => {
		vi.useFakeTimers()
		watcher = new TestWatcher()
		waiters = []
		watch.mockReset().mockImplementation((_directory, _options, listener) => {
			watcher.on("change", listener)
			return watcher
		})
	})

	afterEach(() => {
		for (const waiter of waiters) waiter.close()
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it.each([lockName, null])("wakes for the canonical lock or an unknown filename (%s)", async (filename) => {
		const waiter = createWaiter()
		const controller = new AbortController()
		const waiting = waiter.wait(waiter.checkpoint(), 400, controller.signal)

		expect(watch).toHaveBeenCalledWith(path.dirname(lockPath), { persistent: false }, expect.any(Function))
		expect(vi.getTimerCount()).toBe(1)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
		watcher.emit("change", "rename", filename)

		await expect(waiting).resolves.toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it("ignores unrelated sibling and token-suffixed filenames", async () => {
		const waiter = createWaiter()
		const checkpoint = waiter.checkpoint()
		let resolved = false
		const waiting = waiter.wait(checkpoint, 400).then(() => {
			resolved = true
		})
		watcher.emit("change", "rename", "agent_control.json")
		watcher.emit("change", "rename", `${lockName}.release.other-owner`)
		await vi.advanceTimersByTimeAsync(399)

		expect(resolved).toBe(false)
		expect(waiter.checkpoint()).toBe(checkpoint)
		await vi.advanceTimersByTimeAsync(1)
		await waiting
		expect(resolved).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("retains notifications during a probe without queuing duplicate future wakes", async () => {
		const waiter = createWaiter()
		const checkpoint = waiter.checkpoint()
		watcher.emit("change", "rename", lockName)
		watcher.emit("change", "rename", lockName)

		await expect(waiter.wait(checkpoint, 400)).resolves.toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		let resolved = false
		const next = waiter.wait(waiter.checkpoint(), 400).then(() => {
			resolved = true
		})
		await vi.advanceTimersByTimeAsync(399)
		expect(resolved).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await next
	})

	it.each([false, true])("falls back to its bounded timer when watch is unsupported=%s", async (unsupported) => {
		if (unsupported)
			watch.mockImplementation(() => {
				throw new Error("Watch unavailable")
			})
		const waiter = createWaiter()
		const controller = new AbortController()
		let resolved = false
		const waiting = waiter.wait(waiter.checkpoint(), 25, controller.signal).then(() => {
			resolved = true
		})

		await vi.advanceTimersByTimeAsync(24)
		expect(resolved).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await waiting
		expect(resolved).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it.each(["error", "close"])("continues with bounded polling after an asynchronous watcher %s", async (event) => {
		const waiter = createWaiter()
		const waiting = waiter.wait(waiter.checkpoint(), 400)
		watcher.emit(event, ...(event === "error" ? [new Error("Watch stopped")] : []))
		await expect(waiting).resolves.toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)

		const fallback = waiter.wait(waiter.checkpoint(), 400)
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(400)
		await expect(fallback).resolves.toBeUndefined()
		waiter.close()
		expect(watch).toHaveBeenCalledOnce()
		expect(watcher.close).toHaveBeenCalledTimes(event === "error" ? 1 : 0)
	})

	it("removes the pending timer and abort listener when cancelled", async () => {
		const waiter = createWaiter()
		const controller = new AbortController()
		const waiting = waiter.wait(waiter.checkpoint(), 400, controller.signal)
		const rejected = expect(waiting).rejects.toMatchObject({ code: "ABORT_ERR" })
		controller.abort(new Error("private cancellation detail"))
		await rejected
		expect(vi.getTimerCount()).toBe(0)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)

		// Acquisition owns the watcher and disposes it in its finally block.
		waiter.close()
		expect(watcher.close).toHaveBeenCalledOnce()
	})

	it("honors cancellation before consuming a retained notification", async () => {
		const waiter = createWaiter()
		const checkpoint = waiter.checkpoint()
		watcher.emit("change", "rename", lockName)
		const controller = new AbortController()
		controller.abort()

		await expect(waiter.wait(checkpoint, 400, controller.signal)).rejects.toMatchObject({ code: "ABORT_ERR" })
		expect(vi.getTimerCount()).toBe(0)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it("disposes a pending wait and closes the watcher idempotently", async () => {
		const waiter = createWaiter()
		const controller = new AbortController()
		const waiting = waiter.wait(waiter.checkpoint(), 400, controller.signal)
		waiter.close()
		waiter.close()

		await expect(waiting).resolves.toBeUndefined()
		expect(watcher.close).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})
})
