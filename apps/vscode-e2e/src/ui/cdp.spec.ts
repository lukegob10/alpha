import * as assert from "node:assert/strict"
import { test } from "node:test"
import { CdpConnection } from "./cdp"

test("CDP refuses non-loopback and credential-bearing endpoints", async () => {
	for (const url of [
		"ws://remote/devtools/browser/id",
		"ws://user:secret@127.0.0.1/devtools/browser/id",
		"http://127.0.0.1/devtools/browser/id",
		"ws://127.0.0.1/other",
	])
		await assert.rejects(CdpConnection.connect(url), /owned loopback/)
})

test("CDP correlates responses and rejects outstanding requests when closed", async () => {
	const original = globalThis.WebSocket
	class Socket extends EventTarget {
		static OPEN = 1
		readyState = 1
		constructor() {
			super()
			queueMicrotask(() => this.dispatchEvent(new Event("open")))
		}
		send(value: string) {
			const request = JSON.parse(value)
			if (request.method === "respond")
				queueMicrotask(() =>
					this.dispatchEvent(
						new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: { ok: true } }) }),
					),
				)
		}
		close() {
			this.readyState = 3
			this.dispatchEvent(new Event("close"))
		}
	}
	globalThis.WebSocket = Socket as unknown as typeof WebSocket
	try {
		const connection = await CdpConnection.connect("ws://127.0.0.1:1/devtools/browser/id")
		assert.deepEqual(await connection.request("respond"), { ok: true })
		const pending = connection.request("pending")
		const rejected = assert.rejects(pending, /closed/)
		connection.close()
		await rejected
	} finally {
		globalThis.WebSocket = original
	}
})

test("CDP forwards notifications to bounded disposable observers without retaining them", async () => {
	const original = globalThis.WebSocket
	const sockets: EventTarget[] = []
	class Socket extends EventTarget {
		static OPEN = 1
		readyState = 1
		constructor() {
			super()
			sockets.push(this)
			queueMicrotask(() => this.dispatchEvent(new Event("open")))
		}
		close() {
			this.readyState = 3
			this.dispatchEvent(new Event("close"))
		}
	}
	globalThis.WebSocket = Socket as unknown as typeof WebSocket
	try {
		const connection = await CdpConnection.connect("ws://127.0.0.1:1/devtools/browser/id")
		const received: string[] = []
		const dispose = connection.observe((event) => received.push(`${event.sessionId}:${event.method}`))
		const emit = () =>
			sockets[0]!.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						method: "Runtime.exceptionThrown",
						sessionId: "owned-renderer",
						params: {},
					}),
				}),
			)
		emit()
		assert.deepEqual(received, ["owned-renderer:Runtime.exceptionThrown"])
		dispose()
		emit()
		assert.equal(received.length, 1)
		for (let index = 0; index < 8; index++) connection.observe(() => undefined)
		assert.throws(() => connection.observe(() => undefined), /observer limit/)
		connection.close()
		emit()
		assert.equal(received.length, 1)
	} finally {
		globalThis.WebSocket = original
	}
})
