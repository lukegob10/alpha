import test from "node:test"
import assert from "node:assert/strict"
import { publishFiles } from "../src/artifacts.js"
test("publishes declared runtime entries only", () =>
	assert.deepEqual(
		publishFiles(["dist/index.js", "dist/browser.js", "dist/internal.js", "dist/index.js.map", "../secret"], {
			exports: { ".": { import: "./dist/index.js", browser: "./dist/browser.js" } },
		}),
		["dist/browser.js", "dist/index.js"],
	))
