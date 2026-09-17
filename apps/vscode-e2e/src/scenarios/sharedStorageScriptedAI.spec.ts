import * as assert from "node:assert/strict"
import * as path from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"

import { record } from "../evidence/sharedStorageProtocol"
import { PairedScriptedAI } from "./sharedStorageScriptedAI"

interface Handler {
	getModel(): { id: string }
	createMessage(prompt: string, messages: unknown[]): AsyncIterable<unknown>
}

test("the actual production FakeAIHandler registers and rehydrates the paired fixture ID", async () => {
	// Use the existing workspace TS loader so this also runs under the normal compiled Node test runner.
	// Production source stays outside the E2E TypeScript compile graph.
	const source = path.resolve(__dirname, "../../../../src/api/providers/fake-ai.ts")
	const loader = createRequire(__filename)("tsx/cjs/api") as { require: (file: string, from: string) => unknown }
	const exports = record(loader.require(source, __filename))
	assert.equal(typeof exports.FakeAIHandler, "function")
	const FakeAIHandler = exports.FakeAIHandler as new (options: { fakeAi: unknown }) => Handler
	let entered = false
	let release!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	const fixture = new PairedScriptedAI("registration-test", "a", async () => {
		entered = true
		await barrier
	})
	const peer = new PairedScriptedAI("registration-test", "b", async () => {})
	assert.notEqual(fixture.id, peer.id)
	const { id: _missingId, ...withoutId } = fixture
	assert.throws(() => new FakeAIHandler({ fakeAi: withoutId }), /Fake AI is not set/)
	try {
		new FakeAIHandler({ fakeAi: fixture })
		const rehydrated = new FakeAIHandler({ fakeAi: { id: fixture.id } })
		assert.equal(rehydrated.getModel().id, fixture.getModel().id)
		const stream = rehydrated.createMessage("", [])[Symbol.asyncIterator]()
		const next = stream.next()
		await Promise.resolve()
		assert.equal(entered, true)
		assert.equal(fixture.requests, 1)
		release()
		assert.deepEqual((await next).value, { type: "text", text: "Shared-storage verification completed." })
		await stream.return?.()
	} finally {
		release()
		fixture.removeFromCache?.()
	}
})
