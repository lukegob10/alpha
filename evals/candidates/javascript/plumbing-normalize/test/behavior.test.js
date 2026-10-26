import test from "node:test"
import assert from "node:assert/strict"
import { normalize, workflowIdentity } from "../src/workflow.js"

test("normalizes text, empty values and numeric inputs", () => {
	assert.equal(normalize(" alpha "), "ALPHA")
	assert.equal(normalize(" \t "), "")
	assert.equal(normalize(42), "42")
	assert.equal(workflowIdentity, "plumbing-normalize")
})
