import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test, type TestContext } from "node:test"

import {
	WorkflowProcessCapture,
	snapshotWorkflowProcessWorkspace,
	workflowProcessRootDigest,
} from "./workflowProcessCapture"

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const binding = {
	taskIdentity: "fixture@1",
	runId: "real-observer-contract",
	variantIdentity: "fixture@1:" + digest("variant"),
	decisionPlanDigest: digest("plan"),
}
const requirements = { initialValidation: true, finalValidation: true, instructions: [], hooks: [] }
const validationCommands = [{ command: "node", args: ["--test"] }]

async function fixture(t: TestContext) {
	const temporary = await fs.realpath(os.tmpdir())
	const directory = await fs.realpath(await fs.mkdtemp(path.join(temporary, "alpha-process-capture-")))
	t.after(async () => {
		assert.equal(path.dirname(await fs.realpath(directory)), temporary)
		await fs.rm(directory, { recursive: true, force: true })
	})
	const workspace = path.join(directory, "workspace")
	await fs.mkdir(workspace)
	await fs.mkdir(path.join(workspace, "src"))
	await fs.writeFile(path.join(workspace, "src", "main.js"), "export const value = 1\n")
	await fs.writeFile(path.join(workspace, "README.md"), "Test fixture\n")
	return { directory, workspace }
}

class TaskFixture {
	taskId = "owned-task"
	executionMode = "selective-parallel"
	acceptedToolCallIds: string[] = []
	effectStartedToolCallIds: string[] = []
	readonly observations: unknown[] = []
	getCanonicalLifecycleSnapshot() {
		return this
	}
	async enqueueCanonicalLifecycleEvent(
		type: string,
		payload: { item?: { toolCallId: string }; toolCallId?: string },
	) {
		if (type === "tool_call_accepted") this.acceptedToolCallIds.push(payload.item!.toolCallId)
		if (type === "tool_effect_started") this.effectStartedToolCallIds.push(payload.toolCallId!)
	}
	async recordToolCallForStopping(...args: unknown[]) {
		this.observations.push(args)
	}
	async appendAgentTurnEvent(event: unknown) {
		this.observations.push(event)
	}
	async accept(callId: string, name: string, args: unknown) {
		await this.enqueueCanonicalLifecycleEvent("tool_call_accepted", {
			item: { toolCallId: callId, name, arguments: args },
		} as never)
		await this.enqueueCanonicalLifecycleEvent("tool_effect_started", { toolCallId: callId })
	}
	async terminal(
		callId: string,
		name: string,
		args: unknown,
		exitCode: number | undefined,
		status: "success" | "error" = "success",
	) {
		await this.recordToolCallForStopping(name, args, status, "test", {
			callId,
			name,
			status,
			exitCode,
			executionStatus: exitCode === undefined ? undefined : exitCode === 0 ? "success" : "error",
		})
		await this.appendAgentTurnEvent({ type: "tool_result", callId, name, status, output: "ignored candidate text" })
		if (exitCode !== undefined)
			await this.appendAgentTurnEvent({
				type: "verification_result",
				toolName: name,
				status: exitCode === 0 ? "success" : "error",
				exitCode,
			})
	}
}

test("source snapshots match raw private tree rows and omit only declared generated paths and verified marker", async (t) => {
	const { workspace } = await fixture(t)
	await fs.mkdir(path.join(workspace, ".git"))
	await fs.writeFile(path.join(workspace, ".git", "config"), "git metadata")
	await fs.mkdir(path.join(workspace, "src", "__pycache__"))
	await fs.writeFile(path.join(workspace, "src", "__pycache__", "main.pyc"), "cache")
	await fs.writeFile(
		path.join(workspace, ".alpha-e2e-owned.json"),
		'{"schemaVersion":1,"purpose":"alpha-vscode-e2e","kind":"workspace"}',
	)
	const snapshot = await snapshotWorkflowProcessWorkspace(workspace)
	const rows: Array<[string, string | null]> = [
		["README.md", digest("Test fixture\n")],
		["src/", null],
		["src/main.js", digest("export const value = 1\n")],
	]
	assert.deepEqual(snapshot.rows, rows)
	assert.equal(snapshot.digest, digest(JSON.stringify(rows, null, 2) + "\n"))
	await fs.writeFile(
		path.join(workspace, ".alpha-e2e-owned.json"),
		'{"schemaVersion":1,"purpose":"alpha-vscode-e2e","kind":"workspace","extra":true}',
	)
	await assert.rejects(snapshotWorkflowProcessWorkspace(workspace), /Invalid controller/)
})

test("snapshots reject links, hardlinks, excessive bytes and inherited root paths", async (t) => {
	const { workspace, directory } = await fixture(t)
	await assert.rejects(snapshotWorkflowProcessWorkspace(workspace, { fileBytes: 1 }), /byte bound/)
	await fs.link(path.join(workspace, "README.md"), path.join(workspace, "duplicate.md"))
	await assert.rejects(snapshotWorkflowProcessWorkspace(workspace), /Linked or special/)
	await fs.unlink(path.join(workspace, "duplicate.md"))
	await fs.mkdir(path.join(directory, "outside"))
	try {
		await fs.symlink(
			path.join(directory, "outside"),
			path.join(workspace, "linked"),
			process.platform === "win32" ? "junction" : "dir",
		)
	} catch (error) {
		if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return
		throw error
	}
	await assert.rejects(snapshotWorkflowProcessWorkspace(workspace), /Linked or special/)
})

test("actual effect fences capture initial failure, shell edit and final successful validation against measured revisions", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	capture.onTaskPrompt("Repair this fixture")
	await task.appendAgentTurnEvent({ type: "model_request_started", attempt: 0 })
	capture.onModelRequest([{ role: 1, content: [{ value: "Repair this fixture" }] }])
	await task.accept("baseline", "exec_command", { cmd: "node --test" })
	await task.terminal("baseline", "exec_command", { cmd: "node --test" }, 1)
	await task.accept("edit", "exec_command", { cmd: "node scripts/fix.js" })
	await fs.writeFile(path.join(workspace, "src", "main.js"), "export const value = 2\n")
	await task.terminal("edit", "exec_command", { cmd: "node scripts/fix.js" }, 0)
	await task.accept("validate", "exec_command", { cmd: "node --test" })
	await task.terminal("validate", "exec_command", { cmd: "node --test" }, 0)
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert.equal(result.capture.trace, "complete", result.diagnostics.gaps.join(", "))
	assert.equal(result.capture.sourceVersions, "complete", result.diagnostics.gaps.join(", "))
	assert.equal(result.capture.instructionDelivery, "complete")
	assert.equal(result.capture.hookDelivery, "unavailable")
	assert.deepEqual(result.changedPaths, ["src/main.js"])
	assert.notEqual(result.binding.initialWorkspaceDigest, result.binding.finalWorkspaceDigest)
	const baseline = result.trace.find(
		(event) => event.type === "agent.turn.tool_result" && event.payload.callId === "baseline",
	)!
	assert.equal(baseline.payload.exitCode, 1)
	assert.equal(baseline.payload.status, "error")
	const edit = result.trace.find(
		(event) => event.type === "agent.turn.tool_result" && event.payload.callId === "edit",
	)!
	assert.equal(edit.payload.mutatesWorkspace, true)
	const final = result.trace.find(
		(event) => event.type === "agent.turn.tool_result" && event.payload.callId === "validate",
	)!
	const source = result.sourceVersions.find((version) => version.sequence === final.sequence)!
	assert.equal(source.beforeWorkspaceDigest, result.binding.finalWorkspaceDigest)
	assert.equal(source.workspaceDigest, result.binding.finalWorkspaceDigest)
	assert.equal(task.executionMode, "selective-parallel")
	assert.equal(Object.hasOwn(task, "enqueueCanonicalLifecycleEvent"), false)
	assert.equal(Object.hasOwn(task, "recordToolCallForStopping"), false)
	assert.equal(JSON.stringify(result).includes("ignored candidate text"), false)
})

test("concurrent effects preserve concurrency and make overlapping revision coverage unavailable", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	await task.accept("first", "exec_command", { cmd: "node --test first" })
	await task.accept("second", "exec_command", { cmd: "node --test second" })
	await task.terminal("second", "exec_command", { cmd: "node --test second" }, 0)
	await task.terminal("first", "exec_command", { cmd: "node --test first" }, 0)
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert(result.diagnostics.gaps.includes("overlapping-effect-source-windows"))
	assert.equal(result.capture.sourceVersions, "partial")
	assert.equal(task.executionMode, "selective-parallel")
})

test("source changes are observed even after an error and a later restoration", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	await task.accept("failed-write", "exec_command", { cmd: "node scripts/write-and-fail.js" })
	await fs.writeFile(path.join(workspace, "src", "main.js"), "changed\n")
	await task.terminal("failed-write", "exec_command", { cmd: "node scripts/write-and-fail.js" }, 1, "error")
	await task.accept("restore", "exec_command", { cmd: "node scripts/restore.js" })
	await fs.writeFile(path.join(workspace, "src", "main.js"), "export const value = 1\n")
	await task.terminal("restore", "exec_command", { cmd: "node scripts/restore.js" }, 0)
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert.deepEqual(result.changedPaths, [])
	assert.equal(result.binding.initialWorkspaceDigest, result.binding.finalWorkspaceDigest)
	assert(result.sourceVersions.some((row) => row.workspaceDigest !== result.binding.initialWorkspaceDigest))
	assert.equal(
		result.trace.find(
			(event) => event.payload.callId === "failed-write" && event.type === "agent.turn.tool_result",
		)!.payload.mutatesWorkspace,
		true,
	)
})

test("a yielded command cannot close its source window merely because its tool handler returned", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	await task.accept("background", "exec_command", { cmd: "node slow.js" })
	await task.recordToolCallForStopping("exec_command", { cmd: "node slow.js" }, "success", undefined, {
		callId: "background",
		name: "exec_command",
		status: "success",
		executionStatus: "running",
	})
	await task.appendAgentTurnEvent({
		type: "tool_result",
		callId: "background",
		name: "exec_command",
		status: "success",
	})
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert.equal(result.capture.sourceVersions, "partial")
	assert(result.diagnostics.gaps.includes("background-command-source-window-unsettled"))
})

test("command location comes from the completed native receipt, not the requested working directory", async (t) => {
	const { workspace } = await fixture(t)
	const empty = path.join(workspace, "empty")
	await fs.mkdir(empty)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	Object.assign(task, {
		getCommandExecutionEvidence: () => [
			{
				toolCallId: "validate",
				executionId: "physical-process",
				command: "node --test",
				cwd: empty,
				status: "succeeded",
				exitCode: 0,
				startedAt: Date.now() - 5,
				completedAt: Date.now(),
			},
		],
	})
	capture.attachTask(task)
	await task.accept("validate", "exec_command", { cmd: "node --test", workdir: workspace })
	await task.terminal("validate", "exec_command", { cmd: "node --test", workdir: workspace }, 0)
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert.equal(result.binding.workspaceRootDigest, await workflowProcessRootDigest(workspace))
	assert.equal(result.capture.commandContexts, "complete")
	assert.equal(result.commandContexts.length, 1)
	assert.equal(result.commandContexts[0]!.actualCwdDigest, await workflowProcessRootDigest(empty))
	assert.notEqual(result.commandContexts[0]!.actualCwdDigest, result.binding.workspaceRootDigest)
	const terminal = result.trace.find(
		(row) => row.type === "agent.turn.tool_result" && row.payload.callId === "validate",
	)!
	assert.equal(result.commandContexts[0]!.sequence, terminal.sequence)
})

test("requested cwd and contradictory or duplicate native receipts cannot invent actual command context", async (t) => {
	const { workspace } = await fixture(t)
	for (const kind of ["requested-only", "contradictory", "duplicate"]) {
		const capture = new WorkflowProcessCapture({ workspace })
		await capture.ready()
		const task = new TaskFixture()
		const receipt = {
			toolCallId: "validate",
			executionId: "physical-process",
			command: "node --test",
			cwd: workspace,
			status: "succeeded",
			exitCode: kind === "contradictory" ? 1 : 0,
			startedAt: Date.now() - 5,
			completedAt: Date.now(),
		}
		if (kind !== "requested-only")
			Object.assign(task, {
				getCommandExecutionEvidence: () => (kind === "duplicate" ? [receipt, receipt] : [receipt]),
			})
		capture.attachTask(task)
		await task.accept("validate", "exec_command", { cmd: "node --test", workdir: workspace })
		await task.terminal("validate", "exec_command", { cmd: "node --test", workdir: workspace }, 0)
		await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
		const result = await capture.finalize({ binding, validationCommands, requirements })
		assert.equal(result.capture.commandContexts, "unavailable", kind)
		assert.deepEqual(result.commandContexts, [], kind)
		assert.equal(result.capture.trace, "complete", kind)
	}
})

test("missing actual observer methods and unavailable identity do not acquire complete capture", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	capture.attachTask({ taskId: "missing-methods" })
	const result = await capture.finalize({
		binding: { ...binding, variantIdentity: "unavailable:executed-variant" },
		validationCommands,
		requirements,
	})
	assert.equal(result.bindingComplete, false)
	assert.equal(result.capture.trace, "partial")
	assert.equal(result.capture.sourceVersions, "partial")
	assert(result.diagnostics.gaps.includes("actual-effect-observer-boundary-unavailable"))
})

test("a prompt first seen in a later model request cannot claim delivery before the first request", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	capture.onTaskPrompt("Repair this fixture")
	await task.appendAgentTurnEvent({ type: "model_request_started", attempt: 0 })
	capture.onModelRequest([{ role: 1, content: [{ value: "Unrelated text" }] }])
	await task.appendAgentTurnEvent({ type: "model_request_started", attempt: 0 })
	capture.onModelRequest([{ role: 1, content: [{ value: "Repair this fixture" }] }])
	await task.appendAgentTurnEvent({ type: "task_completed", status: "completed" })
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert.equal(result.capture.instructionDelivery, "unavailable")
	assert.deepEqual(result.instructions, [])
})

test("finalizing directly after validation preserves its before-source proof and method failures remain original", async (t) => {
	const { workspace } = await fixture(t)
	const capture = new WorkflowProcessCapture({ workspace })
	await capture.ready()
	const task = new TaskFixture()
	capture.attachTask(task)
	await task.accept("validate", "exec_command", { cmd: "node --test" })
	await task.terminal("validate", "exec_command", { cmd: "node --test" }, 0)
	const result = await capture.finalize({ binding, validationCommands, requirements })
	assert(result.sourceVersions.find((row) => row.beforeWorkspaceDigest === result.binding.finalWorkspaceDigest))
	await assert.rejects(capture.finalize({ binding, validationCommands, requirements }), /already finalized/)
	const failure = new Error("original failure")
	const other = new TaskFixture()
	other.appendAgentTurnEvent = async () => {
		throw failure
	}
	const observing = new WorkflowProcessCapture({ workspace })
	await observing.ready()
	observing.attachTask(other)
	await assert.rejects(other.appendAgentTurnEvent({ type: "model_request_started" }), (error) => error === failure)
	const failed = await observing.finalize({ binding, validationCommands, requirements })
	assert(failed.diagnostics.gaps.includes("observed-task-boundary-failed"))
})
