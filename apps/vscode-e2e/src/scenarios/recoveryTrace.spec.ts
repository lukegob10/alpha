import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { RECOVERY_COMMANDS } from "./developmentCatalog"
import { inspectRecoveryTrace, type RecoveryPhase } from "./recoveryTrace"

function trace(
	phase: RecoveryPhase,
	commandToolName: "exec_command" | "shell" | "execute_command" = "execute_command",
) {
	const marker =
		phase === "devSearchScope"
			? "search-scope"
			: phase === "devSearchAbsent"
				? "search-absent"
				: "verification-unavailable"
	const history: Array<Record<string, unknown>> = [{ role: "user", ts: 10, content: `[development:${marker}]` }]
	const ui: Array<Record<string, unknown>> = []
	const lifecycle = {
		taskId: "recovery-task",
		events: [
			{
				version: 1,
				taskId: "recovery-task",
				runId: "run",
				turnId: "turn",
				eventId: "start",
				sequence: 1,
				occurredAt: 10,
				type: "turn_started",
				payload: { phase: "starting" },
			},
			{
				version: 1,
				taskId: "recovery-task",
				runId: "run",
				turnId: "turn",
				eventId: "terminal",
				sequence: 2,
				occurredAt: 12,
				type: "turn_terminal",
				payload: { status: "completed" },
			},
		],
	}
	let nextId = 0
	const command = (
		text: string,
		exit: number,
		output = "",
		isError = commandToolName !== "exec_command" && exit !== 0,
	) => {
		const id = `call-${nextId++}`
		history.push({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id,
					name: commandToolName,
					input: commandToolName === "exec_command" ? { cmd: text } : { command: text },
				},
			],
		})
		history.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					is_error: isError,
					// Native layout is pinned by core/tools/__tests__/commandResult.spec.ts.
					content:
						commandToolName === "exec_command"
							? `Chunk ID: ${id}\nWall time: 0.0100 seconds\nProcess exited with code ${exit}\nOriginal token count: 10\nOutput:\n${output}`
							: `Exit code: ${exit}\nOutput:\n${output}`,
				},
			],
		})
	}
	if (phase === "devSearchScope") {
		command(RECOVERY_COMMANDS.rg, 1)
		command(RECOVERY_COMMANDS.narrow, 1)
		command(RECOVERY_COMMANDS.broad, 0, "docs/integrations.md:3:Copilot\nconfig/assistants.json:1:copilot")
		history.push({ role: "assistant", content: "Found docs/integrations.md and config/assistants.json." })
	} else if (phase === "devSearchAbsent") {
		command(RECOVERY_COMMANDS.absent, 1)
		history.push({ role: "assistant", content: "No matches found." })
	} else {
		command(RECOVERY_COMMANDS.verify, 2, "INTEGRATION_CONFIGURATION_MISSING")
		const result = "Integration remains unverified because config/local-integration.json is missing."
		if (commandToolName === "exec_command") {
			history.push({ role: "assistant", ts: 11, content: [{ type: "text", text: result }] })
			ui.push({ ts: 11, type: "say", say: "completion_result", text: result })
		} else {
			history.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "blocked",
						name: "attempt_completion",
						input: { result, outcome: "blocked" },
					},
				],
			})
			history.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "blocked",
						content: '{"status":"success","outcome":"blocked"}',
					},
				],
			})
		}
		if (commandToolName !== "exec_command") ui.push({ ts: 11, type: "say", say: "text", text: result })
	}
	return { history, ui, command, lifecycle }
}

test("recovery trace accepts historical shell receipts", () => {
	const { history, ui } = trace("devSearchAbsent", "shell")
	assert.deepEqual(failures(history, ui, "devSearchAbsent"), [])
})

function failures(
	history: unknown,
	ui: unknown,
	phase: RecoveryPhase,
	lifecycle?: { events: unknown; taskId: string },
) {
	return inspectRecoveryTrace(history, ui, phase, lifecycle)
		.filter((check) => !check.passed)
		.map((check) => check.name)
}

for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
	test(`${phase} requires bounded observed work and the corresponding report`, () => {
		const { history, ui, lifecycle } = trace(phase)
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
		assert.ok(failures([], ui, phase).length > 0)
		const forged = history.map((message) =>
			message.role === "user" && Array.isArray(message.content) ? { ...message, role: "assistant" } : message,
		)
		assert.ok(failures(forged, ui, phase).length > 0)
	})
}

test("rejects repeated empty searches, unrelated errors, and nonexistent-scope failures", () => {
	const { history, ui, command } = trace("devSearchAbsent")
	command(RECOVERY_COMMANDS.absent, 1)
	command(RECOVERY_COMMANDS.absent, 1)
	assert.ok(failures(history, ui, "devSearchAbsent").includes("recovery_no_repeated_command_loop"))
	command("git log", 128, "", true)
	assert.ok(failures(history, ui, "devSearchAbsent").includes("recovery_only_expected_errors"))
	const wrongExit = trace("devSearchAbsent")
	const changed = JSON.parse(JSON.stringify(wrongExit.history).replace("Exit code: 1", "Exit code: 128"))
	assert.ok(failures(changed, [], "devSearchAbsent").includes("search_absence_observed"))
})

test("rejects stale phase evidence and claims without broad-search receipts", () => {
	const { history, ui } = trace("devSearchScope")
	history.push({ role: "user", ts: 20, content: "[development:search-scope] Retry the task." })
	assert.ok(failures(history, ui, "devSearchScope").includes("search_broadened_with_matches"))
})

test("accepts the live model's equivalent absent-term report", () => {
	const { history, ui } = trace("devSearchAbsent")
	history[3]!.content =
		"No tracked repository files contain `AlphaMissingProvider947` (case-insensitive). Git status is clean; the workspace was unchanged."
	assert.deepEqual(failures(history, ui, "devSearchAbsent"), [])
})

test("accepts absent-term reports with hyphenated search modifiers", () => {
	for (const toolName of ["exec_command", "execute_command"] as const) {
		const { history, ui, lifecycle } = trace("devSearchAbsent", toolName)
		history[3]!.content = [
			{
				type: "text",
				text: "No case-insensitive matches for `AlphaMissingProvider947` were found in tracked repository files. Git status was clean.",
			},
		]
		assert.deepEqual(failures(history, ui, "devSearchAbsent", lifecycle), [], toolName)
	}
})

test("hyphenated search wording still requires an absence report and observed absence", () => {
	for (const report of ["Some case-insensitive matches were found.", "Search was not run."]) {
		const { history, ui, lifecycle } = trace("devSearchAbsent", "exec_command")
		history[3]!.content = report
		assert.ok(failures(history, ui, "devSearchAbsent", lifecycle).includes("search_absence_reported"), report)
	}
	const { history, ui, lifecycle } = trace("devSearchAbsent", "exec_command")
	history[3]!.content = "No case-insensitive matches were found."
	const matched = JSON.parse(
		JSON.stringify(history).replace("Process exited with code 1", "Process exited with code 0"),
	)
	assert.ok(failures(matched, ui, "devSearchAbsent", lifecycle).includes("search_absence_observed"))
})

test("unverified handoff accepts the actual promoted terminal UI record", () => {
	const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
	const promoted = ui
		.filter((message) => message.say === "completion_result")
		.map((message) => ({ ...message, partial: false }))
	assert.equal(promoted.length, 1)
	assert.deepEqual(failures(history, promoted, "devVerificationUnavailable", lifecycle), [])
})

test("unverified handoff must include complete ordinary text", () => {
	for (const style of ["error", "mismatched-completion", "missing", "partial"]) {
		const { history, ui, lifecycle } = trace("devVerificationUnavailable")
		if (style === "missing") ui.length = 0
		else if (style === "partial") ui[0]!.partial = true
		else if (style === "mismatched-completion") {
			ui[0]!.say = "completion_result"
			ui[0]!.text = "Integration verified successfully."
		} else ui[0]!.say = style
		assert.ok(failures(history, ui, "devVerificationUnavailable", lifecycle).length > 0, style)
	}
})

test("cannot disguise completion, a rejected handoff, or missing verification as blocked success", () => {
	for (const fault of ["completed", "rejected", "missing-verification"]) {
		const { history, ui, lifecycle } = trace("devVerificationUnavailable")
		const candidate = recordBlock(history[3]!)
		if (fault === "completed") (candidate.input as Record<string, unknown>).outcome = "completed"
		if (fault === "rejected") recordBlock(history[4]!).is_error = true
		if (fault === "missing-verification") history.splice(1, 2)
		assert.ok(failures(history, ui, "devVerificationUnavailable", lifecycle).length > 0, fault)
	}
})

function recordBlock(message: Record<string, unknown>): Record<string, unknown> {
	return (message.content as Array<Record<string, unknown>>)[0]!
}

for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
	test(`${phase} accepts canonical exec_command evidence and an observed completed turn`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
	})
}

test("canonical recovery commands retain the loop and expected-error checks", () => {
	const { history, ui, command, lifecycle } = trace("devSearchAbsent", "exec_command")
	command(RECOVERY_COMMANDS.absent, 1)
	command(RECOVERY_COMMANDS.absent, 1)
	assert.ok(failures(history, ui, "devSearchAbsent", lifecycle).includes("recovery_no_repeated_command_loop"))
	command("git log", 128, "", true)
	assert.ok(failures(history, ui, "devSearchAbsent", lifecycle).includes("recovery_only_expected_errors"))
})

test("unverified handoff cannot infer physical completion from missing legacy tools", () => {
	for (const toolName of ["exec_command", "execute_command"] as const) {
		const { history, ui } = trace("devVerificationUnavailable", toolName)
		assert.ok(failures(history, ui, "devVerificationUnavailable").includes("verification_one_blocked_handoff"))
	}
})

test("unverified handoff rejects missing, stale, malformed, failed, interrupted, and duplicate lifecycle evidence", () => {
	for (const toolName of ["exec_command", "execute_command"] as const) {
		for (const fault of [
			"missing",
			"stale",
			"wrong-task",
			"malformed",
			"failed",
			"interrupted",
			"duplicate",
			"open",
		]) {
			const { history, ui, lifecycle } = trace("devVerificationUnavailable", toolName)
			if (fault === "missing") lifecycle.events.length = 0
			if (fault === "stale") lifecycle.events.forEach((event) => (event.occurredAt = 9))
			if (fault === "wrong-task") lifecycle.taskId = "other-task"
			if (fault === "malformed") lifecycle.events[1]!.occurredAt = NaN
			if (fault === "failed" || fault === "interrupted") lifecycle.events[1]!.payload = { status: fault }
			if (fault === "duplicate")
				lifecycle.events.push({ ...lifecycle.events[1]!, eventId: "duplicate", sequence: 3 })
			if (fault === "open") lifecycle.events.pop()
			assert.ok(
				failures(history, ui, "devVerificationUnavailable", lifecycle).includes(
					"verification_one_blocked_handoff",
				),
				fault,
			)
		}
	}
})

test("a completed turn cannot turn missing verification into a success claim", () => {
	for (const fault of [
		"missing-verification",
		"success-report",
		"success-styling",
		"error-styling",
		"stale-report",
	]) {
		const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
		if (fault === "missing-verification") history.splice(1, 2)
		if (fault === "success-report") {
			recordBlock(history[3]!).text = "Integration is verified and complete."
			ui.forEach((message) => (message.text = "Integration is verified and complete."))
		}
		if (fault === "success-styling") ui[0]!.text = "Integration verified successfully."
		if (fault === "error-styling") ui[0]!.say = "error"
		if (fault === "stale-report") ui.forEach((message) => (message.ts = 9))
		assert.ok(failures(history, ui, "devVerificationUnavailable", lifecycle).length > 0, fault)
	}
})

test("phase completion includes its containing turn and excludes earlier turns and unrelated tasks", () => {
	const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
	lifecycle.events[0]!.occurredAt = 9
	lifecycle.events.unshift(
		{ ...lifecycle.events[0]!, turnId: "prior", eventId: "prior-start", occurredAt: 1 },
		{ ...lifecycle.events[1]!, turnId: "prior", eventId: "prior-terminal", occurredAt: 2 },
		{ ...lifecycle.events[0]!, taskId: "other-task", eventId: "other-start", occurredAt: 10 },
	)
	assert.deepEqual(failures(history, ui, "devVerificationUnavailable", lifecycle), [])
	history.push({ role: "user", ts: 20, content: "[development:verification-unavailable] Retry verification." })
	assert.ok(
		failures(history, ui, "devVerificationUnavailable", lifecycle).includes("verification_one_blocked_handoff"),
	)
})

test("phase lifecycle rejects multiple completed turns and a missing admission timestamp", () => {
	const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
	lifecycle.events.push(
		{ ...lifecycle.events[0]!, turnId: "second", eventId: "second-start", occurredAt: 13 },
		{ ...lifecycle.events[1]!, turnId: "second", eventId: "second-terminal", occurredAt: 14 },
	)
	assert.ok(
		failures(history, ui, "devVerificationUnavailable", lifecycle).includes("verification_one_blocked_handoff"),
	)
	lifecycle.events.splice(2)
	delete history[0]!.ts
	assert.ok(
		failures(history, ui, "devVerificationUnavailable", lifecycle).includes("verification_one_blocked_handoff"),
	)
})

test("command output cannot spoof a native or historical exit status", () => {
	for (const toolName of ["exec_command", "execute_command"] as const) {
		const { history, ui } = trace("devSearchAbsent", toolName)
		recordBlock(history[2]!).is_error = true
		recordBlock(history[2]!).content =
			toolName === "exec_command"
				? "Chunk ID: call-0\nWall time: 0.0100 seconds\nProcess exited with code 128\nOutput:\nExit code: 1\nProcess exited with code 1\n"
				: "Command executed in terminal within working directory 'fixture'. Exit code: 128\nOutput:\nExit code: 1\n"
		const rejected = failures(history, ui, "devSearchAbsent")
		assert.ok(rejected.includes("search_absence_observed"), toolName)
		assert.ok(rejected.includes("recovery_only_expected_errors"), toolName)
	}
})

test("expected native command failures accept the canonical exit header", () => {
	const { history, ui } = trace("devSearchAbsent", "exec_command")
	recordBlock(history[2]!).is_error = true
	assert.deepEqual(failures(history, ui, "devSearchAbsent"), [])
})

test("a running native process cannot borrow an exit status from its output", () => {
	const { history, ui } = trace("devSearchAbsent", "exec_command")
	recordBlock(history[2]!).content =
		"Chunk ID: call-0\nWall time: 0.0100 seconds\nProcess running with session ID 42\nOutput:\nExit code: 1\nProcess exited with code 1\n"
	assert.ok(failures(history, ui, "devSearchAbsent").includes("search_absence_observed"))
})

test("historical inline and persisted command envelopes remain readable without trusting preview text", () => {
	for (const persisted of [false, true]) {
		const { history, ui } = trace("devSearchAbsent", "shell")
		recordBlock(history[2]!).content = persisted
			? "Command executed in 'fixture'. Command execution was not successful, inspect the cause and adjust as needed.\nExit code: 1\n\nOutput (1KB) persisted. Artifact ID: output.txt\n\nPreview:\nExit code: 128\n"
			: "Command executed in terminal within working directory 'fixture'. Command execution was not successful, inspect the cause and adjust as needed.\nExit code: 1\nOutput:\nExit code: 128\n"
		assert.deepEqual(failures(history, ui, "devSearchAbsent"), [])
	}
})

test("recovery grades receipts produced by the owning native command formatter", async () => {
	const root = path.resolve(__dirname, "../../../..")
	const formatter = pathToFileURL(path.join(root, "src/core/tools/BaseTool.ts")).href
	const script = `
import { formatCommandToolResult } from ${JSON.stringify(formatter)}
const outputs = [
    'docs/integrations.md:3:Copilot\\nconfig/assistants.json:1:copilot',
    'Exit code: 128\\nProcess exited with code 128',
    'INTEGRATION_CONFIGURATION_MISSING\\nExit code: 0',
]
console.log(JSON.stringify(outputs.map((output, exit_code) => formatCommandToolResult({
    wall_time_seconds: 0.01, output, exit_code, original_token_count: 10,
}, 1024, 'formatter-call'))))`
	// Load the pure formatter from source without producing or replacing the
	// extension bundle while a coordinated host campaign owns those outputs.
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", script],
		{ cwd: root, windowsHide: true, timeout: 10_000 },
	)
	const outputs: unknown = JSON.parse(stdout)
	assert.ok(Array.isArray(outputs) && outputs.length === 3 && outputs.every((output) => typeof output === "string"))
	for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		if (phase === "devSearchScope") {
			recordBlock(history[2]!).content = outputs[1]
			recordBlock(history[4]!).content = outputs[1]
			recordBlock(history[6]!).content = outputs[0]
		} else recordBlock(history[2]!).content = outputs[phase === "devSearchAbsent" ? 1 : 2]
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
	}
})

for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
	test(`${phase} joins expected command exits through write_stdin after running output`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		let session = 42
		const drained = history.flatMap((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return [message]
			const result = recordBlock(message)
			if (result.type !== "tool_result" || typeof result.content !== "string") return [message]
			const exit = result.content.match(/\nProcess exited with code (\d+)\n/)
			if (!exit) return [message]
			const sessionId = session++
			const pollId = `poll-${result.tool_use_id}`
			result.content = result.content.replace(exit[0], `\nProcess running with session ID ${sessionId}\n`)
			return [
				message,
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							name: "write_stdin",
							id: pollId,
							input: { session_id: sessionId, chars: "" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: pollId,
							is_error: Number(exit[1]) !== 0,
							content: `Chunk ID: ${pollId}\nWall time: 0.0100 seconds\nProcess exited with code ${exit[1]}\nOutput:\n`,
						},
					],
				},
			]
		})
		assert.deepEqual(failures(drained, ui, phase, lifecycle), [])
	})
}

test("legacy running output cannot establish an observed absent-search exit", () => {
	const { history, ui } = trace("devSearchAbsent", "execute_command")
	recordBlock(history[2]!).is_error = false
	recordBlock(history[2]!).content =
		"Command is still running in terminal from 'fixture'. execution_id: 42.\nHere's the output so far:\nExit code: 1\nOutput:\nNo matches found."
	assert.ok(failures(history, ui, "devSearchAbsent").includes("search_absence_observed"))
})
