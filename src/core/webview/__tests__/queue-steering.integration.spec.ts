import type { ExtensionMessage } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

it("does not revive delivered input in another view when an earlier publication settles late", async () => {
	const entered = barrier()
	const held = barrier()
	const received: ExtensionMessage[] = []
	const first = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "task", taskId: "shared-task" },
		messageQueueSeq: 0,
		taskStateSeq: 1,
		clineMessagesSeq: 0,
		postMessageToWebview: vi.fn().mockImplementationOnce(async () => {
			entered.resolve()
			await held.promise
		}),
	}) as AlphaProvider
	const second = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "task", taskId: "shared-task" },
		messageQueueSeq: 0,
		taskStateSeq: 1,
		clineMessagesSeq: 0,
		postMessageToWebview: vi.fn(async (message: ExtensionMessage) => {
			received.push(structuredClone(message))
		}),
	}) as AlphaProvider
	const publisher = Object.assign(Object.create(AlphaProvider.prototype), {
		getHostProviders: () => [first, second],
	}) as AlphaProvider
	const publishing = publisher.postTaskQueueToWebview("shared-task", [
		{ id: "input", timestamp: 1, text: "arbitrary input", deliveryState: "delivering" },
	])
	await entered.promise
	await publisher.postTaskQueueToWebview("shared-task", [])
	held.resolve()
	await publishing
	const latest = received.at(-1)!.state!
	expect(latest.messageQueue).toEqual([])
	const sequences = received.map((message) => message.state!.messageQueueSeq!)
	expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
})
