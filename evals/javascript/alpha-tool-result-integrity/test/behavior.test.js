import test from "node:test"
import assert from "node:assert/strict"
import { acceptResult } from "../src/protocol.js"
test("rejects mismatched and malformed results", () => {
	assert.deepEqual(acceptResult("a", { callId: "b", value: 1 }), { status: "retry", code: "call_id_mismatch" })
	assert.deepEqual(acceptResult("a", { callId: "a" }), { status: "retry", code: "missing_payload" })
	assert.deepEqual(acceptResult("a", { callId: "a", value: 0 }), { status: "ok", value: 0 })
})
