import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { pnpmInvocation } from "./pnpm.mjs"

test("pnpm native and JavaScript launches preserve data argument boundaries", () => {
	const args = ["test", "a path/spec.ts"]
	const executable = path.resolve("pnpm.exe")
	assert.deepEqual(pnpmInvocation(executable, args), { executable, args })
	const cli = path.resolve("pnpm.cjs")
	assert.deepEqual(pnpmInvocation(cli, args, "node"), { executable: "node", args: [cli, ...args] })
	assert.throws(() => pnpmInvocation(path.resolve("pnpm.cmd"), args), /shell shim/)
})
