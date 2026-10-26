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

test("a result ID without an observed payload cannot establish tool completion", () => {
	for (const content of [undefined, null, 7, {}, [undefined], [{ type: "text" }]]) {
		const inspected = inspectToolTransactions([
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content }] },
		])
		assert.deepEqual(inspected.errors, ["tool_result_content_invalid"])
	}
	for (const content of ["", [], [{ type: "text", text: "" }]]) {
		assert.deepEqual(
			inspectToolTransactions([
				{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content }] },
			]).errors,
			[],
			"an explicitly observed empty result is different from an unavailable payload",
		)
	}
})

test("malformed call names and absent arguments cannot become grading evidence", () => {
	for (const block of [
		{ type: "tool_use", id: "call", input: {} },
		{ type: "tool_use", id: "call", name: "   ", input: {} },
		{ type: "tool_use", id: "call", name: "read_file" },
	]) {
		const inspected = inspectToolTransactions([
			{ role: "assistant", content: [block] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "observed" }] },
		])
		assert.ok(inspected.errors.length > 0)
	}
})

test("terminal status metadata and canonical cancellation receipts cannot masquerade as success", () => {
	for (const specimen of [
		{ status: "cancelled", content: "stopped" },
		{ status: "denied", content: "declined" },
		{ status: "failed", content: "failed" },
		{ content: "Tool call was not executed because the task was cancelled." },
		{ content: "Error: cancelled" },
	]) {
		const receipt = { type: "tool_result", tool_use_id: "call", is_error: false, ...specimen }
		const history = [
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "exec_command", input: {} }] },
			{ role: "user", content: [receipt] },
		]
		assert.ok(inspectToolTransactions(history).errors.includes("tool_result_status_invalid"))
		receipt.is_error = true
		assert.deepEqual(inspectToolTransactions(history).errors, [])
	}
	for (const content of [
		"The documentation describes cancelled and denied requests.",
		"Chunk ID: fixture\nProcess exited with code 0\nOutput:\nError: cancelled",
		'{"status":"cancelled","description":"a record read from disk"}',
	])
		assert.deepEqual(
			inspectToolTransactions([
				{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content }] },
			]).errors,
			[],
			"ordinary retrieved text must not be reclassified by a status substring",
		)
})

test("an explicit success status cannot override an owned cancellation envelope", () => {
	assert.ok(
		inspectToolTransactions([
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "exec_command", input: {} }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call",
						status: "success",
						is_error: false,
						content: "Error: cancelled",
					},
				],
			},
		]).errors.includes("tool_result_status_invalid"),
	)
})

function toolLifecycle() {
	const taskId = "tool-integrity"
	const item = { itemId: "call-item", type: "tool_call", toolCallId: "call", name: "read_file", arguments: {} }
	const result = { itemId: "result-item", type: "tool_result", toolCallId: "call", status: "success", output: "read" }
	const entries: Array<[string, Record<string, unknown>]> = [
		["turn_started", {}],
		["tool_call_accepted", { item }],
		["tool_effect_started", { toolCallId: "call" }],
		["tool_result_recorded", { item: result }],
		["turn_terminal", { status: "completed" }],
	]
	const events = entries.map(([type, payload], index) =>
		lifecycleEnvelope(taskId, "run", "turn", type, payload, `event-${index}`, index + 1),
	)
	const history = [
		{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_file", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "read", is_error: false }] },
	]
	return { taskId, events, history, item, result }
}

test("independent lifecycle inspection rejects orphan, duplicate, unclosed, and late tool effects", () => {
	for (const fault of [
		"orphan-effect",
		"orphan-result",
		"duplicate-effect",
		"duplicate-result",
		"missing-result",
		"late-effect",
	]) {
		const { taskId, events } = toolLifecycle()
		if (fault === "orphan-effect") events[2]!.payload.toolCallId = "unknown"
		if (fault === "orphan-result") (events[3]!.payload.item as Record<string, unknown>).toolCallId = "unknown"
		if (fault === "duplicate-effect") events.splice(3, 0, { ...events[2]!, eventId: "duplicate-effect" })
		if (fault === "duplicate-result") events.splice(4, 0, { ...events[3]!, eventId: "duplicate-result" })
		if (fault === "missing-result") events.splice(3, 1)
		if (fault === "late-effect") [events[2], events[3]] = [events[3]!, events[2]!]
		assert.ok(inspectTaskLifecycle(events, taskId).errors.length > 0, fault)
	}
})

test("effects require settled approval and denied calls retain a matching failure outcome", () => {
	for (const decision of ["requested", "denied", "cancelled", "approved"]) {
		const { taskId, events } = toolLifecycle()
		const approval = {
			itemId: "approval",
			type: "approval",
			approvalId: "permission",
			toolCallId: "call",
			status: "requested",
		}
		events.splice(
			2,
			0,
			lifecycleEnvelope(taskId, "run", "turn", "approval_requested", { item: approval }, "request", 3),
		)
		if (decision !== "requested")
			events.splice(
				3,
				0,
				lifecycleEnvelope(
					taskId,
					"run",
					"turn",
					"approval_resolved",
					{ item: { ...approval, status: decision } },
					"decision",
					4,
				),
			)
		assert.equal(inspectTaskLifecycle(events, taskId).errors.length === 0, decision === "approved", decision)
	}
	const { taskId, events, result } = toolLifecycle()
	const approval = {
		itemId: "approval",
		type: "approval",
		approvalId: "permission",
		toolCallId: "call",
		status: "requested",
	}
	events.splice(
		2,
		1,
		lifecycleEnvelope(taskId, "run", "turn", "approval_requested", { item: approval }, "request", 3),
		lifecycleEnvelope(
			taskId,
			"run",
			"turn",
			"approval_resolved",
			{ item: { ...approval, status: "denied" } },
			"decision",
			4,
		),
	)
	result.status = "denied"
	assert.deepEqual(inspectTaskLifecycle(events, taskId).errors, [])
})

test("a later approval cannot retroactively authorize an effect or reopen a terminal tool", () => {
	for (const boundary of ["effect-started", "result-recorded"] as const) {
		const { taskId, events, history } = toolLifecycle()
		const approval = {
			itemId: "late-approval",
			type: "approval",
			approvalId: "late-permission",
			toolCallId: "call",
			status: "requested",
		}
		events.splice(
			boundary === "effect-started" ? 3 : 4,
			0,
			lifecycleEnvelope(taskId, "run", "turn", "approval_requested", { item: approval }, "late-request", 6),
			lifecycleEnvelope(
				taskId,
				"run",
				"turn",
				"approval_resolved",
				{ item: { ...approval, status: "approved" } },
				"late-decision",
				7,
			),
		)
		for (const [index, event] of events.entries()) {
			event.sequence = index + 1
			event.occurredAt = index + 1
		}
		const errors = inspectTaskLifecycle(events, taskId, { apiHistory: history }).errors
		assert.ok(
			errors.includes(
				boundary === "effect-started" ? "lifecycle_tool_effect_without_approval" : "lifecycle_approval_invalid",
			),
			boundary,
		)
	}
})

test("journal tool outcomes must agree with retained persisted receipts", () => {
	for (const fault of [
		"unaccepted-call",
		"wrong-name",
		"wrong-input",
		"success-shaped-cancellation",
		"changed-status",
		"wrong-output",
	]) {
		const { taskId, events, history, item, result } = toolLifecycle()
		if (fault === "unaccepted-call") item.toolCallId = "different"
		if (fault === "wrong-name") item.name = "apply_patch"
		if (fault === "wrong-input") item.arguments = { path: "other" }
		if (fault === "success-shaped-cancellation") result.status = "cancelled"
		if (fault === "changed-status") Object.assign(history[1]!.content[0]!, { status: "denied", is_error: true })
		if (fault === "wrong-output") result.output = "different"
		assert.ok(inspectTaskLifecycle(events, taskId, { apiHistory: history }).errors.length > 0, fault)
	}
})

test("legacy optional fields and aliases stay readable while compaction may remove old transactions", () => {
	const { taskId, events, history, result } = toolLifecycle()
	delete (events[1]!.payload.item as Record<string, unknown>).status
	Object.assign(result, { status: "completed", result: result.output })
	delete (result as Record<string, unknown>).output
	assert.deepEqual(inspectTaskLifecycle(events, taskId, { apiHistory: history }).errors, [])
	assert.deepEqual(inspectTaskLifecycle(events, taskId, { apiHistory: [] }).errors, [])
	assert.deepEqual(inspectTaskLifecycle(events, taskId).errors, [])
})

test("terminal outcome aliases, optional success flags, and indeterminate recovery correlate independently", () => {
	for (const status of ["success", "completed", "error", "failed", "denied", "cancelled", "indeterminate"]) {
		const { taskId, events, history, result } = toolLifecycle()
		result.status = status
		if (status === "denied") events.splice(2, 1)
		const success = status === "success" || status === "completed"
		Object.assign(history[1]!.content[0]!, {
			status: status === "indeterminate" ? "cancelled" : status,
			is_error: !success,
		})
		if (success) delete (history[1]!.content[0]! as Record<string, unknown>).is_error
		assert.deepEqual(inspectTaskLifecycle(events, taskId, { apiHistory: history }).errors, [], status)
	}
})

test("a legacy result ID alias and text-block projections remain valid receipts", () => {
	const { taskId, events, history, result } = toolLifecycle()
	const receipt = history[1]!.content[0]! as Record<string, unknown>
	receipt.tool_call_id = receipt.tool_use_id
	delete receipt.tool_use_id
	Object.assign(result, { output: [{ type: "text", text: "read" }] })
	assert.deepEqual(inspectToolTransactions(history).errors, [])
	assert.deepEqual(inspectTaskLifecycle(events, taskId, { apiHistory: history }).errors, [])
	receipt.tool_use_id = "different"
	assert.ok(inspectToolTransactions(history).errors.includes("tool_result_id_invalid"))
})

test("tool payloads, approval decisions, and terminal tool state cannot change after closure", () => {
	for (const fault of [
		"missing-acceptance",
		"missing-effect-id",
		"missing-output",
		"unknown-status",
		"after-result-update",
		"after-turn-update",
		"cross-turn-result",
	]) {
		const { taskId, events } = toolLifecycle()
		if (fault === "missing-acceptance") events[1]!.payload = {}
		if (fault === "missing-effect-id") events[2]!.payload = {}
		if (fault === "missing-output") delete (events[3]!.payload.item as Record<string, unknown>).output
		if (fault === "unknown-status") (events[3]!.payload.item as Record<string, unknown>).status = "pending"
		if (fault === "after-result-update" || fault === "after-turn-update") {
			const changed = { ...(events[3]!.payload.item as Record<string, unknown>), status: "cancelled" }
			events.splice(
				fault === "after-result-update" ? 4 : 5,
				0,
				lifecycleEnvelope(taskId, "run", "turn", "item_updated", { item: changed }, "changed", 6),
			)
		}
		if (fault === "cross-turn-result") events[3]!.turnId = "different-turn"
		assert.ok(inspectTaskLifecycle(events, taskId).errors.length > 0, fault)
	}
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

test("accepts the canonical tool effect start event", () => {
	const { taskId, events } = toolLifecycle()

	assert.deepEqual(inspectTaskLifecycle(events, taskId), {
		completedTurns: 1,
		cancelledTurns: 0,
		failedTurns: 0,
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
