export async function createOrder(db, order) {
	await db.insertOrder(order)
	await db.insertOutbox({ type: "order.created", payload: order })
}
