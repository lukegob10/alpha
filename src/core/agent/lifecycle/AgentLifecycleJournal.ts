import * as fs from "fs/promises"
import * as path from "path"

import {
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleEvent,
	type AgentLifecycleSnapshot,
} from "@alpha-code/types"

import {
	AgentLifecycleReducerError,
	createAgentLifecycleSnapshot,
	fingerprintAgentLifecycleEvent,
	reduceAgentLifecycleEvent,
} from "./reducer.js"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { atomicWriteJson, withFileLock } from "../../task-persistence/atomicWrite"

const MAX_VALUE_LENGTH = 8_000
const REDACTED_VALUE = "[redacted]"

/** An event with a journal-assigned sequence may omit `sequence` at the call boundary. */
export type AgentLifecycleEventInput = Omit<AgentLifecycleEvent, "sequence"> & {
	sequence?: number
}

export interface AgentLifecycleJournalOptions {
	/** Seed state for a fresh journal or a journal whose snapshot is absent. */
	initialSnapshot?: AgentLifecycleSnapshot
	/** Write an atomic snapshot after this many newly appended events. */
	snapshotEvery?: number
	/** Readable alias for snapshotEvery. */
	snapshotEveryEvents?: number
	/** Optional time-based snapshot threshold checked after each append. */
	snapshotIntervalMs?: number
	/** Injectable clock for deterministic tests. */
	now?: () => number
	/** Bound and redact unknown values before they reach the journal. */
	maxValueLength?: number
	/** Use a caller-owned filename while retaining the default contract. */
	eventsFileName?: string
	snapshotFileName?: string
}

export interface AgentLifecycleAppendReceipt {
	event: AgentLifecycleEvent
	snapshot: AgentLifecycleSnapshot
	sequence: number
	/** True when this append also wrote the atomic lifecycle snapshot. */
	snapshotWritten: boolean
	/** True when the requested event was already durably present. */
	replayed: boolean
}

export type AgentLifecycleJournalRecoveryErrorCode =
	| "malformed_record"
	| "torn_final_record"
	| "invalid_event"
	| "invalid_snapshot"
	| "snapshot_mismatch"
	| "snapshot_ahead"
	| "sequence_gap"
	| "duplicate_sequence"
	| "duplicate_event_conflict"
	| "task_mismatch"
	| "run_mismatch"
	| "turn_mismatch"
	| "read_failed"
	| "write_failed"
	| "not_initialized"
	| "closed"
	| AgentLifecycleReducerError["code"]

export interface AgentLifecycleJournalRecoveryDetails {
	lineNumber?: number
	sequence?: number
	expectedSequence?: number
	eventId?: string
	filePath?: string
	lastSequence?: number
	[cause: string]: unknown
}

/**
 * A typed integrity error. Recovery errors are deliberately separate from
 * provider/runtime errors so callers can stop and ask for repair instead of
 * continuing from an untrusted state.
 */
export class AgentLifecycleRecoveryError extends Error {
	readonly code: AgentLifecycleJournalRecoveryErrorCode
	readonly taskId: string
	readonly details: AgentLifecycleJournalRecoveryDetails
	readonly causeError?: unknown

	constructor(
		code: AgentLifecycleJournalRecoveryErrorCode,
		message: string,
		taskId: string,
		details: AgentLifecycleJournalRecoveryDetails = {},
		causeError?: unknown,
	) {
		super(message)
		this.name = "AgentLifecycleRecoveryError"
		this.code = code
		this.taskId = taskId
		this.details = details
		this.causeError = causeError
	}
}

// Naming aliases make the boundary discoverable without forcing hosts to
// know whether a failure came from a journal read or replay operation.
export { AgentLifecycleRecoveryError as AgentLifecycleJournalError }
export { AgentLifecycleRecoveryError as LifecycleRecoveryError }

type JournalState = "open" | "closing" | "closed"

interface JournalPaths {
	eventsPath: string
	snapshotPath: string
}

interface LoadedJournal {
	events: AgentLifecycleEvent[]
	snapshot: AgentLifecycleSnapshot | undefined
}

interface JournalFileStamps {
	events: string
	snapshot: string
}

interface JournalCache {
	eventsById: Map<string, AgentLifecycleEvent>
	stamps: JournalFileStamps
}

/**
 * Durable JSONL journal for the provider-neutral lifecycle contract.
 *
 * Event records are append-only and snapshots are independent atomic files.
 * Every read validates the event/snapshot schema and then replays through the
 * canonical reducer, so a restart cannot silently continue from an invalid
 * or non-contiguous sequence.
 */
export class AgentLifecycleJournal {
	private readonly now: () => number
	private readonly maxValueLength: number
	private readonly snapshotEvery: number
	private readonly snapshotIntervalMs: number | undefined
	private readonly initialSnapshot: AgentLifecycleSnapshot | undefined
	private readonly eventsFileName: string
	private readonly snapshotFileName: string

	private state: JournalState = "open"
	private paths: JournalPaths | undefined
	private currentSnapshot: AgentLifecycleSnapshot | undefined
	private cache: JournalCache | undefined
	private lastSnapshotAt = 0
	private initializationPromise: Promise<void> | undefined
	private closePromise: Promise<void> | undefined
	private writeQueue: Promise<void> = Promise.resolve()
	private readonly pendingFailures: unknown[] = []

	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
		options: AgentLifecycleJournalOptions = {},
	) {
		if (!taskId || taskId.trim().length === 0) throw new Error("Agent lifecycle task ID cannot be blank")
		this.now = options.now ?? Date.now
		this.maxValueLength = options.maxValueLength ?? MAX_VALUE_LENGTH
		this.snapshotEvery = normalizePositiveThreshold(options.snapshotEveryEvents ?? options.snapshotEvery)
		this.snapshotIntervalMs = normalizePositiveThreshold(options.snapshotIntervalMs) || undefined
		this.initialSnapshot = options.initialSnapshot
			? validateSnapshotSeed(options.initialSnapshot, taskId)
			: undefined
		this.eventsFileName = options.eventsFileName ?? GlobalFileNames.agentLifecycleEvents
		this.snapshotFileName = options.snapshotFileName ?? GlobalFileNames.agentLifecycleSnapshot
	}

	/** Open and recover a journal explicitly. Construction itself performs no I/O. */
	async initialize(): Promise<void> {
		if (!this.initializationPromise) {
			this.initializationPromise = this.initializeInternal()
		}
		return this.initializationPromise
	}

	/** Convenience constructor for hosts that prefer an async open boundary. */
	static async open(
		taskId: string,
		globalStoragePath: string,
		options: AgentLifecycleJournalOptions = {},
	): Promise<AgentLifecycleJournal> {
		const journal = new AgentLifecycleJournal(taskId, globalStoragePath, options)
		await journal.initialize()
		return journal
	}

	getTaskId(): string {
		return this.taskId
	}

	async getFilePaths(): Promise<JournalPaths> {
		await this.ensurePaths()
		return { ...this.paths! }
	}

	async getEventsFilePath(): Promise<string> {
		return (await this.getFilePaths()).eventsPath
	}

	async getSnapshotFilePath(): Promise<string> {
		return (await this.getFilePaths()).snapshotPath
	}

	getSequence(): number {
		return this.currentSnapshot?.lastSequence ?? 0
	}

	getSnapshot(): AgentLifecycleSnapshot | undefined {
		return this.currentSnapshot ? cloneSnapshot(this.currentSnapshot) : undefined
	}

	/** Replay the durable files and return the recovered canonical state. */
	replay(): Promise<AgentLifecycleSnapshot | undefined> {
		return this.enqueueOrdered(async () => {
			await this.initialize()
			const paths = await this.ensurePaths()
			await withFileLock(paths.eventsPath, () => this.loadAndCacheFromPaths(paths))
			return this.getSnapshot()
		})
	}

	async readSnapshot(): Promise<AgentLifecycleSnapshot | undefined> {
		return this.replay()
	}

	/**
	 * Append one validated lifecycle event. If sequence is omitted, the next
	 * durable sequence is assigned after the journal lock is acquired.
	 */
	append(input: AgentLifecycleEventInput): Promise<AgentLifecycleAppendReceipt> {
		if (this.state !== "open") return Promise.reject(this.closedError())
		return this.enqueue(async () => {
			await this.initialize()
			const paths = await this.ensurePaths()

			// Resolve the durable head while holding the event lock. This keeps two
			// journal objects in one host (or two extension processes) from assigning
			// the same sequence after both observed the same previous state. A file stamp
			// lets the common single-writer path reuse its already-validated state;
			// any external event or snapshot change invalidates that cache.
			return withFileLock(paths.eventsPath, async () => {
				const loaded = await this.loadForAppend(paths)

				const existingEvent = loaded.eventsById.get(input.eventId)
				const sameIdentity =
					loaded.snapshot !== undefined &&
					loaded.snapshot.runId === input.runId &&
					loaded.snapshot.turnId === input.turnId
				const expectedSequence =
					sameIdentity || loaded.snapshot === undefined ? (loaded.snapshot?.lastSequence ?? 0) + 1 : 1
				const candidate = {
					...(input as Record<string, unknown>),
					sequence: input.sequence ?? existingEvent?.sequence ?? expectedSequence,
				}
				const event = validateAndRedactEvent(candidate, this.taskId, this.maxValueLength)

				if (existingEvent) {
					if (fingerprintAgentLifecycleEvent(existingEvent) !== fingerprintAgentLifecycleEvent(event)) {
						throw new AgentLifecycleRecoveryError(
							"duplicate_event_conflict",
							`Lifecycle event ID ${event.eventId} was already persisted with different content`,
							this.taskId,
							{ sequence: event.sequence, eventId: event.eventId },
						)
					}
					return {
						event: cloneEvent(existingEvent),
						snapshot: cloneSnapshot(loaded.snapshot ?? snapshotFromEvent(existingEvent)),
						sequence: existingEvent.sequence,
						snapshotWritten: false,
						replayed: true,
					}
				}

				if (event.sequence !== expectedSequence) {
					throw new AgentLifecycleRecoveryError(
						event.sequence > expectedSequence ? "sequence_gap" : "duplicate_sequence",
						`Lifecycle event sequence ${event.sequence} cannot be appended; expected ${expectedSequence}`,
						this.taskId,
						{ sequence: event.sequence, expectedSequence, eventId: event.eventId },
					)
				}

				const identityChanged =
					loaded.snapshot !== undefined &&
					(loaded.snapshot.runId !== event.runId || loaded.snapshot.turnId !== event.turnId)
				if (identityChanged && loaded.snapshot?.status === "in_progress") {
					throw new AgentLifecycleRecoveryError(
						loaded.snapshot.runId !== event.runId ? "run_mismatch" : "turn_mismatch",
						`Cannot switch lifecycle identity while turn ${loaded.snapshot.turnId} is in progress`,
						this.taskId,
						{ sequence: event.sequence, expectedSequence, eventId: event.eventId },
					)
				}
				// A terminal turn closes one reducer partition. The next run/turn starts
				// a fresh local sequence in the same task journal.
				const base = identityChanged ? snapshotFromEvent(event) : (loaded.snapshot ?? snapshotFromEvent(event))
				let next: AgentLifecycleSnapshot
				try {
					next = reduceAgentLifecycleEvent(base, event)
				} catch (error) {
					throw wrapRecoveryError(error, this.taskId, event)
				}

				try {
					await fs.appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, "utf8")
				} catch (error) {
					throw new AgentLifecycleRecoveryError(
						"write_failed",
						`Failed to append lifecycle event for task ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
						this.taskId,
						{ eventId: event.eventId, sequence: event.sequence, filePath: paths.eventsPath },
						error,
					)
				}

				this.currentSnapshot = next
				const snapshotWritten = await this.shouldWriteSnapshot(paths)
				loaded.eventsById.set(event.eventId, event)
				await this.refreshCache(paths, loaded.eventsById)
				return {
					event: cloneEvent(event),
					snapshot: cloneSnapshot(next),
					sequence: event.sequence,
					snapshotWritten,
					replayed: false,
				}
			})
		})
	}

	appendEvent(input: AgentLifecycleEventInput): Promise<AgentLifecycleAppendReceipt> {
		return this.append(input)
	}

	/** Write the current snapshot immediately, even when periodic snapshots are disabled. */
	writeSnapshot(): Promise<AgentLifecycleSnapshot> {
		if (this.state !== "open") return Promise.reject(this.closedError())
		return this.enqueue(async () => {
			await this.initialize()
			if (!this.currentSnapshot) {
				throw new AgentLifecycleRecoveryError(
					"not_initialized",
					`Cannot snapshot task ${this.taskId} before its first lifecycle event`,
					this.taskId,
				)
			}
			await this.persistSnapshot(this.currentSnapshot)
			return cloneSnapshot(this.currentSnapshot)
		})
	}

	requestSnapshot(): Promise<AgentLifecycleSnapshot> {
		return this.writeSnapshot()
	}

	/** Wait for all queued appends/snapshots and surface the first failure. */
	async flush(): Promise<void> {
		await this.writeQueue
		this.throwPendingFailure()
	}

	/**
	 * Stop accepting writes, durably snapshot the recovered state, and surface
	 * any queued I/O failure. Close is idempotent and concurrent callers share a
	 * single promise.
	 */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.state = "closing"
		this.closePromise = this.writeQueue
			.then(async () => {
				await this.initialize()
				if (this.currentSnapshot) await this.persistSnapshot(this.currentSnapshot)
				this.throwPendingFailure()
			})
			.finally(() => {
				this.state = "closed"
			})
		return this.closePromise
	}

	private async initializeInternal(): Promise<void> {
		const paths = await this.ensurePaths()
		await withFileLock(paths.eventsPath, () => this.loadAndCacheFromPaths(paths))
		this.lastSnapshotAt = this.currentSnapshot ? this.now() : 0
	}

	/**
	 * Return the in-memory reduction when neither durable file changed. File
	 * stamps are checked only while the events lock is held, so cooperating
	 * journal instances cannot append between validation and sequence assignment.
	 */
	private async loadForAppend(
		paths: JournalPaths,
	): Promise<{ eventsById: Map<string, AgentLifecycleEvent>; snapshot: AgentLifecycleSnapshot | undefined }> {
		const stamps = await captureJournalFileStamps(paths)
		if (stamps && this.cache && equivalentFileStamps(stamps, this.cache.stamps)) {
			return { eventsById: this.cache.eventsById, snapshot: this.currentSnapshot }
		}

		const loaded = await this.loadAndCacheFromPaths(paths)
		return {
			eventsById: this.cache?.eventsById ?? indexEventsById(loaded.events),
			snapshot: loaded.snapshot,
		}
	}

	/** Full recovery remains the cache-miss path and the explicit replay path. */
	private async loadAndCacheFromPaths(paths: JournalPaths): Promise<LoadedJournal> {
		const before = await captureJournalFileStamps(paths)
		const loaded = await this.loadFromPaths(paths)
		const after = await captureJournalFileStamps(paths)
		this.currentSnapshot = loaded.snapshot

		// A non-cooperating writer can still change a snapshot while the event
		// lock is held. Do not retain a cache unless both files stayed stable for
		// the complete validation/replay window.
		this.cache =
			before && after && equivalentFileStamps(before, after)
				? { eventsById: indexEventsById(loaded.events), stamps: after }
				: undefined
		return loaded
	}

	/** Cache refresh is an optimization; a failed stat must not turn a durable append into a reported failure. */
	private async refreshCache(paths: JournalPaths, eventsById: Map<string, AgentLifecycleEvent>): Promise<void> {
		const stamps = await captureJournalFileStamps(paths)
		this.cache = stamps ? { eventsById, stamps } : undefined
	}

	private async ensurePaths(): Promise<JournalPaths> {
		if (this.paths) return this.paths
		const taskDirectory = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
		this.paths = {
			eventsPath: path.join(taskDirectory, this.eventsFileName),
			snapshotPath: path.join(taskDirectory, this.snapshotFileName),
		}
		return this.paths
	}

	private closedError(): AgentLifecycleRecoveryError {
		return new AgentLifecycleRecoveryError(
			"closed",
			`Cannot append to a ${this.state} agent lifecycle journal`,
			this.taskId,
		)
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.writeQueue.then(operation)
		const exposed = queued.catch((error) => {
			this.pendingFailures.push(error)
			throw error
		})
		this.writeQueue = exposed.then(
			() => undefined,
			() => undefined,
		)
		return exposed
	}

	/** Order a recovery read with accepted writes without treating read errors as deferred write failures. */
	private enqueueOrdered<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.writeQueue.then(operation)
		this.writeQueue = queued.then(
			() => undefined,
			() => undefined,
		)
		return queued
	}

	private async shouldWriteSnapshot(paths: JournalPaths): Promise<boolean> {
		if (!this.currentSnapshot) return false
		const sequence = this.currentSnapshot.lastSequence
		const byCount = this.snapshotEvery > 0 && sequence % this.snapshotEvery === 0
		const byTime =
			this.snapshotIntervalMs !== undefined &&
			(this.lastSnapshotAt === 0 || this.now() - this.lastSnapshotAt >= this.snapshotIntervalMs)
		if (!byCount && !byTime) return false
		await this.persistSnapshot(this.currentSnapshot, paths.snapshotPath)
		return true
	}

	private async persistSnapshot(snapshot: AgentLifecycleSnapshot, requestedPath?: string): Promise<void> {
		const paths = requestedPath ? undefined : await this.ensurePaths()
		const snapshotPath = requestedPath ?? paths!.snapshotPath
		const validated = agentLifecycleSnapshotSchema.safeParse(snapshot)
		if (!validated.success) {
			throw new AgentLifecycleRecoveryError(
				"invalid_snapshot",
				`Cannot persist invalid lifecycle snapshot for task ${this.taskId}: ${validated.error.message}`,
				this.taskId,
				{ filePath: snapshotPath },
			)
		}
		try {
			await withFileLock(snapshotPath, () => atomicWriteJson(snapshotPath, validated.data))
			this.lastSnapshotAt = this.now()
		} catch (error) {
			if (error instanceof AgentLifecycleRecoveryError) throw error
			throw new AgentLifecycleRecoveryError(
				"write_failed",
				`Failed to write lifecycle snapshot for task ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				this.taskId,
				{ filePath: snapshotPath, lastSequence: snapshot.lastSequence },
				error,
			)
		}
	}

	private throwPendingFailure(): void {
		if (this.pendingFailures.length === 0) return
		const failure = this.pendingFailures.shift()
		if (failure instanceof Error) throw failure
		throw new Error(String(failure))
	}

	private async loadFromPaths(paths: JournalPaths): Promise<LoadedJournal> {
		const events = await readLifecycleEventsFile(paths.eventsPath, this.taskId)
		const diskSnapshot = await readLifecycleSnapshotFile(paths.snapshotPath, this.taskId)
		const persistedSnapshot = diskSnapshot ?? this.initialSnapshot

		if (events.length === 0) {
			if (diskSnapshot && this.initialSnapshot && !equivalentSnapshots(diskSnapshot, this.initialSnapshot)) {
				throw new AgentLifecycleRecoveryError(
					"snapshot_mismatch",
					`Lifecycle snapshot seed for task ${this.taskId} conflicts with the durable snapshot`,
					this.taskId,
				)
			}
			return { events, snapshot: persistedSnapshot ? cloneSnapshot(persistedSnapshot) : undefined }
		}

		const replayed = replayEvents(events, this.taskId)
		if (!persistedSnapshot) return { events, snapshot: replayed }

		if (persistedSnapshot.taskId !== this.taskId) {
			throw new AgentLifecycleRecoveryError(
				"task_mismatch",
				`Lifecycle snapshot belongs to task ${persistedSnapshot.taskId}, expected ${this.taskId}`,
				this.taskId,
			)
		}
		if (persistedSnapshot.lastSequence > replayed.lastSequence) {
			throw new AgentLifecycleRecoveryError(
				"snapshot_ahead",
				`Lifecycle snapshot sequence ${persistedSnapshot.lastSequence} is ahead of journal sequence ${replayed.lastSequence}`,
				this.taskId,
				{ lastSequence: persistedSnapshot.lastSequence, expectedSequence: replayed.lastSequence },
			)
		}

		const snapshotAtSequence = replayPrefix(
			events,
			persistedSnapshot.lastSequence,
			this.taskId,
			persistedSnapshot.runId,
			persistedSnapshot.turnId,
		)
		if (!equivalentSnapshots(snapshotAtSequence, persistedSnapshot)) {
			throw new AgentLifecycleRecoveryError(
				"snapshot_mismatch",
				`Lifecycle snapshot does not match the journal prefix at sequence ${persistedSnapshot.lastSequence}`,
				this.taskId,
				{ lastSequence: persistedSnapshot.lastSequence },
			)
		}
		return { events, snapshot: replayed }
	}
}

/** Read and validate only the new lifecycle journal file. */
export async function readAgentLifecycleEvents(
	taskId: string,
	globalStoragePath: string,
	options: Pick<AgentLifecycleJournalOptions, "eventsFileName"> = {},
): Promise<AgentLifecycleEvent[]> {
	const journal = new AgentLifecycleJournal(taskId, globalStoragePath, options)
	await journal.initialize()
	const filePath = await journal.getEventsFilePath()
	return readLifecycleEventsFile(filePath, taskId)
}

/** Read and validate the new snapshot without touching legacy files. */
export async function readAgentLifecycleSnapshot(
	taskId: string,
	globalStoragePath: string,
	options: Pick<AgentLifecycleJournalOptions, "snapshotFileName" | "eventsFileName"> = {},
): Promise<AgentLifecycleSnapshot | undefined> {
	const journal = new AgentLifecycleJournal(taskId, globalStoragePath, options)
	await journal.initialize()
	return journal.getSnapshot()
}

function normalizePositiveThreshold(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function indexEventsById(events: readonly AgentLifecycleEvent[]): Map<string, AgentLifecycleEvent> {
	return new Map(events.map((event) => [event.eventId, event]))
}

async function captureJournalFileStamps(paths: JournalPaths): Promise<JournalFileStamps | undefined> {
	try {
		const [events, snapshot] = await Promise.all([fileStamp(paths.eventsPath), fileStamp(paths.snapshotPath)])
		return { events, snapshot }
	} catch {
		// Stamps only decide whether the validated in-memory reduction is reusable.
		// The normal read/replay path still reports any real filesystem failure.
		return undefined
	}
}

async function fileStamp(filePath: string): Promise<string> {
	try {
		const stats = await fs.stat(filePath, { bigint: true })
		return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
		throw error
	}
}

function equivalentFileStamps(left: JournalFileStamps, right: JournalFileStamps): boolean {
	return left.events === right.events && left.snapshot === right.snapshot
}

function cloneEvent(event: AgentLifecycleEvent): AgentLifecycleEvent {
	return JSON.parse(JSON.stringify(event)) as AgentLifecycleEvent
}

function cloneSnapshot(snapshot: AgentLifecycleSnapshot): AgentLifecycleSnapshot {
	return JSON.parse(JSON.stringify(snapshot)) as AgentLifecycleSnapshot
}

function validateSnapshotSeed(snapshot: AgentLifecycleSnapshot, taskId: string): AgentLifecycleSnapshot {
	const result = agentLifecycleSnapshotSchema.safeParse(snapshot)
	if (!result.success) {
		throw new AgentLifecycleRecoveryError(
			"invalid_snapshot",
			`Invalid initial lifecycle snapshot for task ${taskId}: ${result.error.message}`,
			taskId,
			{ filePath: "initialSnapshot" },
			result.error,
		)
	}
	if (result.data.taskId !== taskId) {
		throw new AgentLifecycleRecoveryError(
			"task_mismatch",
			`Initial lifecycle snapshot belongs to task ${result.data.taskId}, expected ${taskId}`,
			taskId,
		)
	}
	return cloneSnapshot(result.data)
}

function snapshotFromEvent(event: AgentLifecycleEvent): AgentLifecycleSnapshot {
	return createAgentLifecycleSnapshot({ taskId: event.taskId, runId: event.runId, turnId: event.turnId })
}

function validateAndRedactEvent(value: unknown, taskId: string, maxValueLength: number): AgentLifecycleEvent {
	const redacted = redactLifecycleValue(value, maxValueLength)
	const result = agentLifecycleEventSchema.safeParse(redacted)
	if (!result.success) {
		throw new AgentLifecycleRecoveryError(
			"invalid_event",
			`Invalid lifecycle event for task ${taskId}: ${result.error.message}`,
			taskId,
			{ filePath: "append" },
			result.error,
		)
	}
	if (result.data.taskId !== taskId) {
		throw new AgentLifecycleRecoveryError(
			"task_mismatch",
			`Lifecycle event targets task ${result.data.taskId}, expected ${taskId}`,
			taskId,
			{ eventId: result.data.eventId, sequence: result.data.sequence },
		)
	}
	return result.data
}

/** Apply the journal's bounded secret-redaction policy without writing a file. */
export function redactAgentLifecycleEvent(
	event: AgentLifecycleEvent,
	maxValueLength = MAX_VALUE_LENGTH,
): AgentLifecycleEvent {
	const result = agentLifecycleEventSchema.safeParse(redactLifecycleValue(event, maxValueLength))
	if (!result.success) throw result.error
	return result.data
}

function wrapRecoveryError(error: unknown, taskId: string, event?: AgentLifecycleEvent): AgentLifecycleRecoveryError {
	if (error instanceof AgentLifecycleRecoveryError) return error
	if (error instanceof AgentLifecycleReducerError) {
		return new AgentLifecycleRecoveryError(
			error.code,
			error.message,
			taskId,
			{
				...error.details,
				eventId: error.details.eventId ?? event?.eventId,
				sequence: error.details.sequence ?? event?.sequence,
			},
			error,
		)
	}
	return new AgentLifecycleRecoveryError(
		"invalid_event",
		`Lifecycle event could not be reduced: ${error instanceof Error ? error.message : String(error)}`,
		taskId,
		{ eventId: event?.eventId, sequence: event?.sequence },
		error,
	)
}

async function readLifecycleSnapshotFile(
	filePath: string,
	taskId: string,
): Promise<AgentLifecycleSnapshot | undefined> {
	let contents: string
	try {
		contents = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new AgentLifecycleRecoveryError(
			"invalid_snapshot",
			`Failed to read lifecycle snapshot at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			taskId,
			{ filePath },
			error,
		)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(contents)
	} catch (error) {
		throw new AgentLifecycleRecoveryError(
			"invalid_snapshot",
			`Lifecycle snapshot at ${filePath} is not valid JSON`,
			taskId,
			{ filePath },
			error,
		)
	}
	const result = agentLifecycleSnapshotSchema.safeParse(parsed)
	if (!result.success) {
		throw new AgentLifecycleRecoveryError(
			"invalid_snapshot",
			`Invalid lifecycle snapshot at ${filePath}: ${result.error.message}`,
			taskId,
			{ filePath },
			result.error,
		)
	}
	if (result.data.taskId !== taskId) {
		throw new AgentLifecycleRecoveryError(
			"task_mismatch",
			`Lifecycle snapshot at ${filePath} belongs to task ${result.data.taskId}, expected ${taskId}`,
			taskId,
			{ filePath },
		)
	}
	return cloneSnapshot(result.data)
}

async function readLifecycleEventsFile(filePath: string, taskId: string): Promise<AgentLifecycleEvent[]> {
	let contents: string
	try {
		contents = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw new AgentLifecycleRecoveryError(
			"read_failed",
			`Failed to read lifecycle journal at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			taskId,
			{ filePath },
			error,
		)
	}

	if (contents.length === 0) return []
	const lines = contents.split("\n")
	const hasTrailingNewline = contents.endsWith("\n")
	if (hasTrailingNewline) lines.pop()

	const events: AgentLifecycleEvent[] = []
	let offset = 0
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		const lineNumber = index + 1
		const lineStart = offset
		offset += line.length + 1
		if (line.trim().length === 0) {
			throw new AgentLifecycleRecoveryError(
				"malformed_record",
				`Blank lifecycle record at ${filePath}:${lineNumber}`,
				taskId,
				{ lineNumber, filePath },
			)
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch (error) {
			const isUnterminatedFinalLine = index === lines.length - 1 && !hasTrailingNewline
			if (isUnterminatedFinalLine) {
				// The previous newline-delimited records are durable. Truncate only
				// this final partial record so the next append can proceed normally.
				try {
					await fs.truncate(filePath, lineStart)
				} catch (truncateError) {
					throw new AgentLifecycleRecoveryError(
						"torn_final_record",
						`Torn lifecycle record at ${filePath}:${lineNumber} could not be recovered`,
						taskId,
						{ lineNumber, filePath },
						truncateError,
					)
				}
				return events
			}
			throw new AgentLifecycleRecoveryError(
				"malformed_record",
				`Malformed lifecycle record at ${filePath}:${lineNumber}`,
				taskId,
				{ lineNumber, filePath },
				error,
			)
		}

		const result = agentLifecycleEventSchema.safeParse(parsed)
		if (!result.success) {
			throw new AgentLifecycleRecoveryError(
				"malformed_record",
				`Lifecycle record at ${filePath}:${lineNumber} failed schema validation: ${result.error.message}`,
				taskId,
				{ lineNumber, filePath },
				result.error,
			)
		}
		if (result.data.taskId !== taskId) {
			throw new AgentLifecycleRecoveryError(
				"task_mismatch",
				`Lifecycle record at ${filePath}:${lineNumber} targets task ${result.data.taskId}`,
				taskId,
				{ lineNumber, filePath, eventId: result.data.eventId, sequence: result.data.sequence },
			)
		}
		events.push(result.data)
	}
	return events
}

function replayEvents(events: readonly AgentLifecycleEvent[], taskId: string): AgentLifecycleSnapshot {
	const first = events[0]
	if (!first)
		throw new AgentLifecycleRecoveryError("invalid_event", "Cannot replay an empty lifecycle event list", taskId)
	let snapshot = snapshotFromEvent(first)
	const seenIds = new Map<string, AgentLifecycleEvent>()
	for (const event of events) {
		const priorId = seenIds.get(event.eventId)
		if (priorId) {
			throw new AgentLifecycleRecoveryError(
				"duplicate_event_conflict",
				`Lifecycle event ID ${event.eventId} appears more than once`,
				taskId,
				{ sequence: event.sequence, eventId: event.eventId },
			)
		}
		seenIds.set(event.eventId, event)

		const identityChanged = event.runId !== snapshot.runId || event.turnId !== snapshot.turnId
		if (identityChanged) {
			if (snapshot.status === "in_progress") {
				throw new AgentLifecycleRecoveryError(
					event.runId !== snapshot.runId ? "run_mismatch" : "turn_mismatch",
					`Lifecycle identity changed while turn ${snapshot.turnId} is in progress`,
					taskId,
					{ sequence: event.sequence, expectedSequence: snapshot.lastSequence + 1, eventId: event.eventId },
				)
			}
			if (event.sequence !== 1) {
				throw new AgentLifecycleRecoveryError(
					"sequence_gap",
					`New lifecycle turn must begin at sequence 1; received ${event.sequence}`,
					taskId,
					{ sequence: event.sequence, expectedSequence: 1, eventId: event.eventId },
				)
			}
			snapshot = snapshotFromEvent(event)
		}

		const expected = snapshot.lastSequence + 1
		if (event.sequence > expected) {
			throw new AgentLifecycleRecoveryError(
				"sequence_gap",
				`Lifecycle sequence gap: expected ${expected}, received ${event.sequence}`,
				taskId,
				{ sequence: event.sequence, expectedSequence: expected, eventId: event.eventId },
			)
		}
		if (event.sequence < expected) {
			throw new AgentLifecycleRecoveryError(
				"duplicate_sequence",
				`Lifecycle sequence ${event.sequence} is older than expected ${expected}`,
				taskId,
				{ sequence: event.sequence, expectedSequence: expected, eventId: event.eventId },
			)
		}
		try {
			snapshot = reduceAgentLifecycleEvent(snapshot, event)
		} catch (error) {
			throw wrapRecoveryError(error, taskId, event)
		}
	}
	return snapshot
}

function replayPrefix(
	events: readonly AgentLifecycleEvent[],
	lastSequence: number,
	taskId: string,
	runId?: string,
	turnId?: string,
): AgentLifecycleSnapshot {
	const requestedIdentity = runId !== undefined && turnId !== undefined ? { runId, turnId } : undefined
	const targetIdentity =
		requestedIdentity ??
		(events.at(-1) ? { runId: events.at(-1)!.runId, turnId: events.at(-1)!.turnId } : undefined)
	const segmentStart = targetIdentity
		? events.reduce((start, event, index) => {
				if (
					event.runId === targetIdentity.runId &&
					event.turnId === targetIdentity.turnId &&
					event.sequence === 1
				)
					return index
				return start
			}, -1)
		: -1
	const segmentEnd =
		segmentStart >= 0
			? events.findIndex(
					(event, index) =>
						index > segmentStart &&
						(event.runId !== targetIdentity!.runId || event.turnId !== targetIdentity!.turnId),
				)
			: -1
	const resolvedEnd = segmentEnd >= 0 ? segmentEnd : events.length
	const segment = segmentStart >= 0 ? events.slice(segmentStart, resolvedEnd) : []
	if (!segment[0] || segment[0].runId !== targetIdentity?.runId || segment[0].turnId !== targetIdentity?.turnId) {
		throw new AgentLifecycleRecoveryError(
			"snapshot_mismatch",
			`Lifecycle journal does not contain the snapshot identity ${runId ?? "unknown"}/${turnId ?? "unknown"}`,
			taskId,
			{ lastSequence },
		)
	}
	if (lastSequence === 0) return snapshotFromEvent(segment[0])
	const prefix = segment.filter((event) => event.sequence <= lastSequence)
	if (prefix.length !== lastSequence || prefix.some((event, index) => event.sequence !== index + 1)) {
		throw new AgentLifecycleRecoveryError(
			"snapshot_ahead",
			`Lifecycle journal does not contain a complete prefix through sequence ${lastSequence}`,
			taskId,
			{ lastSequence },
		)
	}
	return replayEvents(prefix, taskId)
}

function equivalentSnapshots(left: AgentLifecycleSnapshot, right: AgentLifecycleSnapshot): boolean {
	return stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
	return JSON.stringify(canonicalize(value))
}

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

const SECRET_KEY_PATTERN =
	/(api.?key|access.?key|client.?secret|secret|password|passwd|credential|authorization|private.?key|(?:(?:auth|access|refresh|id).?)?token)$/i

function redactLifecycleValue(
	value: unknown,
	maxValueLength: number,
	seen = new WeakSet<object>(),
	key?: string,
): unknown {
	if (key && SECRET_KEY_PATTERN.test(key)) return REDACTED_VALUE
	if (typeof value === "string") {
		let redacted = value
		redacted = redacted.replace(/(\bAuthorization\b\s*[:=]\s*Bearer\s+)[^\s,;}\]]+/gi, `$1${REDACTED_VALUE}`)
		redacted = redacted.replace(
			/(\b(?:api.?key|access.?key|client.?secret|secret|password|passwd|credential|authorization|private.?key|(?:(?:auth|access|refresh|id).?)?token)\b\s*[:=]\s*)(?!Bearer\b)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
			`$1${REDACTED_VALUE}`,
		)
		redacted = redacted.replace(/(\bBearer\s+)(?!\[redacted\])[^\s,;}\]]+/gi, `$1${REDACTED_VALUE}`)
		if (redacted.length <= maxValueLength) return redacted
		const suffix = "\n[truncated]"
		return `${redacted.slice(0, Math.max(0, maxValueLength - suffix.length))}${suffix}`
	}
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "undefined") {
		return value
	}
	if (typeof value === "bigint") return String(value)
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactLifecycleValue(value.message, maxValueLength),
			...(value.stack ? { stack: redactLifecycleValue(value.stack, maxValueLength) } : {}),
		}
	}
	if (value instanceof Date) return value.toISOString()
	if (seen.has(value)) return "[circular]"
	seen.add(value)
	if (Array.isArray(value)) return value.map((entry) => redactLifecycleValue(entry, maxValueLength, seen))
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
			entryKey,
			redactLifecycleValue(entryValue, maxValueLength, seen, entryKey),
		]),
	)
}
