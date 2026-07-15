import test from "node:test"
import assert from "node:assert/strict"
import { resolveConfig } from "../src/config.js"
test("uses documented precedence and falsy overrides", () =>
	assert.deepEqual(resolveConfig({ port: 80, color: true }, { port: 3000 }, { port: 4000 }, { color: false }), {
		port: 4000,
		color: false,
	}))
