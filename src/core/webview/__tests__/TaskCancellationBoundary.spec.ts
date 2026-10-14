import { describe, expect, it } from "vitest"

import { awaitTaskCancellationBoundary, hasTaskCancellationBoundary } from "../TaskCancellationBoundary"

describe("TaskCancellationBoundary", () => {
	it("waits for the runtime join before persistence completion", async () => {
		const order: string[] = []
		let resolveJoin!: () => void
		let resolvePersistence!: () => void
		const join = new Promise<void>((resolve) => {
			resolveJoin = resolve
		})
		const persistence = new Promise<void>((resolve) => {
			resolvePersistence = resolve
		})

		const task = {
			lifecycleRuntime: {
				join: async () => {
					order.push("join-start")
					await join
					order.push("join-complete")
				},
				waitForPersistence: async () => {
					order.push("persistence-start")
					await persistence
					order.push("persistence-complete")
				},
			},
		}

		expect(hasTaskCancellationBoundary(task)).toBe(true)
		const boundary = awaitTaskCancellationBoundary(task)
		await Promise.resolve()
		expect(order).toEqual(["join-start"])

		resolveJoin()
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(order).toEqual(["join-start", "join-complete", "persistence-start"])
		expect(order).not.toContain("persistence-complete")

		resolvePersistence()
		await boundary
		expect(order).toEqual(["join-start", "join-complete", "persistence-start", "persistence-complete"])
	})

	it("awaits direct cancellation receipts and reports legacy absence", async () => {
		let resolveReceipt!: () => void
		const receipt = new Promise<void>((resolve) => {
			resolveReceipt = resolve
		})
		const runtimeBackedTask = { cancellationReceipt: receipt }

		expect(hasTaskCancellationBoundary(runtimeBackedTask)).toBe(true)
		const pending = awaitTaskCancellationBoundary(runtimeBackedTask)
		let settled = false
		void pending.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)

		resolveReceipt()
		await pending
		expect(settled).toBe(true)
		expect(await awaitTaskCancellationBoundary({ abortTask: async () => undefined })).toMatchObject({
			lifecycleRuntimeAvailable: false,
		})
	})

	it("does not treat a persistence-only legacy task as a lifecycle join boundary", async () => {
		const flushApiConversationHistoryPersistence = vi.fn(async () => undefined)
		const task = { flushApiConversationHistoryPersistence }

		expect(hasTaskCancellationBoundary(task)).toBe(false)
		expect(await awaitTaskCancellationBoundary(task)).toMatchObject({ lifecycleRuntimeAvailable: false })
		expect(flushApiConversationHistoryPersistence).not.toHaveBeenCalled()
	})
})
