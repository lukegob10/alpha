import { describe, expect, it, vi } from "vitest"

import type { QueuedMessage } from "@alpha-code/types"

import { MessageQueueService } from "../../core/message-queue/MessageQueueService"
import { API } from "../api"

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

async function fixture() {
	let stored: QueuedMessage[] = []
	const save = vi.fn(async (messages: readonly QueuedMessage[]) => {
		stored = structuredClone([...messages])
	})
	const queue = new MessageQueueService({ load: async () => [], save })
	const first = (await queue.addMessageDurably("First instruction", [], "first"))!
	const second = (await queue.addMessageDurably("Second instruction", [], "second"))!
	const api = Object.assign(Object.create(API.prototype), {
		sidebarProvider: { getCurrentTask: () => ({ messageQueueService: queue }) },
	}) as API
	return { queue, api, first, second, save, stored: () => stored }
}

describe("queued input deletion durability", () => {
	it("restores the same queued input and order when deletion cannot be saved", async () => {
		const { queue, api, first, second, save, stored } = await fixture()
		save.mockRejectedValueOnce(new Error("delete snapshot failed"))

		await expect(api.deleteQueuedMessage(first.id)).rejects.toThrow("delete snapshot failed")

		expect(queue.messages).toEqual([first, second])
		expect(stored()).toEqual([first, second])
		expect(queue.dequeueMessage()).toBe(first)
		queue.dispose()
	})

	it("keeps later input behind an unresolved deletion receipt", async () => {
		const { queue, api, first, second, save, stored } = await fixture()
		const saving = barrier()
		const finish = barrier()
		const persist = save.getMockImplementation()!
		save.mockImplementationOnce(async (messages) => {
			saving.resolve()
			await finish.promise
			await persist(messages)
		})
		const deletion = api.deleteQueuedMessage(first.id)
		try {
			await saving.promise
			expect(queue.messages).toEqual([])
			expect(queue.visibleMessages).toEqual([second])
			expect(queue.dequeueMessage()).toBeUndefined()
			expect(queue.claimMessage(first.id)).toBeUndefined()
			expect(queue.getClaimedMessageIds()).toEqual([])
		} finally {
			finish.resolve()
			await deletion
		}
		expect(queue.messages).toEqual([second])
		expect(stored()).toEqual([second])
		expect(queue.dequeueMessage()).toBe(second)
		queue.dispose()
	})

	it("serializes deletion after an edit of the same input and does not revive it", async () => {
		const { queue, api, first, second, save, stored } = await fixture()
		const saving = barrier()
		const finish = barrier()
		const persist = save.getMockImplementation()!
		save.mockImplementationOnce(async (messages) => {
			saving.resolve()
			await finish.promise
			await persist(messages)
		})
		const edit = queue.updateMessageDurably(first.id, "Edited first instruction")
		await saving.promise
		const deletion = api.deleteQueuedMessage(first.id)
		finish.resolve()
		expect(await edit).toBe(true)
		await deletion
		expect(queue.visibleMessages).toEqual([second])
		expect(stored()).toEqual([second])
		queue.dispose()
	})

	it("preserves other admissions while a failed deletion rolls back", async () => {
		const { queue, api, first, second, save, stored } = await fixture()
		const saving = barrier()
		const finish = barrier()
		save.mockImplementationOnce(async () => {
			saving.resolve()
			await finish.promise
			throw new Error("delete snapshot failed")
		})
		const deletion = expect(api.deleteQueuedMessage(first.id)).rejects.toThrow("delete snapshot failed")
		await saving.promise
		const admission = queue.addMessageDurably("Third instruction", [], "third").catch(() => undefined)
		finish.resolve()
		await deletion
		// An unrelated admission sharing the failed disk snapshot may reject,
		// but a retry must preserve its identity without disturbing old input.
		await admission
		const third = (await queue.addMessageDurably("Third instruction", [], "third"))!
		expect(queue.messages).toEqual([first, second, third])
		expect(stored()).toEqual([first, second, third])
		queue.dispose()
	})

	it("leaves a selected delivery intact and makes repeated deletion idempotent", async () => {
		const { queue, api, first, second, stored } = await fixture()
		queue.claimMessage(first.id)
		await queue.flush()
		await api.deleteQueuedMessage(first.id)
		expect(queue.getClaimedMessageIds()).toEqual([first.id])
		expect(queue.visibleMessages).toEqual([{ ...first, deliveryState: "delivering" }, second])
		await api.deleteQueuedMessage(second.id)
		await api.deleteQueuedMessage(second.id)
		expect(queue.getClaimedMessageIds()).toEqual([first.id])
		expect(stored()).toEqual([first])
		queue.dispose()
	})
})
