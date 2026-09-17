import test from "node:test"
import assert from "node:assert/strict"
import { Limiter } from "../src/limiter.js"
test("uses an open lower boundary", () => {
	const l = new Limiter(2, 100)
	assert.equal(l.allow(0), true)
	assert.equal(l.allow(1), true)
	assert.equal(l.allow(2), false)
	assert.equal(l.allow(100), true)
	assert.equal(l.hits.length, 2)
})
