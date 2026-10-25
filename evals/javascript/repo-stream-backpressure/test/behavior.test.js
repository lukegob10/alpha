import test from "node:test"
import assert from "node:assert/strict"
import { exportRecords } from "../src/pipeline.js"
test("honors backpressure", async () => {
	let active = 0,
		peak = 0
	const written = []
	await exportRecords(
		[1, 2, 3, 4],
		async (record) => {
			active++
			peak = Math.max(peak, active)
			written.push(record)
			await Promise.resolve()
			active--
		},
		{ concurrency: 2 },
	)
	assert.equal(peak, 2)
	assert.deepEqual(written.sort(), [1, 2, 3, 4])
})

test("does not start writes after cancellation before dispatch", async () => {
	const controller = new AbortController()
	const reason = new Error("cancelled before dispatch")
	controller.abort(reason)
	const written = []
	await assert.rejects(
		exportRecords([1, 2, 3], async (record) => written.push(record), { signal: controller.signal }),
		(error) => error === reason,
	)
	assert.deepEqual(written, [])
})

test("stops pulling records when a completed write cancels the export", async () => {
	const controller = new AbortController()
	const reason = new Error("cancelled during dispatch")
	const written = []
	await assert.rejects(
		exportRecords(
			[1, 2, 3],
			async (record, signal) => {
				assert.equal(signal, controller.signal)
				written.push(record)
				controller.abort(reason)
			},
			{ concurrency: 1, signal: controller.signal },
		),
		(error) => error === reason,
	)
	assert.deepEqual(written, [1])
})

test("completes an empty export without starting a writer", async () => {
	const written = []
	await exportRecords([], async (record) => written.push(record))
	assert.deepEqual(written, [])
})
