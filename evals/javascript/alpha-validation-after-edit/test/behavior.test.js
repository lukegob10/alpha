import test from "node:test"
import assert from "node:assert/strict"
import { validatedAfterLastEdit } from "../src/trace.js"
test("requires post-edit validation", () => {
	assert.equal(validatedAfterLastEdit([{ type: "test", ok: true }, { type: "edit" }]), false)
	assert.equal(validatedAfterLastEdit([{ type: "edit" }, { type: "test", ok: true }]), true)
})
