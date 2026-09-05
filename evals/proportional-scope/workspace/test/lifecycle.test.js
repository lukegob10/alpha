import test from "node:test"
import assert from "node:assert/strict"
import { transition } from "../src/lifecycle.js"
import { project } from "../src/projection.js"

test("cancellation survives duplicate start delivery and projection", () => {
	const cancelled = transition({ id: "task", status: "running" }, "cancel")
	assert.deepEqual(project(cancelled), { id: "task", status: "cancelled", terminal: true })
	assert.deepEqual(transition(cancelled, "start"), cancelled)
})

test("completed tasks remain terminal", () => {
	const completed = { id: "task", status: "completed" }
	assert.deepEqual(transition(completed, "cancel"), completed)
	assert.deepEqual(project(completed), { ...completed, terminal: true })
})
