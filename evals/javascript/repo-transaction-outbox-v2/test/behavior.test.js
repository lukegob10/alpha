import test from "node:test"
import assert from "node:assert/strict"

import { orderCreatedEvent } from "../src/events.js"
import { createOrder } from "../src/orders.js"

function database({ failEvent = false, eventGate, eventEntered } = {}) {
	const orders = []
	const events = []
	let transactions = 0
	return {
		orders,
		events,
		get transactions() {
			return transactions
		},
		async insertOrder() {
			throw new Error("order write outside transaction")
		},
		async insertOutbox() {
			throw new Error("event write outside transaction")
		},
		async transaction(run) {
			transactions++
			const stagedOrders = []
			const stagedEvents = []
			let pendingWrites = 0
			await run({
				async insertOrder(order) {
					stagedOrders.push(order)
				},
				async insertOutbox(event) {
					pendingWrites++
					try {
						eventEntered?.()
						await eventGate
						if (failEvent) throw new Error("event write rejected")
						stagedEvents.push(event)
					} finally {
						pendingWrites--
					}
				},
			})
			if (pendingWrites) throw new Error("transaction returned before its writes completed")
			orders.push(...stagedOrders)
			events.push(...stagedEvents)
		},
	}
}

test("constructs stable event identities without changing the caller's order", () => {
	const order = Object.freeze({ id: "o1", total: 42 })
	assert.deepEqual(orderCreatedEvent(order), { id: "order:o1", type: "order.created", payload: order })
	assert.deepEqual(orderCreatedEvent({ id: "o2" }), {
		id: "order:o2",
		type: "order.created",
		payload: { id: "o2" },
	})
	assert.deepEqual(order, { id: "o1", total: 42 })
})

test("commits one order and its stable event in the same transaction", async () => {
	const db = database()
	const order = Object.freeze({ id: "o1", total: 42 })
	await assert.doesNotReject(() => createOrder(db, order))
	assert.equal(db.transactions, 1)
	assert.deepEqual(db.orders, [order])
	assert.deepEqual(db.events, [{ id: "order:o1", type: "order.created", payload: order }])
})

test("rolls back both writes when event persistence rejects", async () => {
	const db = database({ failEvent: true })
	await assert.rejects(() => createOrder(db, { id: "o3" }), /event write rejected/)
	assert.equal(db.transactions, 1)
	assert.deepEqual(db.orders, [])
	assert.deepEqual(db.events, [])
})

test("waits for event persistence before committing the transaction", async () => {
	let releaseEvent
	const eventGate = new Promise((resolve) => {
		releaseEvent = resolve
	})
	let markEntered
	const entered = new Promise((resolve) => {
		markEntered = resolve
	})
	const db = database({ eventGate, eventEntered: markEntered })
	const completion = assert.doesNotReject(() => createOrder(db, { id: "o4" }))
	try {
		await Promise.race([entered, completion])
		assert.deepEqual(db.orders, [])
		assert.deepEqual(db.events, [])
	} finally {
		releaseEvent()
	}
	await completion
	assert.deepEqual(db.orders, [{ id: "o4" }])
	assert.equal(db.events[0].id, "order:o4")
})
