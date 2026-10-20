import { test } from "node:test"
import { strict as assert } from "node:assert"

import { assertRequestedHostVersion } from "../suite/test-utils"

test("exact host contracts accept the independently requested minimum and reference versions", () => {
	assert.equal(assertRequestedHostVersion("1.125.0", "1.125.0"), "1.125.0")
	assert.equal(assertRequestedHostVersion("1.138.0", "1.138.0"), "1.138.0")
})

test("a compatibility host cannot substitute for the requested reference host or vice versa", () => {
	assert.throws(() => assertRequestedHostVersion("1.125.0", "1.138.0"), /must match the requested exact version/)
	assert.throws(() => assertRequestedHostVersion("1.138.0", "1.125.0"), /must match the requested exact version/)
})

test("exact contracts reject missing, floating, malformed and uncharacterized requested hosts", () => {
	for (const expected of [undefined, "", "stable", "insiders", "^1.125.0", "1.126.0", "1.138.1"]) {
		assert.throws(() => assertRequestedHostVersion("1.138.0", expected), /requires an explicitly requested exact/)
	}
})
