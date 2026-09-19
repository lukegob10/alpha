import * as assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { pnpmCommand } from "./ownedProcess"

test("host preparation supports native pnpm and JS CLIs without shell concatenation", () => {
	const args = ["--dir", "a path", "test"]
	const native = path.resolve("pnpm.exe")
	assert.deepEqual(pnpmCommand(native, args), { executable: native, args })
	const js = path.resolve("pnpm.cjs")
	assert.deepEqual(pnpmCommand(js, args), { executable: process.execPath, args: [js, ...args] })
	assert.throws(() => pnpmCommand(path.resolve("pnpm.cmd"), args), /Expected/)
})
