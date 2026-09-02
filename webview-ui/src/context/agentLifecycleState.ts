import {
	agentLifecycleEventSchema,
	agentLifecycleEventMessageSchema,
	agentLifecycleDegradedMessageSchema,
	agentLifecycleDegradedSignalSchema,
	agentLifecycleSnapshotSchema,
	agentLifecycleSnapshotMessageSchema,
	type AgentLifecycleEvent,
	type AgentLifecycleDegradedSignal,
	type AgentLifecycleItem,
	type AgentLifecycleSnapshot,
	type ExtensionState,
	type LiveTaskMetadata,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

/**
 * The extension host owns the canonical lifecycle reducer. The webview keeps
 * a validated snapshot projection so it can update immediately on an event
 * and recover from a later full snapshot without touching the transcript.
 */
export type AgentLifecycleSnapshots = Record<string, AgentLifecycleSnapshot>
export type AgentLifecycleDegradedSignals = Record<string, AgentLifecycleDegradedSignal>

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

const clone = <T>(value: T): T => structuredClone(value)

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function isDirectLifecycleEvent(value: unknown): boolean {
	const record = asRecord(value)
	return Boolean(record && typeof record.type === "string" && lifecycleEventTypes.has(record.type))
}

function isDirectLifecycleSnapshot(value: unknown): boolean {
	const record = asRecord(value)
	return Boolean(record && record.version === 1 && typeof record.taskId === "string" && "lastSequence" in record)
}

export function parseAgentLifecycleSnapshot(value: unknown): AgentLifecycleSnapshot | undefined {
	if (isDirectLifecycleSnapshot(value)) {
		const parsed = agentLifecycleSnapshotSchema.safeParse(value)
		return parsed.success ? parsed.data : undefined
	}

	const record = asRecord(value)
	const aliases = [record?.payload, record?.snapshot, record?.agentLifecycleSnapshot].filter(
		(candidate) => candidate !== undefined,
	)
	if (aliases.length > 1 && aliases.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(aliases[0]))) {
		return undefined
	}
	const envelope = agentLifecycleSnapshotMessageSchema.safeParse(value)
	if (!envelope.success) return undefined
	return envelope.data.payload ?? envelope.data.snapshot ?? envelope.data.agentLifecycleSnapshot
}

export function parseAgentLifecycleEvent(value: unknown): AgentLifecycleEvent | undefined {
	if (isDirectLifecycleEvent(value)) {
		const parsed = agentLifecycleEventSchema.safeParse(value)
		return parsed.success ? parsed.data : undefined
	}

	const record = asRecord(value)
	const aliases = [record?.payload, record?.event, record?.agentLifecycleEvent].filter(
		(candidate) => candidate !== undefined,
	)
	if (aliases.length > 1 && aliases.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(aliases[0]))) {
		return undefined
	}
	const envelope = agentLifecycleEventMessageSchema.safeParse(value)
	if (!envelope.success) return undefined
	return envelope.data.payload ?? envelope.data.event ?? envelope.data.agentLifecycleEvent
}

export function parseAgentLifecycleDegraded(value: unknown): AgentLifecycleDegradedSignal | undefined {
	const record = asRecord(value)
	if (
		record &&
		record.version === 1 &&
		typeof record.taskId === "string" &&
		typeof record.degraded === "boolean" &&
		typeof record.occurredAt === "number"
	) {
		const parsed = agentLifecycleDegradedSignalSchema.safeParse(value)
		return parsed.success ? parsed.data : undefined
	}

	const aliases = [record?.payload, record?.signal, record?.agentLifecycleDegraded].filter(
		(candidate) => candidate !== undefined,
	)
	if (aliases.length > 1 && aliases.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(aliases[0]))) {
		return undefined
	}
	const envelope = agentLifecycleDegradedMessageSchema.safeParse(value)
	if (!envelope.success) return undefined
	return envelope.data.payload ?? envelope.data.signal ?? envelope.data.agentLifecycleDegraded
}

/** Merge a state payload containing the currently degraded task signals. */
export function mergeAgentLifecycleDegradedSignals(
	previous: AgentLifecycleDegradedSignals | undefined,
	incoming: AgentLifecycleDegradedSignals | undefined,
): AgentLifecycleDegradedSignals | undefined {
	if (incoming === undefined) return previous
	const merged: AgentLifecycleDegradedSignals = {}
	for (const [taskId, value] of Object.entries(incoming)) {
		const signal = parseAgentLifecycleDegraded(value)
		if (signal?.degraded && signal.taskId === taskId) merged[taskId] = clone(signal)
	}
	return merged
}

function lifecyclePhaseForEvent(event: AgentLifecycleEvent): AgentLifecycleSnapshot["phase"] {
	switch (event.type) {
		case "turn_started":
			return event.payload.phase ?? "starting"
		case "phase_changed":
			return event.payload.phase
		case "step_started":
		case "step_status_changed":
			return event.payload.phase ?? "working"
		default:
			return "working"
	}
}

function createSnapshotFromEvent(event: AgentLifecycleEvent): AgentLifecycleSnapshot {
	return {
		version: 1,
		taskId: event.taskId,
		runId: event.runId,
		turnId: event.turnId,
		status: "in_progress",
		phase: lifecyclePhaseForEvent(event),
		lastSequence: 0,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
	}
}

function fingerprint(event: AgentLifecycleEvent): string {
	return JSON.stringify(event)
}

function addItem(snapshot: AgentLifecycleSnapshot, item: AgentLifecycleItem): void {
	if (snapshot.items.some((candidate) => candidate.itemId === item.itemId)) return
	snapshot.items.push(item)
	if (item.type === "tool_call" && item.status === "accepted" && item.accepted !== false) {
		if (!snapshot.acceptedToolCallIds.includes(item.toolCallId)) {
			snapshot.acceptedToolCallIds.push(item.toolCallId)
		}
	}
	if (item.type === "tool_result" && !snapshot.terminalToolCallIds.includes(item.toolCallId)) {
		snapshot.terminalToolCallIds.push(item.toolCallId)
	}
}

function applyEvent(snapshot: AgentLifecycleSnapshot, event: AgentLifecycleEvent): void {
	switch (event.type) {
		case "turn_started":
			snapshot.phase = event.payload.phase ?? snapshot.phase
			return
		case "phase_changed":
			snapshot.phase = event.payload.phase
			return
		case "step_started":
			snapshot.steps.push({
				stepId: event.stepId,
				status: "in_progress",
				phase: event.payload.phase,
				startedAt: event.occurredAt,
			})
			snapshot.currentStepId = event.stepId
			snapshot.phase = event.payload.phase ?? snapshot.phase
			return
		case "step_status_changed": {
			const step = snapshot.steps.find((candidate) => candidate.stepId === event.stepId)
			if (step) {
				step.status = event.payload.status
				step.phase = event.payload.phase ?? step.phase
				if (event.payload.status !== "in_progress") step.endedAt = event.occurredAt
				if (event.payload.reason !== undefined) step.reason = event.payload.reason
			}
			snapshot.currentStepId = event.stepId
			snapshot.phase = event.payload.phase ?? snapshot.phase
			return
		}
		case "item_added":
		case "tool_call_accepted":
		case "tool_result_recorded":
		case "approval_requested":
			addItem(snapshot, event.payload.item)
			return
		case "item_updated":
		case "approval_resolved": {
			const item = event.payload.item
			const index = snapshot.items.findIndex((candidate) => candidate.itemId === item.itemId)
			if (index >= 0) snapshot.items[index] = item
			return
		}
		case "turn_status_changed":
			snapshot.status = event.payload.status
			if (event.payload.status !== "in_progress") {
				snapshot.terminalEventId = event.eventId
				snapshot.terminalAt = event.occurredAt
			}
			return
		case "turn_terminal":
		case "turn_completed":
		case "turn_interrupted":
		case "turn_cancelled":
		case "turn_failed":
			snapshot.status =
				event.type === "turn_completed" ? "completed" : event.type === "turn_failed" ? "failed" : "interrupted"
			snapshot.terminalEventId = event.eventId
			snapshot.terminalAt = event.occurredAt
			return
	}
}

/**
 * Apply an event when an older host does not attach its already-reduced
 * snapshot to the event envelope. Invalid, out-of-order, or conflicting
 * deltas are intentionally ignored; the next host snapshot is authoritative.
 */
export function reduceAgentLifecycleEvent(
	previous: AgentLifecycleSnapshot | undefined,
	value: unknown,
): AgentLifecycleSnapshot | undefined {
	const event = parseAgentLifecycleEvent(value)
	if (!event) return previous

	let snapshot = previous
	if (!snapshot) {
		if (event.sequence !== 1) return undefined
		snapshot = createSnapshotFromEvent(event)
	} else if (snapshot.taskId !== event.taskId || snapshot.runId !== event.runId || snapshot.turnId !== event.turnId) {
		if (event.sequence !== 1 || snapshot.status === "in_progress") return snapshot
		snapshot = createSnapshotFromEvent(event)
	}

	const receipt = snapshot.processedEvents.find((candidate) => candidate.eventId === event.eventId)
	if (receipt)
		return receipt.sequence === event.sequence && receipt.fingerprint === fingerprint(event) ? snapshot : undefined
	if (event.sequence !== snapshot.lastSequence + 1 || snapshot.status !== "in_progress") return snapshot

	const next = clone(snapshot)
	applyEvent(next, event)
	next.lastSequence = event.sequence
	next.processedEvents.push({ eventId: event.eventId, sequence: event.sequence, fingerprint: fingerprint(event) })
	const parsed = agentLifecycleSnapshotSchema.safeParse(next)
	return parsed.success ? parsed.data : snapshot
}

function shouldReplaceSnapshot(previous: AgentLifecycleSnapshot | undefined, next: AgentLifecycleSnapshot): boolean {
	if (!previous) return true
	if (previous.taskId !== next.taskId) return true
	if (previous.runId === next.runId && previous.turnId === next.turnId)
		return next.lastSequence >= previous.lastSequence
	return previous.status !== "in_progress" || next.lastSequence >= previous.lastSequence
}

/** Merge full snapshots without allowing delayed state messages to roll back a task. */
export function mergeAgentLifecycleSnapshots(
	previous: AgentLifecycleSnapshots | undefined,
	incoming: AgentLifecycleSnapshots | undefined,
): AgentLifecycleSnapshots {
	if (!incoming || Object.keys(incoming).length === 0) return previous ?? {}

	let merged = previous ?? {}
	for (const [taskId, value] of Object.entries(incoming ?? {})) {
		const snapshot = parseAgentLifecycleSnapshot(value)
		if (snapshot && snapshot.taskId === taskId && shouldReplaceSnapshot(merged[taskId], snapshot)) {
			if (merged === previous) merged = { ...merged }
			merged[taskId] = clone(snapshot)
		}
	}
	return merged
}

export interface ProjectedLifecycleMetadata {
	lifecycle: TaskLifecycleState
	status: TaskStatus
	isWaitingForInput: boolean
	waitingReason?: string
	isTerminal: boolean
}

export function projectLifecycleMetadata(snapshot: AgentLifecycleSnapshot): ProjectedLifecycleMetadata {
	if (snapshot.status === "completed") {
		return {
			lifecycle: TaskLifecycleState.Completed,
			status: TaskStatus.Idle,
			isWaitingForInput: false,
			isTerminal: true,
		}
	}
	if (snapshot.status === "failed") {
		return {
			lifecycle: TaskLifecycleState.Failed,
			status: TaskStatus.Idle,
			isWaitingForInput: false,
			isTerminal: true,
		}
	}
	if (snapshot.status === "interrupted") {
		return {
			lifecycle: TaskLifecycleState.Closed,
			status: TaskStatus.Idle,
			isWaitingForInput: false,
			isTerminal: true,
		}
	}

	const isWaitingForInput = snapshot.phase === "waiting" || snapshot.phase === "awaiting_approval"
	return {
		lifecycle: isWaitingForInput ? TaskLifecycleState.Waiting : TaskLifecycleState.Running,
		status: isWaitingForInput ? TaskStatus.Interactive : TaskStatus.Running,
		isWaitingForInput,
		waitingReason: isWaitingForInput ? snapshot.phase : undefined,
		isTerminal: false,
	}
}

/** Project canonical snapshots into the existing live-task status surface. */
export function applyLifecycleSnapshotsToExtensionState(
	state: ExtensionState,
	snapshots: AgentLifecycleSnapshots | undefined = state.agentLifecycleSnapshots,
): ExtensionState {
	if (!snapshots || Object.keys(snapshots).length === 0) return state

	let liveTasksById = state.liveTasksById
	let liveTaskIds = state.liveTaskIds
	for (const snapshot of Object.values(snapshots)) {
		if (state.agentLifecycleDegraded?.[snapshot.taskId]?.degraded) continue
		const projection = projectLifecycleMetadata(snapshot)
		const existing = liveTasksById?.[snapshot.taskId]
		const nextMetadata = {
			id: snapshot.taskId,
			status: projection.status,
			lifecycle: projection.lifecycle,
			isActive: existing?.isActive ?? state.activeTaskId === snapshot.taskId,
			isStreaming: existing?.isStreaming === true && !projection.isTerminal && !projection.isWaitingForInput,
			isWaitingForInput: projection.isWaitingForInput,
			lastUpdatedAt: snapshot.terminalAt ?? existing?.lastUpdatedAt ?? 0,
			waitingReason: projection.waitingReason,
			queueCount: existing?.queueCount ?? 0,
			tokensIn: existing?.tokensIn ?? 0,
			tokensOut: existing?.tokensOut ?? 0,
			totalCost: existing?.totalCost ?? 0,
		}
		if (!liveTasksById || liveTasksById[snapshot.taskId] !== nextMetadata) {
			liveTasksById = { ...(liveTasksById ?? {}), [snapshot.taskId]: nextMetadata }
		}

		const taskIds = liveTaskIds ?? []
		const containsTask = taskIds.includes(snapshot.taskId)
		if (projection.isTerminal && containsTask) {
			liveTaskIds = taskIds.filter((taskId) => taskId !== snapshot.taskId)
		} else if (!projection.isTerminal && !containsTask) {
			liveTaskIds = [...taskIds, snapshot.taskId]
		}
	}

	return liveTasksById === state.liveTasksById && liveTaskIds === state.liveTaskIds
		? state
		: { ...state, liveTasksById, liveTaskIds }
}

/**
 * Reconstruct a task's legacy status from the transcript when a canonical
 * snapshot must be ignored. This is intentionally conservative: an absent
 * transcript is treated as an active task rather than trusting stale
 * canonical terminal metadata.
 */
export function projectLegacyLiveTaskMetadata(
	state: Pick<ExtensionState, "activeTaskId" | "currentTaskId" | "currentTaskItem" | "clineMessages">,
	taskId: string,
	existing?: LiveTaskMetadata,
): LiveTaskMetadata | undefined {
	if (!existing && state.currentTaskId !== taskId) return undefined

	const messages = state.currentTaskId === taskId ? state.clineMessages : []
	const latest = messages.at(-1)
	const taskAsk = [...messages].reverse().find((message) => message.type === "ask")
	const askType = taskAsk?.type === "ask" ? taskAsk.ask : undefined
	const base: LiveTaskMetadata = existing ?? {
		id: taskId,
		status: TaskStatus.Running,
		lifecycle: TaskLifecycleState.Running,
		isActive: state.activeTaskId === taskId,
		isStreaming: false,
		isWaitingForInput: false,
		lastUpdatedAt: 0,
		queueCount: 0,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}

	const terminal = (lifecycle: TaskLifecycleState, status: TaskStatus): LiveTaskMetadata => ({
		...base,
		status,
		lifecycle,
		isStreaming: false,
		isWaitingForInput: false,
		waitingReason: undefined,
		lastUpdatedAt: latest?.ts ?? base.lastUpdatedAt,
	})
	const waiting = (status: TaskStatus, waitingReason: string): LiveTaskMetadata => ({
		...base,
		status,
		lifecycle: TaskLifecycleState.Waiting,
		isStreaming: false,
		isWaitingForInput: true,
		waitingReason,
		lastUpdatedAt: latest?.ts ?? base.lastUpdatedAt,
	})

	if (askType === "resume_completed_task") return terminal(TaskLifecycleState.Completed, TaskStatus.Idle)
	if (askType === "resume_task") return waiting(TaskStatus.Resumable, "resumable")
	if (askType === "followup" || askType === "command" || askType === "tool" || askType === "use_mcp_server") {
		return waiting(TaskStatus.Interactive, "interactive")
	}
	if (askType === "completion_result") return waiting(TaskStatus.Idle, "completion")
	if (latest?.type === "say" && latest.say === "error") return terminal(TaskLifecycleState.Failed, TaskStatus.None)
	if (latest?.type === "say" && latest.say === "completion_result" && latest.partial !== true) {
		return terminal(TaskLifecycleState.Completed, TaskStatus.Idle)
	}

	const historyStatus = state.currentTaskItem?.id === taskId ? state.currentTaskItem.status : undefined
	if (historyStatus === "completed") return terminal(TaskLifecycleState.Completed, TaskStatus.Idle)
	if (historyStatus === "failed") return terminal(TaskLifecycleState.Failed, TaskStatus.None)
	if (historyStatus === "interrupted" || historyStatus === "cancelled" || historyStatus === "timed_out") {
		return terminal(TaskLifecycleState.Closed, TaskStatus.Idle)
	}

	return {
		...base,
		status: TaskStatus.Running,
		lifecycle: TaskLifecycleState.Running,
		isStreaming: base.isStreaming,
		isWaitingForInput: false,
		waitingReason: undefined,
		lastUpdatedAt: latest?.ts ?? base.lastUpdatedAt,
	}
}

/** Apply a task-scoped lifecycle fallback/recovery signal. */
export function applyLifecycleDegradedToExtensionState(state: ExtensionState, signalValue: unknown): ExtensionState {
	const signal = parseAgentLifecycleDegraded(signalValue)
	if (!signal) return state

	const degraded = { ...(state.agentLifecycleDegraded ?? {}) }
	if (signal.degraded) degraded[signal.taskId] = clone(signal)
	else delete degraded[signal.taskId]

	const nextState = { ...state, agentLifecycleDegraded: degraded }
	if (signal.degraded) {
		const legacy = projectLegacyLiveTaskMetadata(nextState, signal.taskId, nextState.liveTasksById?.[signal.taskId])
		if (!legacy) return nextState
		const liveTasksById = { ...(nextState.liveTasksById ?? {}), [signal.taskId]: legacy }
		const liveTaskIds = nextState.liveTaskIds ?? []
		const isTerminal =
			legacy.lifecycle === TaskLifecycleState.Completed ||
			legacy.lifecycle === TaskLifecycleState.Failed ||
			legacy.lifecycle === TaskLifecycleState.Closed
		const nextLiveTaskIds = isTerminal
			? liveTaskIds.filter((taskId) => taskId !== signal.taskId)
			: liveTaskIds.includes(signal.taskId)
				? liveTaskIds
				: [...liveTaskIds, signal.taskId]
		return { ...nextState, liveTasksById, liveTaskIds: nextLiveTaskIds }
	}

	const snapshot = nextState.agentLifecycleSnapshots?.[signal.taskId]
	return snapshot ? applyLifecycleSnapshotToExtensionState(nextState, snapshot) : nextState
}

export const applyAgentLifecycleDegradedToExtensionState = applyLifecycleDegradedToExtensionState

export function applyLifecycleSnapshotToExtensionState(state: ExtensionState, snapshotValue: unknown): ExtensionState {
	const snapshot = parseAgentLifecycleSnapshot(snapshotValue)
	if (!snapshot) return state
	const snapshots = mergeAgentLifecycleSnapshots(state.agentLifecycleSnapshots, { [snapshot.taskId]: snapshot })
	if (snapshots === state.agentLifecycleSnapshots) return state
	return applyLifecycleSnapshotsToExtensionState({ ...state, agentLifecycleSnapshots: snapshots }, snapshots)
}

export function applyLifecycleEventToExtensionState(state: ExtensionState, eventValue: unknown): ExtensionState {
	const event = parseAgentLifecycleEvent(eventValue)
	if (!event) return state
	const attachedSnapshotValue = asRecord(eventValue)?.agentLifecycleSnapshot
	if (attachedSnapshotValue !== undefined) {
		const attachedSnapshot = parseAgentLifecycleSnapshot(attachedSnapshotValue)
		if (!attachedSnapshot || attachedSnapshot.taskId !== event.taskId) return state
		return applyLifecycleSnapshotToExtensionState(state, attachedSnapshot)
	}
	const current = state.agentLifecycleSnapshots?.[event.taskId]
	const next = reduceAgentLifecycleEvent(current, event)
	if (!next) return state
	const snapshots = mergeAgentLifecycleSnapshots(state.agentLifecycleSnapshots, { [event.taskId]: next })
	if (snapshots === state.agentLifecycleSnapshots) return state
	return applyLifecycleSnapshotsToExtensionState({ ...state, agentLifecycleSnapshots: snapshots }, snapshots)
}
