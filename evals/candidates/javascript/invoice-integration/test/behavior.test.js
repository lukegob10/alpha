import test from "node:test"
import assert from "node:assert/strict"
import { invoice } from "../src/invoice.js"
import { discountRate } from "../src/policy.js"

test("integrates the policy with quantity-aware invoice totals", () => {
	const items = Object.freeze([Object.freeze({ price: 20, quantity: 3 }), Object.freeze({ price: 10, quantity: 4 })])
	assert.deepEqual(invoice(items, "member"), { subtotal: 100, discount: 10, total: 90 })
	assert.deepEqual(invoice(items), { subtotal: 100, discount: 0, total: 100 })
	assert.deepEqual(invoice([], "member"), { subtotal: 0, discount: 0, total: 0 })
	assert.equal(discountRate("member"), 0.1)
	assert.equal(discountRate("standard"), 0)
})
