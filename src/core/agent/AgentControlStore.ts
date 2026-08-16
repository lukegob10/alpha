import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import { isDeepStrictEqual } from "util"

import {
	agentCanonicalPathSchema,
	agentControlStateSchema,
	type AgentCanonicalPath,
	type AgentControlState,
	type AgentLifecycleStatus,
	type AgentMailboxCursor,
	type AgentMailboxEntry,
	type AgentMailboxKind,
	type AgentRecord,
	type AgentRuntimeSnapshot,
	type AgentTerminalResultMetadata,
	type ClosedAgentTombstone,
} from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeWriteJson } from "../../utils/safeWriteJson"

const ACTIVE_STATUSES = new Set<AgentLifecycleStatus>(["pending", "running", "cancelling"])
const TERMINAL_STATUSES = new Set<AgentLifecycleStatus>(["completed", "blocked", "failed", "cancelled", "timed_out"])
const CLOSABLE_STATUSES = new Set<AgentLifecycleStatus>([...TERMINAL_STATUSES, "interrupted"])

const ALLOWED_TRANSITIONS: Record<AgentLifecycleStatus, ReadonlySet<AgentLifecycleStatus>> = {
	pending: new Set([
		"running",
		"cancelling",
		"interrupted",
		"completed",
		"blocked",
		"failed",
		"cancelled",
		"timed_out",
	]),
	running: new Set(["cancelling", "interrupted", "completed", "blocked", "failed", "cancelled", "timed_out"]),
	cancelling: new Set(["interrupted", "completed", "blocked", "failed", "cancelled", "timed_out"]),
	interrupted: new Set(["pending", "cancelled"]),
	completed: new Set(["pending"]),
	blocked: new Set(["pending"]),
	failed: new Set(["pending"]),
	cancelled: new Set(),
	timed_out: new Set(["pending"]),
}

const initialState = (now: number): AgentControlState => ({
	version: 1,
	updatedAt: now,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
})

const clone = <T>(value: T): T => structuredClone(value)

/** Replaceable persistence seam used by the production file store and deterministic tests. */
export interface AgentControlPersistence {
	read(): Promise<unknown | undefined>
	write(state: AgentControlState): Promise<void>
}

export class InMemoryAgentControlPersistence implements AgentControlPersistence {
	private state: AgentControlState | undefined

	constructor(state?: AgentControlState) {
		this.state = state ? clone(state) : undefined
	}

	async read(): Promise<AgentControlState | undefined> {
		return this.state ? clone(this.state) : undefined
	}

	async write(state: AgentControlState): Promise<void> {
		this.state = clone(state)
	}
}

export class FileAgentControlPersistence implements AgentControlPersistence {
	readonly filePath: string

	constructor(globalStoragePath: string) {
		this.filePath = path.join(globalStoragePath, GlobalFileNames.agentControl)
	}

	async read(): Promise<unknown | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.filePath, "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined
			}
			throw error
		}
	}

	async write(state: AgentControlState): Promise<void> {
		await safeWriteJson(this.filePath, state, { prettyPrint: true })
	}
}

export interface EnsureRootInput {
	taskId: string
	nickname?: string
	objective?: string
	groupId?: string
	status?: "pending" | "running" | "interrupted"
	snapshot?: AgentRuntimeSnapshot
}

export interface CreateAgentInput {
	taskId: string
	parentTaskId: string
	rootTaskId?: string
	groupId?: string
	nickname: string
	role: "explore" | "review" | "worker"
	objective: string
	status?: AgentLifecycleStatus
	snapshot?: AgentRuntimeSnapshot
}

export interface UpdateAgentStatusInput {
	snapshot?: AgentRuntimeSnapshot
	terminalResult?: AgentTerminalResultMetadata
	at?: number
}

export interface AppendAgentMailboxEventInput {
	eventId?: string
	rootTaskId?: string
	sender?: string
	recipient: string
	kind: AgentMailboxKind
	name: string
	payload?: Record<string, unknown>
	createdAt?: number
}

export interface AppendAgentMailboxEventResult {
	entry: AgentMailboxEntry
	appended: boolean
}

export interface ReadAgentMailboxOptions {
	rootTaskId?: string
	afterSequence?: number
	limit?: number
	includeDelivered?: boolean
	kinds?: AgentMailboxKind[]
}

export interface AgentMailboxRead {
	entries: AgentMailboxEntry[]
	cursor: AgentMailboxCursor
	nextSequence: number
}

export interface ListAgentsOptions {
	rootTaskId?: string
	parentTaskId?: string
	includeRoot?: boolean
	statuses?: AgentLifecycleStatus[]
}

export interface ResolveAgentTargetOptions {
	rootTaskId?: string
	includeClosed?: boolean
}

export interface ClosedAgentTarget {
	closed: true
	tombstone: ClosedAgentTombstone
}

export interface OpenAgentTarget {
	closed: false
	record: AgentRecord
}

export type ResolvedAgentTarget = OpenAgentTarget | ClosedAgentTarget
export type AgentMailboxListener = (entry: AgentMailboxEntry) => void

interface MutableAddress {
	taskId: string
	path: AgentCanonicalPath
	rootTaskId: string
}

/**
 * Durable source of truth for agent identity, tree state, and parent/child mailboxes.
 *
 * Canonical paths are unique within a root task. Mutations are serialized and the
 * complete versioned snapshot is atomically replaced after each successful write.
 */
export class AgentControlStore {
	private static readonly globalStores = new Map<string, AgentControlStore>()
	private state: AgentControlState
	private initialized = false
	private writeLock: Promise<void> = Promise.resolve()
	private readonly listeners = new Set<AgentMailboxListener>()

	constructor(
		private readonly persistence: AgentControlPersistence,
		private readonly now: () => number = Date.now,
	) {
		this.state = initialState(this.now())
	}

	static forGlobalStorage(globalStoragePath: string, now?: () => number): AgentControlStore {
		const key = path.resolve(globalStoragePath)
		let store = this.globalStores.get(key)
		if (!store) {
			store = new AgentControlStore(new FileAgentControlPersistence(key), now)
			this.globalStores.set(key, store)
		}
		return store
	}

	/** Load persisted state and convert abandoned active runs to interrupted exactly once. */
	async initialize(): Promise<void> {
		await this.withWriteLock(async () => {
			if (this.initialized) {
				return
			}

			const stored = await this.persistence.read()
			const draft = stored === undefined ? initialState(this.now()) : agentControlStateSchema.parse(stored)
			const highestSequence = draft.mailbox.reduce((highest, entry) => Math.max(highest, entry.sequence), 0)
			draft.nextSequence = Math.max(draft.nextSequence, highestSequence + 1)

			const recoveredEvents: AgentMailboxEntry[] = []
			let recoveredRecordCount = 0
			const recoveredAt = this.now()
			for (const record of draft.agents) {
				if (!ACTIVE_STATUSES.has(record.status)) {
					continue
				}

				const previousStatus = record.status
				const previousUpdatedAt = record.updatedAt
				record.status = "interrupted"
				record.updatedAt = recoveredAt
				record.interruptedAt = recoveredAt
				recoveredRecordCount++

				const parent = record.parentTaskId
					? draft.agents.find((candidate) => candidate.taskId === record.parentTaskId)
					: undefined
				if (!parent) {
					continue
				}
				const eventId = `agent-recovery:${record.rootTaskId}:${record.taskId}:${previousStatus}:${previousUpdatedAt}`
				if (!draft.mailbox.some((entry) => entry.eventId === eventId)) {
					const entry: AgentMailboxEntry = {
						eventId,
						sequence: draft.nextSequence++,
						rootTaskId: record.rootTaskId,
						senderTaskId: record.taskId,
						senderPath: record.path,
						recipientTaskId: parent.taskId,
						recipientPath: parent.path,
						kind: "lifecycle",
						name: "recovered_interrupted",
						payload: { previousStatus },
						createdAt: recoveredAt,
					}
					draft.mailbox.push(entry)
					recoveredEvents.push(entry)
				}
			}

			if (recoveredRecordCount > 0) {
				draft.updatedAt = recoveredAt
				await this.persistence.write(draft)
			}

			this.state = draft
			this.initialized = true
			this.publish(recoveredEvents)
		})
	}

	async flush(): Promise<void> {
		await this.writeLock
	}

	getSnapshot(): AgentControlState {
		this.assertInitialized()
		return clone(this.state)
	}

	/** Register the primary parent even when it is not managed as a subagent run. */
	async ensureRoot(input: EnsureRootInput): Promise<AgentRecord> {
		return this.transact((draft) => {
			const existing = draft.agents.find((record) => record.taskId === input.taskId)
			if (existing) {
				if (existing.role !== "root" || existing.rootTaskId !== input.taskId || existing.path !== "/root") {
					throw new Error(`Task ${input.taskId} is already registered as a non-root agent`)
				}
				return clone(existing)
			}

			this.assertTaskIdAvailable(draft, input.taskId)
			const timestamp = this.now()
			const status = input.status ?? "running"
			const record: AgentRecord = {
				taskId: input.taskId,
				path: "/root",
				rootTaskId: input.taskId,
				groupId: input.groupId,
				nickname: input.nickname?.trim() || "root",
				role: "root",
				objective: input.objective ?? "",
				status,
				createdAt: timestamp,
				updatedAt: timestamp,
				startedAt: status === "running" ? timestamp : undefined,
				interruptedAt: status === "interrupted" ? timestamp : undefined,
				snapshot: input.snapshot ? clone(input.snapshot) : undefined,
			}
			draft.agents.push(record)
			return clone(record)
		})
	}

	async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
		return this.transact((draft) => {
			this.assertTaskIdAvailable(draft, input.taskId)
			const parent = draft.agents.find((record) => record.taskId === input.parentTaskId)
			if (!parent) {
				throw new Error(
					`Parent agent ${input.parentTaskId} is not registered; call ensureRoot first when it is the primary task`,
				)
			}
			if (input.rootTaskId && input.rootTaskId !== parent.rootTaskId) {
				throw new Error(`Root task ${input.rootTaskId} does not match parent root ${parent.rootTaskId}`)
			}

			const timestamp = this.now()
			const status = input.status ?? "pending"
			const record: AgentRecord = {
				taskId: input.taskId,
				path: this.allocatePath(draft, parent.rootTaskId, parent.path, input.nickname),
				parentTaskId: parent.taskId,
				parentPath: parent.path,
				rootTaskId: parent.rootTaskId,
				groupId: input.groupId,
				nickname: input.nickname.trim() || "agent",
				role: input.role,
				objective: input.objective,
				status,
				createdAt: timestamp,
				updatedAt: timestamp,
				startedAt: status === "running" ? timestamp : undefined,
				interruptedAt: status === "interrupted" ? timestamp : undefined,
				finishedAt: TERMINAL_STATUSES.has(status) ? timestamp : undefined,
				snapshot: input.snapshot ? clone(input.snapshot) : undefined,
			}
			draft.agents.push(record)
			return clone(record)
		})
	}

	async updateAgentStatus(
		target: string,
		status: AgentLifecycleStatus,
		input: UpdateAgentStatusInput = {},
		rootTaskId?: string,
	): Promise<AgentRecord> {
		return this.transact((draft) => {
			const record = this.requireMutableRecord(draft, target, rootTaskId)
			const timestamp = input.at ?? this.now()
			if (record.status !== status && !ALLOWED_TRANSITIONS[record.status].has(status)) {
				throw new Error(`Invalid agent lifecycle transition ${record.status} -> ${status} for ${record.path}`)
			}
			if (input.terminalResult && input.terminalResult.status !== status) {
				throw new Error(
					`Terminal result status ${input.terminalResult.status} does not match agent status ${status}`,
				)
			}
			if (input.terminalResult && !TERMINAL_STATUSES.has(status)) {
				throw new Error(`Agent status ${status} cannot contain terminal result metadata`)
			}

			record.status = status
			record.updatedAt = timestamp
			if (input.snapshot) {
				record.snapshot = clone(input.snapshot)
			}
			if (status === "running") {
				record.startedAt ??= timestamp
			}
			if (status === "interrupted") {
				record.interruptedAt = timestamp
			}
			if (status === "pending") {
				delete record.finishedAt
				delete record.interruptedAt
				delete record.terminalResult
			}
			if (TERMINAL_STATUSES.has(status)) {
				record.finishedAt = timestamp
				record.terminalResult = input.terminalResult
					? clone(input.terminalResult)
					: { status: status as AgentTerminalResultMetadata["status"], completedAt: timestamp }
			}
			return clone(record)
		})
	}

	async updateAgentSnapshot(
		target: string,
		snapshot: AgentRuntimeSnapshot,
		rootTaskId?: string,
	): Promise<AgentRecord> {
		return this.transact((draft) => {
			const record = this.requireMutableRecord(draft, target, rootTaskId)
			record.snapshot = clone(snapshot)
			record.updatedAt = this.now()
			return clone(record)
		})
	}

	resolveTarget(target: string, options: ResolveAgentTargetOptions = {}): ResolvedAgentTarget | undefined {
		this.assertInitialized()
		const record = this.resolveRecord(this.state, target, options.rootTaskId)
		if (record) {
			return { closed: false, record: clone(record) }
		}
		if (!options.includeClosed) {
			return undefined
		}
		const tombstone = this.resolveTombstone(this.state, target, options.rootTaskId)
		return tombstone ? { closed: true, tombstone: clone(tombstone) } : undefined
	}

	getAgent(target: string, rootTaskId?: string): AgentRecord | undefined {
		const resolved = this.resolveTarget(target, { rootTaskId })
		return resolved && !resolved.closed ? resolved.record : undefined
	}

	listAgents(options: ListAgentsOptions = {}): AgentRecord[] {
		this.assertInitialized()
		const statuses = options.statuses ? new Set(options.statuses) : undefined
		return this.state.agents
			.filter((record) => !options.rootTaskId || record.rootTaskId === options.rootTaskId)
			.filter((record) => !options.parentTaskId || record.parentTaskId === options.parentTaskId)
			.filter((record) => options.includeRoot !== false || record.role !== "root")
			.filter((record) => !statuses || statuses.has(record.status))
			.sort((left, right) => left.path.localeCompare(right.path) || left.createdAt - right.createdAt)
			.map(clone)
	}

	listChildren(parent: string, rootTaskId?: string): AgentRecord[] {
		const parentRecord = this.getAgent(parent, rootTaskId)
		if (!parentRecord) {
			throw new Error(`Unknown parent agent target: ${parent}`)
		}
		return this.listAgents({ rootTaskId: parentRecord.rootTaskId, parentTaskId: parentRecord.taskId })
	}

	/** Terminal and interrupted records remain queryable until this explicit close. */
	async closeAgent(target: string, rootTaskId?: string): Promise<ClosedAgentTombstone> {
		return this.transact((draft) => {
			const record = this.requireMutableRecord(draft, target, rootTaskId)
			if (!CLOSABLE_STATUSES.has(record.status)) {
				throw new Error(`Agent ${record.path} cannot be closed while status is ${record.status}`)
			}
			if (draft.agents.some((candidate) => candidate.parentTaskId === record.taskId)) {
				throw new Error(`Agent ${record.path} cannot be closed while it has retained children`)
			}

			const tombstone: ClosedAgentTombstone = {
				taskId: record.taskId,
				path: record.path,
				parentTaskId: record.parentTaskId,
				rootTaskId: record.rootTaskId,
				status: record.status as ClosedAgentTombstone["status"],
				closedAt: this.now(),
			}
			draft.agents = draft.agents.filter((candidate) => candidate.taskId !== record.taskId)
			draft.tombstones.push(tombstone)
			return clone(tombstone)
		})
	}

	async appendEvent(input: AppendAgentMailboxEventInput): Promise<AppendAgentMailboxEventResult> {
		return this.transact((draft) => {
			if (input.eventId) {
				const existing = draft.mailbox.find((entry) => entry.eventId === input.eventId)
				if (existing) {
					this.assertIdempotentEvent(existing, input)
					return { entry: clone(existing), appended: false }
				}
			}

			const recipient = this.requireOpenAddress(draft, input.recipient, input.rootTaskId)
			const sender = input.sender ? this.requireOpenAddress(draft, input.sender, recipient.rootTaskId) : undefined
			const entry: AgentMailboxEntry = {
				eventId: input.eventId ?? randomUUID(),
				sequence: draft.nextSequence++,
				rootTaskId: recipient.rootTaskId,
				senderTaskId: sender?.taskId,
				senderPath: sender?.path,
				recipientTaskId: recipient.taskId,
				recipientPath: recipient.path,
				kind: input.kind,
				name: input.name,
				payload: input.payload ? clone(input.payload) : undefined,
				createdAt: input.createdAt ?? this.now(),
			}
			draft.mailbox.push(entry)
			return { entry: clone(entry), appended: true }
		})
	}

	readMailbox(recipient: string, options: ReadAgentMailboxOptions = {}): AgentMailboxRead {
		this.assertInitialized()
		const address = this.requireAddress(this.state, recipient, options.rootTaskId)
		const cursor = this.cursorFor(this.state, address)
		const afterSequence = options.afterSequence ?? cursor.lastDeliveredSequence
		const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
		const kinds = options.kinds ? new Set(options.kinds) : undefined
		const entries = this.state.mailbox
			.filter((entry) => entry.rootTaskId === address.rootTaskId && entry.recipientTaskId === address.taskId)
			.filter((entry) => entry.sequence > afterSequence)
			.filter((entry) => options.includeDelivered !== false || entry.deliveredAt === undefined)
			.filter((entry) => !kinds || kinds.has(entry.kind))
			.sort((left, right) => left.sequence - right.sequence)
			.slice(0, limit)
			.map(clone)
		return {
			entries,
			cursor: clone(cursor),
			nextSequence: entries.at(-1)?.sequence ?? afterSequence,
		}
	}

	getMailboxCursor(recipient: string, rootTaskId?: string): AgentMailboxCursor {
		this.assertInitialized()
		return clone(this.cursorFor(this.state, this.requireAddress(this.state, recipient, rootTaskId)))
	}

	async markDelivered(
		recipient: string,
		throughSequence: number,
		rootTaskId?: string,
		deliveredAt = this.now(),
	): Promise<AgentMailboxCursor> {
		return this.advanceMailbox(recipient, throughSequence, rootTaskId, deliveredAt, false)
	}

	async acknowledge(
		recipient: string,
		throughSequence: number,
		rootTaskId?: string,
		acknowledgedAt = this.now(),
	): Promise<AgentMailboxCursor> {
		return this.advanceMailbox(recipient, throughSequence, rootTaskId, acknowledgedAt, true)
	}

	subscribe(listener: AgentMailboxListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private async advanceMailbox(
		recipient: string,
		throughSequence: number,
		rootTaskId: string | undefined,
		timestamp: number,
		acknowledge: boolean,
	): Promise<AgentMailboxCursor> {
		if (!Number.isInteger(throughSequence) || throughSequence < 0) {
			throw new Error("Mailbox sequence must be a non-negative integer")
		}
		return this.transact((draft) => {
			const address = this.requireAddress(draft, recipient, rootTaskId)
			const effectiveThroughSequence = Math.min(throughSequence, draft.nextSequence - 1)
			for (const entry of draft.mailbox) {
				if (
					entry.rootTaskId === address.rootTaskId &&
					entry.recipientTaskId === address.taskId &&
					entry.sequence <= effectiveThroughSequence
				) {
					entry.deliveredAt ??= timestamp
					if (acknowledge) {
						entry.acknowledgedAt ??= timestamp
					}
				}
			}

			const key = this.cursorKey(address)
			const cursor = this.cursorFor(draft, address)
			cursor.lastDeliveredSequence = Math.max(cursor.lastDeliveredSequence, effectiveThroughSequence)
			if (acknowledge) {
				cursor.lastAcknowledgedSequence = Math.max(cursor.lastAcknowledgedSequence, effectiveThroughSequence)
			}
			cursor.updatedAt = timestamp
			draft.mailboxCursors[key] = cursor
			return clone(cursor)
		})
	}

	private async transact<T>(mutate: (draft: AgentControlState) => T): Promise<T> {
		this.assertInitialized()
		return this.withWriteLock(async () => {
			const draft = clone(this.state)
			const previousMailboxLength = draft.mailbox.length
			const value = mutate(draft)
			draft.updatedAt = this.now()
			agentControlStateSchema.parse(draft)
			await this.persistence.write(draft)
			this.state = draft
			this.publish(draft.mailbox.slice(previousMailboxLength))
			return value
		})
	}

	private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.writeLock.then(operation, operation)
		this.writeLock = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	private allocatePath(
		draft: AgentControlState,
		rootTaskId: string,
		parentPath: AgentCanonicalPath,
		nickname: string,
	): AgentCanonicalPath {
		const base = this.pathSegment(nickname)
		const usedPaths = new Set(
			[
				...draft.agents.filter((record) => record.rootTaskId === rootTaskId),
				...draft.tombstones.filter((record) => record.rootTaskId === rootTaskId),
			].map((record) => record.path),
		)
		let suffix = 1
		let candidate = `${parentPath}/${base}`
		while (usedPaths.has(candidate)) {
			suffix++
			candidate = `${parentPath}/${base}-${suffix}`
		}
		return agentCanonicalPathSchema.parse(candidate)
	}

	private pathSegment(nickname: string): string {
		return (
			nickname
				.normalize("NFKD")
				.replace(/[\u0300-\u036f]/g, "")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "agent"
		)
	}

	private assertTaskIdAvailable(draft: AgentControlState, taskId: string): void {
		if (
			draft.agents.some((record) => record.taskId === taskId) ||
			draft.tombstones.some((record) => record.taskId === taskId)
		) {
			throw new Error(`Agent task ID ${taskId} has already been used`)
		}
	}

	private resolveRecord(draft: AgentControlState, target: string, rootTaskId?: string): AgentRecord | undefined {
		const byId = draft.agents.find((record) => record.taskId === target)
		if (byId) {
			if (rootTaskId && byId.rootTaskId !== rootTaskId) {
				return undefined
			}
			return byId
		}
		return this.resolvePath(draft.agents, target, rootTaskId)
	}

	private resolveTombstone(
		draft: AgentControlState,
		target: string,
		rootTaskId?: string,
	): ClosedAgentTombstone | undefined {
		const byId = draft.tombstones.find((record) => record.taskId === target)
		if (byId) {
			if (rootTaskId && byId.rootTaskId !== rootTaskId) {
				return undefined
			}
			return byId
		}
		return this.resolvePath(draft.tombstones, target, rootTaskId)
	}

	private resolvePath<T extends { path: AgentCanonicalPath; rootTaskId: string }>(
		items: T[],
		target: string,
		rootTaskId?: string,
	): T | undefined {
		if (!target.startsWith("/")) {
			return undefined
		}
		agentCanonicalPathSchema.parse(target)
		const matches = items.filter((item) => item.path === target && (!rootTaskId || item.rootTaskId === rootTaskId))
		if (matches.length > 1) {
			throw new Error(`Agent path ${target} is ambiguous; provide rootTaskId`)
		}
		return matches[0]
	}

	private requireMutableRecord(draft: AgentControlState, target: string, rootTaskId?: string): AgentRecord {
		const record = this.resolveRecord(draft, target, rootTaskId)
		if (!record) {
			throw new Error(`Unknown agent target: ${target}`)
		}
		return record
	}

	private requireAddress(draft: AgentControlState, target: string, rootTaskId?: string): MutableAddress {
		const record = this.resolveRecord(draft, target, rootTaskId)
		if (record) {
			return { taskId: record.taskId, path: record.path, rootTaskId: record.rootTaskId }
		}
		const tombstone = this.resolveTombstone(draft, target, rootTaskId)
		if (tombstone) {
			return { taskId: tombstone.taskId, path: tombstone.path, rootTaskId: tombstone.rootTaskId }
		}
		throw new Error(`Unknown agent target: ${target}`)
	}

	private requireOpenAddress(draft: AgentControlState, target: string, rootTaskId?: string): MutableAddress {
		const record = this.resolveRecord(draft, target, rootTaskId)
		if (!record) {
			throw new Error(`Unknown or closed agent target: ${target}`)
		}
		return { taskId: record.taskId, path: record.path, rootTaskId: record.rootTaskId }
	}

	private cursorFor(draft: AgentControlState, address: MutableAddress): AgentMailboxCursor {
		return (
			draft.mailboxCursors[this.cursorKey(address)] ?? {
				recipientTaskId: address.taskId,
				recipientPath: address.path,
				lastDeliveredSequence: 0,
				lastAcknowledgedSequence: 0,
				updatedAt: 0,
			}
		)
	}

	private cursorKey(address: MutableAddress): string {
		return `${address.rootTaskId}:${address.taskId}`
	}

	private assertIdempotentEvent(existing: AgentMailboxEntry, input: AppendAgentMailboxEventInput): void {
		const same =
			existing.kind === input.kind &&
			existing.name === input.name &&
			(!input.rootTaskId || existing.rootTaskId === input.rootTaskId) &&
			(existing.recipientTaskId === input.recipient || existing.recipientPath === input.recipient) &&
			(!input.sender || existing.senderTaskId === input.sender || existing.senderPath === input.sender) &&
			(input.createdAt === undefined || existing.createdAt === input.createdAt) &&
			(input.payload === undefined || isDeepStrictEqual(existing.payload, input.payload))
		if (!same) {
			throw new Error(`Mailbox event ID ${existing.eventId} was reused with different content`)
		}
	}

	private publish(entries: AgentMailboxEntry[]): void {
		for (const entry of entries) {
			for (const listener of this.listeners) {
				try {
					listener(clone(entry))
				} catch {
					// Subscriber failures cannot roll back an already durable event.
				}
			}
		}
	}

	private assertInitialized(): void {
		if (!this.initialized) {
			throw new Error("AgentControlStore.initialize() must complete before use")
		}
	}
}
