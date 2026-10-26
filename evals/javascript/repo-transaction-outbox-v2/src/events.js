export function orderCreatedEvent(order) {
	return { type: "order.created", payload: order }
}
