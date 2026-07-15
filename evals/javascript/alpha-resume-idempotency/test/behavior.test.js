import test from "node:test"
import assert from "node:assert/strict"
import { invoke } from "../src/tools.js"
test("does not replay committed calls", async () => {
	const store = new Map([["c1", { key: "stable", value: "done" }]])
	let calls = 0
	assert.equal(
		await invoke(store, { id: "c1" }, () => {
			calls++
			return "again"
		}),
		"done",
	)
	assert.equal(calls, 0)
})
