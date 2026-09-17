import test from "node:test"
import assert from "node:assert/strict"
import { createOrder } from "../src/orders.js"
test("writes atomically with stable event key", async () => {
	const calls = []
	const tx = { insertOrder: (o) => calls.push(["order", o]), insertOutbox: (e) => calls.push(["event", e]) }
	const db = {
		transaction: async (fn) => fn(tx),
		insertOrder: () => {
			throw Error("outside tx")
		},
	}
	await createOrder(db, { id: "o1" })
	assert.deepEqual(calls, [
		["order", { id: "o1" }],
		["event", { id: "order:o1", type: "order.created", payload: { id: "o1" } }],
	])
})
