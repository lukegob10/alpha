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

for (const boundary of ["after-text", "after-thinking", "after-tool-call"] as const) {
	for (const kind of ["pause", "error"] as const) {
		test(`${kind} at ${boundary} follows consumer delivery and closes the owned source`, async () => {
			const fault = new LiveResponseFaultController()
			fault.arm(kind, boundary)
			const part =
				boundary === "after-text"
					? { value: "Accepted text" }
					: boundary === "after-thinking"
						? { value: ["Accepted thinking"], id: "thinking-1", metadata: {} }
						: { callId: "read-1", name: "read_file", input: { path: "fixture.txt" } }
			let closed = false
			let pulledTail = false
			const wrapped = fault.wrap({
				stream: (async function* () {
					try {
						yield { mimeType: "stateful_marker", data: new Uint8Array([1]) }
						yield part
						pulledTail = true
						yield { value: "Tail" }
					} finally {
						closed = true
					}
				})(),
			}) as { stream: AsyncGenerator<unknown> }
			await wrapped.stream.next()
			assert.equal(fault.injected, false)
			assert.equal((await wrapped.stream.next()).value, part)
			assert.equal(fault.injected, false, "Delivery alone must not race the consumer's processing")
			const continuation = wrapped.stream.next()
			const rejection = kind === "error" ? assert.rejects(continuation, /transport interruption/) : undefined
			await fault.whenInjected
			assert.equal(fault.deliveredParts, 2)
			assert.equal(fault.deliveredBoundary, boundary)
			assert.equal(pulledTail, false)
			if (kind === "pause") {
				fault.release()
				assert.deepEqual(await continuation, { value: { value: "Tail" }, done: false })
				await wrapped.stream.return(undefined)
			} else await rejection
			assert.equal(closed, true)
		})
	}
}

test("delivered faults also fire after a terminal part without pulling another source item", async () => {
	const fault = new LiveResponseFaultController()
	fault.arm("error", "after-text")
	const wrapped = fault.wrap({
		stream: (async function* () {
			yield "Final real text"
		})(),
	}) as {
		stream: AsyncGenerator<unknown>
	}
	assert.equal((await wrapped.stream.next()).value, "Final real text")
	await assert.rejects(wrapped.stream.next(), /transport interruption/)
	assert.equal(fault.observedParts, 1)
})

test("a missing delivered boundary does not manufacture a fault or mistake metadata for visible thinking", async () => {
	const fault = new LiveResponseFaultController()
	fault.arm("error", "after-thinking")
	const parts = [{ value: "", id: "signature-only", metadata: {} }, { value: "Plain answer" }]
	const wrapped = fault.wrap({
		stream: (async function* () {
			yield* parts
		})(),
	}) as {
		stream: AsyncGenerator<unknown>
	}
	for await (const _part of wrapped.stream) {
		/* consume the genuine response */
	}
	assert.equal(fault.injected, false)
	assert.equal(fault.deliveredBoundary, undefined)
	assert.equal(fault.deliveredParts, 2)
	for (const kind of ["empty", "no-choices"] as const)
		assert.throws(() => new LiveResponseFaultController().arm(kind, "after-text"), /precede delivered output/)
})

for (const boundary of ["after-text", "after-thinking", "after-tool-call"] as const) {
	for (const kind of ["pause", "error"] as const) {
		test(`${kind} at ${boundary} remains pending across responses without that boundary`, async () => {
			const fault = new LiveResponseFaultController()
			fault.arm(kind, boundary)
			const nonmatching =
				boundary === "after-tool-call"
					? { value: "Plain answer" }
					: { callId: "inspect-1", name: "read_file", input: { path: "fixture.txt" } }
			for (const parts of [[], [{ value: "", id: "signature-only", metadata: {} }], [nonmatching]]) {
				const response = fault.wrap({
					stream: (async function* () {
						yield* parts
					})(),
				}) as { stream: AsyncGenerator<unknown> }
				const delivered = []
				for await (const part of response.stream) delivered.push(part)
				assert.deepEqual(delivered, parts)
				assert.equal(fault.injected, false)
			}
			const part =
				boundary === "after-text"
					? { value: "Accepted text" }
					: boundary === "after-thinking"
						? { value: ["Accepted thinking"], id: "thinking-1", metadata: {} }
						: { callId: "read-1", name: "read_file", input: { path: "fixture.txt" } }
			let closed = false
			const response = {
				stream: (async function* () {
					try {
						yield part
					} finally {
						closed = true
					}
				})(),
			}
			const wrapped = fault.wrap(response) as typeof response
			assert.equal((await wrapped.stream.next()).value, part)
			const continuation = wrapped.stream.next()
			try {
				if (kind === "error") await assert.rejects(continuation, /transport interruption/)
				else {
					assert.equal(
						await Promise.race([fault.whenInjected.then(() => true), continuation.then(() => false)]),
						true,
					)
					fault.release()
					assert.deepEqual(await continuation, { value: undefined, done: true })
				}
				assert.equal(fault.deliveredBoundary, boundary)
				assert.equal(closed, true)
				assert.equal(fault.wrap(response), response, "a delivered fault is consumed exactly once")
			} finally {
				fault.release()
			}
		})
	}
}

test("closing a response before the boundary releases its source and preserves the pending fault", async () => {
	const fault = new LiveResponseFaultController()
	fault.arm("error", "after-text")
	let closed = false
	let pulledTail = false
	const first = fault.wrap({
		stream: (async function* () {
			try {
				yield { callId: "read-1", name: "read_file", input: { path: "fixture.txt" } }
				pulledTail = true
				yield { value: "Unused text" }
			} finally {
				closed = true
			}
		})(),
	}) as { stream: AsyncGenerator<unknown> }
	await first.stream.next()
	const other = {
		stream: (async function* () {
			yield "Other response"
		})(),
	}
	assert.equal(fault.wrap(other), other, "an active response retains sole ownership of the pending fault")
	await first.stream.return(undefined)
	assert.equal(closed, true)
	assert.equal(pulledTail, false)
	assert.equal(fault.injected, false)
	const next = fault.wrap({
		stream: (async function* () {
			yield "Accepted text"
		})(),
	}) as {
		stream: AsyncGenerator<unknown>
	}
	await next.stream.next()
	await assert.rejects(next.stream.next(), /transport interruption/)
})

test("a genuine source error remains visible without consuming an undelivered fault", async () => {
	const fault = new LiveResponseFaultController()
	fault.arm("error", "after-text")
	const first = fault.wrap({
		stream: (async function* () {
			yield { callId: "read-1", name: "read_file", input: { path: "fixture.txt" } }
			throw new Error("Genuine source failure")
		})(),
	}) as {
		stream: AsyncGenerator<unknown>
	}
	await first.stream.next()
	await assert.rejects(first.stream.next(), /Genuine source failure/)
	assert.equal(fault.injected, false)
	const next = fault.wrap({
		stream: (async function* () {
			yield "Accepted text"
		})(),
	}) as {
		stream: AsyncGenerator<unknown>
	}
	await next.stream.next()
	await assert.rejects(next.stream.next(), /transport interruption/)
})
