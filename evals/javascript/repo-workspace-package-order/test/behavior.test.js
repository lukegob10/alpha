import test from "node:test"
import assert from "node:assert/strict"
import { buildOrder } from "../src/workspace.js"
test("dependencies precede consumers", () =>
	assert.deepEqual(
		buildOrder([
			{ name: "app", deps: ["core"] },
			{ name: "core", deps: [] },
			{ name: "ui", deps: ["core"] },
		]),
		["core", "app", "ui"],
	))
test("cycles are explicit", () =>
	assert.throws(
		() =>
			buildOrder([
				{ name: "a", deps: ["b"] },
				{ name: "b", deps: ["a"] },
			]),
		/cycle/i,
	))
