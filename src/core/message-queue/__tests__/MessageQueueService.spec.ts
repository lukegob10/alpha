import { describe, expect, it } from "vitest"

import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService", () => {
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
