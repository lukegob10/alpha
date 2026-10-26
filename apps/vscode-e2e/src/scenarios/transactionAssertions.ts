/**
 * Small, provider-facing integrity assertions for persisted task evidence.
 *
 * These checks intentionally inspect unknown values without importing the
 * production persistence or lifecycle implementations. They return a closed
 * set of static error codes so a scenario can report an integrity failure
 * without leaking transcript contents, identifiers, or tool output.
 */
import { isDeepStrictEqual } from "node:util"

export type ToolTransactionErrorCode =
	| "api_history_not_array"
	| "api_message_not_object"
	| "api_message_content_invalid"
	| "content_block_not_object"
	| "tool_use_wrong_role"
	| "tool_result_wrong_role"
	| "tool_use_id_invalid"
	| "tool_use_name_invalid"
	| "tool_use_input_missing"
	| "duplicate_tool_use_id"
	| "tool_result_id_invalid"
	| "duplicate_tool_result_id"
	| "orphan_tool_result"
	| "missing_tool_result"
	| "tool_result_order"
	| "tool_result_status_invalid"
	| "tool_result_content_invalid"

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
	| "lifecycle_tool_payload_invalid"
	| "lifecycle_duplicate_tool_call"
	| "lifecycle_tool_without_accepted_call"
	| "lifecycle_duplicate_tool_effect"
	| "lifecycle_tool_effect_after_result"
	| "lifecycle_tool_effect_without_approval"
	| "lifecycle_duplicate_tool_result"
	| "lifecycle_missing_tool_result"
	| "lifecycle_approval_invalid"
	| "lifecycle_approval_unresolved"
	| "lifecycle_tool_status_mismatch"
	| "lifecycle_transcript_invalid"
	| "lifecycle_transcript_call_mismatch"
	| "lifecycle_transcript_result_mismatch"

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
	/** Correlate retained provider transactions; compaction may omit older journal transactions. */
	apiHistory?: unknown
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
	"tool_effect_started",
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

function isResultContent(value: unknown): boolean {
	// Preserve explicit empty outputs and open-ended typed media/provider blocks.
	// A missing payload is not an observed result, even if its ID matches a call.
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(
				(block) =>
					isObject(block) &&
					isNonEmptyString(block.type) &&
					(block.type !== "text" || typeof block.text === "string"),
			))
	)
}

type ToolOutcome = "success" | "error" | "denied" | "cancelled" | "indeterminate"

function toolOutcome(value: unknown): ToolOutcome | undefined {
	if (value === "completed" || value === "success") return "success"
	if (value === "failed" || value === "error") return "error"
	if (value === "denied" || value === "cancelled" || value === "indeterminate") return value
	return undefined
}

function resultText(content: unknown): string | undefined {
	if (typeof content === "string") return content
	if (Array.isArray(content) && content.every((block) => isObject(block) && block.type === "text"))
		return content.map((block) => block.text).join("\n")
	return undefined
}

function legacyFailureOutcome(content: unknown): ToolOutcome | undefined {
	const text = resultText(content)?.trim()
	// Recognize only owned terminal envelopes. Retrieved prose, JSON records,
	// and command output containing these words do not establish a tool status.
	if (
		text === "Error: cancelled" ||
		text === "Tool execution was cancelled." ||
		/^Tool call was not executed because (?:the task|the provider response) was cancelled\.$/.test(text ?? "")
	)
		return "cancelled"
	if (text === "Error: denied" || text === "Command control was denied") return "denied"
	return undefined
}

function receiptOutcome(block: JsonObject): ToolOutcome | undefined {
	return toolOutcome(block.status) ?? legacyFailureOutcome(block.content)
}

function receiptId(block: JsonObject): unknown {
	return block.tool_use_id ?? block.tool_call_id
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
				if (!isNonEmptyString(blockValue.name)) addError(errors, "tool_use_name_invalid")
				if (!("input" in blockValue)) addError(errors, "tool_use_input_missing")

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
			const outcome = receiptOutcome(blockValue)
			if (
				(blockValue.status !== undefined && !toolOutcome(blockValue.status)) ||
				(toolOutcome(blockValue.status) === "success" &&
					legacyFailureOutcome(blockValue.content) !== undefined) ||
				(outcome !== undefined &&
					(outcome === "success" ? blockValue.is_error === true : blockValue.is_error !== true))
			)
				addError(errors, "tool_result_status_invalid")
			if (!isResultContent(blockValue.content)) addError(errors, "tool_result_content_invalid")

			const id = receiptId(blockValue)
			if (
				blockValue.tool_use_id !== undefined &&
				blockValue.tool_call_id !== undefined &&
				blockValue.tool_use_id !== blockValue.tool_call_id
			)
				addError(errors, "tool_result_id_invalid")
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

interface ObservedTool {
	turnKey: string
	name: string
	input: unknown
	effectStarted: boolean
	outcome?: ToolOutcome
	output?: unknown
}

interface ObservedApproval {
	turnKey: string
	toolCallId?: string
	status: "requested" | "approved" | "denied" | "cancelled"
}

function approvalStatus(value: unknown): ObservedApproval["status"] | undefined {
	return value === "requested" || value === "approved" || value === "denied" || value === "cancelled"
		? value
		: undefined
}

function inspectToolEvent(
	type: string,
	payload: JsonObject | undefined,
	turnKey: string,
	tools: Map<string, ObservedTool>,
	approvals: Map<string, ObservedApproval>,
	errors: Set<LifecycleInspectionErrorCode>,
): void {
	const item = isObject(payload?.item) ? payload.item : undefined
	const itemEvent = type === "item_added" || type === "item_updated"
	if (type === "tool_call_accepted" || (itemEvent && item?.type === "tool_call")) {
		if (
			!item ||
			item.type !== "tool_call" ||
			!isNonEmptyString(item.toolCallId) ||
			!isNonEmptyString(item.name) ||
			!("arguments" in item) ||
			(item.status !== undefined && !["accepted", "rejected", "cancelled"].includes(String(item.status))) ||
			(item.accepted !== undefined && typeof item.accepted !== "boolean")
		) {
			addError(errors, "lifecycle_tool_payload_invalid")
			return
		}
		if (item.status === "rejected" || item.status === "cancelled" || item.accepted === false) {
			if (type === "tool_call_accepted") addError(errors, "lifecycle_tool_payload_invalid")
			return
		}
		if (tools.has(item.toolCallId)) addError(errors, "lifecycle_duplicate_tool_call")
		else tools.set(item.toolCallId, { turnKey, name: item.name, input: item.arguments, effectStarted: false })
		return
	}
	if (type === "approval_requested" || type === "approval_resolved" || (itemEvent && item?.type === "approval")) {
		const status = approvalStatus(item?.status)
		if (
			!item ||
			item.type !== "approval" ||
			!isNonEmptyString(item.approvalId) ||
			!status ||
			(item.toolCallId !== undefined && !isNonEmptyString(item.toolCallId))
		) {
			addError(errors, "lifecycle_approval_invalid")
			return
		}
		const key = JSON.stringify([turnKey, item.approvalId])
		const previous = approvals.get(key)
		const toolCallId = isNonEmptyString(item.toolCallId) ? item.toolCallId : previous?.toolCallId
		if (toolCallId && tools.get(toolCallId)?.turnKey !== turnKey)
			addError(errors, "lifecycle_tool_without_accepted_call")
		if (status === "requested") {
			const tool = toolCallId ? tools.get(toolCallId) : undefined
			// A later grant cannot retroactively authorize an already-started
			// effect or reopen a tool whose terminal outcome is durable.
			if (tool?.outcome !== undefined) addError(errors, "lifecycle_approval_invalid")
			else if (tool?.effectStarted) addError(errors, "lifecycle_tool_effect_without_approval")
			if (previous || type === "approval_resolved") addError(errors, "lifecycle_approval_invalid")
			else approvals.set(key, { turnKey, toolCallId, status: "requested" })
		} else if (
			!previous ||
			previous.status !== "requested" ||
			(previous.toolCallId !== undefined && toolCallId !== previous.toolCallId) ||
			type === "approval_requested"
		) {
			addError(errors, "lifecycle_approval_invalid")
		} else {
			previous.status = status
			if (toolCallId && tools.get(toolCallId)?.effectStarted && status !== "approved")
				addError(errors, "lifecycle_tool_effect_without_approval")
		}
		return
	}
	if (
		type !== "tool_effect_started" &&
		type !== "tool_result_recorded" &&
		!(itemEvent && item?.type === "tool_result")
	)
		return
	const id = type === "tool_effect_started" ? payload?.toolCallId : item?.toolCallId
	if (!isNonEmptyString(id)) {
		addError(errors, "lifecycle_tool_payload_invalid")
		return
	}
	const tool = tools.get(id)
	if (!tool || tool.turnKey !== turnKey) {
		addError(errors, "lifecycle_tool_without_accepted_call")
		return
	}
	const permissions = [...approvals.values()].filter(
		(approval) => approval.turnKey === turnKey && approval.toolCallId === id,
	)
	if (type === "tool_effect_started") {
		if (tool.effectStarted) addError(errors, "lifecycle_duplicate_tool_effect")
		if (tool.outcome !== undefined) addError(errors, "lifecycle_tool_effect_after_result")
		if (permissions.some((approval) => approval.status !== "approved"))
			addError(errors, "lifecycle_tool_effect_without_approval")
		tool.effectStarted = true
		return
	}
	const outcome = toolOutcome(item?.status)
	if (!item || item.type !== "tool_result" || !outcome || (item.output === undefined && item.result === undefined)) {
		addError(errors, "lifecycle_tool_payload_invalid")
		return
	}
	if (tool.outcome !== undefined) {
		addError(errors, "lifecycle_duplicate_tool_result")
		return
	}
	if (
		(outcome === "denied" && tool.effectStarted) ||
		permissions.some(
			(approval) =>
				approval.status === "requested" ||
				((approval.status === "denied" || approval.status === "cancelled") && outcome !== approval.status),
		)
	)
		addError(errors, "lifecycle_tool_status_mismatch")
	tool.outcome = outcome
	tool.output = item.output !== undefined ? item.output : item.result
}

function comparableOutput(value: unknown): unknown {
	const text = resultText(value)
	return text === "" ? "(tool did not return anything)" : (text ?? value)
}

function inspectTranscriptCorrelation(
	history: unknown,
	tools: Map<string, ObservedTool>,
	errors: Set<LifecycleInspectionErrorCode>,
): void {
	if (inspectToolTransactions(history).errors.length > 0) addError(errors, "lifecycle_transcript_invalid")
	if (!Array.isArray(history)) return
	for (const message of history) {
		if (!isObject(message) || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (!isObject(block)) continue
			if (message.role === "assistant" && block.type === "tool_use") {
				const tool = isNonEmptyString(block.id) ? tools.get(block.id) : undefined
				if (!tool || tool.name !== block.name || !isDeepStrictEqual(tool.input, block.input))
					addError(errors, "lifecycle_transcript_call_mismatch")
			} else if (message.role === "user" && block.type === "tool_result") {
				const id = receiptId(block)
				const tool = isNonEmptyString(id) ? tools.get(id) : undefined
				const outcome = toolOutcome(block.status)
				if (
					!tool ||
					!tool.outcome ||
					(tool.outcome === "success" ? block.is_error === true : block.is_error !== true) ||
					(outcome !== undefined && tool.outcome !== "indeterminate" && outcome !== tool.outcome) ||
					!isDeepStrictEqual(comparableOutput(tool.output), comparableOutput(block.content))
				)
					addError(errors, "lifecycle_transcript_result_mismatch")
			}
		}
	}
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
	const tools = new Map<string, ObservedTool>()
	const approvals = new Map<string, ObservedApproval>()
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
		if (existing.terminalStatus !== undefined) {
			addError(errors, "lifecycle_event_after_turn_terminal")
			continue
		}
		inspectToolEvent(type, payload, turnKey, tools, approvals, errors)
	}

	for (const [turnKey, state] of turns) {
		if (state.terminalStatus !== undefined) {
			if ([...tools.values()].some((tool) => tool.turnKey === turnKey && tool.outcome === undefined))
				addError(errors, "lifecycle_missing_tool_result")
			if (
				[...approvals.values()].some(
					(approval) => approval.turnKey === turnKey && approval.status === "requested",
				)
			)
				addError(errors, "lifecycle_approval_unresolved")
			continue
		}
		if (options.allowOpenLastTurn && turnKey === lastStartedTurnKey && turnKey === lastObservedTurnKey) continue
		if (options.allowOpenLastTurn) addError(errors, "lifecycle_open_turn_not_last")
		addError(errors, "lifecycle_missing_turn_terminal")
	}
	if ("apiHistory" in options) inspectTranscriptCorrelation(options.apiHistory, tools, errors)

	return { ...counts, errors: [...errors] }
}
