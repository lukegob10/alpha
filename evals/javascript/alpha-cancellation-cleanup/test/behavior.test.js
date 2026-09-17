import test from "node:test"
import assert from "node:assert/strict"
import { cancelRun } from "../src/run.js"
test("cleans all owned resources once", () => {
	let releases = 0
	const run = {
		state: "running",
		timer: {},
		lease: {
			release() {
				releases++
			},
		},
	}
	cancelRun(run)
	cancelRun(run)
	assert.deepEqual(
		{ state: run.state, timer: run.timer, lease: run.lease },
		{ state: "cancelled", timer: null, lease: null },
	)
	assert.equal(releases, 1)
})
