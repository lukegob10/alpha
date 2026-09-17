import test from "node:test"
import assert from "node:assert/strict"
import { Sessions } from "../src/sessions.js"
test("rotates once and rejects replay", () => {
	const s = new Sessions()
	s.issue("u", "a")
	assert.equal(s.rotate("u", "a", "b"), true)
	assert.equal(s.rotate("u", "a", "c"), false)
	assert.equal(s.active.get("u"), "b")
	assert.deepEqual([...s.used], ["a"])
})
