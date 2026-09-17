import test from "node:test"
import assert from "node:assert/strict"
import { restore } from "../src/scheduler.js"
test("restores pending jobs deterministically", () =>
	assert.deepEqual(
		restore([
			{ id: "b", at: 1, seq: 2, state: "pending" },
			{ id: "done", at: 0, seq: 0, state: "complete" },
			{ id: "a", at: 1, seq: 1, state: "pending" },
		]).map((x) => x.id),
		["a", "b"],
	))
