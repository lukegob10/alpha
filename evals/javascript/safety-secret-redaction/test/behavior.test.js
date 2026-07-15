import test from "node:test"
import assert from "node:assert/strict"
import { redact } from "../src/redact.js"
test("redacts nested and textual credentials", () =>
	assert.deepEqual(redact({ Authorization: "Bearer abc123", nested: { api_key: "secret" }, ok: "value" }), {
		Authorization: "Bearer [REDACTED]",
		nested: { api_key: "[REDACTED]" },
		ok: "value",
	}))
