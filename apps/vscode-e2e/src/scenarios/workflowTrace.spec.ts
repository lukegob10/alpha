import { strict as assert } from "node:assert"
import { test } from "node:test"
import { inspectWorkflowTrace } from "./workflowTrace"

const call = (id: string, command: string) => ({
	role: "assistant",
	content: [{ type: "tool_use", name: "execute_command", id, input: { command } }],
})
const receipt = (id: string, is_error?: unknown) => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, is_error, content: "private-output" }],
})

test("trace checks require actual matching receipts, never assistant claims or missing calls", () => {
	const inspected = inspectWorkflowTrace(
		[
			{ role: "assistant", content: "I ran the tests successfully" },
			call("a", "node --test"),
			receipt("a"),
			receipt("a"),
			call("b", "git status --short"),
			receipt("orphan"),
		],
		["node --test", "git status --short"],
	)
	assert.deepEqual(inspected, { commandReceipts: { "node --test": 1, "git status --short": 0 }, errorResults: 0 })
})

test("failed or malformed command receipts never count as successful; raw data is not projected", () => {
	const inspected = inspectWorkflowTrace(
		[
			call("a", "node --test"),
			receipt("a", true),
			call("b", "node --test"),
			receipt("b", "false"),
			call("c", "private-command --token=secret"),
			receipt("c"),
		],
		["node --test"],
	)
	assert.deepEqual(inspected, { commandReceipts: { "node --test": 0 }, errorResults: 1 })
	assert.doesNotMatch(JSON.stringify(inspected), /private|secret/)
})

test("orphan and wrong-role receipts cannot retroactively confirm a command", () => {
	const inspected = inspectWorkflowTrace(
		[
			receipt("a"),
			call("a", "node --test"),
			receipt("a"),
			call("b", "node --test"),
			{ ...receipt("b"), role: "assistant" },
		],
		["node --test"],
	)
	assert.equal(inspected.commandReceipts["node --test"], 0)
})
