import assert from "node:assert/strict"
import { test } from "node:test"
import { RECOVERY_COMMANDS } from "./developmentCatalog"
import { inspectRecoveryTrace, type RecoveryPhase } from "./recoveryTrace"

function trace(phase: RecoveryPhase) {
	const marker =
		phase === "devSearchScope"
			? "search-scope"
			: phase === "devSearchAbsent"
				? "search-absent"
				: "verification-unavailable"
	const history: Array<Record<string, unknown>> = [{ role: "user", ts: 10, content: `[development:${marker}]` }]
	const ui: Array<Record<string, unknown>> = []
	let nextId = 0
	const command = (text: string, exit: number, output = "") => {
		const id = `call-${nextId++}`
		history.push({
			role: "assistant",
			content: [{ type: "tool_use", id, name: "execute_command", input: { command: text } }],
		})
		history.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					is_error: exit !== 0,
					content: `Exit code: ${exit}\nOutput:\n${output}`,
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
		history.push({
			role: "assistant",
			content: [
				{ type: "tool_use", id: "blocked", name: "attempt_completion", input: { result, outcome: "blocked" } },
			],
		})
		history.push({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "blocked", content: '{"status":"success","outcome":"blocked"}' },
			],
		})
		ui.push({ ts: 11, type: "say", say: "text", text: result })
	}
	return { history, ui, command }
}

function failures(history: unknown, ui: unknown, phase: RecoveryPhase) {
	return inspectRecoveryTrace(history, ui, phase)
		.filter((check) => !check.passed)
		.map((check) => check.name)
}

for (const phase of ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"] as const) {
	test(`${phase} requires bounded observed work and the corresponding report`, () => {
		const { history, ui } = trace(phase)
		assert.deepEqual(failures(history, ui, phase), [])
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
	command("git log", 128)
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

test("unverified handoff must be visible ordinary text, with no failed or successful final styling", () => {
	for (const style of ["error", "completion_result", "missing", "partial"]) {
		const { history, ui } = trace("devVerificationUnavailable")
		if (style === "missing") ui.length = 0
		else if (style === "partial") ui[0]!.partial = true
		else ui[0]!.say = style
		assert.ok(failures(history, ui, "devVerificationUnavailable").length > 0, style)
	}
})

test("cannot disguise completion, a rejected handoff, or missing verification as blocked success", () => {
	for (const fault of ["completed", "rejected", "missing-verification"]) {
		const { history, ui } = trace("devVerificationUnavailable")
		const candidate = recordBlock(history[3]!)
		if (fault === "completed") (candidate.input as Record<string, unknown>).outcome = "completed"
		if (fault === "rejected") recordBlock(history[4]!).is_error = true
		if (fault === "missing-verification") history.splice(1, 2)
		assert.ok(failures(history, ui, "devVerificationUnavailable").length > 0, fault)
	}
})

function recordBlock(message: Record<string, unknown>): Record<string, unknown> {
	return (message.content as Array<Record<string, unknown>>)[0]!
}
