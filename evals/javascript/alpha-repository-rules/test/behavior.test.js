import test from "node:test"
import assert from "node:assert/strict"
import { effectiveRules, mayEdit } from "../src/rules.js"
test("nearest instructions win without dropping inherited protection", () => {
	const r = effectiveRules([{ format: "tabs", protected: ["secrets.env"] }, { format: "spaces" }])
	assert.equal(r.format, "spaces")
	assert.equal(mayEdit("secrets.env", r), false)
})
