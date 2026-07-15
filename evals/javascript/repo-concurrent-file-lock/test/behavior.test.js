import test from "node:test"
import assert from "node:assert/strict"
import { Lock } from "../src/lock.js"
test("enforces lease ownership", () => {
	let t = 0
	const l = new Lock(() => t)
	assert.equal(l.acquire("a", 10), true)
	assert.equal(l.acquire("b", 10), false)
	assert.equal(l.release("b"), false)
	t = 11
	assert.equal(l.acquire("b", 10), true)
})
