import { describe, expect, it } from "vitest"

import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService", () => {
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
