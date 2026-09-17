import { strict as assert } from "node:assert"
import { test } from "node:test"
import { LiveResponseFaultController } from "./liveResponseFault"

test("a paused real stream preserves parts and opaque state after release", async () => {
	const fault = new LiveResponseFaultController()
	fault.arm("pause")
	const part = { text: "real part" }
	const opaque = Symbol("provider")
	let closed = false
	const response = Object.freeze({
		[opaque]: "state",
		stream: (async function* () {
			try {
				yield part
			} finally {
				closed = true
			}
		})(),
	})
	const wrapped = fault.wrap(response) as typeof response
	assert.throws(() => fault.arm("empty"), /exactly one injection/)
	const next = wrapped.stream.next()
	await fault.whenInjected
	assert.equal(fault.injected, true)
	assert.equal(wrapped[opaque], "state")
	fault.release()
	assert.equal((await next).value, part)
	await wrapped.stream.return()
	assert.equal(closed, true)
	assert.equal(fault.wrap(response), response, "later responses are not faulted")
})

test("error and empty faults consume genuine parts and close the source", async () => {
	for (const kind of ["error", "empty", "no-choices"] as const) {
		const fault = new LiveResponseFaultController()
		fault.arm(kind)
		let closed = false
		const response = {
			stream: (async function* () {
				try {
					yield "real"
				} finally {
					closed = true
				}
			})(),
		}
		const wrapped = fault.wrap(response) as typeof response
		if (kind === "error") await assert.rejects(wrapped.stream.next(), /transport interruption/)
		else if (kind === "no-choices")
			await assert.rejects(wrapped.stream.next(), /^Error: Response contained no choices\.$/)
		else assert.deepEqual(await wrapped.stream.next(), { value: undefined, done: true })
		assert.equal(fault.observedParts, 1)
		assert.equal(closed, true)
	}
})
