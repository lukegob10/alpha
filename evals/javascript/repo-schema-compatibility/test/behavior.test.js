import test from "node:test"
import assert from "node:assert/strict"
import { encodeProfile, decodeProfile } from "../src/profile.js"
test("writes a dual-compatible shape", () =>
	assert.deepEqual(encodeProfile({ id: 1, displayName: "Ada Lovelace" }), {
		id: 1,
		displayName: "Ada Lovelace",
		firstName: "Ada",
		lastName: "Lovelace",
	}))
test("reads legacy rows", () =>
	assert.deepEqual(decodeProfile({ id: 2, firstName: "Grace", lastName: "Hopper" }), {
		id: 2,
		displayName: "Grace Hopper",
	}))
