import {
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleApprovalItem,
	type AgentLifecycleEvent,
	type AgentLifecycleItem,
	type AgentLifecyclePhase,
	type AgentLifecycleSnapshot,
	type AgentLifecycleStepSnapshot,
	type AgentLifecycleToolCallItem,
	type AgentLifecycleToolResultItem,
	type AgentTurnStatus,
	type AgentTurnTerminalStatus,
	type AgentTaskId,
	type AgentRunId,
	type AgentTurnId,
} from "@alpha-code/types"

/**
 * Explicit failure categories make integrity failures distinguishable from
 * provider/runtime failures at the caller boundary.
 */
export type AgentLifecycleReducerErrorCode =
	| "task_mismatch"
	| "run_mismatch"
	| "turn_mismatch"
	| "sequence_gap"
	| "duplicate_sequence"
	| "duplicate_event_conflict"
	| "terminal_turn"
	| "invalid_transition"
	| "duplicate_item"
	| "missing_item"
	| "duplicate_step"
	| "missing_step"
	| "duplicate_tool_call"
	| "tool_result_without_accepted_call"
	| "duplicate_tool_result"
	| "unresolved_tool_calls"
	| "invalid_tool_call"
	| "invalid_approval"

export interface AgentLifecycleReducerErrorDetails {
	eventId?: string
	sequence?: number
	expectedSequence?: number
	toolCallId?: string
	itemId?: string
	stepId?: string
}

/** Error raised when an event cannot be applied without corrupting a snapshot. */
export class AgentLifecycleReducerError extends Error {
	readonly code: AgentLifecycleReducerErrorCode
	readonly details: AgentLifecycleReducerErrorDetails

	constructor(
		code: AgentLifecycleReducerErrorCode,
		message: string,
		details: AgentLifecycleReducerErrorDetails = {},
	) {
		super(message)
		this.name = "AgentLifecycleReducerError"
		this.code = code
		this.details = details
	}
}

export function isAgentLifecycleReducerError(error: unknown): error is AgentLifecycleReducerError {
	return error instanceof AgentLifecycleReducerError
}

/** Input needed to start a fresh canonical task/run/turn snapshot. */
export interface AgentLifecycleSnapshotInput {
	taskId: AgentTaskId
	runId: AgentRunId
	turnId: AgentTurnId
	phase?: AgentLifecyclePhase
}

/**
 * Construct the canonical empty state. Keeping construction here (rather than
 * in a provider or Task host) gives replay and tests one deterministic origin.
 */
export function createAgentLifecycleSnapshot(input: AgentLifecycleSnapshotInput): AgentLifecycleSnapshot {
	return agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId: input.taskId,
		runId: input.runId,
		turnId: input.turnId,
		status: "in_progress",
		phase: input.phase ?? "queued",
		lastSequence: 0,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
	})
}

export const createInitialAgentLifecycleSnapshot = createAgentLifecycleSnapshot
export const createInitialLifecycleSnapshot = createAgentLifecycleSnapshot
export const createLifecycleSnapshot = createAgentLifecycleSnapshot

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
	if (typeof value === "bigint") return `${value}n`
	if (typeof value === "undefined") return "[undefined]"
	if (typeof value !== "object") return String(value)
	if (seen.has(value)) return "[circular]"
	seen.add(value)
	if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen))

	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, canonicalize((value as Record<string, unknown>)[key], seen)]),
	)
}

/** Stable content identity used only for replay/conflict detection. */
export function fingerprintAgentLifecycleEvent(event: AgentLifecycleEvent): string {
	return JSON.stringify(canonicalize(event))
}

function fail(
	code: AgentLifecycleReducerErrorCode,
	message: string,
	details?: AgentLifecycleReducerErrorDetails,
): never {
	throw new AgentLifecycleReducerError(code, message, details)
}

function assertEventIdentity(snapshot: AgentLifecycleSnapshot, event: AgentLifecycleEvent): void {
	if (event.taskId !== snapshot.taskId) {
		fail("task_mismatch", `Lifecycle event targets task ${event.taskId}, expected ${snapshot.taskId}`, {
			eventId: event.eventId,
			sequence: event.sequence,
		})
	}
	if (event.runId !== snapshot.runId) {
		fail("run_mismatch", `Lifecycle event targets run ${event.runId}, expected ${snapshot.runId}`, {
			eventId: event.eventId,
			sequence: event.sequence,
		})
	}
	if (event.turnId !== snapshot.turnId) {
		fail("turn_mismatch", `Lifecycle event targets turn ${event.turnId}, expected ${snapshot.turnId}`, {
			eventId: event.eventId,
			sequence: event.sequence,
		})
	}
}

function ensureCanChange(snapshot: AgentLifecycleSnapshot, event: AgentLifecycleEvent): void {
	if (snapshot.status !== "in_progress") {
		fail("terminal_turn", `Turn ${snapshot.turnId} is already terminal (${snapshot.status})`, {
			eventId: event.eventId,
			sequence: event.sequence,
		})
	}
}

function copySnapshot(snapshot: AgentLifecycleSnapshot): AgentLifecycleSnapshot {
	return {
		...snapshot,
		items: [...snapshot.items],
		steps: snapshot.steps.map((step) => ({ ...step })),
		acceptedToolCallIds: [...snapshot.acceptedToolCallIds],
		terminalToolCallIds: [...snapshot.terminalToolCallIds],
		processedEvents: snapshot.processedEvents.map((receipt) => ({ ...receipt })),
	}
}

function findItem(snapshot: AgentLifecycleSnapshot, itemId: string): AgentLifecycleItem | undefined {
	return snapshot.items.find((item) => item.itemId === itemId)
}

function findStep(snapshot: AgentLifecycleSnapshot, stepId: string): AgentLifecycleStepSnapshot | undefined {
	return snapshot.steps.find((step) => step.stepId === stepId)
}

function itemBelongsToEventStep(event: AgentLifecycleEvent, item: AgentLifecycleItem): void {
	if (event.stepId !== undefined && item.stepId !== undefined && event.stepId !== item.stepId) {
		fail(
			"invalid_transition",
			`Lifecycle item ${item.itemId} belongs to step ${item.stepId}, not event step ${event.stepId}`,
			{ eventId: event.eventId, sequence: event.sequence, itemId: item.itemId, stepId: event.stepId },
		)
	}
}

function isAcceptedToolCall(item: AgentLifecycleToolCallItem): boolean {
	return item.status === "accepted" && item.accepted !== false
}

function appendToolCall(
	snapshot: AgentLifecycleSnapshot,
	item: AgentLifecycleToolCallItem,
	event: AgentLifecycleEvent,
): void {
	if (!isAcceptedToolCall(item)) {
		if (event.type === "tool_call_accepted") {
			fail("invalid_tool_call", "tool_call_accepted requires an accepted tool call item", {
				eventId: event.eventId,
				sequence: event.sequence,
				itemId: item.itemId,
				toolCallId: item.toolCallId,
			})
		}
		return
	}
	if (snapshot.acceptedToolCallIds.includes(item.toolCallId)) {
		fail("duplicate_tool_call", `Tool call ${item.toolCallId} was already accepted`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
			toolCallId: item.toolCallId,
		})
	}
	snapshot.acceptedToolCallIds.push(item.toolCallId)
}

function appendToolResult(
	snapshot: AgentLifecycleSnapshot,
	item: AgentLifecycleToolResultItem,
	event: AgentLifecycleEvent,
): void {
	if (!snapshot.acceptedToolCallIds.includes(item.toolCallId)) {
		fail(
			"tool_result_without_accepted_call",
			`Tool result ${item.itemId} has no accepted call for ${item.toolCallId}`,
			{ eventId: event.eventId, sequence: event.sequence, itemId: item.itemId, toolCallId: item.toolCallId },
		)
	}
	if (snapshot.terminalToolCallIds.includes(item.toolCallId)) {
		fail("duplicate_tool_result", `Tool call ${item.toolCallId} already has a terminal result`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
			toolCallId: item.toolCallId,
		})
	}
	snapshot.terminalToolCallIds.push(item.toolCallId)
}

function appendItem(snapshot: AgentLifecycleSnapshot, item: AgentLifecycleItem, event: AgentLifecycleEvent): void {
	itemBelongsToEventStep(event, item)
	// Check call-level identity before item identity. A producer may retry a
	// result with a fresh item ID; that is still a duplicate terminal result for
	// the same accepted call and should be classified as such.
	if (item.type === "tool_result" && snapshot.terminalToolCallIds.includes(item.toolCallId)) {
		fail("duplicate_tool_result", `Tool call ${item.toolCallId} already has a terminal result`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
			toolCallId: item.toolCallId,
		})
	}
	if (
		item.type === "tool_call" &&
		isAcceptedToolCall(item) &&
		snapshot.acceptedToolCallIds.includes(item.toolCallId)
	) {
		fail("duplicate_tool_call", `Tool call ${item.toolCallId} was already accepted`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
			toolCallId: item.toolCallId,
		})
	}
	if (findItem(snapshot, item.itemId)) {
		fail("duplicate_item", `Lifecycle item ${item.itemId} was already recorded`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}

	if (item.type === "tool_call") appendToolCall(snapshot, item, event)
	if (item.type === "tool_result") appendToolResult(snapshot, item, event)
	snapshot.items.push(item)
}

function replaceApproval(
	snapshot: AgentLifecycleSnapshot,
	item: AgentLifecycleApprovalItem,
	event: AgentLifecycleEvent,
): void {
	const index = snapshot.items.findIndex(
		(candidate): candidate is AgentLifecycleApprovalItem =>
			candidate.type === "approval" && candidate.approvalId === item.approvalId,
	)
	if (index < 0) {
		fail("invalid_approval", `Approval ${item.approvalId} has no request`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	const previous = snapshot.items[index]
	if (previous?.type !== "approval") {
		fail("invalid_approval", `Approval ${item.approvalId} is not represented by an approval item`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	if (previous.itemId !== item.itemId || previous.toolCallId !== item.toolCallId) {
		fail("invalid_approval", `Approval ${item.approvalId} changed identity during resolution`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	if (previous.status !== "requested" || item.status === "requested") {
		fail("invalid_approval", `Approval ${item.approvalId} has an invalid status transition`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	snapshot.items[index] = item
}

function updateItem(snapshot: AgentLifecycleSnapshot, item: AgentLifecycleItem, event: AgentLifecycleEvent): void {
	itemBelongsToEventStep(event, item)
	const index = snapshot.items.findIndex((candidate) => candidate.itemId === item.itemId)
	if (index < 0) {
		fail("missing_item", `Cannot update missing lifecycle item ${item.itemId}`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	const previous = snapshot.items[index]
	if (!previous || previous.type !== item.type) {
		fail("invalid_transition", `Lifecycle item ${item.itemId} cannot change type`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}

	if (item.type === "approval") {
		replaceApproval(snapshot, item, event)
		return
	}
	if (item.type === "tool_call" || item.type === "tool_result") {
		fail("invalid_transition", `Lifecycle ${item.type} items are immutable after recording`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}

	if (
		(previous.type === "assistant_text" || previous.type === "assistant_reasoning") &&
		item.type === previous.type &&
		!item.text.startsWith(previous.text)
	) {
		fail("invalid_transition", `Assistant item ${item.itemId} updates must append text`, {
			eventId: event.eventId,
			sequence: event.sequence,
			itemId: item.itemId,
		})
	}
	snapshot.items[index] = item
}

function startStep(
	snapshot: AgentLifecycleSnapshot,
	event: Extract<AgentLifecycleEvent, { type: "step_started" }>,
): void {
	if (findStep(snapshot, event.stepId)) {
		fail("duplicate_step", `Step ${event.stepId} was already started`, {
			eventId: event.eventId,
			sequence: event.sequence,
			stepId: event.stepId,
		})
	}
	snapshot.steps.push({
		stepId: event.stepId,
		status: "in_progress",
		phase: event.payload.phase,
		startedAt: event.occurredAt,
	})
	snapshot.currentStepId = event.stepId
}

function changeStepStatus(
	snapshot: AgentLifecycleSnapshot,
	event: Extract<AgentLifecycleEvent, { type: "step_status_changed" }>,
): void {
	const index = snapshot.steps.findIndex((step) => step.stepId === event.stepId)
	if (index < 0) {
		fail("missing_step", `Cannot update missing lifecycle step ${event.stepId}`, {
			eventId: event.eventId,
			sequence: event.sequence,
			stepId: event.stepId,
		})
	}
	const previous = snapshot.steps[index]
	if (!previous) return
	if (previous.status !== "in_progress") {
		fail("invalid_transition", `Step ${event.stepId} is already terminal (${previous.status})`, {
			eventId: event.eventId,
			sequence: event.sequence,
			stepId: event.stepId,
		})
	}
	snapshot.steps[index] = {
		...previous,
		status: event.payload.status,
		phase: event.payload.phase ?? previous.phase,
		...(event.payload.status !== "in_progress" ? { endedAt: event.occurredAt } : {}),
		...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
	}
	snapshot.currentStepId = event.stepId
}

function unresolvedToolCalls(snapshot: AgentLifecycleSnapshot): string[] {
	const finished = new Set(snapshot.terminalToolCallIds)
	return snapshot.acceptedToolCallIds.filter((toolCallId) => !finished.has(toolCallId))
}

function finishTurn(
	snapshot: AgentLifecycleSnapshot,
	event: AgentLifecycleEvent,
	status: AgentTurnTerminalStatus,
): void {
	ensureCanChange(snapshot, event)
	const unresolved = unresolvedToolCalls(snapshot)
	if (unresolved.length > 0) {
		fail(
			"unresolved_tool_calls",
			`Cannot terminally close turn ${snapshot.turnId}; accepted tool calls without terminal results: ${unresolved.join(", ")}`,
			{ eventId: event.eventId, sequence: event.sequence, toolCallId: unresolved[0] },
		)
	}

	snapshot.status = status
	snapshot.terminalEventId = event.eventId
	snapshot.terminalAt = event.occurredAt
	if (snapshot.currentStepId) {
		const index = snapshot.steps.findIndex((step) => step.stepId === snapshot.currentStepId)
		const step = snapshot.steps[index]
		if (index >= 0 && step?.status === "in_progress") {
			snapshot.steps[index] = { ...step, status, endedAt: event.occurredAt }
		}
	}
}

function applyEvent(snapshot: AgentLifecycleSnapshot, event: AgentLifecycleEvent): void {
	ensureCanChange(snapshot, event)

	switch (event.type) {
		case "turn_started":
			if (event.payload.phase !== undefined) snapshot.phase = event.payload.phase
			return

		case "phase_changed":
			snapshot.phase = event.payload.phase
			return

		case "step_started":
			startStep(snapshot, event)
			if (event.payload.phase !== undefined) snapshot.phase = event.payload.phase
			return

		case "step_status_changed":
			changeStepStatus(snapshot, event)
			if (event.payload.phase !== undefined) snapshot.phase = event.payload.phase
			return

		case "item_added":
			appendItem(snapshot, event.payload.item, event)
			return

		case "item_updated":
			updateItem(snapshot, event.payload.item, event)
			return

		case "tool_call_accepted":
			if (event.payload.item.status !== "accepted" || event.payload.item.accepted === false) {
				fail("invalid_tool_call", "tool_call_accepted requires an accepted tool call item", {
					eventId: event.eventId,
					sequence: event.sequence,
					itemId: event.payload.item.itemId,
					toolCallId: event.payload.item.toolCallId,
				})
			}
			appendItem(snapshot, event.payload.item, event)
			return

		case "tool_result_recorded":
			appendItem(snapshot, event.payload.item, event)
			return

		case "approval_requested":
			if (event.payload.item.status !== "requested") {
				fail("invalid_approval", "approval_requested requires a requested approval item", {
					eventId: event.eventId,
					sequence: event.sequence,
					itemId: event.payload.item.itemId,
				})
			}
			appendItem(snapshot, event.payload.item, event)
			return

		case "approval_resolved":
			if (event.payload.item.status === "requested") {
				fail("invalid_approval", "approval_resolved requires a terminal approval status", {
					eventId: event.eventId,
					sequence: event.sequence,
					itemId: event.payload.item.itemId,
				})
			}
			replaceApproval(snapshot, event.payload.item, event)
			return

		case "turn_status_changed":
			if (event.payload.status === "in_progress") {
				snapshot.status = "in_progress"
				return
			}
			finishTurn(snapshot, event, event.payload.status)
			return

		case "turn_terminal":
			finishTurn(snapshot, event, event.payload.status)
			return

		case "turn_completed":
			finishTurn(snapshot, event, "completed")
			return

		case "turn_interrupted":
			finishTurn(snapshot, event, "interrupted")
			return

		case "turn_cancelled":
			finishTurn(snapshot, event, "interrupted")
			return

		case "turn_failed":
			finishTurn(snapshot, event, "failed")
			return
	}
}

/**
 * Pure lifecycle reducer. It never mutates either argument. An exact replay of
 * a processed event returns an equivalent snapshot; a conflicting duplicate,
 * gap, or illegal transition throws an observable typed error.
 */
export function reduceAgentLifecycleEvent(
	inputSnapshot: AgentLifecycleSnapshot,
	inputEvent: AgentLifecycleEvent,
): AgentLifecycleSnapshot {
	const snapshot = agentLifecycleSnapshotSchema.parse(inputSnapshot)
	const event = agentLifecycleEventSchema.parse(inputEvent)
	assertEventIdentity(snapshot, event)

	const fingerprint = fingerprintAgentLifecycleEvent(event)
	const previousReceipt = snapshot.processedEvents.find((receipt) => receipt.eventId === event.eventId)
	if (previousReceipt) {
		if (previousReceipt.sequence === event.sequence && previousReceipt.fingerprint === fingerprint) return snapshot
		fail(
			"duplicate_event_conflict",
			`Lifecycle event ${event.eventId} was already processed with different content`,
			{
				eventId: event.eventId,
				sequence: event.sequence,
				expectedSequence: previousReceipt.sequence,
			},
		)
	}

	const expectedSequence = snapshot.lastSequence + 1
	if (event.sequence > expectedSequence) {
		fail("sequence_gap", `Lifecycle event sequence gap: expected ${expectedSequence}, received ${event.sequence}`, {
			eventId: event.eventId,
			sequence: event.sequence,
			expectedSequence,
		})
	}
	if (event.sequence < expectedSequence) {
		fail(
			"duplicate_sequence",
			`Duplicate lifecycle event sequence ${event.sequence}; expected ${expectedSequence}`,
			{
				eventId: event.eventId,
				sequence: event.sequence,
				expectedSequence,
			},
		)
	}

	const next = copySnapshot(snapshot)
	applyEvent(next, event)
	next.lastSequence = event.sequence
	next.processedEvents.push({ eventId: event.eventId, sequence: event.sequence, fingerprint })
	return agentLifecycleSnapshotSchema.parse(next)
}

export const applyAgentLifecycleEvent = reduceAgentLifecycleEvent
export const reduceLifecycleEvent = reduceAgentLifecycleEvent
export const reduceAgentLifecycle = reduceAgentLifecycleEvent

export type AgentLifecycleReductionSuccess = {
	ok: true
	applied: boolean
	replayed: boolean
	snapshot: AgentLifecycleSnapshot
}

export type AgentLifecycleReductionFailure = {
	ok: false
	applied: false
	replayed: false
	snapshot: AgentLifecycleSnapshot
	error: AgentLifecycleReducerError
}

export type AgentLifecycleReductionResult = AgentLifecycleReductionSuccess | AgentLifecycleReductionFailure

/** Non-throwing adapter for hosts that classify lifecycle integrity failures. */
export function tryReduceAgentLifecycleEvent(
	inputSnapshot: AgentLifecycleSnapshot,
	inputEvent: AgentLifecycleEvent,
): AgentLifecycleReductionResult {
	try {
		const snapshot = reduceAgentLifecycleEvent(inputSnapshot, inputEvent)
		const replayed = snapshot.lastSequence === inputSnapshot.lastSequence
		return { ok: true, applied: !replayed, replayed, snapshot }
	} catch (error) {
		if (!(error instanceof AgentLifecycleReducerError)) throw error
		return { ok: false, applied: false, replayed: false, snapshot: inputSnapshot, error }
	}
}

export const safeReduceAgentLifecycleEvent = tryReduceAgentLifecycleEvent
