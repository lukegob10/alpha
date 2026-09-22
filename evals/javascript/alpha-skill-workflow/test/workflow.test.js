import assert from "node:assert/strict"
import test from "node:test"

import { runWorkflow } from "../src/run.js"

test("follows the skill workflow", () => {
	assert.deepEqual(
		runWorkflow([
			{ status: "ready", amount: 2 },
			{ status: "skip", amount: 9 },
			{ status: "ready", amount: 4 },
		]),
		{ kept: 2, total: 6, skill: "alpha-workflow" },
	)
})

test("returns an empty ready set", () => {
	assert.deepEqual(runWorkflow([{ status: "skip", amount: 3 }]), { kept: 0, total: 0, skill: "alpha-workflow" })
})
