import test from "node:test"
import assert from "node:assert/strict"
import { resolveConfig } from "../src/config.js"

test("uses key-wise precedence without treating false-like values as absent", () => {
	const defaults = Object.freeze({ retries: 3, enabled: true, label: "base", optional: "value", stable: 9 })
	const workspace = Object.freeze({ retries: 2, enabled: false, label: "project", optional: null })
	const commandLine = Object.freeze({ retries: 0, label: "", enabled: undefined, extra: "new" })
	assert.deepEqual(resolveConfig(defaults, workspace, commandLine), {
		retries: 0,
		enabled: false,
		label: "",
		optional: null,
		stable: 9,
		extra: "new",
	})
	assert.deepEqual(resolveConfig({ x: 1 }, { x: undefined }, {}), { x: 1 })
	assert.deepEqual(resolveConfig({}, {}, { missing: undefined }), {})
})
