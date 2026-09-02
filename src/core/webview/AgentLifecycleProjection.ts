import {
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleEvent,
	type AgentLifecycleSnapshot,
	type ClineMessage,
	TaskLifecycleState,
	TaskStatus,
	type HistoryItem,
} from "@alpha-code/types"

import {
	AgentLifecycleReducerError,
	createAgentLifecycleSnapshot,
	fingerprintAgentLifecycleEvent,
	tryReduceAgentLifecycleEvent,
} from "../agent/lifecycle/reducer"

/** A request made when an incremental lifecycle stream can no longer be trusted. */
export type AgentLifecycleResyncReason =
	| "sequence_gap"
	| "duplicate_event_conflict"
	| "duplicate_sequence"
	| "identity_conflict"
	| "invalid_event"
	| "invalid_snapshot"

export interface AgentLifecycleSnapshotResyncRequest {
	taskId: string
	runId?: string
	turnId?: string
	expectedSequence?: number
	receivedSequence?: number
	eventId?: string
	reason: AgentLifecycleResyncReason
}

export interface AgentLifecycleProjectorOptions {
	/** Called once for each resync incident until a valid snapshot is received. */
	onSnapshotResyncRequired?: (request: AgentLifecycleSnapshotResyncRequest) => void | Promise<void>
	/** Called after an event or snapshot is accepted. */
	onSnapshotUpdated?: (snapshot: AgentLifecycleSnapshot, previous?: AgentLifecycleSnapshot) => void | Promise<void>
}

export type AgentLifecycleProjectionResultKind =
	| "applied"
	| "replayed"
	| "snapshot_applied"
	| "ignored"
	| "resync_required"
	| "invalid"

/**
 * Result returned by the extension-side lifecycle adapter. The boolean fields
 * intentionally make this useful to older callers that do not want to depend
 * on the result discriminant.
 */
export interface AgentLifecycleProjectionResult {
	kind: AgentLifecycleProjectionResultKind
	/** Alias retained for callers that use a status-shaped result. */
	status: AgentLifecycleProjectionResultKind
	taskId?: string
	event?: AgentLifecycleEvent
	snapshot?: AgentLifecycleSnapshot
	previousSnapshot?: AgentLifecycleSnapshot
	request?: AgentLifecycleSnapshotResyncRequest
	error?: unknown
	accepted: boolean
	applied: boolean
	replayed: boolean
	resyncRequired: boolean
}

interface ProjectedTaskState {
	snapshot?: AgentLifecycleSnapshot
	needsSnapshot: boolean
	resyncRequest?: AgentLifecycleSnapshotResyncRequest
}

const cloneSnapshot = (snapshot: AgentLifecycleSnapshot): AgentLifecycleSnapshot => structuredClone(snapshot)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

const result = (
	kind: AgentLifecycleProjectionResultKind,
	fields: Omit<
		AgentLifecycleProjectionResult,
		"kind" | "status" | "accepted" | "applied" | "replayed" | "resyncRequired"
	> = {},
): AgentLifecycleProjectionResult => ({
	kind,
	status: kind,
	accepted: kind === "applied" || kind === "replayed" || kind === "snapshot_applied",
	applied: kind === "applied" || kind === "snapshot_applied",
	replayed: kind === "replayed",
	resyncRequired: kind === "resync_required",
	...fields,
})

function eventFromMessage(value: unknown): { taskId?: string; event: unknown } {
	const record = asRecord(value)
	if (!record) return { event: value }
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
	// A canonical event also has a `payload` member. Treat it as a direct
	// event when its discriminant is one of the lifecycle event types rather
	// than accidentally parsing the nested payload as the event itself.
	if (typeof record.type === "string" && lifecycleEventTypes.has(record.type)) {
		return { taskId: typeof record.taskId === "string" ? record.taskId : undefined, event: value }
	}

	// Extension messages have historically carried data in `payload`; `event`
	// and `agentLifecycleEvent` are accepted aliases so a host can roll forward
	// independently of the webview. The canonical event object is still parsed
	// by agentLifecycleEventSchema below.
	const event = record.event ?? record.agentLifecycleEvent ?? record.payload ?? value
	return {
		taskId: typeof record.taskId === "string" ? record.taskId : undefined,
		event,
	}
}

function snapshotFromMessage(value: unknown): { taskId?: string; snapshot: unknown } {
	const record = asRecord(value)
	if (!record) return { snapshot: value }

	const snapshot = record.snapshot ?? record.agentLifecycleSnapshot ?? record.payload ?? value
	return {
		taskId: typeof record.taskId === "string" ? record.taskId : undefined,
		snapshot,
	}
}

function eventPhase(event: AgentLifecycleEvent): AgentLifecycleSnapshot["phase"] | undefined {
	if (event.type === "phase_changed") return event.payload.phase
	if (event.type === "turn_started") return event.payload.phase
	if (event.type === "step_started") return event.payload.phase
	if (event.type === "step_status_changed") return event.payload.phase
	return undefined
}

function reducerErrorReason(error: AgentLifecycleReducerError): AgentLifecycleResyncReason | undefined {
	switch (error.code) {
		case "sequence_gap":
			return "sequence_gap"
		case "duplicate_event_conflict":
			return "duplicate_event_conflict"
		case "duplicate_sequence":
			return "duplicate_sequence"
		case "task_mismatch":
		case "run_mismatch":
		case "turn_mismatch":
			return "identity_conflict"
		default:
			return undefined
	}
}

/**
 * Pure extension-side projector for the provider-neutral lifecycle stream.
 *
 * The projector never mutates a task's ClineMessage transcript. It keeps one
 * reducer snapshot per task, rejects gaps/conflicts, and asks its host for a
 * full snapshot when the incremental stream is no longer authoritative.
 */
export class AgentLifecycleProjector {
	private readonly states = new Map<string, ProjectedTaskState>()

	constructor(private readonly options: AgentLifecycleProjectorOptions = {}) {}

	getSnapshot(taskId: string): AgentLifecycleSnapshot | undefined {
		const snapshot = this.states.get(taskId)?.snapshot
		return snapshot ? cloneSnapshot(snapshot) : undefined
	}

	getSnapshots(): Record<string, AgentLifecycleSnapshot> {
		return Object.fromEntries(
			Array.from(this.states.entries())
				.filter(([, state]) => state.snapshot !== undefined)
				.map(([taskId, state]) => [taskId, cloneSnapshot(state.snapshot!)]),
		)
	}

	/** Alias used by state projection callers. */
	getAllSnapshots(): Record<string, AgentLifecycleSnapshot> {
		return this.getSnapshots()
	}

	needsSnapshotResync(taskId: string): boolean {
		return this.states.get(taskId)?.needsSnapshot === true
	}

	/** Alias used by hosts that call the condition `isResyncRequired`. */
	isSnapshotResyncRequired(taskId: string): boolean {
		return this.needsSnapshotResync(taskId)
	}

	clear(taskId?: string): void {
		if (taskId === undefined) this.states.clear()
		else this.states.delete(taskId)
	}

	/**
	 * Apply one incremental event. Invalid envelopes are ignored and do not
	 * change the last trusted snapshot.
	 */
	ingestEvent(value: unknown): AgentLifecycleProjectionResult {
		const { taskId: envelopeTaskId, event: candidate } = eventFromMessage(value)
		const parsed = agentLifecycleEventSchema.safeParse(candidate)
		if (!parsed.success) {
			const taskId = envelopeTaskId
			if (taskId) {
				const request = this.markResync(taskId, {
					taskId,
					reason: "invalid_event",
				})
				return result("resync_required", { taskId, request, error: parsed.error })
			}
			return result("invalid", { taskId, error: parsed.error })
		}

		const event = parsed.data
		if (envelopeTaskId !== undefined && envelopeTaskId !== event.taskId) {
			const request = this.markResync(event.taskId, {
				taskId: event.taskId,
				runId: event.runId,
				turnId: event.turnId,
				receivedSequence: event.sequence,
				eventId: event.eventId,
				reason: "identity_conflict",
			})
			return result("resync_required", { taskId: event.taskId, event, request })
		}

		let state = this.states.get(event.taskId)
		if (!state) {
			state = { needsSnapshot: false }
			this.states.set(event.taskId, state)
		}
		let baseSnapshot = state.snapshot
		let previousSnapshot = baseSnapshot

		// Once a gap or conflict has been observed, no later delta is trusted
		// until the host supplies a complete snapshot.
		if (state.needsSnapshot) {
			const request =
				state.resyncRequest ??
				this.markResync(event.taskId, {
					taskId: event.taskId,
					runId: event.runId,
					turnId: event.turnId,
					receivedSequence: event.sequence,
					eventId: event.eventId,
					reason: "sequence_gap",
				})
			return result("resync_required", { taskId: event.taskId, event, request })
		}

		if (!baseSnapshot) {
			if (event.sequence !== 1) {
				const request = this.markResync(event.taskId, {
					taskId: event.taskId,
					runId: event.runId,
					turnId: event.turnId,
					expectedSequence: 1,
					receivedSequence: event.sequence,
					eventId: event.eventId,
					reason: "sequence_gap",
				})
				return result("resync_required", { taskId: event.taskId, event, request })
			}
			baseSnapshot = createAgentLifecycleSnapshot({
				taskId: event.taskId,
				runId: event.runId,
				turnId: event.turnId,
				phase: eventPhase(event),
			})
			previousSnapshot = undefined
		}

		// A new run can legitimately restart sequence numbers after a terminal
		// turn. An active turn changing identity is a conflict and requires a
		// snapshot rather than an inferred reset.
		if (baseSnapshot.runId !== event.runId || baseSnapshot.turnId !== event.turnId) {
			if (event.sequence !== 1 || baseSnapshot.status === "in_progress") {
				const request = this.markResync(event.taskId, {
					taskId: event.taskId,
					runId: event.runId,
					turnId: event.turnId,
					expectedSequence: 1,
					receivedSequence: event.sequence,
					eventId: event.eventId,
					reason: "identity_conflict",
				})
				return result("resync_required", { taskId: event.taskId, event, request })
			}
			baseSnapshot = createAgentLifecycleSnapshot({
				taskId: event.taskId,
				runId: event.runId,
				turnId: event.turnId,
				phase: eventPhase(event),
			})
			previousSnapshot = undefined
		}

		const reduced = tryReduceAgentLifecycleEvent(baseSnapshot, event)
		if (!reduced.ok) {
			const reason = reducerErrorReason(reduced.error)
			if (reason) {
				const request = this.markResync(event.taskId, {
					taskId: event.taskId,
					runId: event.runId,
					turnId: event.turnId,
					expectedSequence: reduced.error.details.expectedSequence,
					receivedSequence: event.sequence,
					eventId: event.eventId,
					reason,
				})
				return result("resync_required", { taskId: event.taskId, event, request, error: reduced.error })
			}
			return result("invalid", { taskId: event.taskId, event, error: reduced.error })
		}

		state.snapshot = reduced.snapshot
		const nextSnapshot = cloneSnapshot(reduced.snapshot)
		const kind = reduced.replayed ? "replayed" : "applied"
		this.notifySnapshotUpdated(nextSnapshot, previousSnapshot)
		return result(kind, {
			taskId: event.taskId,
			event,
			snapshot: nextSnapshot,
			previousSnapshot: previousSnapshot ? cloneSnapshot(previousSnapshot) : undefined,
		})
	}

	/** Compatibility aliases for providers that call the operation `apply`. */
	applyEvent(value: unknown): AgentLifecycleProjectionResult {
		return this.ingestEvent(value)
	}

	applyAgentLifecycleEvent(value: unknown): AgentLifecycleProjectionResult {
		return this.ingestEvent(value)
	}

	/** Apply a full snapshot and clear any pending resync incident. */
	ingestSnapshot(value: unknown): AgentLifecycleProjectionResult {
		const { taskId: envelopeTaskId, snapshot: candidate } = snapshotFromMessage(value)
		const parsed = agentLifecycleSnapshotSchema.safeParse(candidate)
		if (!parsed.success) {
			if (envelopeTaskId) {
				const request = this.markResync(envelopeTaskId, {
					taskId: envelopeTaskId,
					reason: "invalid_snapshot",
				})
				return result("resync_required", { taskId: envelopeTaskId, request, error: parsed.error })
			}
			return result("invalid", { taskId: envelopeTaskId, error: parsed.error })
		}

		const snapshot = parsed.data
		if (envelopeTaskId !== undefined && envelopeTaskId !== snapshot.taskId) {
			const request = this.markResync(snapshot.taskId, {
				taskId: snapshot.taskId,
				runId: snapshot.runId,
				turnId: snapshot.turnId,
				reason: "identity_conflict",
			})
			return result("resync_required", { taskId: snapshot.taskId, request })
		}

		const state = this.states.get(snapshot.taskId) ?? { needsSnapshot: false }
		const previous = state.snapshot
		if (
			previous &&
			previous.runId === snapshot.runId &&
			previous.turnId === snapshot.turnId &&
			snapshot.lastSequence < previous.lastSequence
		) {
			// A delayed response to an older resync request must not roll a trusted
			// snapshot backwards.
			this.states.set(snapshot.taskId, state)
			return result("ignored", {
				taskId: snapshot.taskId,
				snapshot: cloneSnapshot(previous),
				previousSnapshot: cloneSnapshot(previous),
			})
		}

		state.snapshot = cloneSnapshot(snapshot)
		state.needsSnapshot = false
		state.resyncRequest = undefined
		this.states.set(snapshot.taskId, state)
		const nextSnapshot = cloneSnapshot(snapshot)
		this.notifySnapshotUpdated(nextSnapshot, previous)
		return result("snapshot_applied", {
			taskId: snapshot.taskId,
			snapshot: nextSnapshot,
			previousSnapshot: previous ? cloneSnapshot(previous) : undefined,
		})
	}

	applySnapshot(value: unknown): AgentLifecycleProjectionResult {
		return this.ingestSnapshot(value)
	}

	applyAgentLifecycleSnapshot(value: unknown): AgentLifecycleProjectionResult {
		return this.ingestSnapshot(value)
	}

	private markResync(
		taskId: string,
		request: AgentLifecycleSnapshotResyncRequest,
	): AgentLifecycleSnapshotResyncRequest {
		const state = this.states.get(taskId) ?? { needsSnapshot: false }
		if (state.needsSnapshot && state.resyncRequest) return state.resyncRequest
		state.needsSnapshot = true
		state.resyncRequest = request
		this.states.set(taskId, state)
		this.notifyResyncRequired(request)
		return request
	}

	private notifyResyncRequired(request: AgentLifecycleSnapshotResyncRequest): void {
		try {
			const pending = this.options.onSnapshotResyncRequired?.(request)
			if (pending && typeof (pending as Promise<void>).then === "function") void pending.catch(() => undefined)
		} catch {
			// A resync callback must never make lifecycle ingestion throw.
		}
	}

	private notifySnapshotUpdated(snapshot: AgentLifecycleSnapshot, previous?: AgentLifecycleSnapshot): void {
		try {
			const pending = this.options.onSnapshotUpdated?.(snapshot, previous)
			if (pending && typeof (pending as Promise<void>).then === "function") void pending.catch(() => undefined)
		} catch {
			// Projection callbacks are observational and cannot invalidate state.
		}
	}
}

export const AgentLifecycleProjection = AgentLifecycleProjector

export interface ClineMessageStatusProjection {
	source: "lifecycle" | "legacy"
	lifecycle: TaskLifecycleState
	historyStatus: NonNullable<HistoryItem["status"]>
	/** Canonical status is retained for consumers that do not use enum values. */
	status: AgentLifecycleSnapshot["status"] | TaskStatus
	isTerminal: boolean
	isWaitingForInput: boolean
	waitingReason?: string
}

const terminalLifecycleStates = new Set<TaskLifecycleState>([
	TaskLifecycleState.Completed,
	TaskLifecycleState.Failed,
	TaskLifecycleState.Closed,
])

function legacyProjection(
	messages: readonly ClineMessage[] = [],
	taskAsk?: ClineMessage,
	taskStatus?: TaskStatus,
): ClineMessageStatusProjection {
	const latest = messages.at(-1)
	const ask = taskAsk ?? [...messages].reverse().find((message) => message.type === "ask")
	const askType = ask?.type === "ask" ? ask.ask : undefined

	if (askType === "resume_completed_task") {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Completed,
			historyStatus: "completed",
			status: TaskStatus.Idle,
			isTerminal: true,
			isWaitingForInput: false,
		}
	}

	if (askType === "resume_task") {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "interrupted",
			status: TaskStatus.Resumable,
			isTerminal: false,
			isWaitingForInput: true,
			waitingReason: "resumable",
		}
	}

	if (askType === "followup" || askType === "command" || askType === "tool" || askType === "use_mcp_server") {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "active",
			status: TaskStatus.Interactive,
			isTerminal: false,
			isWaitingForInput: true,
			waitingReason: "interactive",
		}
	}

	if (askType === "completion_result") {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "active",
			status: TaskStatus.Idle,
			isTerminal: false,
			isWaitingForInput: true,
			waitingReason: "completion",
		}
	}

	if (latest?.type === "say" && latest.say === "error") {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Failed,
			historyStatus: "failed",
			status: TaskStatus.None,
			isTerminal: true,
			isWaitingForInput: false,
		}
	}

	if (latest?.type === "say" && latest.say === "completion_result" && latest.partial !== true) {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Completed,
			historyStatus: "completed",
			status: TaskStatus.Idle,
			isTerminal: true,
			isWaitingForInput: false,
		}
	}

	if (taskStatus === TaskStatus.Interactive) {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "active",
			status: taskStatus,
			isTerminal: false,
			isWaitingForInput: true,
			waitingReason: "interactive",
		}
	}

	if (taskStatus === TaskStatus.Resumable || taskStatus === TaskStatus.Idle) {
		return {
			source: "legacy",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "active",
			status: taskStatus,
			isTerminal: false,
			isWaitingForInput: Boolean(ask),
			waitingReason: taskStatus === TaskStatus.Resumable ? "resumable" : "idle",
		}
	}

	return {
		source: "legacy",
		lifecycle: taskStatus === TaskStatus.None ? TaskLifecycleState.Initializing : TaskLifecycleState.Running,
		historyStatus: "active",
		status: taskStatus ?? TaskStatus.Running,
		isTerminal: false,
		isWaitingForInput: false,
	}
}

/**
 * Project an individual canonical turn into the legacy task/session surface.
 * A terminal turn is not a terminal task: the task may still publish its
 * completion review boundary, accept feedback, or start another turn.
 */
export function projectAgentLifecycleSnapshot(
	snapshot: AgentLifecycleSnapshot,
	options: { taskAsk?: ClineMessage; messages?: readonly ClineMessage[] } = {},
): ClineMessageStatusProjection {
	if (snapshot.status !== "in_progress") {
		return {
			source: "lifecycle",
			lifecycle: TaskLifecycleState.Running,
			historyStatus: "active",
			status: snapshot.status,
			isTerminal: false,
			isWaitingForInput: false,
		}
	}

	const waitingByPhase = snapshot.phase === "waiting" || snapshot.phase === "awaiting_approval"
	const taskAsk = options.taskAsk
	const waitingByAsk = taskAsk?.type === "ask" && taskAsk.ask !== "resume_completed_task"
	return {
		source: "lifecycle",
		lifecycle: waitingByPhase || waitingByAsk ? TaskLifecycleState.Waiting : TaskLifecycleState.Running,
		historyStatus: "active",
		status: snapshot.status,
		isTerminal: false,
		isWaitingForInput: waitingByPhase || waitingByAsk,
		waitingReason: waitingByPhase ? snapshot.phase : waitingByAsk ? "interactive" : undefined,
	}
}

/**
 * Pure status adapter. It accepts both a single ClineMessage and a transcript
 * so callers can migrate incrementally without changing existing UI records.
 */
export function projectClineMessageStatus(
	input:
		| ClineMessage
		| readonly ClineMessage[]
		| {
				messages?: readonly ClineMessage[]
				taskAsk?: ClineMessage
				taskStatus?: TaskStatus
				snapshot?: AgentLifecycleSnapshot
		  },
	options: {
		taskAsk?: ClineMessage
		taskStatus?: TaskStatus
		snapshot?: AgentLifecycleSnapshot
	} = {},
): ClineMessageStatusProjection {
	let messages: readonly ClineMessage[] = []
	let taskAsk = options.taskAsk
	let taskStatus = options.taskStatus
	let snapshot = options.snapshot

	if (Array.isArray(input)) messages = input
	else if (input && typeof input === "object" && !Array.isArray(input) && "ts" in input) {
		messages = [input as ClineMessage]
	} else if (input && typeof input === "object" && !Array.isArray(input)) {
		const optionsInput = input as {
			messages?: readonly ClineMessage[]
			taskAsk?: ClineMessage
			taskStatus?: TaskStatus
			snapshot?: AgentLifecycleSnapshot
		}
		messages = optionsInput.messages ?? []
		taskAsk = optionsInput.taskAsk ?? taskAsk
		taskStatus = optionsInput.taskStatus ?? taskStatus
		snapshot = optionsInput.snapshot ?? snapshot
	}

	return snapshot
		? projectAgentLifecycleSnapshot(snapshot, { taskAsk, messages })
		: legacyProjection(messages, taskAsk, taskStatus)
}

export function projectLifecycleSnapshotToTaskLifecycle(
	snapshot: AgentLifecycleSnapshot,
	taskAsk?: ClineMessage,
): TaskLifecycleState {
	return projectAgentLifecycleSnapshot(snapshot, { taskAsk }).lifecycle
}

export function projectLifecycleSnapshotToHistoryStatus(
	snapshot: AgentLifecycleSnapshot,
): NonNullable<HistoryItem["status"]> {
	return projectAgentLifecycleSnapshot(snapshot).historyStatus
}

export const projectLifecycleStatus = projectAgentLifecycleSnapshot
export const projectTaskStatus = projectClineMessageStatus
export const toTaskLifecycleState = projectLifecycleSnapshotToTaskLifecycle
export const toHistoryStatus = projectLifecycleSnapshotToHistoryStatus

/** Return whether a projection has reached one of the legacy terminal states. */
export function isProjectedTaskTerminal(projection: ClineMessageStatusProjection): boolean {
	return projection.isTerminal || terminalLifecycleStates.has(projection.lifecycle)
}

/** The reducer fingerprint is re-exported at the extension boundary for tests and diagnostics. */
export { fingerprintAgentLifecycleEvent }
