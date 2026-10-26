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
		const result = "Found docs/integrations.md and config/assistants.json."
		history.push({ role: "assistant", content: result })
		ui.push({ ts: 11, type: "say", say: "completion_result", text: result, partial: false })
	} else if (phase === "devSearchAbsent") {
		command(RECOVERY_COMMANDS.absent, 1)
		const result = "No matches found."
		history.push({ role: "assistant", content: result })
		ui.push({ ts: 11, type: "say", say: "completion_result", text: result, partial: false })
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
	const { history, ui, lifecycle } = trace("devSearchAbsent", "shell")
	assert.deepEqual(failures(history, ui, "devSearchAbsent", lifecycle), [])
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
	const { history, ui, lifecycle } = trace("devSearchAbsent")
	history[3]!.content =
		"No tracked repository files contain `AlphaMissingProvider947` (case-insensitive). Git status is clean; the workspace was unchanged."
	ui[0]!.text = history[3]!.content
	assert.deepEqual(failures(history, ui, "devSearchAbsent", lifecycle), [])
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
		ui[0]!.text = recordBlock(history[3]!).text
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

test("an unavailable verifier cannot be turned into success by mentioning an earlier blocker", () => {
	for (const report of [
		"Configuration was blocked before; verification is now complete and all integration checks passed.",
		"The integration remains unverified because configuration is missing, but all checks passed.",
		"I could not run the integration verifier because config is missing. The task is complete.",
		"Configuration was blocked previously, but I verified the integration.",
		"The integration remains unverified due to missing configuration; all tests passed.",
		"Configuration is missing and was blocked before, but the integration is fully verified.",
		"Blocked by missing configuration. Completed all integration checks.",
		"There is no configuration and the integration was verified successfully.",
		"No service is configured; integration was verified successfully.",
		"No configuration, but integration was verified successfully.",
	]) {
		const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
		recordBlock(history[3]!).text = report
		ui[0]!.text = report
		assert.ok(failures(history, ui, "devVerificationUnavailable", lifecycle).length > 0, report)
	}
})

test("unverified handoffs admit honest ordinary text without treating negated success as a claim", () => {
	for (const report of [
		"Integration remains unverified because config/local-integration.json is missing.",
		"Blocked by missing configuration; I cannot claim that all integration checks passed.",
		"Configuration is missing. The integration has not been verified and the task is incomplete.",
		"I couldn't verify the integration because configuration is missing.",
		"The integration was not run because configuration is missing. Verification is not complete.",
		"Blocked: configuration is missing; no service integration was verified.",
		"Configuration is missing. No integration was verified.",
		"Configuration is missing. No part of the integration was verified.",
		"Configuration is missing. Neither the integration nor the task is complete.",
	]) {
		const { history, ui, lifecycle } = trace("devVerificationUnavailable", "exec_command")
		recordBlock(history[3]!).text = report
		ui[0]!.text = report
		assert.deepEqual(failures(history, ui, "devVerificationUnavailable", lifecycle), [], report)
	}
})

test("unverified handoffs use the final verifier receipt and final assistant response", () => {
	for (const fault of ["later-success", "later-running", "later-tool-only", "later-reasoning-only"]) {
		const { history, ui, lifecycle, command } = trace("devVerificationUnavailable", "exec_command")
		if (fault === "later-success") command(RECOVERY_COMMANDS.verify, 0, "Integration checks passed")
		else if (fault === "later-running") {
			command(RECOVERY_COMMANDS.verify, 2, "INTEGRATION_CONFIGURATION_MISSING")
			recordBlock(history.at(-1)!).content =
				"Chunk ID: later\nWall time: 0.01 seconds\nProcess running with session ID 92\nOutput:\n"
		} else {
			history.push({
				role: "assistant",
				content: [
					fault === "later-tool-only"
						? { type: "tool_use", id: "later", name: "exec_command", input: { cmd: "git status" } }
						: { type: "reasoning", text: String(ui[0]!.text) },
				],
			})
		}
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
	const { history, ui, lifecycle } = trace("devSearchAbsent", "exec_command")
	recordBlock(history[2]!).is_error = true
	assert.deepEqual(failures(history, ui, "devSearchAbsent", lifecycle), [])
})

test("a running native process cannot borrow an exit status from its output", () => {
	const { history, ui } = trace("devSearchAbsent", "exec_command")
	recordBlock(history[2]!).content =
		"Chunk ID: call-0\nWall time: 0.0100 seconds\nProcess running with session ID 42\nOutput:\nExit code: 1\nProcess exited with code 1\n"
	assert.ok(failures(history, ui, "devSearchAbsent").includes("search_absence_observed"))
})

test("historical inline and persisted command envelopes remain readable without trusting preview text", () => {
	for (const persisted of [false, true]) {
		const { history, ui, lifecycle } = trace("devSearchAbsent", "shell")
		recordBlock(history[2]!).content = persisted
			? "Command executed in 'fixture'. Command execution was not successful, inspect the cause and adjust as needed.\nExit code: 1\n\nOutput (1KB) persisted. Artifact ID: output.txt\n\nPreview:\nExit code: 128\n"
			: "Command executed in terminal within working directory 'fixture'. Command execution was not successful, inspect the cause and adjust as needed.\nExit code: 1\nOutput:\nExit code: 128\n"
		assert.deepEqual(failures(history, ui, "devSearchAbsent", lifecycle), [])
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

for (const phase of ["devSearchScope", "devSearchAbsent"] as const) {
	const reportCheck = phase === "devSearchScope" ? "search_report_identifies_matches" : "search_absence_reported"
	test(`${phase} rejects contradictory final answers despite earlier matching commentary`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		const preamble =
			phase === "devSearchScope"
				? "I will inspect docs/integrations.md and config/assistants.json."
				: "I expect no matches; I will run the search."
		const final = phase === "devSearchScope" ? "The search found no matches." : "Matches were found."
		history.splice(1, 0, { role: "assistant", content: [{ type: "text", text: preamble }] })
		history.at(-1)!.content = [{ type: "text", text: final }]
		ui[0]!.text = final
		assert.ok(failures(history, ui, phase, lifecycle).includes(reportCheck))
	})

	test(`${phase} requires a canonical finalized UI report and completed phase`, () => {
		for (const fault of [
			"missing-ui",
			"partial",
			"stale",
			"commentary-only",
			"mismatch",
			"duplicate-ui",
			"missing-lifecycle",
			"failed-lifecycle",
		]) {
			const { history, ui, lifecycle } = trace(phase, "exec_command")
			if (fault === "missing-ui") ui.length = 0
			if (fault === "partial") ui[0]!.partial = true
			if (fault === "stale") ui[0]!.ts = 9
			if (fault === "commentary-only") ui[0]!.say = "text"
			if (fault === "mismatch") ui[0]!.text = "A different response."
			if (fault === "duplicate-ui") ui.push({ ...ui[0], ts: 12 })
			if (fault === "missing-lifecycle") lifecycle.events.length = 0
			if (fault === "failed-lifecycle") lifecycle.events[1]!.payload.status = "failed"
			assert.ok(failures(history, ui, phase, lifecycle).includes(reportCheck), fault)
		}
	})

	test(`${phase} cannot borrow its final answer from reasoning or an earlier assistant response`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		const matching = String(history.at(-1)!.content)
		history.push({ role: "assistant", content: [{ type: "reasoning", text: matching }] })
		assert.ok(failures(history, ui, phase, lifecycle).includes(reportCheck))
	})

	test(`${phase} accepts final text with separate reasoning and presentation whitespace`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		const result = String(history.at(-1)!.content)
		history.at(-1)!.content = [
			{ type: "reasoning", text: "This internal content is not the answer." },
			{ type: "text", text: `\n${result}\n` },
		]
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
	})

	test(`${phase} accepts a paired historical completion matching its canonical final UI`, () => {
		const { history, ui, lifecycle } = trace(phase, "execute_command")
		const result = String(history.pop()!.content)
		history.push({
			role: "assistant",
			content: [{ type: "tool_use", id: "final-completion", name: "attempt_completion", input: { result } }],
		})
		history.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "final-completion",
					is_error: false,
					content: "(tool did not return anything)",
				},
			],
		})
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
		recordBlock(history.at(-1)!).is_error = true
		assert.ok(failures(history, ui, phase, lifecycle).includes(reportCheck))
	})
}

for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
	test(`${phase} retains its completed outcome when a later phase has its own report`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		history.push(
			{ role: "user", ts: 20, content: "[workflow:verify] A later phase." },
			{ role: "assistant", ts: 21, content: [{ type: "text", text: "A later response." }] },
		)
		ui.push({ ts: 21, type: "say", say: "completion_result", text: "A later response.", partial: false })
		lifecycle.events.push(
			{ ...lifecycle.events[0]!, turnId: "later", eventId: "later-start", sequence: 3, occurredAt: 19 },
			{ ...lifecycle.events[1]!, turnId: "later", eventId: "later-terminal", sequence: 4, occurredAt: 22 },
		)
		assert.deepEqual(failures(history, ui, phase, lifecycle), [])
	})

	test(`${phase} cannot borrow finality or a matching report from a later phase`, () => {
		const { history, ui, lifecycle } = trace(phase, "exec_command")
		const result = String(ui[0]!.text)
		const laterStart = { ...lifecycle.events[0]!, turnId: "later", eventId: "later-start", occurredAt: 19 }
		const laterEnd = { ...lifecycle.events[1]!, turnId: "later", eventId: "later-terminal", occurredAt: 22 }
		history.pop()
		ui.length = 0
		lifecycle.events.splice(0, lifecycle.events.length, laterStart, laterEnd)
		history.push(
			{ role: "user", ts: 20, content: "[workflow:verify] A later phase." },
			{ role: "assistant", ts: 21, content: [{ type: "text", text: result }] },
		)
		ui.push({ ts: 21, type: "say", say: "completion_result", text: result, partial: false })
		const check =
			phase === "devSearchScope"
				? "search_report_identifies_matches"
				: phase === "devSearchAbsent"
					? "search_absence_reported"
					: "verification_one_blocked_handoff"
		assert.ok(failures(history, ui, phase, lifecycle).includes(check))
	})
}
