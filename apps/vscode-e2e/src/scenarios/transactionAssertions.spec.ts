import assert from "node:assert/strict"
import test from "node:test"

import { inspectTaskLifecycle, inspectToolTransactions } from "./transactionAssertions"

const lifecycleEnvelope = (
	taskId: string,
	runId: string,
	turnId: string,
	type: string,
	payload: Record<string, unknown>,
	eventId: string,
	sequence: number,
) => ({
	version: 1,
	eventId,
	sequence,
	taskId,
	runId,
	turnId,
	occurredAt: sequence,
	type,
	payload,
})

test("accepts the persisted Anthropic tool transaction shape, including error receipts", () => {
	const history = [
		{ role: "user", content: "inspect the workspace" },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
				{ type: "tool_use", id: "call-2", name: "execute_command", input: { command: "git status" } },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call-1", content: "contents" },
				{ type: "tool_result", tool_use_id: "call-2", is_error: true, content: "denied" },
			],
		},
	]

	assert.deepEqual(inspectToolTransactions(history), { callCount: 2, resultCount: 2, errors: [] })
})

test("reports duplicate, orphan, missing, and out-of-order tool receipts without exposing transcript data", () => {
	const history = [
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "duplicate-call", name: "read_file", input: {} },
				{ type: "tool_use", id: "duplicate-call", name: "read_file", input: {} },
				{ type: "tool_use", id: "unreceipted-call", name: "read_file", input: {} },
				{ type: "tool_use", id: "missing-call", name: "read_file", input: {} },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "duplicate-call", content: "first" },
				{ type: "tool_result", tool_use_id: "unreceipted-call", content: "receipt" },
				{ type: "tool_result", tool_use_id: "unreceipted-call", content: "duplicate" },
				{ type: "tool_result", tool_use_id: "orphan-result", content: "orphan" },
			],
		},
	]

	const result = inspectToolTransactions(history)
	assert.equal(result.callCount, 4)
	assert.equal(result.resultCount, 4)
	assert.deepEqual(
		new Set(result.errors),
		new Set(["duplicate_tool_use_id", "duplicate_tool_result_id", "orphan_tool_result", "missing_tool_result"]),
	)
	assert.equal(
		result.errors.some((error) => error.includes("duplicate-call") || error.includes("orphan-result")),
		false,
	)

	const outOfOrder = inspectToolTransactions([
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call-a", name: "a", input: {} },
				{ type: "tool_use", id: "call-b", name: "b", input: {} },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call-b", content: "b" },
				{ type: "tool_result", tool_use_id: "call-a", content: "a" },
			],
		},
	])
	assert.equal(outOfOrder.errors.includes("tool_result_order"), true)
})

test("does not reinterpret a successful or error result and handles malformed input safely", () => {
	assert.deepEqual(inspectToolTransactions(undefined), {
		callCount: 0,
		resultCount: 0,
		errors: ["api_history_not_array"],
	})

	const malformed = inspectToolTransactions([
		42,
		{ role: "assistant", content: [{ type: "tool_use", id: "", name: "read_file", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "", is_error: "true", content: "private" }] },
	])
	assert.equal(malformed.callCount, 1)
	assert.equal(malformed.resultCount, 1)
	assert.equal(malformed.errors.includes("tool_use_id_invalid"), true)
	assert.equal(malformed.errors.includes("tool_result_id_invalid"), true)
	assert.equal(malformed.errors.includes("tool_result_status_invalid"), true)
	assert.equal(
		malformed.errors.some((error) => error.includes("private")),
		false,
	)
})

test("counts canonical lifecycle terminal outcomes per run/turn and ignores other task IDs", () => {
	const taskId = "task-a"
	const events = [
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_started", { phase: "starting" }, "event-1", 1),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "phase_changed", { phase: "working" }, "event-2", 2),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_terminal", { status: "completed" }, "event-3", 3),
		// The canonical journal starts a new local sequence for a new run.
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_started", { phase: "starting" }, "event-4", 1),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_cancelled", {}, "event-5", 2),
		lifecycleEnvelope(taskId, "run-3", "turn-3", "turn_started", { phase: "starting" }, "event-6", 1),
		lifecycleEnvelope(taskId, "run-3", "turn-3", "turn_failed", { status: "failed" }, "event-7", 2),
		lifecycleEnvelope("other-task", "run-x", "turn-x", "turn_started", {}, "other-1", 1),
		lifecycleEnvelope("other-task", "run-x", "turn-x", "turn_terminal", { status: "not-a-status" }, "other-2", 2),
	]

	assert.deepEqual(inspectTaskLifecycle(events, taskId), {
		completedTurns: 1,
		cancelledTurns: 1,
		failedTurns: 1,
		errors: [],
	})
})

test("catches lifecycle terminality defects and keeps counts scoped to first terminal closure", () => {
	const taskId = "task-lifecycle"
	const events = [
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_started", { phase: "starting" }, "event-1", 1),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_terminal", { status: "completed" }, "event-2", 2),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "phase_changed", { phase: "finalizing" }, "event-3", 3),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_terminal", { status: "failed" }, "event-4", 4),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_terminal", { status: "completed" }, "event-5", 1),
		lifecycleEnvelope(taskId, "run-3", "turn-3", "phase_changed", { phase: "working" }, "event-6", 1),
		lifecycleEnvelope(taskId, "run-4", "turn-4", "turn_started", { phase: "starting" }, "event-7", 1),
		lifecycleEnvelope(taskId, "run-4", "turn-4", "turn_status_changed", { status: "in_progress" }, "event-8", 2),
	]

	const result = inspectTaskLifecycle(events, taskId)
	assert.equal(result.completedTurns, 1)
	assert.equal(result.failedTurns, 0)
	assert.equal(result.errors.includes("lifecycle_event_after_turn_terminal"), true)
	assert.equal(result.errors.includes("lifecycle_duplicate_turn_terminal"), true)
	assert.equal(result.errors.includes("lifecycle_terminal_without_turn_start"), true)
	assert.equal(result.errors.includes("lifecycle_missing_turn_terminal"), true)
})

test("allows only the final open turn when explicitly requested", () => {
	const taskId = "task-open"
	const closedThenOpen = [
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_started", { phase: "starting" }, "event-1", 1),
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_terminal", { status: "completed" }, "event-2", 2),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_started", { phase: "working" }, "event-3", 1),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "phase_changed", { phase: "reporting" }, "event-4", 2),
	]

	assert.deepEqual(inspectTaskLifecycle(closedThenOpen, taskId, { allowOpenLastTurn: true }), {
		completedTurns: 1,
		cancelledTurns: 0,
		failedTurns: 0,
		errors: [],
	})
	assert.equal(inspectTaskLifecycle(closedThenOpen, taskId).errors.includes("lifecycle_missing_turn_terminal"), true)

	const earlierOpen = [
		lifecycleEnvelope(taskId, "run-1", "turn-1", "turn_started", { phase: "starting" }, "event-1", 1),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_started", { phase: "starting" }, "event-2", 1),
		lifecycleEnvelope(taskId, "run-2", "turn-2", "turn_terminal", { status: "completed" }, "event-3", 2),
	]
	const earlierOpenResult = inspectTaskLifecycle(earlierOpen, taskId, { allowOpenLastTurn: true })
	assert.equal(earlierOpenResult.errors.includes("lifecycle_open_turn_not_last"), true)
	assert.equal(earlierOpenResult.errors.includes("lifecycle_missing_turn_terminal"), true)
})
