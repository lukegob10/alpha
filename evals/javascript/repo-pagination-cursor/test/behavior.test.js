import test from "node:test"
import assert from "node:assert/strict"
import { page } from "../src/page.js"
test("cursor survives insertion", () => {
	const rows = [
		{ id: "a", createdAt: 1 },
		{ id: "b", createdAt: 2 },
		{ id: "c", createdAt: 3 },
	]
	const first = page(rows, null, 2)
	rows.unshift({ id: "z", createdAt: 0 })
	const second = page(rows, first.next, 2)
	assert.deepEqual(
		second.items.map((x) => x.id),
		["c"],
	)
	assert.equal(second.next, null)
})
