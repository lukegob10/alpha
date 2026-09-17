import test from "node:test"
import assert from "node:assert/strict"
import { resume } from "../src/resume.js"
test("continues after the last committed effect", () =>
	assert.deepEqual(resume({ steps: ["inspect", "edit", "test"], committed: ["inspect", "edit"] }), {
		completed: ["inspect", "edit"],
		pending: ["test"],
		next: "test",
	}))
