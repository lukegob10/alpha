import test from "node:test"
import assert from "node:assert/strict"
import { exportRecords } from "../src/pipeline.js"
test("honors backpressure", async () => {
	let active = 0,
		peak = 0
	await exportRecords(
		[1, 2, 3, 4],
		async () => {
			active++
			peak = Math.max(peak, active)
			await new Promise((r) => setTimeout(r, 5))
			active--
		},
		{ concurrency: 2 },
	)
	assert.equal(peak, 2)
})
