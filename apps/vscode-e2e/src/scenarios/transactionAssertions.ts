/**
 * Small, provider-facing integrity assertions for persisted task evidence.
 *
 * These checks intentionally inspect unknown values without importing the
 * production persistence or lifecycle implementations. They return a closed
 * set of static error codes so a scenario can report an integrity failure
 * without leaking transcript contents, identifiers, or tool output.
 */

export type ToolTransactionErrorCode =
	| "api_history_not_array"
	| "api_message_not_object"
	| "api_message_content_invalid"
	| "content_block_not_object"
	| "tool_use_wrong_role"
	| "tool_result_wrong_role"
	| "tool_use_id_invalid"
	| "duplicate_tool_use_id"
	| "tool_result_id_invalid"
	| "duplicate_tool_result_id"
	| "orphan_tool_result"
	| "missing_tool_result"
	| "tool_result_order"
	| "tool_result_status_invalid"

export interface ToolTransactionInspection {
	callCount: number
	resultCount: number
	errors: ToolTransactionErrorCode[]
}

export type LifecycleInspectionErrorCode =
	| "lifecycle_events_not_array"
	| "lifecycle_event_not_object"
	| "lifecycle_event_id_invalid"
	| "lifecycle_duplicate_event_id"
	| "lifecycle_version_invalid"
	| "lifecycle_turn_identity_invalid"
	| "lifecycle_event_type_invalid"
	| "lifecycle_unknown_event_type"
	| "lifecycle_event_payload_invalid"
	| "lifecycle_phase_invalid"
	| "lifecycle_status_invalid"
	| "lifecycle_event_without_turn_start"
	| "lifecycle_terminal_without_turn_start"
	| "lifecycle_duplicate_turn_start"
	| "lifecycle_duplicate_turn_terminal"
	| "lifecycle_event_after_turn_terminal"
	| "lifecycle_missing_turn_terminal"
	| "lifecycle_open_turn_not_last"

export interface TaskLifecycleInspection {
	completedTurns: number
	cancelledTurns: number
	failedTurns: number
	errors: LifecycleInspectionErrorCode[]
}

export interface InspectTaskLifecycleOptions {
	/**
	 * Permit one still-open turn only when it is the last observed turn for the
	 * requested task. The default is false because a static journal is expected
	 * to contain a terminal event for every started turn.
	 */
	allowOpenLastTurn?: boolean
}

type JsonObject = Record<string, unknown>
type LifecycleTerminalStatus = "completed" | "cancelled" | "failed"

const lifecycleEventTypes = new Set([
	"turn_started",
	"phase_changed",
	"step_started",
	"step_status_changed",
	"item_added",
	"item_updated",
	"tool_call_accepted",
	"tool_result_recorded",
	"approval_requested",
	"approval_resolved",
	"turn_status_changed",
	"turn_terminal",
	"turn_completed",
	"turn_interrupted",
	"turn_cancelled",
	"turn_failed",
])

const lifecyclePhases = new Set([
	"queued",
	"starting",
	"planning",
	"working",
	"executing",
	"waiting",
	"awaiting_approval",
	"steering",
	"compacting",
	"reporting",
	"finalizing",
])

const lifecycleStatuses = new Set(["in_progress", "completed", "interrupted", "failed"])

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function addError<T extends string>(errors: Set<T>, code: T): void {
	errors.add(code)
}

function lifecycleTurnKey(runId: string, turnId: string): string {
	// JSON encoding avoids collisions if an opaque identifier contains a
	// separator. The key never reaches a returned error.
	return JSON.stringify([runId, turnId])
}

/**
 * Inspect an Anthropic-shaped persisted provider transcript.
 *
 * A receipt is structural evidence only: `is_error: true` is still a valid
 * receipt and is never converted into a success or treated as missing.
 */
export function inspectToolTransactions(apiHistory: unknown): ToolTransactionInspection {
	const errors = new Set<ToolTransactionErrorCode>()
	if (!Array.isArray(apiHistory)) {
		addError(errors, "api_history_not_array")
		return { callCount: 0, resultCount: 0, errors: [...errors] }
	}

	let callCount = 0
	let resultCount = 0
	const callOrder: string[] = []
	const callIds = new Set<string>()
	const resultIds = new Set<string>()
	const orphanResultIds = new Set<string>()
	const matchedResultIds = new Set<string>()
	let matchedResultCount = 0

	for (const messageValue of apiHistory) {
		if (!isObject(messageValue)) {
			addError(errors, "api_message_not_object")
			continue
		}

		const role = messageValue.role
		const content = messageValue.content
		if (typeof content === "string") continue
		if (!Array.isArray(content)) {
			addError(errors, "api_message_content_invalid")
			continue
		}

		for (const blockValue of content) {
			if (!isObject(blockValue)) {
				addError(errors, "content_block_not_object")
				continue
			}

			if (blockValue.type === "tool_use") {
				callCount += 1
				if (role !== "assistant") {
					addError(errors, "tool_use_wrong_role")
					continue
				}

				const id = blockValue.id
				if (!isNonEmptyString(id)) {
					addError(errors, "tool_use_id_invalid")
					continue
				}
				if (callIds.has(id)) {
					addError(errors, "duplicate_tool_use_id")
					continue
				}
				callIds.add(id)
				callOrder.push(id)
				continue
			}

			if (blockValue.type !== "tool_result") continue

			resultCount += 1
			if (role !== "user") {
				addError(errors, "tool_result_wrong_role")
				continue
			}

			if (blockValue.is_error !== undefined && typeof blockValue.is_error !== "boolean") {
				addError(errors, "tool_result_status_invalid")
			}

			const id = blockValue.tool_use_id
			if (!isNonEmptyString(id)) {
				addError(errors, "tool_result_id_invalid")
				continue
			}
			if (resultIds.has(id)) {
				addError(errors, "duplicate_tool_result_id")
				continue
			}
			resultIds.add(id)

			// A result must follow its call. Keeping this check chronological also
			// prevents a later call from retroactively legitimizing an orphan.
			if (!callIds.has(id) || orphanResultIds.has(id)) {
				addError(errors, "orphan_tool_result")
				orphanResultIds.add(id)
				continue
			}

			const expectedId = callOrder[matchedResultCount]
			if (expectedId !== id) addError(errors, "tool_result_order")
			matchedResultIds.add(id)
			matchedResultCount += 1
		}
	}

	for (const id of callOrder) {
		if (!matchedResultIds.has(id)) addError(errors, "missing_tool_result")
	}

	return { callCount, resultCount, errors: [...errors] }
}

interface LifecycleTurnState {
	terminalStatus?: LifecycleTerminalStatus
}

function readPayload(event: JsonObject, errors: Set<LifecycleInspectionErrorCode>): JsonObject | undefined {
	if (event.payload === undefined) return undefined
	if (!isObject(event.payload)) {
		addError(errors, "lifecycle_event_payload_invalid")
		return undefined
	}
	return event.payload
}

function validateOptionalPhase(payload: JsonObject | undefined, errors: Set<LifecycleInspectionErrorCode>): void {
	if (payload?.phase !== undefined && (typeof payload.phase !== "string" || !lifecyclePhases.has(payload.phase))) {
		addError(errors, "lifecycle_phase_invalid")
	}
}

function validateRequiredPhase(payload: JsonObject | undefined, errors: Set<LifecycleInspectionErrorCode>): void {
	if (!payload || typeof payload.phase !== "string" || !lifecyclePhases.has(payload.phase)) {
		addError(errors, "lifecycle_phase_invalid")
	}
}

function validateAliasStatus(
	payload: JsonObject | undefined,
	expected: "completed" | "interrupted" | "failed",
	errors: Set<LifecycleInspectionErrorCode>,
): void {
	if (payload?.status !== undefined && payload.status !== expected) {
		addError(errors, "lifecycle_status_invalid")
	}
}

function readTerminalStatus(
	type: string,
	payload: JsonObject | undefined,
	errors: Set<LifecycleInspectionErrorCode>,
): LifecycleTerminalStatus | "in_progress" | undefined {
	switch (type) {
		case "turn_terminal": {
			if (
				!payload ||
				typeof payload.status !== "string" ||
				!lifecycleStatuses.has(payload.status) ||
				payload.status === "in_progress"
			) {
				addError(errors, "lifecycle_status_invalid")
				return undefined
			}
			return payload.status === "completed" ? "completed" : payload.status === "failed" ? "failed" : "cancelled"
		}
		case "turn_status_changed": {
			if (!payload || typeof payload.status !== "string" || !lifecycleStatuses.has(payload.status)) {
				addError(errors, "lifecycle_status_invalid")
				return undefined
			}
			if (payload.status === "in_progress") return "in_progress"
			return payload.status === "completed" ? "completed" : payload.status === "failed" ? "failed" : "cancelled"
		}
		case "turn_completed":
			validateAliasStatus(payload, "completed", errors)
			return "completed"
		case "turn_interrupted":
			validateAliasStatus(payload, "interrupted", errors)
			return "cancelled"
		case "turn_cancelled":
			if (payload?.status !== undefined && payload.status !== "interrupted") {
				addError(errors, "lifecycle_status_invalid")
			}
			return "cancelled"
		case "turn_failed":
			validateAliasStatus(payload, "failed", errors)
			return "failed"
		default:
			return undefined
	}
}

function addTerminalCount(
	status: LifecycleTerminalStatus,
	counts: Pick<TaskLifecycleInspection, "completedTurns" | "cancelledTurns" | "failedTurns">,
): void {
	if (status === "completed") counts.completedTurns += 1
	else if (status === "cancelled") counts.cancelledTurns += 1
	else counts.failedTurns += 1
}

/**
 * Inspect canonical `agent_lifecycle_events.jsonl` records already parsed as
 * JSON values. Only records for `taskId` participate; unrelated task records
 * cannot create global ordering or terminality failures.
 */
export function inspectTaskLifecycle(
	events: unknown,
	taskId: string,
	options: InspectTaskLifecycleOptions = {},
): TaskLifecycleInspection {
	const errors = new Set<LifecycleInspectionErrorCode>()
	const counts = { completedTurns: 0, cancelledTurns: 0, failedTurns: 0 }

	if (!isNonEmptyString(taskId)) {
		addError(errors, "lifecycle_turn_identity_invalid")
		return { ...counts, errors: [...errors] }
	}
	if (!Array.isArray(events)) {
		addError(errors, "lifecycle_events_not_array")
		return { ...counts, errors: [...errors] }
	}

	const turns = new Map<string, LifecycleTurnState>()
	const eventIds = new Set<string>()
	let lastObservedTurnKey: string | undefined
	let lastStartedTurnKey: string | undefined

	for (const eventValue of events) {
		if (!isObject(eventValue)) {
			addError(errors, "lifecycle_event_not_object")
			continue
		}

		// Task scoping is deliberately the first semantic check. A malformed
		// record belonging to another task is not evidence about this task.
		if (eventValue.taskId !== taskId) continue

		if (eventValue.eventId !== undefined) {
			if (!isNonEmptyString(eventValue.eventId)) addError(errors, "lifecycle_event_id_invalid")
			else if (eventIds.has(eventValue.eventId)) addError(errors, "lifecycle_duplicate_event_id")
			else eventIds.add(eventValue.eventId)
		}
		if (eventValue.version !== undefined && eventValue.version !== 1) {
			addError(errors, "lifecycle_version_invalid")
		}

		const runId = eventValue.runId
		const turnId = eventValue.turnId
		if (!isNonEmptyString(runId) || !isNonEmptyString(turnId)) {
			addError(errors, "lifecycle_turn_identity_invalid")
			continue
		}
		const turnKey = lifecycleTurnKey(runId, turnId)
		lastObservedTurnKey = turnKey

		if (!isNonEmptyString(eventValue.type)) {
			addError(errors, "lifecycle_event_type_invalid")
			continue
		}
		const type = eventValue.type
		if (!lifecycleEventTypes.has(type)) {
			addError(errors, "lifecycle_unknown_event_type")
			continue
		}

		const payload = readPayload(eventValue, errors)
		if (type === "turn_started") validateOptionalPhase(payload, errors)
		else if (type === "phase_changed") validateRequiredPhase(payload, errors)
		else if (type === "step_started" || type === "step_status_changed") validateOptionalPhase(payload, errors)

		const existing = turns.get(turnKey)
		if (type === "turn_started") {
			if (existing) {
				addError(errors, "lifecycle_duplicate_turn_start")
				if (existing.terminalStatus !== undefined) addError(errors, "lifecycle_event_after_turn_terminal")
			} else {
				turns.set(turnKey, {})
				lastStartedTurnKey = turnKey
			}
			continue
		}

		const terminalStatus = readTerminalStatus(type, payload, errors)
		const terminalEvent =
			type === "turn_terminal" ||
			type === "turn_status_changed" ||
			type === "turn_completed" ||
			type === "turn_interrupted" ||
			type === "turn_cancelled" ||
			type === "turn_failed"

		if (terminalEvent) {
			if (terminalStatus === "in_progress") {
				if (!existing) addError(errors, "lifecycle_event_without_turn_start")
				else if (existing.terminalStatus !== undefined) addError(errors, "lifecycle_event_after_turn_terminal")
				continue
			}
			if (terminalStatus === undefined) continue
			if (!existing) {
				addError(errors, "lifecycle_terminal_without_turn_start")
				continue
			}
			if (existing.terminalStatus !== undefined) {
				addError(errors, "lifecycle_duplicate_turn_terminal")
				continue
			}
			existing.terminalStatus = terminalStatus
			addTerminalCount(terminalStatus, counts)
			continue
		}

		if (!existing) {
			// The current journal can be seeded by a phase_changed record. It is
			// not itself a started turn and cannot satisfy a later terminal.
			if (type !== "phase_changed") addError(errors, "lifecycle_event_without_turn_start")
			continue
		}
		if (existing.terminalStatus !== undefined) addError(errors, "lifecycle_event_after_turn_terminal")
	}

	for (const [turnKey, state] of turns) {
		if (state.terminalStatus !== undefined) continue
		if (options.allowOpenLastTurn && turnKey === lastStartedTurnKey && turnKey === lastObservedTurnKey) continue
		if (options.allowOpenLastTurn) addError(errors, "lifecycle_open_turn_not_last")
		addError(errors, "lifecycle_missing_turn_terminal")
	}

	return { ...counts, errors: [...errors] }
}
