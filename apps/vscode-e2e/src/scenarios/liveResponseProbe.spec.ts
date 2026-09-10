import { strict as assert } from "node:assert"
import { test } from "node:test"
import { LiveResponseProbe } from "./liveResponseProbe"

test("response observation preserves ordered parts and receiver state without recording payloads", async () => {
	const parts = [{ value: "private answer" }, { callId: "id", name: "tool", input: { secret: "private" } }]
	const original = Object.freeze({
		stream: (async function* () {
			yield* parts
		})(),
		state: "opaque-state",
		read() {
			assert.equal(this, original)
			return this.state
		},
	})
	const probe = new LiveResponseProbe()
	const wrapped = probe.wrap(original, 9, 0) as typeof original
	assert.equal(wrapped.read(), "opaque-state")
	const actual = []
	for await (const part of wrapped.stream) actual.push(part)
	assert.deepEqual(actual, parts)
	assert.equal(actual[0], parts[0])
	assert.deepEqual(probe.observations, [
		{ request: 9, toolCount: 0, parts: { value: 1, "callId,input,name": 1 }, textCharacters: 14, ended: true },
	])
	assert.ok(!JSON.stringify(probe.observations).includes("private"))
})

test("response observation propagates failures and closes the underlying iterator on cancellation", async () => {
	let closed = false
	const probe = new LiveResponseProbe()
	const wrapped = probe.wrap(
		{
			stream: (async function* () {
				try {
					yield "first"
					throw new Error("transport failed")
				} finally {
					closed = true
				}
			})(),
		},
		1,
		0,
	) as { stream: AsyncIterable<unknown> }
	await assert.rejects(async () => {
		for await (const _part of wrapped.stream) {
			/* drain */
		}
	}, /transport failed/)
	assert.ok(closed)
	assert.equal(probe.observations[0]?.ended, false)
	closed = false
	const cancelled = probe.wrap(
		{
			stream: (async function* () {
				try {
					yield "first"
					yield "second"
				} finally {
					closed = true
				}
			})(),
		},
		2,
		1,
	) as { stream: AsyncIterable<unknown> }
	for await (const _part of cancelled.stream) break
	assert.ok(closed)
	assert.equal(probe.observations[1]?.ended, false)
})
