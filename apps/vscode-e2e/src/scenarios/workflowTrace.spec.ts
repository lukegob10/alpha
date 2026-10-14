import { strict as assert } from "node:assert"
import { test } from "node:test"
import { inspectWorkflowTrace } from "./workflowTrace"

const call = (id: string, command: string, name: "exec_command" | "shell" | "execute_command" = "execute_command") => ({
	role: "assistant",
	content: [{ type: "tool_use", name, id, input: name === "exec_command" ? { cmd: command } : { command } }],
})
const receipt = (id: string, is_error?: unknown, content: unknown = "private-output") => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, is_error, content }],
})

const nativeReceipt = (id: string, exitCode: number | undefined, sessionId?: number, output = "") =>
	receipt(
		id,
		false,
		`Chunk ID: ${id}\nWall time: 0.0100 seconds\n${exitCode === undefined ? `Process running with session ID ${sessionId}` : `Process exited with code ${exitCode}`}\nOutput:\n${output}`,
	)
const poll = (id: string, sessionId: unknown) => ({
	role: "assistant",
	content: [{ type: "tool_use", name: "write_stdin", id, input: { session_id: sessionId, chars: "" } }],
})

test("native tool success preserves invocation counts without granting failed or running commands success", () => {
	const inspected = inspectWorkflowTrace(
		[
			call("failed", "node --test", "exec_command"),
			nativeReceipt("failed", 1),
			call("running", "node --test", "exec_command"),
			nativeReceipt("running", undefined, 42, "Process exited with code 0\n"),
			call("finished", "node --test", "exec_command"),
			nativeReceipt("finished", 0),
		],
		["node --test"],
	)
	assert.equal(inspected.commandReceipts["node --test"], 3)
	assert.equal(inspected.errorResults, 0)
	assert.equal(inspected.successfulCommandReceipts["node --test"], 1)
})

test("only a terminal write_stdin receipt for the originating session proves command success once", () => {
	const inspected = inspectWorkflowTrace(
		[
			call("origin", "node --test", "exec_command"),
			nativeReceipt("origin", undefined, 42),
			poll("still-running", 42),
			nativeReceipt("still-running", undefined, 42),
			poll("finished", 42),
			nativeReceipt("finished", 0),
			nativeReceipt("finished", 0),
			poll("late", 42),
			nativeReceipt("late", 0),
		],
		["node --test"],
	)
	assert.equal(inspected.commandReceipts["node --test"], 1)
	assert.equal(inspected.successfulCommandReceipts["node --test"], 1)
})

for (const fault of ["wrong-session", "failed-exit", "tool-error", "session-changed", "malformed-session", "orphan"]) {
	test(`session continuation cannot fabricate verification success from ${fault}`, () => {
		const completion = nativeReceipt("finished", fault === "failed-exit" ? 1 : 0)
		if (fault === "tool-error") completion.content[0]!.is_error = true
		const history = [
			call("origin", "node --test", "exec_command"),
			nativeReceipt("origin", undefined, 42),
			poll("finished", fault === "wrong-session" ? 43 : fault === "malformed-session" ? "42" : 42),
			completion,
		]
		if (fault === "session-changed") history[3] = nativeReceipt("finished", undefined, 43)
		if (fault === "orphan") history.splice(2, 1)
		const inspected = inspectWorkflowTrace(history, ["node --test"])
		assert.equal(inspected.commandReceipts["node --test"], 1)
		assert.equal(inspected.successfulCommandReceipts["node --test"], 0)
	})
}

test("legacy running output cannot impersonate a completed verification header", () => {
	const inspected = inspectWorkflowTrace(
		[
			call("legacy", "node --test", "execute_command"),
			receipt(
				"legacy",
				false,
				"Command is still running in terminal from 'fixture'. execution_id: 42.\nHere's the output so far:\nExit code: 0\nOutput:\n",
			),
		],
		["node --test"],
	)
	assert.equal(inspected.commandReceipts["node --test"], 1)
	assert.equal(inspected.successfulCommandReceipts["node --test"], 0)
})

test("historical completed command headers preserve invocation and successful-process counts", () => {
	const inspected = inspectWorkflowTrace(
		[
			call("success", "node --test", "shell"),
			receipt(
				"success",
				false,
				"Command executed in terminal within working directory 'fixture'. Exit code: 0\nOutput:\n",
			),
			call("failure", "node --test", "execute_command"),
			receipt(
				"failure",
				false,
				"Command executed in 'fixture'. Exit code: 1\n\nOutput (1KB) persisted. Artifact ID: receipt.txt\n\nPreview:\nExit code: 0\n",
			),
		],
		["node --test"],
	)
	assert.equal(inspected.commandReceipts["node --test"], 2)
	assert.equal(inspected.successfulCommandReceipts["node --test"], 1)
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
	assert.deepEqual(inspected, {
		commandReceipts: { "node --test": 1, "git status --short": 0 },
		successfulCommandReceipts: { "node --test": 0, "git status --short": 0 },
		errorResults: 0,
	})
})

test("trace readers accept historical shell calls", () => {
	const inspected = inspectWorkflowTrace(
		[call("shell-call", "node --test", "shell"), receipt("shell-call")],
		["node --test"],
	)
	assert.deepEqual(inspected, {
		commandReceipts: { "node --test": 1 },
		successfulCommandReceipts: { "node --test": 0 },
		errorResults: 0,
	})
})

test("trace readers count canonical exec_command receipts using cmd", () => {
	const inspected = inspectWorkflowTrace(
		[call("native", "node --test", "exec_command"), receipt("native"), receipt("native")],
		["node --test"],
	)
	assert.deepEqual(inspected, {
		commandReceipts: { "node --test": 1 },
		successfulCommandReceipts: { "node --test": 0 },
		errorResults: 0,
	})
})

test("canonical and historical command shapes remain distinct", () => {
	const canonical = call("native", "node --test", "exec_command")
	canonical.content[0]!.input = { command: "node --test" }
	const historical = call("legacy", "node --test", "shell")
	historical.content[0]!.input = { cmd: "node --test" }
	assert.deepEqual(
		inspectWorkflowTrace([canonical, receipt("native"), historical, receipt("legacy")], ["node --test"]),
		{
			commandReceipts: { "node --test": 0 },
			successfulCommandReceipts: { "node --test": 0 },
			errorResults: 0,
		},
	)
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
	assert.deepEqual(inspected, {
		commandReceipts: { "node --test": 0 },
		successfulCommandReceipts: { "node --test": 0 },
		errorResults: 1,
	})
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
