import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import { WorkflowRequestBudget } from "./requestBudget"
import { ENHANCED_SOURCE, scriptedTests, WorkflowScriptedAI } from "./scriptedWorkflow"
import { applyFixturePatch } from "./fixturePatchTestHelper"

const resultMessage = (id: string, text: string) => [
	{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
]

test("scripted command settlement drains the current canonical session before ordinary completion", async () => {
	const provider = new WorkflowScriptedAI(new WorkflowRequestBudget(20), "/fixture")
	provider.setPhase("commandSettlement", 1)
	let commandId = ""
	for (let request = 0; request < 10 && !commandId; request++) {
		for await (const chunk of provider.createMessage()) {
			assert.notEqual(chunk.type, "text")
			if (chunk.type === "tool_call" && (chunk.name === "exec_command" || chunk.name === "shell"))
				commandId = chunk.id
		}
	}
	assert.ok(commandId)
	const running = `Chunk ID: ${commandId}\nWall time: 1.0000 seconds\nProcess running with session ID 42\nOutput:\npending receipt`
	const chunks = []
	for await (const chunk of provider.createMessage("", resultMessage(commandId, running))) chunks.push(chunk)
	const wait = chunks.find((chunk) => chunk.type === "tool_call")
	assert.equal(wait?.type, "tool_call")
	if (wait?.type !== "tool_call") throw new Error("Missing command wait")
	assert.equal(wait.name, "write_stdin")
	assert.deepEqual(JSON.parse(wait.arguments), { session_id: 42, chars: "", yield_time_ms: 10_000 })
	assert.equal(
		chunks.some((chunk) => chunk.type === "text"),
		false,
	)
	const settled = `Chunk ID: ${wait.id}\nWall time: 0.5000 seconds\nProcess exited with code 0\nOutput:\nreceipt persisted`
	const final = []
	for await (const chunk of provider.createMessage("", resultMessage(wait.id, settled))) final.push(chunk)
	assert.equal(final.filter((chunk) => chunk.type === "text").length, 1)
	assert.equal(
		final.some((chunk) => chunk.type === "tool_call"),
		false,
	)
})

test("scripted session waits ignore unrelated receipts and running text inside command output", async () => {
	for (const fault of ["wrong-id", "output-text"] as const) {
		const provider = new WorkflowScriptedAI(new WorkflowRequestBudget(20), "/fixture")
		provider.setPhase("hold")
		const first = []
		for await (const chunk of provider.createMessage()) first.push(chunk)
		const call = first.find((chunk) => chunk.type === "tool_call")
		if (call?.type !== "tool_call") throw new Error("Missing command")
		const prefix = `Chunk ID: ${call.id}\nWall time: 0.1000 seconds\n`
		const text =
			fault === "wrong-id"
				? `${prefix}Process running with session ID 42\nOutput:\nready`
				: `${prefix}Process exited with code 0\nOutput:\nProcess running with session ID 42`
		const next = []
		for await (const chunk of provider.createMessage(
			"",
			resultMessage(fault === "wrong-id" ? "foreign" : call.id, text),
		))
			next.push(chunk)
		assert.equal(
			next.some((chunk) => chunk.type === "tool_call"),
			false,
		)
		assert.equal(next.filter((chunk) => chunk.type === "text").length, 1)
	}
})

test("sequential extension patches retain one executable accumulated-case loop", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-scripted-extend-")))
	try {
		await fs.mkdir(path.join(root, "test"))
		await fs.mkdir(path.join(root, "lib"))
		await fs.writeFile(path.join(root, "lib/stats.cjs"), ENHANCED_SOURCE)
		await fs.writeFile(path.join(root, "test/stats.test.cjs"), scriptedTests(true, false))
		const provider = new WorkflowScriptedAI(new WorkflowRequestBudget(20), root)
		const environment = { ...process.env }
		delete environment.NODE_TEST_CONTEXT
		for (const step of [1, 2]) {
			provider.setPhase("extend", step)
			let complete = false
			for (let request = 0; request < 10 && !complete; request++) {
				for await (const chunk of provider.createMessage()) {
					if (chunk.type === "text") complete = true
					if (chunk.type === "tool_call" && chunk.name === "apply_patch")
						await applyFixturePatch(root, JSON.parse(chunk.arguments).patch)
				}
			}
			assert.equal(complete, true)
			const result = await promisify(execFile)(
				process.execPath,
				["--test", "--test-reporter=tap", "test/stats.test.cjs"],
				{
					cwd: root,
					env: environment,
					windowsHide: true,
					timeout: 10_000,
					maxBuffer: 128 * 1024,
				},
			)
			assert.match(result.stdout, new RegExp(`^# tests ${3 + step}$`, "m"))
			assert.equal(await fs.readFile(path.join(root, "test/stats.test.cjs"), "utf8"), scriptedTests(true, true))
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
