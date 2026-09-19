import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import type { Stats } from "fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import {
	hashAgentTurnEvidenceId,
	projectPersistedAgentTurnEvent,
	type PersistedAgentTurnEvent,
} from "../agent/AgentTurnEventLog"

const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024
const MAX_LINE_BYTES = 256 * 1_024
const MAX_EVENTS = 2_000
const MAX_HISTORY_MESSAGES = 2_000

const EVENT_TYPES = new Set([
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
	"assistant_committed",
	"response_terminal",
	"tool_result",
	"tool_batch_started",
	"tool_batch_finished",
	"approval_request",
	"approval_result",
	"retry",
	"model_request_started",
	"request_usage",
	"turn_completed",
	"task_completed",
	"turn_failed",
	"task_failed",
	"turn_incomplete",
	"task_incomplete",
	"compaction_completed",
	"verification_result",
	"cancelled",
	"turn_interrupted",
	"turn_cancelled",
	"internal_task_started",
	"internal_task_completed",
	"progress",
	"context_refreshed",
	"policy_snapshot",
	"profile_resolved",
])
const STATUSES = new Set([
	"in_progress",
	"starting",
	"running",
	"finalizing",
	"completed",
	"failed",
	"incomplete",
	"exhausted",
	"aborted",
	"cancelled",
	"success",
	"error",
	"denied",
	"approved",
	"blocked",
	"timed_out",
	"pending",
	"interrupted",
])
const PHASES = new Set([
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
const COMMAND_CATEGORIES = new Set(["test", "build", "lint", "typecheck"])
const COMPLETION_REASON_CODES = new Set([
	"ready",
	"command_running",
	"receipt_pending",
	"evidence_pending",
	"scope_unavailable",
	"verification_failed",
	"verification_missing",
	"managed_results_pending",
	"descendants_running",
	"child_results_unconsumed",
	"todos_open",
	"persistence_unavailable",
	"runtime_timeout",
	"interrupted",
	"repair_limit",
	"stale_content",
	"unsafe_command",
	"unsupported_command",
	"unsupported_configuration",
	"uncovered_changes",
	"unavailable_scope",
	"missing_change_set",
	"unknown_change_set",
	"unavailable_content",
	"no_test_validation",
	"runtime_scope_unavailable",
])
const OBLIGATION_STATUSES = new Set(["required", "pending", "satisfied", "failed", "superseded", "not_applicable"])
const OBLIGATION_ORIGINS = new Set(["worker", "primary"])

export type DiagnosticsEvidenceStatus = "captured" | "absent" | "incomplete"

export interface DiagnosticsSourceEvidence {
	status: DiagnosticsEvidenceStatus
	sourceBytes?: number
	sourceSha256?: string
	warning?: string
	projection?: unknown
}

export interface CollectedDiagnosticsEvidence {
	history: Array<Record<string, unknown>>
	historyParseFailed: boolean
	evidence: {
		status: DiagnosticsEvidenceStatus
		taskIdSha256: string
		rawProviderHistory: { included: false; reason: "omitted_by_default" }
		sources: Record<string, DiagnosticsSourceEvidence>
		joins: { records: Array<Record<string, unknown>>; missing: string[] }
	}
}

interface BoundedSource {
	content: Buffer
	bytes: number
	sha256: string
}

class SourceError extends Error {
	constructor(
		readonly warning:
			| "SOURCE_LIMIT"
			| "SOURCE_NOT_FILE"
			| "SOURCE_CHANGED"
			| "SOURCE_MALFORMED"
			| "SOURCE_RECORD_LIMIT"
			| "SOURCE_SEQUENCE_INVALID",
	) {
		super(warning)
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 256 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function hashId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256
		? hashAgentTurnEvidenceId(value)
		: undefined
}

function projectLifecycleEvent(value: unknown): Record<string, unknown> | undefined {
	const raw = object(value)
	const event = object(raw?.event) ?? raw
	const payload = object(event?.payload) ?? event
	const type = safeString(event?.type)
	if (!type || !EVENT_TYPES.has(type)) return undefined
	const projected: Record<string, unknown> = { type }
	for (const key of ["eventId", "taskId", "runId", "turnId", "stepId", "correlationId", "causationId"] as const) {
		const value = hashId(event?.[key] ?? raw?.[key])
		if (value) projected[`${key}Sha256`] = value
	}
	for (const key of [
		"sequence",
		"occurredAt",
		"attempt",
		"requestIndex",
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"durationMs",
		"exitCode",
		"batchSize",
		"parallelBatchCount",
		"parallelToolCount",
		"truncatedResultCount",
	] as const) {
		const number = finiteNumber(raw?.[key] ?? payload?.[key])
		if (number !== undefined) projected[key] = number
	}
	for (const key of ["status", "phase", "decision", "commandCategory"] as const) {
		const value = safeString(payload?.[key] ?? raw?.[key])
		if (
			value &&
			((key === "status" && STATUSES.has(value)) ||
				(key === "phase" && PHASES.has(value)) ||
				(key === "commandCategory" && COMMAND_CATEGORIES.has(value)) ||
				(key === "decision" && ["approved", "denied", "cancelled"].includes(value)))
		)
			projected[key] = value
	}
	for (const key of ["callId", "toolCallId", "requestId", "attemptId", "approvalId"] as const) {
		const value = hashId(payload?.[key] ?? raw?.[key])
		if (value) projected[`${key}Sha256`] = value
	}
	for (const key of ["reason", "error", "message"] as const) {
		if (payload?.[key] !== undefined || raw?.[key] !== undefined) projected[`${key}Present`] = true
	}
	return projected
}

function projectSnapshot(value: unknown): Record<string, unknown> {
	const snapshot = object(value)
	if (!snapshot) throw new SourceError("SOURCE_MALFORMED")
	const projected: Record<string, unknown> = {}
	for (const key of ["taskId", "runId", "turnId", "currentStepId"] as const) {
		const value = hashId(snapshot[key])
		if (value) projected[`${key}Sha256`] = value
	}
	for (const key of ["version", "lastSequence"] as const) {
		const value = finiteNumber(snapshot[key])
		if (value !== undefined) projected[key] = value
	}
	for (const key of ["status", "phase"] as const) {
		const value = safeString(snapshot[key])
		if (value && ((key === "status" && STATUSES.has(value)) || (key === "phase" && PHASES.has(value))))
			projected[key] = value
	}
	for (const key of ["items", "steps", "acceptedToolCallIds", "terminalToolCallIds", "processedEvents"] as const) {
		if (Array.isArray(snapshot[key])) projected[`${key}Count`] = snapshot[key].length
	}
	return projected
}

function projectProviderTranscript(value: unknown): Record<string, unknown> {
	const receipt = object(value)
	if (!receipt) throw new SourceError("SOURCE_MALFORMED")
	const projected: Record<string, unknown> = {}
	for (const key of ["version", "revision", "messageCount", "committedAt"] as const) {
		const value = finiteNumber(receipt[key])
		if (value !== undefined) projected[key] = value
	}
	for (const key of ["taskId", "digest", "instanceId"] as const) {
		const value = safeString(receipt[key])
		if (value) projected[`${key}Sha256`] = hashAgentTurnEvidenceId(value)
	}
	return projected
}

function projectConversation(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) throw new SourceError("SOURCE_MALFORMED")
	if (value.length > MAX_HISTORY_MESSAGES) throw new SourceError("SOURCE_RECORD_LIMIT")
	return value.map((entry, index) => {
		const message = object(entry)
		const blocks = Array.isArray(message?.content) ? message.content : []
		return {
			index,
			role:
				message?.role === "assistant" || message?.role === "user" || message?.role === "system"
					? message.role
					: "unknown",
			blocks: blocks.flatMap((blockValue) => {
				const block = object(blockValue)
				if (!block || typeof block.type !== "string") return []
				const type = ["text", "image", "tool_use", "tool_result", "thinking", "image_url"].includes(block.type)
					? block.type
					: "unknown"
				const projected: Record<string, unknown> = { type }
				if (type === "tool_use" && typeof block.id === "string")
					projected.idSha256 = hashAgentTurnEvidenceId(block.id)
				if (type === "tool_result" && typeof block.tool_use_id === "string") {
					projected.toolUseIdSha256 = hashAgentTurnEvidenceId(block.tool_use_id)
					projected.isError = block.is_error === true
				}
				return [projected]
			}),
		}
	})
}

function sameSource(left: Stats, right: Stats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	)
}

async function readBoundedSource(filePath: string): Promise<BoundedSource> {
	const stat = await fs.lstat(filePath)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new SourceError("SOURCE_NOT_FILE")
	if (stat.size > MAX_SOURCE_BYTES) throw new SourceError("SOURCE_LIMIT")
	let handle: Awaited<ReturnType<typeof fs.open>>
	try {
		handle = await fs.open(filePath, "r")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceError("SOURCE_CHANGED")
		throw error
	}
	const chunks: Buffer[] = []
	let bytes = 0
	try {
		const opened = await handle.stat()
		if (!sameSource(stat, opened)) throw new SourceError("SOURCE_CHANGED")
		const buffer = Buffer.alloc(64 * 1_024)
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
			if (bytesRead === 0) break
			bytes += bytesRead
			if (bytes > MAX_SOURCE_BYTES) throw new SourceError("SOURCE_LIMIT")
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
		}
		const finalStat = await handle.stat()
		const namedStat = await fs.lstat(filePath)
		if (!sameSource(opened, finalStat) || !sameSource(opened, namedStat)) throw new SourceError("SOURCE_CHANGED")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceError("SOURCE_CHANGED")
		throw error
	} finally {
		await handle.close()
	}
	const content = Buffer.concat(chunks, bytes)
	return { content, bytes, sha256: createHash("sha256").update(content).digest("hex") }
}

function projectJsonLines(content: Buffer, project: (value: unknown) => unknown): unknown[] {
	const lines = content.toString("utf8").split("\n")
	if (lines.at(-1) === "") lines.pop()
	if (lines.length > MAX_EVENTS) throw new SourceError("SOURCE_RECORD_LIMIT")
	const result: unknown[] = []
	for (const line of lines) {
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES || line.trim().length === 0)
			throw new SourceError(line.trim().length === 0 ? "SOURCE_MALFORMED" : "SOURCE_LIMIT")
		let value: unknown
		try {
			value = JSON.parse(line)
		} catch {
			throw new SourceError("SOURCE_MALFORMED")
		}
		const projection = project(value)
		if (projection === undefined) throw new SourceError("SOURCE_MALFORMED")
		result.push(projection)
	}
	return result
}

function projectJournalRecords(
	content: Buffer,
	project: (value: unknown) => unknown,
	sequencePartition: "run" | "turn",
): Record<string, unknown> {
	const events = projectJsonLines(content, project)
	const sequencesByPartition = new Map<string, number[]>()
	let unverified = false
	for (const value of events) {
		const record = object(value)
		const sequence = record?.sequence
		const runId = record?.runIdSha256
		const turnId = record?.turnIdSha256
		if (
			!Number.isInteger(sequence) ||
			(sequence as number) <= 0 ||
			typeof runId !== "string" ||
			(sequencePartition === "turn" && typeof turnId !== "string")
		) {
			unverified = true
			continue
		}
		const partition = sequencePartition === "turn" ? `${runId}:${turnId as string}` : runId
		const sequences = sequencesByPartition.get(partition) ?? []
		sequences.push(sequence as number)
		sequencesByPartition.set(partition, sequences)
	}
	const sequenceInvalid = [...sequencesByPartition.values()].some((sequences) =>
		sequences.some((sequence, index) => sequence !== index + 1),
	)
	const validationStatus = sequenceInvalid
		? "incomplete"
		: unverified || sequencesByPartition.size === 0
			? "unverified"
			: "validated"
	return {
		events,
		captureStatus: "captured",
		validationStatus,
		warnings: sequenceInvalid
			? ["SOURCE_SEQUENCE_INVALID"]
			: validationStatus === "unverified"
				? ["SOURCE_VALIDATION_UNVERIFIED"]
				: [],
		// The old boolean remains for readers that only understand the v1 shape.
		complete: validationStatus === "validated",
	}
}

async function captureSource(
	filePath: string,
	project: (content: Buffer) => unknown,
): Promise<DiagnosticsSourceEvidence> {
	try {
		const source = await readBoundedSource(filePath)
		return {
			status: "captured",
			sourceBytes: source.bytes,
			sourceSha256: source.sha256,
			projection: project(source.content),
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" }
		const warning =
			error instanceof SourceError
				? error.warning
				: error instanceof SyntaxError
					? "SOURCE_MALFORMED"
					: "SOURCE_UNAVAILABLE"
		return { status: "incomplete", warning }
	}
}

function joinEvidence(
	lifecycle: DiagnosticsSourceEvidence,
	eventLog: DiagnosticsSourceEvidence,
): { records: Array<Record<string, unknown>>; missing: string[] } {
	const fields = [
		"taskIdSha256",
		"runIdSha256",
		"turnIdSha256",
		"stepIdSha256",
		"requestIdSha256",
		"attemptIdSha256",
	] as const
	const groups = new Map<string, Record<string, unknown>>()
	const conflictsByGroup = new Map<string, Set<string>>()
	const missing = new Set<string>()
	const add = (source: "lifecycle" | "eventLog", value: unknown) => {
		const record = object(value)
		if (!record) return
		for (const field of fields) if (typeof record[field] !== "string") missing.add(`${source}:${field}`)
		const key = fields
			.slice(0, 4)
			.map((field) => String(record[field] ?? "?"))
			.join(":")
		const existing =
			groups.get(key) ??
			({
				identity: Object.fromEntries(fields.map((field) => [field, record[field]])),
				lifecycleSequences: [],
				eventLogSequences: [],
				eventTypes: [],
				identityConflicts: [],
				status: "partial",
			} satisfies Record<string, unknown>)
		const identity = existing.identity as Record<string, unknown>
		const conflicts = conflictsByGroup.get(key) ?? new Set<string>()
		const hasStableIdentity = fields.slice(0, 4).every((field) => typeof identity[field] === "string")
		for (const field of fields.slice(4)) {
			const value = record[field]
			if (typeof value !== "string" || conflicts.has(field)) continue
			if (identity[field] === undefined) identity[field] = value
			else if (identity[field] !== value) {
				delete identity[field]
				conflicts.add(field)
				;(existing.identityConflicts as string[]).push(field)
			}
		}
		const sequence = finiteNumber(record.sequence)
		if (sequence !== undefined)
			(source === "lifecycle"
				? (existing.lifecycleSequences as number[])
				: (existing.eventLogSequences as number[])
			).push(sequence)
		const type = safeString(record.type) ?? safeString(object(record.event)?.type)
		if (type && !(existing.eventTypes as string[]).includes(type)) (existing.eventTypes as string[]).push(type)
		if (
			hasStableIdentity &&
			(existing.lifecycleSequences as number[]).length > 0 &&
			(existing.eventLogSequences as number[]).length > 0
		)
			existing.status = "joined"
		conflictsByGroup.set(key, conflicts)
		groups.set(key, existing)
	}
	if (lifecycle.status !== "captured") missing.add(`lifecycle:${lifecycle.status}`)
	if (eventLog.status !== "captured") missing.add(`eventLog:${eventLog.status}`)
	const lifecycleEvents = object(lifecycle.projection)?.events
	if (Array.isArray(lifecycleEvents)) lifecycleEvents.forEach((value) => add("lifecycle", value))
	const eventRecords = object(eventLog.projection)?.records
	if (Array.isArray(eventRecords)) eventRecords.forEach((value) => add("eventLog", value))
	return { records: [...groups.values()], missing: [...missing].sort() }
}

function sourceStatus(sources: Record<string, DiagnosticsSourceEvidence>): DiagnosticsEvidenceStatus {
	if (Object.values(sources).some((source) => source.status === "incomplete")) return "incomplete"
	if (Object.values(sources).some((source) => source.status === "captured")) return "captured"
	return "absent"
}

export function projectRuntimeDiagnostics(value: unknown): unknown {
	const runtime = object(value)
	if (!runtime) return { unavailable: true }
	if (runtime.unavailable === true) return { unavailable: true }
	const completion = object(runtime.completion)
	const projectedCompletion: Record<string, unknown> = {}
	for (const key of [
		"candidateCount",
		"rejectionCount",
		"repairToolCount",
		"runtimeWaitMs",
		"firstCandidateAt",
		"persistenceSettledAt",
		"completedAt",
		"blockedAt",
	] as const) {
		const number = finiteNumber(completion?.[key])
		if (number !== undefined) projectedCompletion[key] = number
	}
	if (typeof completion?.lastReasonCode === "string" && COMPLETION_REASON_CODES.has(completion.lastReasonCode))
		projectedCompletion.lastReasonCode = completion.lastReasonCode
	const commands = Array.isArray(runtime.commands)
		? runtime.commands.slice(0, 32).flatMap((value) => {
				const command = object(value)
				if (!command) return []
				const projected: Record<string, unknown> = {}
				const status = safeString(command.status)
				if (status && STATUSES.has(status)) projected.status = status
				for (const key of ["startedAt", "completedAt", "exitCode"] as const) {
					const number = finiteNumber(command[key])
					if (number !== undefined) projected[key] = number
				}
				for (const key of ["toolCallId", "executionId"] as const) {
					const hash = hashId(command[key])
					if (hash) projected[`${key}Sha256`] = hash
				}
				return [projected]
			})
		: []
	const obligations = Array.isArray(runtime.obligations)
		? runtime.obligations.slice(0, 16).flatMap((value) => {
				const obligation = object(value)
				if (!obligation) return []
				const projected: Record<string, unknown> = {}
				const status = safeString(obligation.status)
				if (status && OBLIGATION_STATUSES.has(status)) projected.status = status
				const origin = safeString(obligation.origin)
				if (origin && OBLIGATION_ORIGINS.has(origin)) projected.origin = origin
				for (const key of ["fileCount", "updatedAt"] as const) {
					const number = finiteNumber(obligation[key])
					if (number !== undefined) projected[key] = number
				}
				for (const key of ["changeSetId", "contentVersion"] as const) {
					const hash = hashId(obligation[key])
					if (hash) projected[`${key}Sha256`] = hash
				}
				for (const key of ["scopeUnresolved", "observationIncomplete"] as const)
					if (typeof obligation[key] === "boolean") projected[key] = obligation[key]
				return [projected]
			})
		: []
	return {
		completion: projectedCompletion,
		commands,
		obligations,
		truncated: runtime.truncated === true || (Array.isArray(runtime.commands) && runtime.commands.length > 32),
	}
}

export function projectErrorDetails(value: string | undefined): Record<string, unknown> {
	if (value === undefined || value.length === 0) return { present: false, bytes: 0 }
	return {
		present: true,
		bytes: Buffer.byteLength(value, "utf8"),
		sha256: createHash("sha256").update(value, "utf8").digest("hex"),
	}
}

export async function collectDiagnosticsEvidence(
	taskDirPath: string,
	taskId: string,
): Promise<CollectedDiagnosticsEvidence> {
	const lifecycle = await captureSource(path.join(taskDirPath, GlobalFileNames.agentLifecycleEvents), (content) => ({
		...projectJournalRecords(content, projectLifecycleEvent, "turn"),
	}))
	const eventLog = await captureSource(path.join(taskDirPath, GlobalFileNames.agentTurnEvents), (content) => ({
		...projectJournalRecords(
			content,
			(value) => {
				const record = object(value) as Partial<PersistedAgentTurnEvent> | undefined
				if (
					!record ||
					typeof record.taskId !== "string" ||
					typeof record.runId !== "string" ||
					!Number.isInteger(record.sequence) ||
					typeof record.timestamp !== "number" ||
					!object(record.event)
				)
					throw new SourceError("SOURCE_MALFORMED")
				const projected = projectPersistedAgentTurnEvent(record as PersistedAgentTurnEvent)
				if (projected.event.type === "unknown") throw new SourceError("SOURCE_MALFORMED")
				return projected
			},
			"run",
		),
	}))
	const lifecycleSnapshot = await captureSource(
		path.join(taskDirPath, GlobalFileNames.agentLifecycleSnapshot),
		(content) => projectSnapshot(JSON.parse(content.toString("utf8"))),
	)
	const transcript = await captureSource(path.join(taskDirPath, GlobalFileNames.apiConversationHistory), (content) =>
		projectConversation(JSON.parse(content.toString("utf8"))),
	)
	const providerTranscript = await captureSource(
		path.join(taskDirPath, GlobalFileNames.providerTranscript),
		(content) => projectProviderTranscript(JSON.parse(content.toString("utf8"))),
	)
	const sources = { lifecycle, lifecycleSnapshot, eventLog, transcript, providerTranscript }
	return {
		history: transcript.status === "captured" && Array.isArray(transcript.projection) ? transcript.projection : [],
		historyParseFailed: transcript.status === "incomplete" && transcript.warning === "SOURCE_MALFORMED",
		evidence: {
			status: sourceStatus(sources),
			taskIdSha256: hashAgentTurnEvidenceId(taskId),
			rawProviderHistory: { included: false, reason: "omitted_by_default" },
			sources,
			joins: joinEvidence(lifecycle, eventLog),
		},
	}
}
