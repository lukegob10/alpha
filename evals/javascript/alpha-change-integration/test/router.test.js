import assert from "node:assert/strict"
import test from "node:test"

import { route } from "../src/router.js"

test("creates a record", () => {
	assert.deepEqual(route("create", { id: 1, status: "open" }), { id: 1, status: "created" })
})

test("archives a record through the router", () => {
	assert.deepEqual(route("archive", { id: 1, status: "open" }), { id: 1, status: "archived" })
})
