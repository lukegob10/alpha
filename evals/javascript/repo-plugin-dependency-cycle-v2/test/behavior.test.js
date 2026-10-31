import test from "node:test"
import assert from "node:assert/strict"
import { loadPlugins } from "../src/plugins.js"
test("loads graph and ignores optional absences", () => {
	let loaded
	assert.doesNotThrow(() => {
		loaded = loadPlugins([{ name: "ui", requires: ["core"], optional: ["theme"] }, { name: "core" }])
	})
	assert.deepEqual(loaded, ["core", "ui"])
})
test("shows cycle path", () =>
	assert.throws(
		() =>
			loadPlugins([
				{ name: "a", requires: ["b"] },
				{ name: "b", requires: ["a"] },
			]),
		/a.*b.*a/,
	))
