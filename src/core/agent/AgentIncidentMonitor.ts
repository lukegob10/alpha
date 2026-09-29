import { createHash } from "crypto"

import {
	agentLifecycleEventSchema,
	toolNamesSchema,
	type AgentLifecycleEvent,
	type HistoryItem,
	type IncidentDashboardAlert,
	type IncidentDashboardSnapshot,
	type IncidentDashboardTask,
	type IncidentDashboardTimelineItem,
	type ToolName,
} from "@alpha-code/types"

const MAX_TASKS = 12
const MAX_ALERTS = 12
const MAX_TIMELINE_ITEMS = 8
const MAX_EVENTS_PER_TASK = 256
const MAX_TASK_ID_LENGTH = 128
const MAX_OPAQUE_ID_LENGTH = 256
const MAX_INVESTIGATION_PROMPT_BYTES = 12_000
const SAFE_EVIDENCE_WARNINGS = new Set([
	"SOURCE_LIMIT",
	"SOURCE_NOT_FILE",
	"SOURCE_CHANGED",
	"SOURCE_MALFORMED",
	"SOURCE_RECORD_LIMIT",
	"SOURCE_SEQUENCE_INVALID",
	"SOURCE_UNAVAILABLE",
])
const TIMELINE_KINDS = new Set<TimelineKind>([
	"task_started",
	"turn_started",
	"turn_completed",
	"turn_failed",
	"approval_requested",
	"approval_resolved",
	"cancelled",
	"interrupted",
	"lifecycle_resync",
	"lifecycle_invalid",
	"task_status_changed",
])

const PROJECTION_ISSUE_REASONS = new Set<IncidentProjectionIssueReason>([
	"sequence_gap",
	"duplicate_event_conflict",
	"duplicate_sequence",
	"identity_conflict",
	"persistence_failed",
])

type TaskState = IncidentDashboardTask["state"]
type TimelineKind = IncidentDashboardTimelineItem["kind"]
type IncidentKind = "turn_failed" | "task_failed" | "lifecycle_resync" | "persistence_failed"
type EvidenceSource = "lifecycle" | "projector" | "task_history"
type EvidenceStatus = "captured" | "absent" | "incomplete"
type ErrorStatus = "failed" | "incomplete"

export interface AgentIncidentMonitorOptions {
	/** Injectable wall clock for deterministic hosts and tests. */
	now?: () => number
	/** Maximum number of task projections retained, capped at the dashboard contract limit. */
	maxTasks?: number
	/** Maximum event IDs retained per task for replay deduplication. */
	maxEventsPerTask?: number
	/** Maximum timeline entries retained per task, capped at the dashboard contract limit. */
	maxTimelinePerTask?: number
	/** Maximum alerts retained, capped at the dashboard contract limit. */
	maxAlerts?: number
}

export interface IncidentTaskSeed {
	taskId: string
	status?: HistoryItem["status"]
	updatedAt?: number
	evidenceStatus?: EvidenceStatus
	diagnosticSession?: boolean
	/** Canonical lifecycle journal tail, in its persisted order. */
	events?: readonly AgentLifecycleEvent[]
}

export type IncidentProjectionIssueReason =
	| "sequence_gap"
	| "duplicate_event_conflict"
	| "duplicate_sequence"
	| "identity_conflict"
	| "persistence_failed"

/** Bounded, payload-free details from the lifecycle projector or journal reader. */
export interface IncidentProjectionIssue {
	taskId: string
	reason: IncidentProjectionIssueReason
	at?: number
	eventId?: string
	runId?: string
	turnId?: string
	expectedSequence?: number
	receivedSequence?: number
}

export interface IncidentObservationOptions {
	diagnosticSession?: boolean
}

export interface IncidentAlertContext extends IncidentDashboardAlert {
	taskId: string
	errorStatus: ErrorStatus
	evidenceStatus?: EvidenceStatus
	turnIdSha256?: string
	toolCallIdSha256?: string
	toolName?: ToolName
	incidentKind: IncidentKind
	taskIdSha256: string
	taskLabel: string
	taskState: TaskState
	taskTimeline: IncidentDashboardTimelineItem[]
	evidenceReference: {
		source: EvidenceSource
		eventIdSha256?: string
		runIdSha256?: string
		turnIdSha256?: string
		sequence?: number
		expectedSequence?: number
		at: number
		reason?: IncidentProjectionIssueReason
	}
}

interface StoredTimelineItem extends IncidentDashboardTimelineItem {
	sequence: number
}

interface TaskRecord {
	taskId: string
	taskIdSha256: string
	label: string
	state: TaskState
	stateAt: number
	updatedAt: number
	lastLiveEventAt: number
	evidenceStatus?: EvidenceStatus
	timeline: StoredTimelineItem[]
	seenEventIds: Set<string>
	toolNamesByCallId: Map<string, ToolName>
	recentFailedTool?: { runIdSha256: string; turnIdSha256: string; toolCallIdSha256: string; toolName?: ToolName }
}

interface StoredAlert extends IncidentDashboardAlert {
	taskId: string
	errorStatus: ErrorStatus
	turnIdSha256?: string
	toolCallIdSha256?: string
	toolName?: ToolName
	incidentKind: IncidentKind
	taskIdSha256: string
	evidenceReference: IncidentAlertContext["evidenceReference"]
	identityKey: string
	origin: "live" | "restored"
}

interface InvestigationEvidenceSource {
	status?: unknown
	sourceBytes?: unknown
	sourceSha256?: unknown
	warning?: unknown
}

/** Structural subset of `CollectedDiagnosticsEvidence`; raw history and projections are intentionally ignored. */
export interface IncidentInvestigationEvidence {
	evidence?: {
		status?: unknown
		taskIdSha256?: unknown
		sources?: Record<string, InvestigationEvidenceSource | undefined>
		joins?: { missing?: readonly unknown[] }
		rawProviderHistory?: { included?: unknown; reason?: unknown }
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

function validTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
		? value
		: undefined
}

function validTaskId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TASK_ID_LENGTH
}

function boundedLimit(value: number | undefined, defaultValue: number, hardLimit: number): number {
	if (!Number.isInteger(value) || value === undefined || value < 1) return defaultValue
	return Math.min(value, hardLimit)
}

function taskLabel(taskId: string): string {
	return `Task ${hashEvidenceId(taskId).slice(0, 8)}`
}

function taskLabelForPrompt(taskId: string): string {
	return taskLabel(taskId)
}

function validSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
}

function isEvidenceStatus(value: unknown): value is EvidenceStatus {
	return value === "captured" || value === "absent" || value === "incomplete"
}

function hashEvidenceId(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex")
}

function taskStateFromHistory(status: HistoryItem["status"] | undefined): TaskState {
	switch (status) {
		case "active":
			return "running"
		case "blocked":
		case "delegated":
			return "waiting"
		case "completed":
			return "completed"
		case "failed":
		case "timed_out":
			return "failed"
		case "cancelled":
			return "cancelled"
		case "interrupted":
			return "interrupted"
		default:
			return "unknown"
	}
}

function taskStateFromTurnStatus(status: string): TaskState | undefined {
	switch (status) {
		case "in_progress":
			return "running"
		case "completed":
			return "completed"
		case "failed":
			return "failed"
		case "interrupted":
			return "interrupted"
		default:
			return undefined
	}
}

function timelineProjection(event: AgentLifecycleEvent):
	| {
			kind: TimelineKind
			label: IncidentDashboardTimelineItem["label"]
	  }
	| undefined {
	switch (event.type) {
		case "turn_started":
			return { kind: "turn_started", label: "Turn started" }
		case "phase_changed":
			return event.payload.phase === "awaiting_approval"
				? { kind: "approval_requested", label: "Waiting for approval" }
				: undefined
		case "approval_requested":
			return { kind: "approval_requested", label: "Approval requested" }
		case "approval_resolved":
			return { kind: "approval_resolved", label: "Approval resolved" }
		case "turn_completed":
			return { kind: "turn_completed", label: "Turn completed" }
		case "turn_failed":
			return { kind: "turn_failed", label: "Turn failed" }
		case "turn_terminal":
			if (event.payload.status === "failed") return { kind: "turn_failed", label: "Turn failed" }
			if (event.payload.status === "interrupted") return { kind: "interrupted", label: "Turn interrupted" }
			return { kind: "turn_completed", label: "Turn completed" }
		case "turn_interrupted":
			return { kind: "interrupted", label: "Turn interrupted" }
		case "turn_cancelled":
			return { kind: "cancelled", label: "Turn cancelled" }
		case "turn_status_changed":
			if (event.payload.status === "failed") return { kind: "turn_failed", label: "Turn failed" }
			if (event.payload.status === "interrupted") return { kind: "interrupted", label: "Turn interrupted" }
			if (event.payload.status === "completed") return { kind: "turn_completed", label: "Turn completed" }
			return undefined
		case "step_status_changed":
			if (event.payload.status === "failed") return { kind: "task_status_changed", label: "Step failed" }
			return undefined
		default:
			return undefined
	}
}

function alertText(
	kind: IncidentKind,
): Pick<IncidentDashboardAlert, "severity" | "title" | "summary"> & { errorStatus: ErrorStatus } {
	switch (kind) {
		case "turn_failed":
			return {
				severity: "error",
				title: "Agent turn failed",
				summary: "A task turn ended in an explicit failure. Review the bounded lifecycle evidence.",
				errorStatus: "failed",
			}
		case "task_failed":
			return {
				severity: "error",
				title: "Task failed",
				summary: "Task history records a failure or timeout.",
				errorStatus: "failed",
			}
		case "lifecycle_resync":
			return {
				severity: "warning",
				title: "Lifecycle stream needs resync",
				summary: "The lifecycle projector could not verify an event sequence or identity.",
				errorStatus: "incomplete",
			}
		case "persistence_failed":
			return {
				severity: "warning",
				title: "Lifecycle evidence write failed",
				summary: "A lifecycle event could not be persisted, so task evidence may be incomplete.",
				errorStatus: "incomplete",
			}
	}
}

function isFailureEvent(event: AgentLifecycleEvent): boolean {
	return (
		event.type === "turn_failed" ||
		(event.type === "turn_terminal" && event.payload.status === "failed") ||
		(event.type === "turn_status_changed" && event.payload.status === "failed")
	)
}

function isFailureTaskStatus(status: HistoryItem["status"] | undefined): boolean {
	return status === "failed" || status === "timed_out"
}

function eventState(event: AgentLifecycleEvent): TaskState | undefined {
	switch (event.type) {
		case "turn_started":
			return event.payload.phase === "awaiting_approval" || event.payload.phase === "waiting"
				? "waiting"
				: "running"
		case "phase_changed":
			return event.payload.phase === "awaiting_approval" || event.payload.phase === "waiting"
				? "waiting"
				: "running"
		case "step_started":
			return event.payload.phase === "awaiting_approval" || event.payload.phase === "waiting"
				? "waiting"
				: "running"
		case "step_status_changed":
			if (event.payload.status !== "in_progress") return undefined
			return event.payload.phase === "awaiting_approval" || event.payload.phase === "waiting"
				? "waiting"
				: "running"
		case "approval_requested":
			return "waiting"
		case "approval_resolved":
			return event.payload.item.status === "cancelled" ? "cancelled" : "running"
		case "turn_status_changed":
			return taskStateFromTurnStatus(event.payload.status)
		case "turn_terminal":
			return taskStateFromTurnStatus(event.payload.status)
		case "turn_completed":
			return "completed"
		case "turn_failed":
			return "failed"
		case "turn_interrupted":
			return "interrupted"
		case "turn_cancelled":
			return "cancelled"
		default:
			return undefined
	}
}

function safeHash(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_OPAQUE_ID_LENGTH
		? hashEvidenceId(value)
		: undefined
}

function safeSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function eventReference(event: AgentLifecycleEvent): IncidentAlertContext["evidenceReference"] {
	return {
		source: "lifecycle",
		eventIdSha256: safeHash(event.eventId),
		runIdSha256: safeHash(event.runId),
		turnIdSha256: safeHash(event.turnId),
		sequence: safeSequence(event.sequence),
		at: event.occurredAt,
	}
}

function compareTimeline(left: StoredTimelineItem, right: StoredTimelineItem): number {
	return left.at - right.at || left.sequence - right.sequence || left.id.localeCompare(right.id)
}

/**
 * Keeps a bounded, privacy-filtered in-memory view of canonical lifecycle events.
 * It accepts only events already applied by the lifecycle projector; callers
 * report rejected projections through `recordProjectionIssue`.
 */
export class AgentIncidentMonitor {
	private readonly now: () => number
	private readonly maxTasks: number
	private readonly maxEventsPerTask: number
	private readonly maxTimelinePerTask: number
	private readonly maxAlerts: number
	private readonly tasks = new Map<string, TaskRecord>()
	private readonly alerts = new Map<string, StoredAlert>()
	private readonly alertIdsByIdentity = new Map<string, string>()
	private readonly diagnosticTaskIds = new Set<string>()
	private readonly listeners = new Set<(snapshot: IncidentDashboardSnapshot) => void>()

	constructor(options: AgentIncidentMonitorOptions = {}) {
		this.now = options.now ?? Date.now
		this.maxTasks = boundedLimit(options.maxTasks, MAX_TASKS, MAX_TASKS)
		this.maxEventsPerTask = boundedLimit(options.maxEventsPerTask, MAX_EVENTS_PER_TASK, MAX_EVENTS_PER_TASK)
		this.maxTimelinePerTask = boundedLimit(options.maxTimelinePerTask, MAX_TIMELINE_ITEMS, MAX_TIMELINE_ITEMS)
		this.maxAlerts = boundedLimit(options.maxAlerts, MAX_ALERTS, MAX_ALERTS)
	}

	/**
	 * Observe one already-applied canonical lifecycle event. The return value is
	 * present only when this event created a new safe dashboard alert.
	 */
	observe(event: AgentLifecycleEvent, options: IncidentObservationOptions = {}): IncidentDashboardAlert | undefined {
		if (options.diagnosticSession === true) {
			this.excludeDiagnosticTask(event?.taskId)
			return undefined
		}
		if (!isRecord(event) || !agentLifecycleEventSchema.safeParse(event).success) return undefined
		if (this.diagnosticTaskIds.has(event.taskId)) return undefined

		const task = this.getOrCreateTask(event.taskId, event.occurredAt)
		if (!task || task.seenEventIds.has(hashEvidenceId(event.eventId))) return undefined
		this.rememberEventId(task, event.eventId)
		task.lastLiveEventAt = Math.max(task.lastLiveEventAt, event.occurredAt)
		task.updatedAt = Math.max(task.updatedAt, event.occurredAt)
		this.captureToolContext(task, event)

		const state = eventState(event)
		if (state && event.occurredAt >= task.stateAt) {
			task.state = state
			task.stateAt = event.occurredAt
		}

		const projectedTimeline = timelineProjection(event)
		if (projectedTimeline) {
			this.addTimeline(task, {
				id: hashEvidenceId(`timeline\0${event.taskId}\0${event.eventId}`),
				at: event.occurredAt,
				kind: projectedTimeline.kind,
				label: projectedTimeline.label,
				sequence: event.sequence,
			})
		}

		let newAlert: IncidentDashboardAlert | undefined
		if (isFailureEvent(event)) {
			const failedTool =
				task.recentFailedTool?.runIdSha256 === hashEvidenceId(event.runId) &&
				task.recentFailedTool.turnIdSha256 === hashEvidenceId(event.turnId)
					? task.recentFailedTool
					: undefined
			const alert = this.addAlert({
				task,
				kind: "turn_failed",
				at: event.occurredAt,
				identity: `${event.runId}\0${event.turnId}`,
				reference: eventReference(event),
				tool: failedTool,
				origin: "live",
			})
			if (alert) newAlert = this.toDashboardAlert(alert)
		}

		this.publish()
		return newAlert
	}

	/**
	 * Merge a bounded tail of recent task history and lifecycle records. Existing
	 * live observations and alerts are retained; repeated journal events are
	 * ignored by event ID, and older seed status cannot overwrite newer events.
	 */
	restore(seeds: readonly IncidentTaskSeed[]): IncidentDashboardSnapshot {
		const candidateSeeds = seeds.slice(0, this.maxTasks * 4)
		for (const seed of candidateSeeds) {
			if (!validTaskId(seed?.taskId) || seed.diagnosticSession !== true) continue
			this.removeTask(seed.taskId)
			this.rememberDiagnosticTask(seed.taskId)
		}
		const eligible = candidateSeeds
			.filter((seed) => validTaskId(seed?.taskId) && seed.diagnosticSession !== true)
			.map((seed, index) => ({
				seed,
				index,
				recency: Math.max(
					validTimestamp(seed.updatedAt) ?? 0,
					...(seed.events ?? [])
						.slice(-this.maxEventsPerTask)
						.map((event) => validTimestamp(event?.occurredAt) ?? 0),
				),
			}))
			.sort((left, right) => right.recency - left.recency || left.index - right.index)
			.slice(0, this.maxTasks)

		for (const { seed } of eligible) {
			if (seed.diagnosticSession === true) continue
			if (this.diagnosticTaskIds.has(seed.taskId)) continue
			let task = this.tasks.get(seed.taskId)
			if (!task) {
				if (this.tasks.size >= this.maxTasks) continue
				task = this.createTask(seed.taskId)
				this.tasks.set(seed.taskId, task)
			}

			const statusAt = validTimestamp(seed.updatedAt)
			if (task.evidenceStatus === undefined && isEvidenceStatus(seed.evidenceStatus))
				task.evidenceStatus = seed.evidenceStatus
			if (
				seed.status !== undefined &&
				(statusAt !== undefined ? statusAt >= task.stateAt : task.lastLiveEventAt === 0)
			) {
				task.state = taskStateFromHistory(seed.status)
				task.stateAt = statusAt ?? task.stateAt
				task.updatedAt = Math.max(task.updatedAt, statusAt ?? 0)
			}

			const events = (seed.events ?? []).slice(-this.maxEventsPerTask)
			for (const candidate of events) {
				if (!agentLifecycleEventSchema.safeParse(candidate).success || candidate.taskId !== seed.taskId)
					continue
				this.processRestoredEvent(task, candidate)
			}

			if (isFailureTaskStatus(seed.status)) {
				const failedAt = statusAt ?? this.currentTime()
				const hasRecentFailure = [...this.alerts.values()].some(
					(alert) =>
						alert.taskId === seed.taskId &&
						(alert.incidentKind === "turn_failed" || alert.incidentKind === "task_failed"),
				)
				if (!hasRecentFailure) {
					if (task.evidenceStatus === undefined) task.evidenceStatus = seed.evidenceStatus
					this.addTimeline(task, {
						id: hashEvidenceId(`timeline\0${seed.taskId}\0task-failed\0${failedAt}`),
						at: failedAt,
						kind: "task_status_changed",
						label: "Task marked failed",
						sequence: 0,
					})
					this.addAlert({
						task,
						kind: "task_failed",
						at: failedAt,
						identity: String(failedAt),
						reference: { source: "task_history", at: failedAt },
						origin: "restored",
					})
				}
			}
		}

		this.publish()
		return this.snapshot()
	}

	/** Record a projector or journal integrity issue without retaining raw details. */
	recordProjectionIssue(
		issue: IncidentProjectionIssue,
		options: IncidentObservationOptions = {},
	): IncidentDashboardAlert | undefined {
		if (!isRecord(issue) || !validTaskId(issue.taskId)) return undefined
		if (options.diagnosticSession === true) {
			this.excludeDiagnosticTask(issue.taskId)
			return undefined
		}
		if (this.diagnosticTaskIds.has(issue.taskId) || !PROJECTION_ISSUE_REASONS.has(issue.reason)) return undefined

		const at = validTimestamp(issue.at) ?? this.currentTime()
		const task = this.getOrCreateTask(issue.taskId, at)
		if (!task) return undefined
		task.evidenceStatus = "incomplete"
		task.updatedAt = Math.max(task.updatedAt, at)
		const isPersistenceFailure = issue.reason === "persistence_failed"
		const kind: IncidentKind = isPersistenceFailure ? "persistence_failed" : "lifecycle_resync"
		const timelineKind: TimelineKind = "lifecycle_resync"
		this.addTimeline(task, {
			id: hashEvidenceId(`timeline\0${issue.taskId}\0${kind}\0${issue.eventId ?? issue.receivedSequence ?? at}`),
			at,
			kind: timelineKind,
			label: isPersistenceFailure ? "Lifecycle persistence failed" : "Lifecycle resync required",
			sequence: safeSequence(issue.receivedSequence) ?? 0,
		})

		const alert = this.addAlert({
			task,
			kind,
			at,
			identity: [
				issue.reason,
				issue.runId ?? "",
				issue.turnId ?? "",
				issue.eventId ?? issue.receivedSequence ?? "",
			].join("\0"),
			reference: {
				source: "projector",
				eventIdSha256: safeHash(issue.eventId),
				runIdSha256: safeHash(issue.runId),
				turnIdSha256: safeHash(issue.turnId),
				sequence: safeSequence(issue.receivedSequence),
				expectedSequence: safeSequence(issue.expectedSequence),
				at,
				reason: issue.reason,
			},
			origin: "live",
		})
		this.publish()
		return alert ? this.toDashboardAlert(alert) : undefined
	}

	/** Return a bounded immutable dashboard projection. */
	snapshot(): IncidentDashboardSnapshot {
		const tasks = [...this.tasks.values()]
			.sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId))
			.slice(0, this.maxTasks)
			.map((task) => ({
				taskId: task.taskIdSha256,
				label: task.label,
				state: task.state,
				updatedAt: task.updatedAt,
				...(task.evidenceStatus ? { evidenceStatus: task.evidenceStatus } : {}),
				timeline: task.timeline.map(({ sequence: _sequence, ...item }) => item),
			}))
		const alerts = [...this.alerts.values()]
			.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id))
			.slice(0, this.maxAlerts)
			.map((alert) => this.toDashboardAlert(alert))
		return { generatedAt: this.currentTime(), tasks, alerts }
	}

	/** Resolve an alert into local IDs, current task state, safe timeline, and hashed event references. */
	getAlert(alertId: string): IncidentAlertContext | undefined {
		const stored = this.alerts.get(alertId)
		if (!stored) return undefined
		const task = this.tasks.get(stored.taskId)
		if (!task) return undefined
		return {
			...this.toDashboardAlert(stored),
			taskId: stored.taskId,
			incidentKind: stored.incidentKind,
			taskIdSha256: stored.taskIdSha256,
			taskLabel: task.label,
			taskState: task.state,
			taskTimeline: task.timeline.map(({ sequence: _sequence, ...item }) => ({ ...item })),
			evidenceReference: { ...stored.evidenceReference },
		}
	}

	/** Update evidence completeness after click-time diagnostics collection. */
	setEvidenceStatus(taskId: string, status: EvidenceStatus | undefined): IncidentDashboardSnapshot {
		const task = this.tasks.get(taskId)
		if (!task || (status !== undefined && !isEvidenceStatus(status))) return this.snapshot()
		task.evidenceStatus = status
		for (const alert of this.alerts.values()) {
			if (alert.taskId !== taskId) continue
			alert.evidenceStatus = status
		}
		this.publish()
		return this.snapshot()
	}

	/** Subscribe to dashboard updates. The returned function removes the listener. */
	subscribe(listener: (snapshot: IncidentDashboardSnapshot) => void): () => void {
		this.listeners.add(listener)
		this.notifyListener(listener, this.snapshot())
		return () => this.listeners.delete(listener)
	}

	private processRestoredEvent(task: TaskRecord, event: AgentLifecycleEvent): void {
		if (this.diagnosticTaskIds.has(event.taskId) || task.seenEventIds.has(hashEvidenceId(event.eventId))) return
		this.rememberEventId(task, event.eventId)
		task.updatedAt = Math.max(task.updatedAt, event.occurredAt)
		this.captureToolContext(task, event)
		const state = eventState(event)
		if (state && event.occurredAt >= task.stateAt) {
			task.state = state
			task.stateAt = event.occurredAt
		}
		const projectedTimeline = timelineProjection(event)
		if (projectedTimeline) {
			this.addTimeline(task, {
				id: hashEvidenceId(`timeline\0${event.taskId}\0${event.eventId}`),
				at: event.occurredAt,
				kind: projectedTimeline.kind,
				label: projectedTimeline.label,
				sequence: event.sequence,
			})
		}
		if (isFailureEvent(event)) {
			const failedTool =
				task.recentFailedTool?.runIdSha256 === hashEvidenceId(event.runId) &&
				task.recentFailedTool.turnIdSha256 === hashEvidenceId(event.turnId)
					? task.recentFailedTool
					: undefined
			this.addAlert({
				task,
				kind: "turn_failed",
				at: event.occurredAt,
				identity: `${event.runId}\0${event.turnId}`,
				reference: eventReference(event),
				tool: failedTool,
				origin: "restored",
			})
		}
	}

	private getOrCreateTask(taskId: string, at: number): TaskRecord | undefined {
		if (!validTaskId(taskId) || this.diagnosticTaskIds.has(taskId)) return undefined
		const existing = this.tasks.get(taskId)
		if (existing) return existing
		if (this.tasks.size >= this.maxTasks) {
			const oldest = [...this.tasks.values()].sort(
				(left, right) => left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId),
			)[0]
			if (!oldest || oldest.updatedAt > at) return undefined
			this.removeTask(oldest.taskId)
		}
		const task = this.createTask(taskId)
		task.updatedAt = at
		this.tasks.set(taskId, task)
		return task
	}

	private createTask(taskId: string): TaskRecord {
		return {
			taskId,
			taskIdSha256: hashEvidenceId(taskId),
			label: taskLabel(taskId),
			state: "unknown",
			stateAt: 0,
			updatedAt: 0,
			lastLiveEventAt: 0,
			timeline: [],
			seenEventIds: new Set(),
			toolNamesByCallId: new Map(),
		}
	}

	private captureToolContext(task: TaskRecord, event: AgentLifecycleEvent): void {
		if (event.type === "turn_started") {
			if (
				task.recentFailedTool?.runIdSha256 !== hashEvidenceId(event.runId) ||
				task.recentFailedTool.turnIdSha256 !== hashEvidenceId(event.turnId)
			)
				task.recentFailedTool = undefined
		}
		if (event.type === "tool_call_accepted") {
			const { toolCallId, name } = event.payload.item
			const parsedName = toolNamesSchema.safeParse(name)
			if (parsedName.success) task.toolNamesByCallId.set(hashEvidenceId(toolCallId), parsedName.data)
			while (task.toolNamesByCallId.size > this.maxEventsPerTask) {
				const oldest = task.toolNamesByCallId.keys().next().value as string | undefined
				if (oldest === undefined) break
				task.toolNamesByCallId.delete(oldest)
			}
			return
		}
		if (event.type !== "tool_result_recorded") return
		const result = event.payload.item
		const toolCallIdSha256 = hashEvidenceId(result.toolCallId)
		const toolName = task.toolNamesByCallId.get(toolCallIdSha256)
		task.toolNamesByCallId.delete(toolCallIdSha256)
		if (result.status !== "failed" && result.status !== "error") return
		task.recentFailedTool = {
			runIdSha256: hashEvidenceId(event.runId),
			turnIdSha256: hashEvidenceId(event.turnId),
			toolCallIdSha256,
			...(toolName ? { toolName } : {}),
		}
		this.addTimeline(task, {
			id: hashEvidenceId(`timeline\0${event.taskId}\0tool-error\0${event.eventId}`),
			at: event.occurredAt,
			kind: "task_status_changed",
			label: "Tool returned an error",
			sequence: event.sequence,
		})
	}

	private addTimeline(task: TaskRecord, item: StoredTimelineItem): void {
		if (task.timeline.some((existing) => existing.id === item.id)) return
		task.timeline.push(item)
		task.timeline.sort(compareTimeline)
		if (task.timeline.length > this.maxTimelinePerTask)
			task.timeline.splice(0, task.timeline.length - this.maxTimelinePerTask)
	}

	private rememberEventId(task: TaskRecord, eventId: string): void {
		task.seenEventIds.add(hashEvidenceId(eventId))
		while (task.seenEventIds.size > this.maxEventsPerTask) {
			const oldest = task.seenEventIds.values().next().value as string | undefined
			if (oldest === undefined) break
			task.seenEventIds.delete(oldest)
		}
	}

	private addAlert(input: {
		task: TaskRecord
		kind: IncidentKind
		at: number
		identity: string
		reference: IncidentAlertContext["evidenceReference"]
		tool?: TaskRecord["recentFailedTool"]
		origin: "live" | "restored"
	}): StoredAlert | undefined {
		const identityKey = hashEvidenceId(`${input.task.taskId}\0${input.kind}\0${input.identity}`)
		const existingId = this.alertIdsByIdentity.get(identityKey)
		if (existingId) return undefined
		const text = alertText(input.kind)
		const id = hashEvidenceId(`alert\0${identityKey}`)
		const alert: StoredAlert = {
			id,
			...text,
			at: input.at,
			taskId: input.task.taskId,
			incidentKind: input.kind,
			taskIdSha256: input.task.taskIdSha256,
			errorStatus: text.errorStatus,
			evidenceStatus: input.task.evidenceStatus,
			turnIdSha256: input.reference.turnIdSha256,
			toolCallIdSha256: input.tool?.toolCallIdSha256,
			toolName: input.tool?.toolName,
			evidenceReference: input.reference,
			identityKey,
			origin: input.origin,
		}
		this.alerts.set(id, alert)
		this.alertIdsByIdentity.set(identityKey, id)
		while (this.alerts.size > this.maxAlerts) {
			const allAlerts = [...this.alerts.values()]
			const restoredAlerts = allAlerts.filter((item) => item.origin === "restored")
			const candidates = input.origin === "live" && restoredAlerts.length === 0 ? allAlerts : restoredAlerts
			const oldest = candidates.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))[0]
			if (!oldest) break
			this.alerts.delete(oldest.id)
			this.alertIdsByIdentity.delete(oldest.identityKey)
		}
		return this.alerts.has(id) ? alert : undefined
	}

	private toDashboardAlert(alert: StoredAlert): IncidentDashboardAlert {
		return {
			id: alert.id,
			severity: alert.severity,
			title: alert.title,
			summary: alert.summary,
			at: alert.at,
			taskId: alert.taskIdSha256,
			errorStatus: alert.errorStatus,
			...(alert.evidenceStatus ? { evidenceStatus: alert.evidenceStatus } : {}),
			...(alert.turnIdSha256 ? { turnIdSha256: alert.turnIdSha256 } : {}),
			...(alert.toolCallIdSha256 ? { toolCallIdSha256: alert.toolCallIdSha256 } : {}),
			...(alert.toolName ? { toolName: alert.toolName } : {}),
		}
	}

	private excludeDiagnosticTask(taskId: unknown): void {
		if (!validTaskId(taskId)) return
		const hadTask = this.tasks.has(taskId)
		const hadDiagnostic = this.diagnosticTaskIds.has(taskId)
		if (hadDiagnostic && !hadTask) return
		this.removeTask(taskId)
		this.rememberDiagnosticTask(taskId)
		if (hadTask || !hadDiagnostic) this.publish()
	}

	private rememberDiagnosticTask(taskId: string): void {
		this.diagnosticTaskIds.delete(taskId)
		this.diagnosticTaskIds.add(taskId)
		while (this.diagnosticTaskIds.size > MAX_TASKS * 4) {
			const oldest = this.diagnosticTaskIds.values().next().value as string | undefined
			if (oldest === undefined) break
			this.diagnosticTaskIds.delete(oldest)
		}
	}

	private removeTask(taskId: string): void {
		const removed = this.tasks.get(taskId)
		if (!removed) return
		this.tasks.delete(taskId)
		for (const [id, alert] of this.alerts) {
			if (alert.taskId !== taskId) continue
			this.alerts.delete(id)
			this.alertIdsByIdentity.delete(alert.identityKey)
		}
	}

	private currentTime(): number {
		const value = this.now()
		return validTimestamp(value) ?? 0
	}

	private publish(): void {
		const snapshot = this.snapshot()
		for (const listener of this.listeners) this.notifyListener(listener, snapshot)
	}

	private notifyListener(
		listener: (snapshot: IncidentDashboardSnapshot) => void,
		snapshot: IncidentDashboardSnapshot,
	): void {
		try {
			listener(snapshot)
		} catch {
			// Dashboard observers must not change lifecycle event acceptance or task completion.
		}
	}
}

/**
 * Build a small investigation prompt from a safe alert context and the safe
 * evidence collector output. Raw transcript history and source projections are
 * not included; only fixed labels, hashes, bounded counters, and status codes
 * cross this boundary.
 */
export function buildIncidentInvestigationPrompt(
	alert: IncidentAlertContext,
	collectedEvidence: IncidentInvestigationEvidence,
): string {
	const alertId = typeof alert.id === "string" && /^[a-f0-9]{64}$/i.test(alert.id) ? alert.id : "unavailable"
	const safeAlertId = alertId
	const safeTaskId = validTaskId(alert.taskId) ? alert.taskId : undefined
	const safeTaskHash = safeTaskId
		? hashEvidenceId(safeTaskId)
		: typeof alert.taskIdSha256 === "string" && /^[a-f0-9]{64}$/i.test(alert.taskIdSha256)
			? alert.taskIdSha256
			: "unavailable"
	const incidentKind: IncidentKind =
		alert.incidentKind === "task_failed" ||
		alert.incidentKind === "lifecycle_resync" ||
		alert.incidentKind === "persistence_failed"
			? alert.incidentKind
			: "turn_failed"
	const alertDescription = alertText(incidentKind)
	const taskLabel = safeTaskId ? taskLabelForPrompt(safeTaskId) : "Task unavailable"
	const taskState: TaskState = [
		"running",
		"waiting",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
		"unknown",
	].includes(alert.taskState)
		? alert.taskState
		: "unknown"
	const reference = alert.evidenceReference
	const safeAt = validTimestamp(reference.at) ?? validTimestamp(alert.at) ?? 0
	const source: EvidenceSource =
		reference.source === "lifecycle" || reference.source === "projector" || reference.source === "task_history"
			? reference.source
			: "lifecycle"
	const evidence = collectedEvidence?.evidence
	const evidenceStatus =
		evidence?.status === "captured" || evidence?.status === "absent" || evidence?.status === "incomplete"
			? evidence.status
			: "unavailable"
	const evidenceTaskHash =
		typeof evidence?.taskIdSha256 === "string" && /^[a-f0-9]{64}$/i.test(evidence.taskIdSha256)
			? evidence.taskIdSha256
			: "unavailable"
	const sources: string[] = []
	for (const name of ["lifecycle", "lifecycleSnapshot", "eventLog", "transcript", "providerTranscript"] as const) {
		const source = evidence?.sources?.[name]
		const status =
			source?.status === "captured" || source?.status === "absent" || source?.status === "incomplete"
				? source.status
				: "unavailable"
		const bytes =
			typeof source?.sourceBytes === "number" && Number.isFinite(source.sourceBytes) && source.sourceBytes >= 0
				? Math.floor(source.sourceBytes)
				: undefined
		const digest =
			typeof source?.sourceSha256 === "string" && /^[a-f0-9]{64}$/i.test(source.sourceSha256)
				? source.sourceSha256
				: undefined
		const warning =
			typeof source?.warning === "string" && SAFE_EVIDENCE_WARNINGS.has(source.warning)
				? source.warning
				: undefined
		sources.push(
			`- ${name}: ${status}${bytes === undefined ? "" : `, ${bytes} bytes`}${digest ? `, SHA-256 ${digest}` : ""}${warning ? `, ${warning}` : ""}`,
		)
	}
	const eventRef = [
		`source=${source}`,
		`at=${safeAt}`,
		validSha256(reference.eventIdSha256) ? `eventIdSha256=${reference.eventIdSha256}` : undefined,
		validSha256(reference.runIdSha256) ? `runIdSha256=${reference.runIdSha256}` : undefined,
		validSha256(reference.turnIdSha256) ? `turnIdSha256=${reference.turnIdSha256}` : undefined,
		safeSequence(reference.sequence) === undefined ? undefined : `sequence=${reference.sequence}`,
		safeSequence(reference.expectedSequence) === undefined
			? undefined
			: `expectedSequence=${reference.expectedSequence}`,
		PROJECTION_ISSUE_REASONS.has(reference.reason as IncidentProjectionIssueReason)
			? `reason=${reference.reason}`
			: undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("; ")
	const timeline = (Array.isArray(alert.taskTimeline) ? alert.taskTimeline : [])
		.slice(-MAX_TIMELINE_ITEMS)
		.flatMap((item) =>
			validSha256(item.id) && validTimestamp(item.at) !== undefined && TIMELINE_KINDS.has(item.kind)
				? [`- ${item.at}: ${item.kind} (${item.id})`]
				: [],
		)
		.join("\n")
	const likelyArea =
		incidentKind === "lifecycle_resync" || incidentKind === "persistence_failed"
			? "Lifecycle journal persistence, event ordering, or projector resynchronization."
			: "The task turn’s terminal failure path; the captured evidence does not identify a root cause by itself."
	const errorStatus =
		alert.errorStatus === "failed" || alert.errorStatus === "incomplete" ? alert.errorStatus : "unavailable"
	const priorEvidenceStatus =
		alert.evidenceStatus === "captured" ||
		alert.evidenceStatus === "absent" ||
		alert.evidenceStatus === "incomplete"
			? alert.evidenceStatus
			: "not checked"
	const toolNameResult = toolNamesSchema.safeParse(alert.toolName)
	const toolName = toolNameResult.success ? toolNameResult.data : "unavailable"
	const prompt = [
		"Investigate this Alpha Code incident using only the bounded evidence references below.",
		"Do not infer or reconstruct user prompts, tool arguments, command text, provider payloads, or file contents.",
		"",
		"Observed facts",
		`- Incident: ${alertDescription.title} (${alertDescription.severity})`,
		`- Alert ID: ${safeAlertId}`,
		`- Task reference: ${taskLabel}; task ID SHA-256 ${safeTaskHash}`,
		`- Current task state: ${taskState}`,
		`- Error status: ${errorStatus}`,
		`- Turn ID SHA-256: ${validSha256(alert.turnIdSha256) ? alert.turnIdSha256 : validSha256(reference.turnIdSha256) ? reference.turnIdSha256 : "unavailable"}`,
		`- Tool: ${toolName}`,
		`- Tool call ID SHA-256: ${validSha256(alert.toolCallIdSha256) ? alert.toolCallIdSha256 : "unavailable"}`,
		`- Evidence status before this collection: ${priorEvidenceStatus}`,
		`- Incident time: ${safeAt}`,
		`- Timeline:\n${timeline || "- No additional bounded timeline items."}`,
		"",
		"Likely area",
		`- ${likelyArea}`,
		"",
		"Exact evidence references",
		`- Incident event: ${eventRef}`,
		`- Evidence collection status: ${evidenceStatus}; task ID SHA-256 ${evidenceTaskHash}`,
		"- Sources:",
		...sources,
		`- Raw provider history included: ${evidence?.rawProviderHistory?.included === false ? "no" : "no; excluded by policy"}`,
		`- Missing joins recorded: ${Array.isArray(evidence?.joins?.missing) ? Math.min(evidence.joins.missing.length, 2_000) : 0}`,
		"",
		"Unverified hypotheses",
		"- The root cause is not established by the available projected evidence.",
		"",
		"Next checks",
		"- Compare the referenced lifecycle event sequence with its task snapshot and event-log joins.",
		"- Check whether the same failure identity appears in the turn and task histories.",
		"- Treat missing, incomplete, or mismatched evidence as uncertainty; do not infer from absent records.",
	].join("\n")
	return truncateUtf8(prompt, MAX_INVESTIGATION_PROMPT_BYTES)
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
	const suffix = "\n[bounded prompt truncated]"
	let output = value
	while (Buffer.byteLength(`${output}${suffix}`, "utf8") > maxBytes)
		output = output.slice(0, Math.max(0, output.length - 64))
	return `${output}${suffix}`
}
