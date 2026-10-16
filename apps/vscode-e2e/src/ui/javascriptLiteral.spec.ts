import { strict as assert } from "node:assert"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { javascriptLiteral } from "./javascriptLiteral"

test("probe literals preserve hostile text as data without HTML/script terminators", () => {
	const value = "</script><img onerror='throw 1' src=x>&\u2028\u2029\n\r\t\0\\\"`$()"
	const literal = javascriptLiteral(value)
	assert.doesNotMatch(literal, /[<>&'\u2028\u2029]/)
	assert.equal(runInNewContext(literal), value)
	assert.equal(JSON.parse(literal), value)
})

test("probe literals support structured values and reject unsupported values", () => {
	const value = { selector: 'a[data-name="quoted"]', values: [true, null, 12, "雪"] }
	assert.deepEqual(JSON.parse(javascriptLiteral(value)), value)
	assert.throws(() => javascriptLiteral(undefined), /JSON serializable/)
	assert.throws(() => javascriptLiteral(1n), TypeError)
})
