import assert from "node:assert/strict"
import test from "node:test"

import { comparePatches } from "../src/compare.js"

const same = "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-const n = 1\n+const n = 2\n"
const other = "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-const n = 1\n+const n = 3\n"
const withContext = "--- a/app.js\n+++ b/app.js\n@@ -1,3 +1,3 @@\n context\n-const n = 1\n+const n = 2\n context\n"

test("identical line changes are equivalent", () => {
	const result = comparePatches(same, same)
	assert.equal(result.equivalent, true)
	assert.equal(result.baseChanges, 2)
	assert.equal(result.candidateChanges, 2)
})

test("different line changes are not equivalent", () => {
	assert.equal(comparePatches(same, other).equivalent, false)
})

test("ignores headers and unchanged context", () => {
	const result = comparePatches(same, withContext)
	assert.equal(result.equivalent, true)
	assert.equal(result.candidateChanges, 2)
})
