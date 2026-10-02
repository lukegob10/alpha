import { describe, expect, it, vi } from "vitest"

import { WorkspaceMutationCancelledError, WorkspaceMutationGate } from "../WorkspaceMutationGate"

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe("WorkspaceMutationGate", () => {
	it("releases ownership when an admitted callback throws synchronously", async () => {
		const gate = new WorkspaceMutationGate()
		const failed = gate.run("task-a", "failed admission", () => {
			throw new Error("synchronous mutation failure")
		})
		await expect(failed).rejects.toThrow("synchronous mutation failure")
		await Promise.resolve()
		const recovery = gate.runIfIdle("task-b", "recover", async () => "recovered")
		expect(recovery).toBeDefined()
		await expect(recovery).resolves.toBe("recovered")
	})

	it("cancels a queued worker promptly without releasing the active owner", async () => {
		const gate = new WorkspaceMutationGate()
		const firstRelease = deferred()
		const cancellation = new AbortController()
		const cancelledOperation = vi.fn(async () => undefined)
		const nextOperation = vi.fn(async () => "next")
		const first = gate.run("owner", "active edit", () => firstRelease.promise)
		let settled = false
		let failure: unknown
		const cancelled = gate
			.run("worker", "queued edit", cancelledOperation, () => cancellation.signal.aborted, cancellation.signal)
			.catch((error) => {
				settled = true
				failure = error
			})
		const next = gate.run("next-worker", "next edit", nextOperation)
		cancellation.abort()
		await Promise.resolve()
		try {
			expect(settled).toBe(true)
			expect(failure).toBeInstanceOf(WorkspaceMutationCancelledError)
			expect(cancelledOperation).not.toHaveBeenCalled()
			expect(nextOperation).not.toHaveBeenCalled()
			expect(gate.runIfIdle("parent", "enter Plan", async () => undefined)).toBeUndefined()
		} finally {
			firstRelease.resolve()
			await Promise.allSettled([first, cancelled, next])
		}
		expect(nextOperation).toHaveBeenCalledOnce()
	})

	it("rejects an already-cancelled admission without retaining a listener or running its effect", async () => {
		const gate = new WorkspaceMutationGate()
		const cancellation = new AbortController()
		cancellation.abort()
		const addListener = vi.spyOn(cancellation.signal, "addEventListener")
		const operation = vi.fn(async () => "unused")

		await expect(
			gate.run("worker", "cancelled edit", operation, undefined, cancellation.signal),
		).rejects.toBeInstanceOf(WorkspaceMutationCancelledError)
		expect(operation).not.toHaveBeenCalled()
		expect(addListener).not.toHaveBeenCalled()
		await expect(gate.runIfIdle("parent", "enter Plan", async () => "entered")).resolves.toBe("entered")
	})

	it("detaches queued cancellation listeners after admission and preserves the active outcome", async () => {
		const gate = new WorkspaceMutationGate()
		const cancellation = new AbortController()
		const addListener = vi.spyOn(cancellation.signal, "addEventListener")
		const removeListener = vi.spyOn(cancellation.signal, "removeEventListener")
		const release = deferred<string>()
		const operation = vi.fn(() => release.promise)
		const admitted = gate.run("owner", "active edit", operation, undefined, cancellation.signal)
		const following = vi.fn(async () => "following")
		const next = gate.run("worker", "next edit", following)

		await Promise.resolve()
		expect(operation).toHaveBeenCalledOnce()
		expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1])
		cancellation.abort()
		await Promise.resolve()
		expect(following).not.toHaveBeenCalled()
		expect(gate.runIfIdle("parent", "enter Plan", async () => undefined)).toBeUndefined()
		release.resolve("committed")
		await expect(admitted).resolves.toBe("committed")
		await expect(next).resolves.toBe("following")
	})

	it("detaches a removed request's cancellation listener", async () => {
		const gate = new WorkspaceMutationGate()
		const release = deferred()
		const active = gate.run("owner", "active edit", () => release.promise)
		const cancellation = new AbortController()
		const addListener = vi.spyOn(cancellation.signal, "addEventListener")
		const removeListener = vi.spyOn(cancellation.signal, "removeEventListener")
		const cancelled = gate.run("worker", "queued edit", async () => undefined, undefined, cancellation.signal)
		const rejected = expect(cancelled).rejects.toBeInstanceOf(WorkspaceMutationCancelledError)

		cancellation.abort()
		await rejected
		expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1])
		release.resolve()
		await active
	})

	it("runs workspace mutations serially in FIFO order", async () => {
		const gate = new WorkspaceMutationGate()
		const firstRelease = deferred()
		const order: string[] = []

		const first = gate.run("task-a", "first", async () => {
			order.push("first:start")
			await firstRelease.promise
			order.push("first:end")
		})

		const second = gate.run("task-b", "second", async () => {
			order.push("second:start")
			order.push("second:end")
		})

		await Promise.resolve()
		expect(order).toEqual(["first:start"])

		firstRelease.resolve()
		await Promise.all([first, second])

		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
	})

	it("rejects a queued mutation that is cancelled before acquiring the lock", async () => {
		const gate = new WorkspaceMutationGate()
		const firstRelease = deferred()
		let cancelled = false

		const first = gate.run("task-a", "first", async () => {
			await firstRelease.promise
		})

		const second = gate.run(
			"task-b",
			"second",
			async () => {},
			() => cancelled,
		)
		cancelled = true
		firstRelease.resolve()

		await first
		await expect(second).rejects.toBeInstanceOf(WorkspaceMutationCancelledError)
	})

	it("admits a fail-closed transition only when no mutation is active or queued", async () => {
		const gate = new WorkspaceMutationGate()
		const mutationRelease = deferred()
		const mutation = gate.run("task-a", "edit", () => mutationRelease.promise)
		await Promise.resolve()

		expect(gate.runIfIdle("task-a", "enter Plan", async () => "entered")).toBeUndefined()

		mutationRelease.resolve()
		await mutation
		await Promise.resolve()
		await expect(gate.runIfIdle("task-a", "enter Plan", async () => "entered")).resolves.toBe("entered")
	})

	it("holds an admitted transition against a racing Worker launch", async () => {
		const gate = new WorkspaceMutationGate()
		const transitionRelease = deferred()
		const order: string[] = []
		const transition = gate.runIfIdle("parent", "enter Plan", async () => {
			order.push("plan:start")
			await transitionRelease.promise
			order.push("plan:end")
		})
		const worker = gate.run("parent", "Worker launch admission", async () => {
			order.push("worker:start")
		})

		await Promise.resolve()
		expect(order).toEqual(["plan:start"])
		transitionRelease.resolve()
		await Promise.all([transition, worker])
		expect(order).toEqual(["plan:start", "plan:end", "worker:start"])
	})
})
