import test from "node:test"
import assert from "node:assert/strict"
import { charge } from "../src/payments.js"
test("retries return one external result", async () => {
	const store = new Map()
	let calls = 0
	const p = { charge: async () => ({ id: `p${++calls}` }) }
	assert.deepEqual(await charge(store, p, "k", 10), { id: "p1" })
	assert.deepEqual(await charge(store, p, "k", 10), { id: "p1" })
	assert.equal(calls, 1)
})
