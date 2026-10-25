import test from "node:test"
import assert from "node:assert/strict"
import { commandReceipt } from "../src/receipt.js"

test("keeps successful, failed and pending receipts distinct without losing bytes", () => {
	for (const [exitCode, status] of [
		[0, "success"],
		[1, "error"],
		[-1, "error"],
		[null, "pending"],
	]) {
		assert.deepEqual(commandReceipt(exitCode, " output\n"), { status, exitCode, output: " output\n" })
	}
})
