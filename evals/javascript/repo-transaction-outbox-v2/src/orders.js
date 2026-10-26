import { orderCreatedEvent } from "./events.js"

export async function createOrder(db, order) {
	await db.insertOrder(order)
	await db.insertOutbox(orderCreatedEvent(order))
}
