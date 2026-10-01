import { describe, expect, it } from "vitest"

import type { QueuedMessage } from "@alpha-code/types"
import { MAX_QUEUED_MESSAGE_BYTES, MessageQueueService, type MessageQueuePersistence } from "../MessageQueueService"

const memoryPersistence = (initial: QueuedMessage[] = []) => {
	let stored = structuredClone(initial)
	const persistence: MessageQueuePersistence = {
		load: async () => structuredClone(stored),
		save: async (messages) => {
			stored = structuredClone([...messages])
		},
	}
	return { persistence, read: () => stored }
}

describe("MessageQueueService", () => {
	it("keeps selected input visible until its containing transcript acknowledges it", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		const selected = (await queue.addMessageDurably("arbitrary selected input"))!
		const waiting = (await queue.addMessageDurably("arbitrary waiting input"))!
		queue.claimMessage(selected.id)
		await queue.flush()
		expect(queue.messages).toEqual([waiting])
		expect(queue.visibleMessages).toEqual([{ ...selected, deliveryState: "delivering" }, waiting])
		const published = vi.fn()
		queue.on("stateChanged", published)
		queue.acknowledgeMessages([selected.id])
		await queue.flush()
		expect(queue.visibleMessages).toEqual([waiting])
		expect(published).toHaveBeenCalledOnce()
		expect(store.read()).toEqual([waiting])
	})

	it("restores ordinary queue controls when a selected input is released", async () => {
		const queue = new MessageQueueService()
		const selected = queue.addMessage("input with no special wording")!
		queue.claimMessage(selected.id)
		expect(queue.visibleMessages).toEqual([{ ...selected, deliveryState: "delivering" }])
		queue.releaseMessage(selected.id)
		expect(queue.visibleMessages).toEqual([selected])
		expect(queue.getMessage(selected.id)).toBe(selected)
	})

	it("keeps selected guidance outstanding until its transcript receipt is acknowledged", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		const message = await queue.addMessageDurably("finish this guidance first")
		queue.claimMessage(message!.id)
		await queue.flush()
		expect(queue.messages).toEqual([])
		expect(queue.isEmpty()).toBe(true)
		expect(queue.hasUnconsumedInput()).toBe(true)
		queue.acknowledgeMessages([message!.id])
		await queue.flush()
		expect(queue.isEmpty()).toBe(true)
		expect(queue.hasUnconsumedInput()).toBe(false)
	})

	it("restores claimed input after a crash until its transcript receipt is acknowledged", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!
		await queue.flush()
		queue.dequeueMessage()
		await queue.flush()
		expect(queue.getClaimedMessageIds()).toEqual([first.id])
		expect(store.read()).toEqual([first, second])
		queue.dispose()

		const reloaded = new MessageQueueService(store.persistence)
		await reloaded.ready
		expect(reloaded.messages).toEqual([first, second])
		expect(reloaded.getClaimedMessageIds()).toEqual([])
		reloaded.dequeueMessage()
		reloaded.acknowledgeMessages([first.id])
		await reloaded.flush()
		expect(store.read()).toEqual([second])
	})

	it("merges admissions made before persisted input finishes loading", async () => {
		const old = { id: "old", timestamp: 1, text: "old" }
		let finishLoad!: (messages: QueuedMessage[]) => void
		const loaded = new Promise<QueuedMessage[]>((resolve) => {
			finishLoad = resolve
		})
		const save = vi.fn(async () => undefined)
		const queue = new MessageQueueService({ load: () => loaded, save })
		const admitted = queue.addMessage("new")!
		finishLoad([old])
		await queue.ready
		await queue.flush()
		expect(queue.messages).toEqual([old, admitted])
		expect(save).toHaveBeenLastCalledWith([old, admitted])
	})

	it("persists order edits while keeping claimed input before the pending queue", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!
		const third = queue.addMessage("third")!
		queue.claimMessage(second.id)
		queue.moveMessage(third.id, 0)
		await queue.flush()
		expect(store.read()).toEqual([second, third, first])
		queue.clear()
		await queue.flush()
		expect(store.read()).toEqual([second])
	})

	it("retains failed admissions for a durable retry and does not clear storage on dispose", async () => {
		const store = memoryPersistence()
		let rejectSave!: (error: Error) => void
		let enteredSave!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredSave = resolve
		})
		const saveFailure = new Promise<void>((_resolve, reject) => {
			rejectSave = reject
		})
		const originalSave = store.persistence.save
		store.persistence.save = vi
			.fn()
			.mockImplementationOnce(() => {
				enteredSave()
				return saveFailure
			})
			.mockImplementation(originalSave)
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const message = queue.addMessage("accepted")!
		const failed = expect(queue.flush()).rejects.toThrow("disk full")
		await entered
		rejectSave(new Error("disk full"))
		await failed
		expect(queue.messages).toEqual([message])
		expect(store.read()).toEqual([])
		await queue.flush()
		queue.dispose()
		await queue.flush()
		expect(store.read()).toEqual([message])
	})

	it("bounds accepted pending and claimed entries without losing existing input", () => {
		const queue = new MessageQueueService()
		for (let index = 0; index < 100; index++) queue.addMessage(`message ${index}`)
		const claimed = queue.dequeueMessage()!
		expect(() => queue.addMessage("overflow")).toThrow("queue is full")
		expect(queue.messages).toHaveLength(99)
		queue.acknowledgeMessages([claimed.id])
		expect(queue.addMessage("replacement")).toBeDefined()
	})

	it("rejects oversized edits atomically, including encoded image payloads", () => {
		const queue = new MessageQueueService()
		const accepted = queue.addMessage("keep")!
		expect(() => queue.updateMessage(accepted.id, "replace", ["x".repeat(MAX_QUEUED_MESSAGE_BYTES)])).toThrow(
			"32 MiB",
		)
		expect(queue.getMessage(accepted.id)).toEqual(accepted)
		expect(accepted.text).toBe("keep")
		expect(accepted.images).toBeUndefined()
	})

	it("coalesces rapid edits while a persistence write is pending", async () => {
		let release!: () => void
		let enteredSave!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredSave = resolve
		})
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const save = vi
			.fn()
			.mockImplementationOnce(async () => {
				enteredSave()
				await held
			})
			.mockResolvedValue(undefined)
		const queue = new MessageQueueService({ load: async () => [], save })
		await queue.ready
		const message = queue.addMessage("original")!
		await entered
		for (let index = 0; index < 100; index++) queue.updateMessage(message.id, `edit ${index}`)
		expect(save).toHaveBeenCalledOnce()
		release()
		await queue.flush()
		expect(save).toHaveBeenCalledTimes(2)
		expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ text: "edit 99" })])
	})

	it("does not publish a state change when an empty queue is dequeued", () => {
		const queue = new MessageQueueService()
		const onStateChanged = vi.fn()
		queue.on("stateChanged", onStateChanged)

		expect(queue.dequeueMessage()).toBeUndefined()
		expect(onStateChanged).not.toHaveBeenCalled()
	})

	it("publishes exactly one state change when a message is dequeued", () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("first")!
		const onStateChanged = vi.fn()
		queue.on("stateChanged", onStateChanged)

		expect(queue.dequeueMessage()).toBe(message)
		expect(onStateChanged).toHaveBeenCalledOnce()
	})

	it("reads a queued message without removing or reordering it", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!

		expect(queue.getMessage(first.id)).toBe(first)
		expect(queue.messages).toEqual([first, second])
	})

	it("releases a rejected steering claim at its original position", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!
		const third = queue.addMessage("third")!
		queue.claimMessage(second.id)
		expect(queue.releaseMessage(second.id, 1)).toBe(true)
		expect(queue.releaseMessage(second.id, 1)).toBe(false)
		await queue.flush()
		expect(queue.messages).toEqual([first, second, third])
		expect(store.read()).toEqual([first, second, third])
	})

	it("does not expose or select an admission before storage accepts it", async () => {
		let release!: () => void
		let entered!: () => void
		const saving = new Promise<void>((resolve) => {
			entered = resolve
		})
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const store = memoryPersistence()
		const save = store.persistence.save
		store.persistence.save = vi.fn(async (messages) => {
			entered()
			await held
			await save(messages)
		})
		const queue = new MessageQueueService(store.persistence)
		const admission = queue.addMessageDurably("wait for disk", [], "admission")
		await saving
		expect(queue.messages).toEqual([])
		expect(queue.dequeueMessage()).toBeUndefined()
		expect(queue.claimMessage("admission")).toBeUndefined()
		expect(queue.isEmpty()).toBe(false)
		release()
		const message = await admission
		expect(queue.messages).toEqual([message])
		expect(store.read()).toEqual([message])
	})

	it("rolls a rejected admission back without leaving consumable input", async () => {
		const store = memoryPersistence()
		store.persistence.save = vi
			.fn()
			.mockRejectedValueOnce(new Error("disk full"))
			.mockImplementation(store.persistence.save)
		const queue = new MessageQueueService(store.persistence)
		await expect(queue.addMessageDurably("not accepted", [], "rejected")).rejects.toThrow("disk full")
		expect(queue.messages).toEqual([])
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(store.read()).toEqual([])
		await queue.addMessageDurably("not accepted", [], "rejected")
		expect(queue.messages).toHaveLength(1)
	})

	it("restores the previous queued text and images after an edit write fails", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		const original = await queue.addMessageDurably("original", undefined, "edit")
		store.persistence.save = vi
			.fn()
			.mockRejectedValueOnce(new Error("edit failed"))
			.mockImplementation(store.persistence.save)
		await expect(queue.updateMessageDurably("edit", "changed", ["new-image"])).rejects.toThrow("edit failed")
		expect(queue.messages).toEqual([original])
		expect(queue.getMessage("edit")).toMatchObject({ text: "original" })
		expect(queue.getMessage("edit")?.images).toBeUndefined()
		expect(store.read()[0]?.text).toBe("original")
	})

	it("serializes edits of the same identity and retries after the preceding edit rolls back", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		const original = (await queue.addMessageDurably("original", undefined, "edit"))!
		let rejectSave!: (error: Error) => void
		let enteredSave!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredSave = resolve
		})
		const held = new Promise<void>((_resolve, reject) => {
			rejectSave = reject
		})
		store.persistence.save = vi
			.fn()
			.mockImplementationOnce(() => {
				enteredSave()
				return held
			})
			.mockImplementation(store.persistence.save)
		const first = expect(queue.updateMessageDurably("edit", "first edit")).rejects.toThrow("first edit failed")
		const second = queue.updateMessageDurably("edit", "second edit").then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		)
		await entered
		const pendingText = original.text
		rejectSave(new Error("first edit failed"))
		await first
		const secondResult = await second
		expect(pendingText).toBe("first edit")
		expect(secondResult).toEqual({ result: true })
		expect(queue.getMessage("edit")?.text).toBe("second edit")
		expect(store.read()[0]?.text).toBe("second edit")
	})

	it("retries a concurrent admission identity after the preceding admission rolls back", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		let rejectSave!: (error: Error) => void
		let enteredSave!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredSave = resolve
		})
		const held = new Promise<void>((_resolve, reject) => {
			rejectSave = reject
		})
		store.persistence.save = vi
			.fn()
			.mockImplementationOnce(() => {
				enteredSave()
				return held
			})
			.mockImplementation(store.persistence.save)
		const first = expect(queue.addMessageDurably("arbitrary input", [], "retry")).rejects.toThrow(
			"admission failed",
		)
		const retry = queue.addMessageDurably("arbitrary input", [], "retry").then(
			(message) => ({ message }),
			(error: unknown) => ({ error }),
		)
		await entered
		rejectSave(new Error("admission failed"))
		await first
		const retried = await retry
		expect(retried).toEqual({ message: expect.objectContaining({ id: "retry", text: "arbitrary input" }) })
		expect(queue.messages).toHaveLength(1)
		expect(store.read()).toEqual(queue.messages)
	})

	it("does not expose an identity between two already requested durable edits", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.addMessageDurably("original", undefined, "edit")
		let releaseSave!: () => void
		let enteredSave!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredSave = resolve
		})
		const held = new Promise<void>((resolve) => {
			releaseSave = resolve
		})
		const save = store.persistence.save
		store.persistence.save = vi
			.fn()
			.mockImplementationOnce(async (messages) => {
				enteredSave()
				await held
				await save(messages)
			})
			.mockImplementation(save)
		const consumed: string[] = []
		queue.on("stateChanged", () => {
			const message = queue.claimMessage("edit")
			if (message) consumed.push(message.text)
		})
		const first = queue.updateMessageDurably("edit", "first edit")
		const second = queue.updateMessageDurably("edit", "second edit")
		await entered
		releaseSave()
		expect(await first).toBe(true)
		expect(await second).toBe(true)
		expect(consumed).toEqual(["second edit"])
		await queue.flush()
		expect(store.read()[0]?.text).toBe("second edit")
	})

	it("reactivates a retained lifecycle without dropping its prior accepted input", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const earlier = queue.addMessage("earlier")!
		await queue.flush()
		queue.dispose()
		expect(() => queue.addMessage("later")).toThrow("disposed")
		queue.activate()
		const later = queue.addMessage("later")!
		await queue.flush()
		expect(store.read()).toEqual([earlier, later])
	})

	it("makes admission retries with the same identity idempotent through reload and selection", async () => {
		const store = memoryPersistence()
		const queue = new MessageQueueService(store.persistence)
		await queue.ready
		const message = queue.addMessage("once", [], "request-1")!
		expect(queue.addMessage("once", undefined, "request-1")).toBe(message)
		queue.claimMessage(message.id)
		expect(queue.addMessage("once", [], "request-1")).toBe(message)
		await queue.flush()
		const restored = new MessageQueueService(store.persistence)
		await restored.ready
		restored.addMessage("once", [], "request-1")
		expect(restored.messages).toHaveLength(1)
		expect(() => restored.addMessage("different", [], "request-1")).toThrow("different input")
	})

	it("moves a queued message while preserving message objects", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!
		const third = queue.addMessage("third")!

		expect(queue.moveMessage(third.id, 0)).toBe(true)

		expect(queue.messages).toEqual([third, first, second])
	})

	it("returns false for invalid ids without changing order", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!

		expect(queue.moveMessage("missing", 0)).toBe(false)

		expect(queue.messages).toEqual([first, second])
	})

	it("clamps reorder indices to the front and end", () => {
		const queue = new MessageQueueService()
		const first = queue.addMessage("first")!
		const second = queue.addMessage("second")!
		const third = queue.addMessage("third")!

		expect(queue.moveMessage(second.id, -10)).toBe(true)
		expect(queue.messages).toEqual([second, first, third])

		expect(queue.moveMessage(second.id, 999)).toBe(true)
		expect(queue.messages).toEqual([first, third, second])
	})
})
