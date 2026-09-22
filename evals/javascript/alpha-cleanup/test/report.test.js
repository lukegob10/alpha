import assert from "node:assert/strict"
import test from "node:test"

import * as report from "../src/report.js"

test("formats the total without debug text", () => {
	assert.equal(report.formatReport([{ amount: 2 }, { amount: 3 }]), "total=5")
})

test("does not export the debug helper", () => {
	assert.equal("unusedDebug" in report, false)
})
