import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import type { StepContext } from "./StepContext"
import type { AgentTurnEvent, AgentTurnEventIdentity } from "./AgentTurnEvents"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

const MAX_EVENT_VALUE_LENGTH = 8_000
const REDACTED_VALUE = "[redacted]"

const PROJECTED_EVENT_TYPES = new Set([
	"assistant_committed",
	"response_terminal",
	"tool_result",
	"tool_batch_started",
	"tool_batch_finished",
	"approval_request",
	"approval_result",
	"progress",
	"retry",
	"model_request_started",
	"request_usage",
	"context_refreshed",
	"policy_snapshot",
	"profile_resolved",
	"turn_completed",
	"task_completed",
	"turn_failed",
	"task_failed",
	"turn_incomplete",
	"task_incomplete",
	"compaction_completed",
	"verification_result",
	"cancelled",
	"internal_task_started",
	"internal_task_completed",
])
const PROJECTED_STATUSES = new Set([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"aborted",
	"success",
	"error",
	"denied",
	"approved",
	"blocked",
	"timed_out",
])
const PROJECTED_DECISIONS = new Set(["approved", "denied", "cancelled"])
const PROJECTED_COMMAND_CATEGORIES = new Set(["test", "build", "lint", "typecheck"])
const PROJECTED_RESPONSE_ITEM_TYPES = new Set(["text", "reasoning", "tool_call", "usage", "grounding", "error"])

/** Optional construction hooks kept separate from the persisted event shape. */
export interface AgentTurnEventLogOptions {
	/** Inject a stable run ID in tests or a host that already owns run identity. */
	runId?: string
	/** Maximum size of any persisted string value. */
	maxValueLength?: number
}

export interface PersistedAgentTurnEvent {
	taskId: string
	runId: string
	sequence: number
	timestamp: number
	stepContextId?: string
	stepContextParentId?: string
	/** Optional stable joins added after the original JSONL contract. */
	turnId?: string
	stepId?: string
	requestId?: string
	attemptId?: string
	correlationId?: string
	causationId?: string
	event: AgentTurnEvent
}

type PersistedIdentityKey = keyof AgentTurnEventIdentity

const IDENTITY_KEYS: readonly PersistedIdentityKey[] = [
	"turnId",
	"stepId",
	"requestId",
	"attemptId",
	"correlationId",
	"causationId",
]

function boundedIdentity(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value : undefined
}

function identityFromContext(context: StepContext | undefined): AgentTurnEventIdentity {
	const metadata = context?.request?.metadata as Record<string, unknown> | undefined
	return {
		requestId: boundedIdentity(metadata?.requestId),
		attemptId: boundedIdentity(metadata?.attemptId),
	}
}

function sanitizeIdentity(identity: AgentTurnEventIdentity | undefined): AgentTurnEventIdentity {
	if (!identity) return {}
	const result: AgentTurnEventIdentity = {}
	for (const key of IDENTITY_KEYS) {
		const value = boundedIdentity(identity[key])
		if (value !== undefined) result[key] = value
	}
	return result
}

/**
 * Order persisted records for replay without treating a per-run sequence as
 * a task-global sequence. A task can have more than one run, and every run
 * legitimately starts at sequence one. Records from the same run therefore
 * stay sequence-ordered; records from different runs use their persisted
 * timestamp and stable identity tie-breakers.
 */
export function sortPersistedAgentTurnEvents(records: readonly PersistedAgentTurnEvent[]): PersistedAgentTurnEvent[] {
	type IndexedRecord = { record: PersistedAgentTurnEvent; index: number }
	const runs = new Map<string, IndexedRecord[]>()
	for (const [index, record] of records.entries()) {
		const run = runs.get(record.runId) ?? []
		run.push({ record, index })
		runs.set(record.runId, run)
	}
	for (const run of runs.values()) {
		run.sort(
			(a, b) =>
				a.record.sequence - b.record.sequence || a.record.timestamp - b.record.timestamp || a.index - b.index,
		)
	}

	// Merge the ordered runs by their current heads. Unlike a pairwise comparator,
	// this is a real topological merge: clock rollback in one run can never invert
	// that run's durable sequence constraint.
	const cursors = new Map([...runs.keys()].map((runId) => [runId, 0]))
	const output: PersistedAgentTurnEvent[] = []
	while (output.length < records.length) {
		let selected: IndexedRecord | undefined
		for (const [runId, run] of runs) {
			const candidate = run[cursors.get(runId) ?? 0]
			if (!candidate) continue
			if (
				!selected ||
				candidate.record.timestamp < selected.record.timestamp ||
				(candidate.record.timestamp === selected.record.timestamp &&
					(candidate.record.runId.localeCompare(selected.record.runId) < 0 ||
						(candidate.record.runId === selected.record.runId &&
							(candidate.record.sequence < selected.record.sequence ||
								(candidate.record.sequence === selected.record.sequence &&
									candidate.index < selected.index)))))
			) {
				selected = candidate
			}
		}
		if (!selected) break
		output.push(selected.record)
		cursors.set(selected.record.runId, (cursors.get(selected.record.runId) ?? 0) + 1)
	}
	return output
}

const SECRET_KEY_PATTERN =
	/(api.?key|access.?key|client.?secret|secret|password|passwd|credential|authorization|private.?key|bearer|(?:(?:auth|access|refresh|id).?)?token)$/i

function isSensitiveKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key)
}

/**
 * Redact common secret-bearing string forms before they reach the JSONL log.
 * Key-based redaction below remains the primary defence; this handles command
 * output and error strings such as `apiKey=...` and `Authorization: Bearer ...`.
 */
function redactString(value: string): string {
	let redacted = value
	redacted = redacted.replace(/(\bAuthorization\b\s*[:=]\s*Bearer\s+)[^\s,;}\]]+/gi, `$1${REDACTED_VALUE}`)
	redacted = redacted.replace(
		/(\b(?:api.?key|access.?key|client.?secret|secret|password|passwd|credential|authorization|private.?key|(?:(?:auth|access|refresh|id).?)?token)\b\s*[:=]\s*)(?!Bearer\b)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
		`$1${REDACTED_VALUE}`,
	)
	redacted = redacted.replace(/(\bBearer\s+)(?!\[redacted\])[^\s,;}\]]+/gi, `$1${REDACTED_VALUE}`)
	redacted = redacted.replace(
		/([?&](?:api.?key|access.?key|secret|password|credential|authorization|(?:(?:auth|access|refresh|id).?)?token)=)[^&#\s]+/gi,
		`$1${REDACTED_VALUE}`,
	)
	return redacted
}

function truncateString(value: string, maxValueLength: number): string {
	if (value.length <= maxValueLength) return value
	const suffix = "\n[truncated]"
	const available = Math.max(0, maxValueLength - suffix.length)
	return `${value.slice(0, available)}${suffix}`
}

/**
 * Produce a JSON-safe, bounded, recursively redacted copy of an event. This
 * deliberately does not mutate the event supplied by the caller.
 */
function boundValue(value: unknown, maxValueLength: number, seen = new WeakSet<object>(), key?: string): unknown {
	if (key && isSensitiveKey(key)) return REDACTED_VALUE

	if (typeof value === "string") {
		return truncateString(redactString(value), maxValueLength)
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") return value
	if (typeof value === "bigint") return String(value)
	if (typeof value === "undefined") return value
	if (typeof value === "function" || typeof value === "symbol") return String(value)

	if (value instanceof Error) {
		return {
			name: value.name,
			message: truncateString(redactString(value.message), maxValueLength),
			...(value.stack ? { stack: truncateString(redactString(value.stack), maxValueLength) } : {}),
		}
	}
	if (value instanceof Date) return value.toISOString()

	if (seen.has(value)) return "[circular]"
	seen.add(value)

	if (Array.isArray(value)) {
		return value.map((child) => boundValue(child, maxValueLength, seen))
	}

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
			entryKey,
			boundValue(entryValue, maxValueLength, seen, entryKey),
		]),
	)
}

/** Exported for hosts that need the same redaction policy for non-persisted telemetry. */
export function redactAgentTurnEvent(event: AgentTurnEvent, maxValueLength = MAX_EVENT_VALUE_LENGTH): AgentTurnEvent {
	return boundValue(event, maxValueLength) as AgentTurnEvent
}

/** Stable, one-way identifier used by local diagnosis and E2E evidence. */
export function hashAgentTurnEvidenceId(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex")
}

export interface ProjectedAgentTurnEvent {
	sequence: number
	timestamp: number
	taskIdSha256: string
	runIdSha256: string
	turnIdSha256?: string
	stepIdSha256?: string
	requestIdSha256?: string
	attemptIdSha256?: string
	correlationIdSha256?: string
	causationIdSha256?: string
	event: Record<string, unknown>
}

function projectString(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 256 ? value : undefined
}

function projectEvent(event: AgentTurnEvent): Record<string, unknown> {
	const source = event as unknown as Record<string, unknown>
	const rawType = projectString(source.type)
	const projected: Record<string, unknown> = {
		type: rawType && PROJECTED_EVENT_TYPES.has(rawType) ? rawType : "unknown",
	}
	for (const key of ["status", "decision", "commandCategory"] as const) {
		const value = projectString(source[key])
		if (
			value !== undefined &&
			((key === "status" && PROJECTED_STATUSES.has(value)) ||
				(key === "decision" && PROJECTED_DECISIONS.has(value)) ||
				(key === "commandCategory" && PROJECTED_COMMAND_CATEGORIES.has(value)))
		)
			projected[key] = value
	}
	for (const [key, output] of [
		["name", "nameSha256"],
		["toolName", "toolNameSha256"],
	] as const) {
		const value = projectString(source[key])
		if (value !== undefined) projected[output] = hashAgentTurnEvidenceId(value)
	}
	for (const key of [
		"attempt",
		"requestIndex",
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens",
		"batchSize",
		"parallelBatchCount",
		"parallelToolCount",
		"durationMs",
		"truncatedResultCount",
		"delayMs",
		"exitCode",
		"totalCost",
	] as const) {
		const value = source[key]
		if (typeof value === "number" && Number.isFinite(value)) projected[key] = value
	}
	for (const key of ["retry", "truncated", "timedOut", "lateCollection", "retryable"] as const) {
		const value = source[key]
		if (typeof value === "boolean") projected[key] = value
	}

	for (const [field, output] of [
		["callId", "callIdSha256"],
		["requestId", "requestIdSha256"],
		["envelopeId", "envelopeIdSha256"],
		["childTaskId", "childTaskIdSha256"],
	] as const) {
		const value = projectString(source[field])
		if (value !== undefined) projected[output] = hashAgentTurnEvidenceId(value)
	}

	for (const key of ["reason", "message", "error", "text"] as const) {
		if (source[key] !== undefined) projected[`${key}Present`] = true
	}

	if (source.type === "assistant_committed") {
		const response = source.response as { items?: unknown[]; toolCalls?: unknown[]; outcome?: unknown } | undefined
		if (response && typeof response === "object") {
			if (Array.isArray(response.items)) {
				projected.responseItemTypes = response.items.flatMap((item) => {
					const type = (item as { type?: unknown })?.type
					return typeof type === "string"
						? [PROJECTED_RESPONSE_ITEM_TYPES.has(type) ? type : "unknown"]
						: ["unknown"]
				})
				projected.responseItemCount = response.items.length
			}
			if (Array.isArray(response.toolCalls)) projected.toolCallCount = response.toolCalls.length
		}
	}

	return projected
}

/**
 * Project an additive record without exposing prompts, tool arguments, output,
 * provider payloads, or raw cross-layer IDs.  Missing envelope fields remain
 * absent so callers can distinguish an old record from a joined observation.
 */
export function projectPersistedAgentTurnEvent(record: PersistedAgentTurnEvent): ProjectedAgentTurnEvent {
	const projection: ProjectedAgentTurnEvent = {
		sequence: record.sequence,
		timestamp: record.timestamp,
		taskIdSha256: hashAgentTurnEvidenceId(record.taskId),
		runIdSha256: hashAgentTurnEvidenceId(record.runId),
		event: projectEvent(record.event),
	}
	for (const key of ["turnId", "stepId", "requestId", "attemptId", "correlationId", "causationId"] as const) {
		const value = projectString(record[key])
		if (value !== undefined) Object.assign(projection, { [`${key}Sha256`]: hashAgentTurnEvidenceId(value) })
	}
	return projection
}

type EventLogState = "open" | "closing" | "closed"

interface PendingWriteFailure {
	sequence: number
	error: unknown
	reported: boolean
}

/**
 * Ordered append-only event journal for one task run.
 *
 * Appends only enqueue work; they do not perform filesystem I/O before
 * returning. The queue serializes writes and isolates a failed write so a
 * later event can still be persisted. `flush` and `close` provide explicit
 * durability/lifecycle boundaries for callers that need them.
 */
export class AgentTurnEventLog {
	private readonly runId: string
	private readonly maxValueLength: number
	private sequence = 0
	private state: EventLogState = "open"
	private writeQueue: Promise<void> = Promise.resolve()
	private closePromise: Promise<void> | undefined
	private readonly pendingFailures: PendingWriteFailure[] = []

	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
		options: AgentTurnEventLogOptions = {},
	) {
		this.runId = options.runId ?? crypto.randomUUID()
		this.maxValueLength = options.maxValueLength ?? MAX_EVENT_VALUE_LENGTH
	}

	getRunId(): string {
		return this.runId
	}

	append(event: AgentTurnEvent, context?: StepContext, identity?: AgentTurnEventIdentity): Promise<void> {
		return this.appendWithIdentity(event, context, identity)
	}

	/**
	 * Append an event with an explicit identity snapshot.  Task normally has a
	 * live StepContext from which request/attempt IDs can be recovered, but
	 * explicit identity is needed for late drains and other asynchronous work
	 * whose active step may already have changed.
	 */
	appendWithIdentity(event: AgentTurnEvent, context?: StepContext, identity?: AgentTurnEventIdentity): Promise<void> {
		if (this.state !== "open") {
			return Promise.reject(new Error(`Cannot append to a ${this.state} agent turn event log.`))
		}

		const sequence = ++this.sequence
		const resolvedIdentity = sanitizeIdentity({ ...identityFromContext(context), ...identity })
		const record: PersistedAgentTurnEvent = {
			taskId: this.taskId,
			runId: this.runId,
			sequence,
			timestamp: Date.now(),
			stepContextId: context?.contextId,
			stepContextParentId: context?.parentContextId,
			...resolvedIdentity,
			event: redactAgentTurnEvent(event, this.maxValueLength),
		}

		const queuedWrite = this.writeQueue.then(async () => {
			const taskDirectory = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			await fs.appendFile(
				path.join(taskDirectory, GlobalFileNames.agentTurnEvents),
				`${JSON.stringify(record)}\n`,
				"utf8",
			)
		})

		// Keep the internal tail fulfilled after a failed write so future appends
		// are not permanently poisoned. The individual promise still reports its
		// failure, while flush/close report failures that were not observed there.
		const exposed = queuedWrite.catch((error) => {
			this.pendingFailures.push({ sequence, error, reported: false })
			throw error
		})
		this.writeQueue = exposed.then(
			() => undefined,
			() => undefined,
		)
		// A caller may intentionally rely on flush/close and omit the individual
		// append promise. Mark the returned rejection as handled without changing
		// what an explicit await of `exposed` observes.
		void exposed.catch(() => undefined)
		return exposed
	}

	/** Wait for all appends submitted before this call to settle. */
	async flush(): Promise<void> {
		const boundary = this.sequence
		await this.writeQueue
		const failures = this.pendingFailures.filter((failure) => !failure.reported && failure.sequence <= boundary)
		if (failures.length === 0) return
		for (const failure of failures) failure.reported = true
		if (failures.length === 1) throw asError(failures[0].error)
		throw new AggregateError(
			failures.map((failure) => asError(failure.error)),
			"Multiple agent turn event log writes failed",
		)
	}

	/**
	 * Stop accepting appends and wait for queued writes. Close is idempotent;
	 * concurrent callers share one completion promise.
	 */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.state = "closing"
		this.closePromise = this.flush().finally(() => {
			this.state = "closed"
		})
		return this.closePromise
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

export async function readAgentTurnEvents(
	taskId: string,
	globalStoragePath: string,
): Promise<PersistedAgentTurnEvent[]> {
	const taskDirectory = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDirectory, GlobalFileNames.agentTurnEvents)

	try {
		const contents = await fs.readFile(filePath, "utf8")
		const records = contents
			.split("\n")
			.filter(Boolean)
			.map((line, index) => parsePersistedAgentTurnEvent(line, index + 1, taskId))

		return sortPersistedAgentTurnEvents(records)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
}

function parsePersistedAgentTurnEvent(line: string, lineNumber: number, taskId: string): PersistedAgentTurnEvent {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch (error) {
		throw new Error(`Invalid agent turn event at line ${lineNumber}: malformed JSON`, { cause: error })
	}
	const record = value as Partial<PersistedAgentTurnEvent> | null
	if (
		!record ||
		typeof record !== "object" ||
		record.taskId !== taskId ||
		typeof record.runId !== "string" ||
		record.runId.trim().length === 0 ||
		!Number.isInteger(record.sequence) ||
		(record.sequence ?? 0) <= 0 ||
		typeof record.timestamp !== "number" ||
		!Number.isFinite(record.timestamp) ||
		record.timestamp < 0 ||
		!record.event ||
		typeof record.event !== "object" ||
		typeof (record.event as { type?: unknown }).type !== "string"
	) {
		throw new Error(`Invalid agent turn event at line ${lineNumber}`)
	}
	for (const key of IDENTITY_KEYS) {
		const value = record[key]
		if (value !== undefined && boundedIdentity(value) === undefined) {
			throw new Error(`Invalid agent turn event at line ${lineNumber}`)
		}
	}
	return record as PersistedAgentTurnEvent
}
