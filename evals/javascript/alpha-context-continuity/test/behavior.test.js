import test from "node:test"
import assert from "node:assert/strict"
import { compact } from "../src/context.js"
test("preserves current tool state and open decisions", () => {
	const events = [
		{ type: "decision", id: "d", open: true },
		{ type: "tool", call: "x", value: "old" },
		{ type: "tool", call: "x", value: "new" },
		{ type: "decision", id: "done", open: false },
	]
	assert.deepEqual(compact(events), [events[0], events[2]])
})
