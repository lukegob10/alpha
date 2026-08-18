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
	type ParentVerificationObligation,
	type ParentVerificationReview,
	type ParentVerificationSummary,
	type SubagentChangeSetState,
} from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeWriteJson } from "../../utils/safeWriteJson"
import {
	decideParentCompletion,
	parentVerificationObligationId,
	summarizeParentVerification,
	type ParentCompletionDecision,
} from "./ParentVerification"

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
	verificationObligations: [],
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

export interface RecordWorkerChangeSetInput {
	rootTaskId: string
	parentTaskId: string
	workerTaskId: string
	workerPath?: string
	workerNickname: string
	groupId: string
	changeSet: SubagentChangeSetState
	reviewSource?: ParentVerificationReview["source"]
	at?: number
}

export interface ParentCommandVerificationEvidence {
	toolCallId: string
	executionId: string
	status: "running" | "succeeded" | "failed" | "denied" | "cancelled" | "timed_out"
	exitCode?: number
	signalName?: string
	startedAt: number
	completedAt?: number
	/** Ephemeral command text used only to associate evidence with changed paths. */
	command?: string
}

export interface RecordWorkerChangeSetResult {
	obligation?: ParentVerificationObligation
	changed: boolean
	previousStatus?: ParentVerificationObligation["status"]
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
				const stopReason = record.parentTaskId && !parent ? "orphaned" : "interrupted"
				record.snapshot = { ...record.snapshot, stopReason }
				const recoveryRecipient =
					parent ??
					(record.parentTaskId
						? draft.agents.find(
								(candidate) => candidate.taskId === record.rootTaskId && candidate.role === "root",
							)
						: undefined)
				if (!recoveryRecipient) {
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
						recipientTaskId: recoveryRecipient.taskId,
						recipientPath: recoveryRecipient.path,
						kind: "lifecycle",
						name: "recovered_interrupted",
						payload: {
							previousStatus,
							stopReason,
							...(parent ? {} : { orphaned: true, missingParentTaskId: record.parentTaskId }),
						},
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
			if (!ACTIVE_STATUSES.has(parent.status)) {
				throw new Error(`Parent agent ${parent.path} cannot create a child while status is ${parent.status}`)
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

	/** Return the complete retained subtree below an open agent in stable parent-before-child order. */
	listDescendants(parent: string, rootTaskId?: string): AgentRecord[] {
		const parentRecord = this.getAgent(parent, rootTaskId)
		if (!parentRecord) {
			throw new Error(`Unknown parent agent target: ${parent}`)
		}

		const records = this.listAgents({ rootTaskId: parentRecord.rootTaskId })
		const byParent = new Map<string, AgentRecord[]>()
		for (const record of records) {
			if (!record.parentTaskId) continue
			const children = byParent.get(record.parentTaskId) ?? []
			children.push(record)
			byParent.set(record.parentTaskId, children)
		}
		for (const children of byParent.values()) {
			children.sort((left, right) => left.path.localeCompare(right.path))
		}

		const descendants: AgentRecord[] = []
		const visit = (taskId: string) => {
			for (const child of byParent.get(taskId) ?? []) {
				descendants.push(child)
				visit(child.taskId)
			}
		}
		visit(parentRecord.taskId)
		return descendants.map(clone)
	}

	isDescendant(parent: string, candidate: string, rootTaskId?: string): boolean {
		const parentRecord = this.getAgent(parent, rootTaskId)
		const candidateRecord = this.getAgent(candidate, parentRecord?.rootTaskId ?? rootTaskId)
		if (!parentRecord || !candidateRecord || parentRecord.rootTaskId !== candidateRecord.rootTaskId) return false

		let cursor: AgentRecord | undefined = candidateRecord
		const visited = new Set<string>()
		while (cursor.parentTaskId) {
			if (cursor.parentTaskId === parentRecord.taskId) return true
			if (visited.has(cursor.parentTaskId)) return false
			visited.add(cursor.parentTaskId)
			cursor = this.getAgent(cursor.parentTaskId, parentRecord.rootTaskId)
			if (!cursor) return false
		}
		return false
	}

	getVerificationObligations(
		options: {
			rootTaskId?: string
			parentTaskId?: string
			workerTaskId?: string
		} = {},
	): ParentVerificationObligation[] {
		this.assertInitialized()
		return this.state.verificationObligations
			.filter((item) => !options.rootTaskId || item.rootTaskId === options.rootTaskId)
			.filter((item) => !options.parentTaskId || item.parentTaskId === options.parentTaskId)
			.filter((item) => !options.workerTaskId || item.workerTaskId === options.workerTaskId)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map(clone)
	}

	getWorkerVerificationSummary(workerTaskId: string, rootTaskId?: string): ParentVerificationSummary | undefined {
		return summarizeParentVerification(this.getVerificationObligations({ rootTaskId, workerTaskId }))
	}

	getParentCompletionDecision(parentTaskId: string, rootTaskId?: string): ParentCompletionDecision {
		return decideParentCompletion(this.getVerificationObligations({ rootTaskId, parentTaskId }))
	}

	hasUnappliedWorkerVerification(workerTaskId: string, rootTaskId?: string): boolean {
		return this.getVerificationObligations({ rootTaskId, workerTaskId }).some(
			(obligation) => obligation.status === "required",
		)
	}

	/**
	 * Reconcile one persisted Worker change-set state into the durable obligation
	 * ledger. Replays are no-ops, and stale quarantined projections can never
	 * regress an already-applied obligation.
	 */
	async recordWorkerChangeSet(input: RecordWorkerChangeSetInput): Promise<RecordWorkerChangeSetResult> {
		this.assertInitialized()
		const changedFiles = [...new Set(input.changeSet.changedFiles)].sort()
		if (changedFiles.length === 0) return { changed: false }

		const obligationId = parentVerificationObligationId(input.changeSet.id)
		const before = this.state.verificationObligations.find((item) => item.id === obligationId)
		const wouldChange = !before || this.changeSetWouldAdvance(before, input)
		if (!wouldChange) return { obligation: clone(before), changed: false, previousStatus: before.status }

		return this.transact((draft) => {
			const timestamp = input.at ?? this.now()
			let obligation = draft.verificationObligations.find((item) => item.id === obligationId)
			const previousStatus = obligation?.status
			if (obligation) {
				this.assertVerificationIdentity(obligation, input)
			} else {
				for (const previous of draft.verificationObligations) {
					if (
						previous.workerTaskId === input.workerTaskId &&
						previous.status === "required" &&
						previous.changeSetId !== input.changeSet.id
					) {
						previous.status = "superseded"
						previous.supersededByChangeSetId = input.changeSet.id
						previous.reason = "A newer Worker proposal replaced this unapplied change set."
						previous.updatedAt = timestamp
					}
				}

				obligation = {
					id: obligationId,
					rootTaskId: input.rootTaskId,
					parentTaskId: input.parentTaskId,
					workerTaskId: input.workerTaskId,
					workerPath: input.workerPath,
					workerNickname: input.workerNickname,
					groupId: input.groupId,
					changeSetId: input.changeSet.id,
					changedFiles,
					status: "required",
					createdAt: input.changeSet.createdAt,
					updatedAt: timestamp,
				}
				draft.verificationObligations.push(obligation)
			}

			obligation.workerPath = input.workerPath ?? obligation.workerPath
			obligation.workerNickname = input.workerNickname
			obligation.changedFiles = changedFiles
			this.applyChangeSetTransition(obligation, input, timestamp)
			return { obligation: clone(obligation), changed: true, previousStatus }
		})
	}

	/** Persist terminal parent command evidence against every applied obligation it can cover. */
	async recordParentVerificationEvidence(
		parentTaskId: string,
		evidence: readonly ParentCommandVerificationEvidence[],
		rootTaskId?: string,
	): Promise<ParentVerificationObligation[]> {
		this.assertInitialized()
		const terminalEvidence = evidence
			.filter(
				(item): item is ParentCommandVerificationEvidence & { completedAt: number } =>
					item.status !== "running" && item.completedAt !== undefined,
			)
			.sort(
				(left, right) =>
					left.completedAt - right.completedAt || left.toolCallId.localeCompare(right.toolCallId),
			)
		if (terminalEvidence.length === 0) return []

		const candidates = this.state.verificationObligations.filter(
			(item) =>
				item.parentTaskId === parentTaskId &&
				(!rootTaskId || item.rootTaskId === rootTaskId) &&
				(item.status === "pending" || item.status === "failed") &&
				item.appliedAt !== undefined,
		)
		const wouldChange = candidates.some((item) => {
			const selected = this.selectVerificationEvidence(item, terminalEvidence)
			if (!selected) return false
			const status = selected.evidence.status === "succeeded" ? "passed" : "failed"
			return (
				item.verification?.executionId !== selected.evidence.executionId || item.verification.status !== status
			)
		})
		if (!wouldChange) return []

		return this.transact((draft) => {
			const changed: ParentVerificationObligation[] = []
			for (const obligation of draft.verificationObligations) {
				if (
					obligation.parentTaskId !== parentTaskId ||
					(rootTaskId && obligation.rootTaskId !== rootTaskId) ||
					(obligation.status !== "pending" && obligation.status !== "failed")
				)
					continue

				const selected = this.selectVerificationEvidence(obligation, terminalEvidence)
				if (!selected) continue
				const status = selected.evidence.status === "succeeded" ? "passed" : "failed"
				if (
					obligation.verification?.executionId === selected.evidence.executionId &&
					obligation.verification.status === status
				)
					continue

				obligation.verification = {
					status,
					toolCallId: selected.evidence.toolCallId,
					executionId: selected.evidence.executionId,
					startedAt: selected.evidence.startedAt,
					completedAt: selected.evidence.completedAt,
					exitCode: selected.evidence.exitCode,
					signalName: selected.evidence.signalName,
					matchedFiles: selected.matchedFiles,
				}
				obligation.status = status === "passed" ? "satisfied" : "failed"
				obligation.reason =
					status === "passed"
						? "A parent verification command completed successfully after application."
						: "The latest parent verification command did not complete successfully."
				obligation.updatedAt = selected.evidence.completedAt
				changed.push(clone(obligation))
			}
			return changed
		})
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
				stopReason: record.terminalResult?.stopReason ?? record.snapshot?.stopReason,
			}
			draft.agents = draft.agents.filter((candidate) => candidate.taskId !== record.taskId)
			draft.tombstones.push(tombstone)
			return clone(tombstone)
		})
	}

	private changeSetWouldAdvance(
		obligation: ParentVerificationObligation,
		input: RecordWorkerChangeSetInput,
	): boolean {
		this.assertVerificationIdentity(obligation, input)
		if (input.workerPath && input.workerPath !== obligation.workerPath) return true
		if (input.workerNickname !== obligation.workerNickname) return true
		if (!isDeepStrictEqual([...new Set(input.changeSet.changedFiles)].sort(), obligation.changedFiles)) return true
		if (input.changeSet.status === "applied") {
			return obligation.status === "required"
		}
		if (["discarded", "scope_violation", "unavailable"].includes(input.changeSet.status)) {
			return obligation.status === "required"
		}
		return false
	}

	private applyChangeSetTransition(
		obligation: ParentVerificationObligation,
		input: RecordWorkerChangeSetInput,
		timestamp: number,
	): void {
		if (input.changeSet.status === "applied") {
			if (["satisfied", "pending", "failed"].includes(obligation.status)) return
			obligation.status = "pending"
			obligation.review = {
				decision: "approved",
				source: input.reviewSource === "apply" ? "apply" : "recovered_application",
				recordedAt: timestamp,
			}
			obligation.appliedAt = timestamp
			obligation.updatedAt = timestamp
			obligation.reason = "Worker changes were reviewed and applied; parent verification is pending."
			delete obligation.verification
			delete obligation.supersededByChangeSetId
			return
		}

		if (["discarded", "scope_violation", "unavailable"].includes(input.changeSet.status)) {
			if (["satisfied", "pending", "failed"].includes(obligation.status)) return
			obligation.status = "not_applicable"
			obligation.review = {
				decision: "rejected",
				source: input.reviewSource === "discard" ? "discard" : "recovered_disposition",
				recordedAt: timestamp,
			}
			obligation.updatedAt = timestamp
			obligation.reason =
				input.changeSet.status === "discarded"
					? "The quarantined Worker proposal was explicitly discarded."
					: (input.changeSet.error ?? "The Worker proposal was not eligible for application.")
			delete obligation.appliedAt
			delete obligation.verification
			delete obligation.supersededByChangeSetId
			return
		}

		if (obligation.status === "required") {
			obligation.updatedAt = Math.max(obligation.updatedAt, timestamp)
			obligation.reason =
				input.changeSet.status === "conflicted"
					? "Worker changes remain quarantined because application conflicted."
					: "Worker changes remain quarantined until explicit review and application."
		}
	}

	private selectVerificationEvidence(
		obligation: ParentVerificationObligation,
		evidence: readonly (ParentCommandVerificationEvidence & { completedAt: number })[],
	):
		| {
				evidence: ParentCommandVerificationEvidence & { completedAt: number }
				matchedFiles: string[]
		  }
		| undefined {
		if (obligation.appliedAt === undefined) return undefined
		const relevant = evidence.flatMap((item) => {
			if (item.startedAt < obligation.appliedAt!) return []
			const matchedFiles = this.getReferencedChangedFiles(item.command, obligation.changedFiles)
			return matchedFiles.length > 0 ? [{ evidence: item, matchedFiles }] : []
		})
		if (relevant.length === 0) return undefined
		return relevant.find((item) => item.evidence.status === "succeeded") ?? relevant.at(-1)
	}

	private getReferencedChangedFiles(command: string | undefined, changedFiles: readonly string[]): string[] {
		if (!command?.trim()) return []
		const normalizedCommand = command.replace(/\\/g, "/")
		return changedFiles.filter((changedFile) => {
			const normalizedFile = changedFile.replace(/\\/g, "/").replace(/^\.\//, "")
			const escapedFile = normalizedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			return new RegExp(`(^|[\\s\"'=:(,])(?:\\./)?${escapedFile}(?=$|[\\s\"';),])`, "i").test(normalizedCommand)
		})
	}

	private assertVerificationIdentity(
		obligation: ParentVerificationObligation,
		input: RecordWorkerChangeSetInput,
	): void {
		if (
			obligation.changeSetId !== input.changeSet.id ||
			obligation.rootTaskId !== input.rootTaskId ||
			obligation.parentTaskId !== input.parentTaskId ||
			obligation.workerTaskId !== input.workerTaskId ||
			obligation.groupId !== input.groupId
		) {
			throw new Error(`Verification obligation ${obligation.id} was reused with different identity`)
		}
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
		const byPath = this.resolvePath(draft.agents, target, rootTaskId)
		if (byPath || target.startsWith("/")) return byPath

		const matches = draft.agents.filter(
			(record) => record.nickname === target && (!rootTaskId || record.rootTaskId === rootTaskId),
		)
		if (matches.length > 1) {
			throw new Error(`Agent task_name ${target} is ambiguous; provide a task ID or canonical path`)
		}
		return matches[0]
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
