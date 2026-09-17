import test from "node:test"
import assert from "node:assert/strict"
import { isAllowed } from "../src/paths.js"
test("enforces a path-segment boundary", () => {
	assert.equal(isAllowed("/work/project", "/work/project/src/a.js"), true)
	assert.equal(isAllowed("/work/project", "/work/project-secret/key"), false)
	assert.equal(isAllowed("/work/project", "/work/project/../secret"), false)
})
