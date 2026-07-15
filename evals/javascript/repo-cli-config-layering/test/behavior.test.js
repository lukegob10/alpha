import test from "node:test"
import assert from "node:assert/strict"
import { parseArgs } from "../src/argv.js"
test("parses supported forms", () =>
	assert.deepEqual(parseArgs(["--limit=-2", "--include", "src", "--include", "test"]), {
		limit: -2,
		include: ["src", "test"],
	}))
