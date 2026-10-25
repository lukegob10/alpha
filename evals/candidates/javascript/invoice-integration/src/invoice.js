import { discountRate } from "./policy.js"

export function invoice(items, tier = "standard") {
	const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
	return { subtotal, discount: discountRate(tier), total: subtotal }
}
