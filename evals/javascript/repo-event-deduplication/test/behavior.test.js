import test from "node:test"
import assert from "node:assert/strict"
import { consume } from "../src/consumer.js"
test("failed events remain retryable", async () => {
	const seen = new Set()
	await assert.rejects(consume([{ id: "x" }], () => Promise.reject(Error("temporary")), seen))
	assert.equal(seen.has("x"), false)
	await consume([{ id: "x" }], () => Promise.resolve(), seen)
	assert.equal(seen.has("x"), true)
})
