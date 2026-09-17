import test from "node:test"
import assert from "node:assert/strict"
import { Worker } from "../src/worker.js"
test("drains and closes idempotently", async () => {
	let finish
	const w = new Worker(() => new Promise((r) => (finish = r)))
	w.submit("a")
	let closed = false
	const p = w.close().then(() => (closed = true))
	await Promise.resolve()
	assert.equal(closed, false)
	assert.throws(() => w.submit("b"), /closed/i)
	finish()
	await p
	await w.close()
})
