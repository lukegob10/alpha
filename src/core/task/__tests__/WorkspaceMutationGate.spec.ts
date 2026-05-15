import { describe, expect, it } from "vitest"

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
})
