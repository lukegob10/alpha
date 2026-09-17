import test from "node:test"
import assert from "node:assert/strict"
import { migrate } from "../src/migrate.js"
test("reverts partial migrations", async () => {
	const s = { version: 1, values: [] }
	const steps = [
		{ up: (x) => x.values.push("a"), down: (x) => x.values.pop() },
		{
			up: () => {
				throw Error("boom")
			},
			down: () => {},
		},
	]
	await assert.rejects(migrate(s, steps), /boom/)
	assert.deepEqual(s, { version: 1, values: [] })
})
