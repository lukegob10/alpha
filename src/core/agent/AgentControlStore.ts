import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { isDeepStrictEqual } from "util"
import * as lockfile from "proper-lockfile"

import {
	agentCanonicalPathSchema,
	agentControlStateSchema,
	agentRuntimeOwnerIdSchema,
	type AgentCanonicalPath,
	type AgentControlState,
	type AgentLifecycleStatus,
	type AgentMailboxCursor,
	type AgentMailboxEntry,
	type AgentMailboxKind,
	type AgentRecord,
	type AgentRuntimeSnapshot,
	type AgentRuntimeOwnerId,
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
const DEFAULT_OWNER_LEASE_STALE_MS = 60_000
const DEFAULT_OWNER_LEASE_UPDATE_MS = 10_000
const DEFAULT_RECOVERY_SCAN_INTERVAL_MS = 30_000
const TRANSACTION_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000] as const
const TRANSACTION_LOCK_PROMOTION_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const
const TRANSACTION_LOCK_RELEASE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const
const TRANSIENT_TRANSACTION_LOCK_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"])

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
	version: 2,
	updatedAt: now,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
	verificationObligations: [],
})

const clone = <T>(value: T): T => structuredClone(value)
interface TransactionLockOwner {
	token: string
	pid: number
}

interface ActiveTransaction {
	token: string
	committed: boolean
}

interface PersistedAgentControlState {
	state: AgentControlState
	migrated: boolean
}

/** Replaceable persistence seam used by the production file store and deterministic tests. */
export interface AgentControlPersistence {
	read(): Promise<unknown | undefined>
	write(state: AgentControlState): Promise<void>
	/**
	 * Optional exclusive transaction boundary for persistence shared by multiple
	 * store instances or processes. Implementations must hold the boundary for
	 * the complete read-modify-write operation. Persistence without this hook
	 * retains the store's in-process serialization semantics.
	 */
	withTransaction?<T>(operation: () => Promise<T>): Promise<T>
	/** Optional commit fence for implementations whose transaction lock can be stolen after staleness. */
	assertTransactionOwner?(): Promise<void>
	/** Optional activation-scoped lease seam used by cross-process persistence. */
	acquireOwnerLease?(
		ownerId: AgentRuntimeOwnerId,
		options: { staleMs: number; updateMs: number; onCompromised: (error: Error) => void },
	): Promise<void>
	isOwnerLeaseLive?(ownerId: AgentRuntimeOwnerId, staleMs: number): Promise<boolean>
	tryRevokeOwnerLease?(ownerId: AgentRuntimeOwnerId, staleMs: number): Promise<boolean>
	releaseOwnerLease?(ownerId: AgentRuntimeOwnerId): Promise<void>
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
	private readonly transactionLockPath: string
	private readonly ownerLeaseDirectory: string
	private readonly ownerLeaseReleases = new Map<AgentRuntimeOwnerId, () => Promise<void>>()
	private readonly releasedTransactionTokens = new Set<string>()
	private activeTransaction?: ActiveTransaction

	constructor(globalStoragePath: string) {
		this.filePath = path.join(globalStoragePath, GlobalFileNames.agentControl)
		// This deliberately matches the directory path used by the former
		// proper-lockfile transaction lease. A legacy live holder therefore blocks
		// admission instead of running concurrently with the process-owned lock.
		this.transactionLockPath = `${this.filePath}.transaction.lock`
		this.ownerLeaseDirectory = `${this.filePath}.owners`
	}

	async acquireOwnerLease(
		ownerId: AgentRuntimeOwnerId,
		options: { staleMs: number; updateMs: number; onCompromised: (error: Error) => void },
	): Promise<void> {
		if (this.ownerLeaseReleases.has(ownerId)) return
		await fs.mkdir(this.ownerLeaseDirectory, { recursive: true })
		const release = await lockfile.lock(this.ownerLeasePath(ownerId), {
			stale: options.staleMs,
			update: options.updateMs,
			realpath: false,
			retries: 0,
			onCompromised: (error) => {
				this.ownerLeaseReleases.delete(ownerId)
				options.onCompromised(error)
			},
		})
		this.ownerLeaseReleases.set(ownerId, release)
	}

	async isOwnerLeaseLive(ownerId: AgentRuntimeOwnerId, staleMs: number): Promise<boolean> {
		return lockfile.check(this.ownerLeasePath(ownerId), { stale: staleMs, realpath: false })
	}

	async tryRevokeOwnerLease(ownerId: AgentRuntimeOwnerId, staleMs: number): Promise<boolean> {
		let release: () => Promise<void>
		try {
			release = await lockfile.lock(this.ownerLeasePath(ownerId), {
				stale: staleMs,
				update: Math.max(1_000, Math.min(DEFAULT_OWNER_LEASE_UPDATE_MS, staleMs / 2)),
				realpath: false,
				retries: 0,
				onCompromised: () => undefined,
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED") return false
			throw error
		}
		await release()
		return true
	}

	async releaseOwnerLease(ownerId: AgentRuntimeOwnerId): Promise<void> {
		const release = this.ownerLeaseReleases.get(ownerId)
		if (!release) return
		this.ownerLeaseReleases.delete(ownerId)
		try {
			await release()
		} catch (error) {
			if (!new Set(["ENOENT", "ENOTACQUIRED", "ERELEASED"]).has((error as NodeJS.ErrnoException).code ?? "")) {
				throw error
			}
		}
	}

	private ownerLeasePath(ownerId: AgentRuntimeOwnerId): string {
		return path.join(this.ownerLeaseDirectory, ownerId)
	}

	async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
		const transaction: ActiveTransaction = { token: randomUUID(), committed: false }
		await this.acquireTransactionLock(transaction.token)
		this.activeTransaction = transaction
		let result: T
		let operationFailed = false
		let operationError: unknown
		try {
			result = await operation()
			// A real file write performs its final fence synchronously with the
			// atomic rename. Read-only/test transactions still validate ownership
			// before release.
			if (!transaction.committed) await this.assertTransactionOwner()
		} catch (error) {
			operationFailed = true
			operationError = error
		}
		let releaseFailed = false
		let releaseError: unknown
		try {
			await this.releaseTransactionLock(transaction.token)
		} catch (error) {
			releaseFailed = true
			releaseError = error
		}
		if (this.activeTransaction === transaction) {
			this.activeTransaction = undefined
		}
		// Preserve the mutation failure when both the operation and cleanup fail.
		if (operationFailed) throw operationError
		// Once the synchronous fenced rename committed, a later cleanup failure
		// must not turn a durable success into a rejected API call. The immutable
		// process-owned protocol prevents normal contenders from causing this;
		// surface cleanup failures only for transactions that did not commit.
		if (releaseFailed && !transaction.committed) throw releaseError
		if (releaseFailed) {
			console.error("[AgentControlStore] Failed to release a committed transaction lock", releaseError)
		}
		return result!
	}

	async assertTransactionOwner(): Promise<void> {
		const transaction = this.activeTransaction
		if (!transaction) throw new Error("Agent control transaction is not active")
		const observed = await this.readTransactionLock(this.transactionLockPath)
		if (observed?.token !== transaction.token) throw new Error("Agent control transaction ownership was lost")
	}

	private assertTransactionOwnerSync(): void {
		const transaction = this.activeTransaction
		if (!transaction) throw new Error("Agent control transaction is not active")
		let observed: TransactionLockOwner
		try {
			observed = this.parseTransactionLock(
				fsSync.readFileSync(this.transactionLockOwnerPath(this.transactionLockPath), "utf8"),
			)
		} catch (error) {
			throw new Error("Agent control transaction ownership was lost", { cause: error })
		}
		if (observed.token !== transaction.token) throw new Error("Agent control transaction ownership was lost")
	}

	private commitTransactionFile(temporaryPath: string, destinationPath: string): void {
		const transaction = this.activeTransaction
		if (!transaction) throw new Error("Agent control transaction is not active")
		this.assertTransactionOwnerSync()
		fsSync.renameSync(temporaryPath, destinationPath)
		transaction.committed = true
	}

	private async acquireTransactionLock(transactionToken: string): Promise<void> {
		await fs.mkdir(path.dirname(this.transactionLockPath), { recursive: true })
		const owner: TransactionLockOwner = { token: transactionToken, pid: process.pid }
		for (let attempt = 0; ; attempt++) {
			if (await this.tryCreateTransactionLock(owner)) return
			const observed = await this.observeTransactionLockForAcquisition()
			if (
				observed !== "legacy" &&
				observed &&
				(this.releasedTransactionTokens.has(observed.token) ||
					(await this.isTransactionLockMarkedReleased(this.transactionLockPath, observed.token)))
			) {
				if (await this.tryReapReleasedTransactionLock(observed)) {
					this.releasedTransactionTokens.delete(observed.token)
					continue
				}
			}
			if (
				observed !== "legacy" &&
				observed &&
				!this.isProcessLive(observed.pid) &&
				(await this.tryReapTransactionLock(observed))
			) {
				continue
			}
			const delayMs = TRANSACTION_LOCK_RETRY_DELAYS_MS[attempt]
			if (delayMs === undefined) {
				throw Object.assign(new Error("Agent control transaction lock is already held"), {
					code: "ELOCKED",
					file: this.transactionLockPath,
				})
			}
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
		}
	}

	private async observeTransactionLockForAcquisition(): Promise<TransactionLockOwner | "legacy" | undefined> {
		try {
			return await this.readTransactionLock(this.transactionLockPath)
		} catch (readError) {
			try {
				const lock = await fs.stat(this.transactionLockPath)
				if (lock.isDirectory()) {
					// Empty proper-lockfile transaction directories only existed in an
					// unlanded predecessor of this protocol. Never replace one: on POSIX
					// rename could otherwise claim an empty live legacy directory.
					return "legacy"
				}
			} catch {
				// Preserve the original parsing/read failure below.
			}
			throw readError
		}
	}

	private async tryCreateTransactionLock(owner: TransactionLockOwner): Promise<boolean> {
		try {
			await fs.stat(this.transactionLockPath)
			return false
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}

		const candidatePath = `${this.transactionLockPath}.candidate.${owner.token}`
		const candidateOwnerPath = this.transactionLockOwnerPath(candidatePath)
		let acquired = false
		try {
			await fs.mkdir(candidatePath)
			await fs.writeFile(candidateOwnerPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" })
			for (let attempt = 0; ; attempt++) {
				try {
					await this.renameTransactionLock(candidatePath, this.transactionLockPath)
					acquired = true
					return true
				} catch (error) {
					try {
						await fs.stat(this.transactionLockPath)
						return false
					} catch (statError) {
						if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError
					}

					const code = (error as NodeJS.ErrnoException).code ?? ""
					const delayMs = TRANSACTION_LOCK_PROMOTION_RETRY_DELAYS_MS[attempt]
					if (!TRANSIENT_TRANSACTION_LOCK_RENAME_ERROR_CODES.has(code) || delayMs === undefined) throw error

					// On Windows, a contender can make rename fail with EPERM and then
					// release the destination before the existence check completes. Keep
					// the immutable candidate and retry its atomic promotion.
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
			throw error
		} finally {
			if (!acquired) await this.removeTransactionLockDirectory(candidatePath, true)
		}
	}

	private async tryReapTransactionLock(observed: TransactionLockOwner): Promise<boolean> {
		const reapPath = `${this.transactionLockPath}.reap.${observed.token}`
		try {
			await fs.rename(this.transactionLockPath, reapPath)
		} catch (error) {
			try {
				// A permanent deterministic tombstone means a previous reaper already
				// moved this exact owner. It also prevents a delayed stale reaper from
				// renaming a newly acquired non-empty lock directory on any platform.
				await fs.stat(reapPath)
				return false
			} catch (reapStatError) {
				if ((reapStatError as NodeJS.ErrnoException).code !== "ENOENT") throw reapStatError
			}
			try {
				await fs.stat(this.transactionLockPath)
				throw error
			} catch (lockStatError) {
				if ((lockStatError as NodeJS.ErrnoException).code === "ENOENT") return true
				throw error
			}
		}

		const quarantined = await this.readTransactionLock(reapPath)
		if (!quarantined || quarantined.token !== observed.token || this.isProcessLive(quarantined.pid)) {
			throw new Error("Agent control transaction reaper quarantined an unexpected live owner")
		}
		// Keep the non-empty tombstone permanently. Removing it would allow a
		// delayed second reaper for the old token to capture a successor's lock.
		return true
	}

	private async releaseTransactionLock(transactionToken: string): Promise<void> {
		const observed = await this.readTransactionLock(this.transactionLockPath)
		if (!observed || observed.token !== transactionToken) return
		const releasePath = `${this.transactionLockPath}.release.${transactionToken}`
		for (let attempt = 0; ; attempt++) {
			try {
				await this.renameTransactionLock(this.transactionLockPath, releasePath)
				break
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? ""
				if (code === "ENOENT") return
				const delayMs = TRANSACTION_LOCK_RELEASE_RETRY_DELAYS_MS[attempt]
				if (!TRANSIENT_TRANSACTION_LOCK_RENAME_ERROR_CODES.has(code)) throw error
				if (delayMs === undefined) {
					// A committed write must remain successful, but the live owner may not
					// permanently block the next transaction. Publish a durable release
					// marker that any store instance can safely quarantine by exact token.
					this.releasedTransactionTokens.add(transactionToken)
					await this.markTransactionLockReleased(transactionToken)
					throw error
				}

				await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
				// A transient Windows file lock can clear between attempts. Recheck the
				// token so a delayed retry can never move a successor's lock.
				const current = await this.readTransactionLock(this.transactionLockPath)
				if (!current || current.token !== transactionToken) return
			}
		}
		await this.removeTransactionLockDirectory(releasePath, false)
	}

	private transactionLockReleasedMarkerPath(lockPath: string): string {
		return path.join(lockPath, "released")
	}

	private async markTransactionLockReleased(transactionToken: string): Promise<void> {
		const observed = await this.readTransactionLock(this.transactionLockPath)
		if (!observed || observed.token !== transactionToken) return
		const markerPath = this.transactionLockReleasedMarkerPath(this.transactionLockPath)
		try {
			await fs.writeFile(markerPath, transactionToken, { encoding: "utf8", flag: "wx" })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			const retainedToken = await fs.readFile(markerPath, "utf8")
			if (retainedToken !== transactionToken) {
				throw new Error("Agent control transaction release marker belongs to another owner")
			}
		}
	}

	private async isTransactionLockMarkedReleased(lockPath: string, transactionToken: string): Promise<boolean> {
		try {
			return (await fs.readFile(this.transactionLockReleasedMarkerPath(lockPath), "utf8")) === transactionToken
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
			throw error
		}
	}

	private async tryReapReleasedTransactionLock(observed: TransactionLockOwner): Promise<boolean> {
		const releasedPath = `${this.transactionLockPath}.released.${observed.token}`
		try {
			await this.renameTransactionLock(this.transactionLockPath, releasedPath)
		} catch (error) {
			try {
				// A permanent token-specific tombstone prevents a delayed releaser from
				// ever moving a successor's live lock.
				await fs.stat(releasedPath)
				return false
			} catch (releasedStatError) {
				if ((releasedStatError as NodeJS.ErrnoException).code !== "ENOENT") throw releasedStatError
			}
			try {
				await fs.stat(this.transactionLockPath)
				if (TRANSIENT_TRANSACTION_LOCK_RENAME_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
					return false
				}
				throw error
			} catch (lockStatError) {
				if ((lockStatError as NodeJS.ErrnoException).code === "ENOENT") return true
				throw error
			}
		}

		const quarantined = await this.readTransactionLock(releasedPath)
		const markedReleased = await this.isTransactionLockMarkedReleased(releasedPath, observed.token)
		if (!quarantined || quarantined.token !== observed.token || !markedReleased) {
			throw new Error("Agent control transaction releaser quarantined an unexpected owner")
		}
		// Keep the non-empty tombstone permanently for delayed-releaser safety.
		return true
	}

	private async renameTransactionLock(source: string, destination: string): Promise<void> {
		await fs.rename(source, destination)
	}

	private async readTransactionLock(lockPath: string): Promise<TransactionLockOwner | undefined> {
		try {
			return this.parseTransactionLock(await fs.readFile(this.transactionLockOwnerPath(lockPath), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				try {
					await fs.stat(lockPath)
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined
				}
			}
			throw error
		}
	}

	private transactionLockOwnerPath(lockPath: string): string {
		return path.join(lockPath, "owner.json")
	}

	private async removeTransactionLockDirectory(lockPath: string, ignoreMissing: boolean): Promise<void> {
		await fs.unlink(this.transactionLockOwnerPath(lockPath)).catch((error: NodeJS.ErrnoException) => {
			if (!ignoreMissing || error.code !== "ENOENT") throw error
		})
		await fs.rmdir(lockPath).catch((error: NodeJS.ErrnoException) => {
			if (!ignoreMissing || error.code !== "ENOENT") throw error
		})
	}

	private parseTransactionLock(serialized: string): TransactionLockOwner {
		const candidate = JSON.parse(serialized) as Partial<TransactionLockOwner>
		if (
			typeof candidate.token !== "string" ||
			!candidate.token ||
			!Number.isInteger(candidate.pid) ||
			candidate.pid! <= 0
		) {
			throw new Error("Agent control transaction lock metadata is invalid")
		}
		return { token: candidate.token, pid: candidate.pid! }
	}

	private isProcessLive(pid: number): boolean {
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ESRCH") return false
			if (code === "EPERM") return true
			throw error
		}
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
		await safeWriteJson(this.filePath, state, {
			prettyPrint: true,
			...(this.activeTransaction
				? {
						atomicReplace: true,
						commitTempFile: (source, destination) => this.commitTransactionFile(source, destination),
					}
				: {}),
		})
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
	/** Ephemeral command text retained for diagnostics, never used to infer verification scope. */
	command?: string
	/** Applied Worker change sets this command explicitly verifies. */
	verificationChangeSetIds?: readonly string[]
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

export type AgentMailboxClaimChannel = "wait" | "automatic"
type AgentMailboxClaimDisposition = "acknowledge" | "release"

export interface ClaimAgentMailboxOptions {
	rootTaskId?: string
	afterSequence?: number
	limit?: number
	kinds?: AgentMailboxKind[]
	payloadTaskIds?: string[]
	channel: AgentMailboxClaimChannel
	claimId?: string
}

export interface AgentMailboxClaim {
	claimId: string
	channel: AgentMailboxClaimChannel
	entries: AgentMailboxEntry[]
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

interface PendingMailboxClaimSettlement {
	claimId: string
	recipientTaskId: string
	rootTaskId: string
	disposition: AgentMailboxClaimDisposition
}

type AgentControlOwnerLeasePersistence = AgentControlPersistence &
	Required<
		Pick<
			AgentControlPersistence,
			"withTransaction" | "acquireOwnerLease" | "isOwnerLeaseLive" | "tryRevokeOwnerLease" | "releaseOwnerLease"
		>
	>

export interface AgentControlStoreOptions {
	ownerId?: string
	ownerLeaseStaleMs?: number
	ownerLeaseUpdateMs?: number
	/** Zero disables periodic stale-owner recovery. Lease heartbeats remain active. */
	recoveryScanIntervalMs?: number
}

const hasOwnerLeasePersistence = (
	persistence: AgentControlPersistence,
): persistence is AgentControlOwnerLeasePersistence =>
	Boolean(
		persistence.withTransaction &&
			persistence.acquireOwnerLease &&
			persistence.isOwnerLeaseLive &&
			persistence.tryRevokeOwnerLease &&
			persistence.releaseOwnerLease,
	)

/**
 * Durable source of truth for agent identity, tree state, and parent/child mailboxes.
 *
 * Canonical paths are unique within a root task. Mutations are serialized and the
 * complete versioned snapshot is atomically replaced after each successful write.
 */
export class AgentControlStore {
	private static readonly globalStores = new Map<string, AgentControlStore>()
	private static runtimeOwnerId = agentRuntimeOwnerIdSchema.parse(randomUUID())
	private state: AgentControlState
	private initialized = false
	private disposed = false
	private initialization?: Promise<void>
	private writeLock: Promise<void> = Promise.resolve()
	private readonly listeners = new Set<AgentMailboxListener>()
	private readonly pendingMailboxClaimSettlements = new Map<string, PendingMailboxClaimSettlement>()
	private readonly runtimeOwnerId: AgentRuntimeOwnerId
	private readonly ownerLeaseStaleMs: number
	private readonly ownerLeaseUpdateMs: number
	private readonly recoveryScanIntervalMs: number
	private ownerLeaseHeld = false
	private ownerLeaseCompromisedError?: Error
	private recoveryScanTimer?: ReturnType<typeof setInterval>
	private recoveryScanInFlight?: Promise<void>

	constructor(
		private readonly persistence: AgentControlPersistence,
		private readonly now: () => number = Date.now,
		options: AgentControlStoreOptions = {},
	) {
		this.state = initialState(this.now())
		this.runtimeOwnerId = agentRuntimeOwnerIdSchema.parse(options.ownerId ?? randomUUID())
		this.ownerLeaseStaleMs = options.ownerLeaseStaleMs ?? DEFAULT_OWNER_LEASE_STALE_MS
		this.ownerLeaseUpdateMs = options.ownerLeaseUpdateMs ?? DEFAULT_OWNER_LEASE_UPDATE_MS
		this.recoveryScanIntervalMs = options.recoveryScanIntervalMs ?? 0
		if (!Number.isFinite(this.ownerLeaseStaleMs) || this.ownerLeaseStaleMs < 2_000) {
			throw new Error("Agent owner lease stale interval must be at least 2,000ms")
		}
		if (
			!Number.isFinite(this.ownerLeaseUpdateMs) ||
			this.ownerLeaseUpdateMs < 1_000 ||
			this.ownerLeaseUpdateMs > this.ownerLeaseStaleMs / 2
		) {
			throw new Error("Agent owner lease update interval must be between 1,000ms and half the stale interval")
		}
		if (!Number.isFinite(this.recoveryScanIntervalMs) || this.recoveryScanIntervalMs < 0) {
			throw new Error("Agent owner recovery scan interval must be non-negative")
		}
	}

	static forGlobalStorage(globalStoragePath: string, now?: () => number): AgentControlStore {
		const key = path.resolve(globalStoragePath)
		let store = this.globalStores.get(key)
		if (!store) {
			store = new AgentControlStore(new FileAgentControlPersistence(key), now, {
				ownerId: this.runtimeOwnerId,
				recoveryScanIntervalMs: DEFAULT_RECOVERY_SCAN_INTERVAL_MS,
			})
			this.globalStores.set(key, store)
		}
		return store
	}

	static async shutdownGlobalStores(): Promise<void> {
		const stores = [...this.globalStores.values()]
		const results = await Promise.allSettled(stores.map((store) => store.shutdown()))
		this.globalStores.clear()
		this.runtimeOwnerId = agentRuntimeOwnerIdSchema.parse(randomUUID())
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map(({ reason }) => reason),
				"Failed to shut down one or more agent control stores",
			)
		}
	}

	/** Load persisted state and convert abandoned active runs to interrupted exactly once. */
	async initialize(): Promise<void> {
		if (this.disposed) throw new Error("AgentControlStore cannot be reinitialized after shutdown")
		if (this.initialized) return
		if (this.initialization) return this.initialization

		const initialization = this.withWriteLock(async () => {
			if (this.disposed) throw new Error("AgentControlStore cannot be reinitialized after shutdown")
			if (this.initialized) {
				return
			}

			const acquiredOwnerLease = await this.acquireOwnerLease()
			try {
				let loadedState!: AgentControlState
				let recoveredEvents: AgentMailboxEntry[] = []
				await this.withPersistenceTransaction(async () => {
					await this.assertCurrentOwnerLease()
					const persisted = await this.readPersistedState()
					const draft = persisted.state

					const recoveredAt = this.now()
					const recovery = await this.recoverAbandonedState(draft, recoveredAt)

					if (recovery.changed || persisted.migrated) {
						draft.updatedAt = recoveredAt
						agentControlStateSchema.parse(draft)
						await this.assertCurrentOwnerLease()
						await this.assertPersistenceTransaction()
						await this.persistence.write(draft)
					}

					loadedState = draft
					recoveredEvents = recovery.events
				})
				this.state = loadedState
				this.initialized = true
				this.publish(recoveredEvents)
			} catch (error) {
				if (acquiredOwnerLease) await this.releaseOwnerLease()
				throw error
			}
		})
		this.initialization = initialization
		try {
			await initialization
			this.startRecoveryScan()
		} finally {
			if (this.initialization === initialization) this.initialization = undefined
		}
	}

	async flush(): Promise<void> {
		await this.writeLock
	}

	/** Release this extension-host activation's lease without touching retained records. */
	async shutdown(): Promise<void> {
		this.disposed = true
		this.stopRecoveryScan()
		await this.recoveryScanInFlight?.catch(() => undefined)
		await this.initialization?.catch(() => undefined)
		// Initialization starts the scan after its transaction completes. Stop it
		// again in case shutdown raced an in-flight initialization.
		this.stopRecoveryScan()
		await this.withWriteLock(async () => {
			await this.releaseOwnerLease()
			this.initialized = false
		})
	}

	/** Reap active records only after their previous runtime owner's lease is revoked. */
	async recoverAbandonedOwners(): Promise<number> {
		this.assertInitialized()
		if (!this.hasOwnerLeases()) return 0
		return this.withWriteLock(async () => {
			let recoveredState!: AgentControlState
			let recoveredEvents: AgentMailboxEntry[] = []
			let recoveredRecordCount = 0
			await this.withPersistenceTransaction(async () => {
				await this.assertCurrentOwnerLease()
				const persisted = await this.readPersistedState()
				const draft = persisted.state
				const recoveredAt = this.now()
				const recovery = await this.recoverAbandonedState(draft, recoveredAt)
				if (recovery.changed || persisted.migrated) {
					draft.updatedAt = recoveredAt
					agentControlStateSchema.parse(draft)
					await this.assertCurrentOwnerLease()
					await this.assertPersistenceTransaction()
					await this.persistence.write(draft)
				}
				recoveredState = draft
				recoveredEvents = recovery.events
				recoveredRecordCount = recovery.recordCount
			})
			this.state = recoveredState
			this.publish(recoveredEvents)
			return recoveredRecordCount
		})
	}

	getSnapshot(): AgentControlState {
		this.assertInitialized()
		return clone(this.state)
	}

	/**
	 * Permanently remove one managed-agent tree after its owning root task is
	 * explicitly deleted. No time-based pruning is used because retained mailbox
	 * and verification records remain audit evidence while task history exists.
	 */
	async purgeRoot(rootTaskId: string): Promise<boolean> {
		this.assertInitialized()
		if (!rootTaskId.trim()) throw new Error("A root task ID is required")
		const cursorKeyPrefix = `${rootTaskId}:`
		const hasRetainedState = (state: AgentControlState) =>
			state.agents.some((record) => record.rootTaskId === rootTaskId) ||
			state.tombstones.some((record) => record.rootTaskId === rootTaskId) ||
			state.mailbox.some((entry) => entry.rootTaskId === rootTaskId) ||
			Object.keys(state.mailboxCursors).some((key) => key.startsWith(cursorKeyPrefix)) ||
			state.verificationObligations.some((obligation) => obligation.rootTaskId === rootTaskId)

		// Preserve the existing no-write fast path for in-process persistence.
		// File-backed persistence must inspect durable state while holding its
		// cross-process transaction boundary.
		if (!this.persistence.withTransaction && !hasRetainedState(this.state)) return false

		const purged = await this.transact((draft) => {
			if (!hasRetainedState(draft)) return false
			for (const record of draft.agents) {
				if (record.rootTaskId === rootTaskId && ACTIVE_STATUSES.has(record.status)) {
					this.assertRecordOwned(draft, record, "purge its root")
				}
			}
			draft.agents = draft.agents.filter((record) => record.rootTaskId !== rootTaskId)
			draft.tombstones = draft.tombstones.filter((record) => record.rootTaskId !== rootTaskId)
			draft.mailbox = draft.mailbox.filter((entry) => entry.rootTaskId !== rootTaskId)
			draft.mailboxCursors = Object.fromEntries(
				Object.entries(draft.mailboxCursors).filter(([key]) => !key.startsWith(cursorKeyPrefix)),
			)
			draft.verificationObligations = draft.verificationObligations.filter(
				(obligation) => obligation.rootTaskId !== rootTaskId,
			)
			return true
		})
		if (purged) {
			for (const [claimId, settlement] of this.pendingMailboxClaimSettlements) {
				if (settlement.rootTaskId === rootTaskId) this.pendingMailboxClaimSettlements.delete(claimId)
			}
		}
		return purged
	}

	/** Register the primary parent even when it is not managed as a subagent run. */
	async ensureRoot(input: EnsureRootInput): Promise<AgentRecord> {
		return this.transact((draft) => {
			const existing = draft.agents.find((record) => record.taskId === input.taskId)
			if (existing) {
				if (existing.role !== "root" || existing.rootTaskId !== input.taskId || existing.path !== "/root") {
					throw new Error(`Task ${input.taskId} is already registered as a non-root agent`)
				}
				this.assertRecordOwned(draft, existing, "operate this root task")
				this.claimRecordOwnership(existing)
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
				...(this.hasOwnerLeases() && ACTIVE_STATUSES.has(status)
					? { runtimeOwnerId: this.runtimeOwnerId }
					: {}),
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
			this.assertRecordOwned(draft, parent, "create a child")
			this.claimRecordOwnership(parent)

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
				...(this.hasOwnerLeases() && ACTIVE_STATUSES.has(status)
					? { runtimeOwnerId: this.runtimeOwnerId }
					: {}),
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
			return clone(this.applyAgentStatusTransition(draft, target, status, input, rootTaskId))
		})
	}

	/** Commit a lifecycle transition and its parent mailbox event in one durable transaction. */
	async updateAgentStatusAndAppendEvent(
		target: string,
		status: AgentLifecycleStatus,
		input: UpdateAgentStatusInput,
		eventInput: AppendAgentMailboxEventInput,
		rootTaskId?: string,
	): Promise<{ record: AgentRecord; event: AgentMailboxEntry; appended: boolean }> {
		return this.transact((draft) => {
			const record = this.applyAgentStatusTransition(draft, target, status, input, rootTaskId)
			if (eventInput.eventId) {
				const existing = draft.mailbox.find((entry) => entry.eventId === eventInput.eventId)
				if (existing) {
					this.assertIdempotentEvent(existing, eventInput)
					return { record: clone(record), event: clone(existing), appended: false }
				}
			}

			const recipient = this.requireOpenAddress(draft, eventInput.recipient, eventInput.rootTaskId)
			const sender = eventInput.sender
				? this.requireOwnedAddress(draft, eventInput.sender, recipient.rootTaskId, "publish an event")
				: undefined
			if (!sender) this.assertTreeOwned(draft, recipient.rootTaskId, "publish an event")
			const event: AgentMailboxEntry = {
				eventId: eventInput.eventId ?? randomUUID(),
				sequence: draft.nextSequence++,
				rootTaskId: recipient.rootTaskId,
				senderTaskId: sender?.taskId,
				senderPath: sender?.path,
				recipientTaskId: recipient.taskId,
				recipientPath: recipient.path,
				kind: eventInput.kind,
				name: eventInput.name,
				payload: eventInput.payload ? clone(eventInput.payload) : undefined,
				createdAt: eventInput.createdAt ?? this.now(),
			}
			draft.mailbox.push(event)
			return { record: clone(record), event: clone(event), appended: true }
		})
	}

	private applyAgentStatusTransition(
		draft: AgentControlState,
		target: string,
		status: AgentLifecycleStatus,
		input: UpdateAgentStatusInput,
		rootTaskId?: string,
	): AgentRecord {
		const record = this.requireMutableRecord(draft, target, rootTaskId)
		this.assertRecordOwned(draft, record, "update its lifecycle")
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
		this.claimRecordOwnership(record)
		record.updatedAt = timestamp
		if (input.snapshot) record.snapshot = clone(input.snapshot)
		if (ACTIVE_STATUSES.has(status) && record.snapshot) {
			delete record.snapshot.stopReason
			if (Object.keys(record.snapshot).length === 0) delete record.snapshot
		}
		if (status === "running") record.startedAt ??= timestamp
		if (status === "interrupted") record.interruptedAt = timestamp
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
		return record
	}

	async updateAgentSnapshot(
		target: string,
		snapshot: AgentRuntimeSnapshot,
		rootTaskId?: string,
	): Promise<AgentRecord> {
		return this.transact((draft) => {
			const record = this.requireMutableRecord(draft, target, rootTaskId)
			this.assertRecordOwned(draft, record, "update its runtime snapshot")
			this.claimRecordOwnership(record)
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
		if (!this.persistence.withTransaction) {
			const before = this.state.verificationObligations.find((item) => item.id === obligationId)
			const wouldChange = !before || this.changeSetWouldAdvance(before, input)
			if (!wouldChange) return { obligation: clone(before), changed: false, previousStatus: before.status }
		}

		return this.transact((draft) => {
			this.assertParentMutationOwned(
				draft,
				input.parentTaskId,
				input.rootTaskId,
				"record Worker verification state",
			)
			const timestamp = input.at ?? this.now()
			let obligation = draft.verificationObligations.find((item) => item.id === obligationId)
			if (obligation && !this.changeSetWouldAdvance(obligation, input)) {
				return { obligation: clone(obligation), changed: false, previousStatus: obligation.status }
			}
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

	/** Persist explicitly scoped terminal parent-command evidence against applied obligations. */
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

		if (!this.persistence.withTransaction) {
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
					item.verification?.executionId !== selected.evidence.executionId ||
					item.verification.status !== status
				)
			})
			if (!wouldChange) return []
		}

		return this.transact((draft) => {
			this.assertParentMutationOwned(draft, parentTaskId, rootTaskId, "record parent verification evidence")
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
						? "An explicitly scoped parent verification command completed successfully after application."
						: "The latest explicitly scoped parent verification command did not complete successfully."
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
			this.assertRecordOwned(draft, record, "close it")
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
			if (!item.verificationChangeSetIds?.includes(obligation.changeSetId)) return []
			return [{ evidence: item, matchedFiles: [...obligation.changedFiles] }]
		})
		if (relevant.length === 0) return undefined
		return relevant.find((item) => item.evidence.status === "succeeded") ?? relevant.at(-1)
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
			const sender = input.sender
				? this.requireOwnedAddress(draft, input.sender, recipient.rootTaskId, "publish an event")
				: undefined
			if (!sender) this.assertTreeOwned(draft, recipient.rootTaskId, "publish an event")
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
			.filter(
				(entry) =>
					options.includeDelivered !== false ||
					(entry.deliveredAt === undefined && entry.claimId === undefined),
			)
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

	/**
	 * Claim unread mailbox entries transactionally. A claim is durable ownership:
	 * no competing consumer can select the same entries before ACK or release.
	 */
	async claimMailbox(recipient: string, options: ClaimAgentMailboxOptions): Promise<AgentMailboxClaim> {
		const claimId = options.claimId?.trim() || randomUUID()
		const claimedAt = this.now()
		return this.transact((draft) => {
			const address = this.requireOwnedAddress(draft, recipient, options.rootTaskId, "claim its mailbox")
			const existing = draft.mailbox.filter((entry) => entry.claimId === claimId)
			if (existing.length > 0) {
				if (
					existing.some(
						(entry) =>
							entry.rootTaskId !== address.rootTaskId ||
							entry.recipientTaskId !== address.taskId ||
							entry.claimChannel !== options.channel ||
							(this.hasOwnerLeases() &&
								entry.claimOwnerId !== undefined &&
								entry.claimOwnerId !== this.runtimeOwnerId),
					)
				) {
					throw new Error(`Mailbox claim ID ${claimId} was reused with different ownership`)
				}
				if (this.hasOwnerLeases()) {
					for (const entry of existing) {
						if (entry.acknowledgedAt === undefined) entry.claimOwnerId ??= this.runtimeOwnerId
					}
				}
				return {
					claimId,
					channel: options.channel,
					entries: existing.filter((entry) => entry.acknowledgedAt === undefined).map(clone),
				}
			}

			const afterSequence = options.afterSequence ?? 0
			if (!Number.isInteger(afterSequence) || afterSequence < 0) {
				throw new Error("Mailbox sequence must be a non-negative integer")
			}
			const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
			const kinds = options.kinds ? new Set(options.kinds) : undefined
			const payloadTaskIds = options.payloadTaskIds ? new Set(options.payloadTaskIds) : undefined
			const entries = draft.mailbox
				.filter((entry) => entry.rootTaskId === address.rootTaskId && entry.recipientTaskId === address.taskId)
				.filter((entry) => entry.sequence > afterSequence)
				.filter((entry) => entry.acknowledgedAt === undefined && entry.claimId === undefined)
				.filter((entry) => !kinds || kinds.has(entry.kind))
				.filter(
					(entry) =>
						!payloadTaskIds ||
						(typeof entry.payload?.taskId === "string" && payloadTaskIds.has(entry.payload.taskId)),
				)
				.sort((left, right) => left.sequence - right.sequence)
				.slice(0, limit)
			for (const entry of entries) {
				entry.claimId = claimId
				entry.claimedAt = claimedAt
				entry.claimChannel = options.channel
				if (this.hasOwnerLeases()) entry.claimOwnerId = this.runtimeOwnerId
			}

			return { claimId, channel: options.channel, entries: entries.map(clone) }
		})
	}

	/** Commit a claim after its entries have been handed to the owning consumer. */
	async acknowledgeMailboxClaim(
		recipient: string,
		claimId: string,
		rootTaskId?: string,
		acknowledgedAt = this.now(),
	): Promise<AgentMailboxCursor> {
		return this.transact((draft) => {
			const address = this.requireOwnedAddress(draft, recipient, rootTaskId, "acknowledge its mailbox")
			const claimedEntries = draft.mailbox.filter((entry) => entry.claimId === claimId)
			if (claimedEntries.length === 0) throw new Error(`Unknown mailbox claim: ${claimId}`)
			if (
				claimedEntries.some(
					(entry) =>
						entry.rootTaskId !== address.rootTaskId ||
						entry.recipientTaskId !== address.taskId ||
						(entry.claimOwnerId !== undefined && entry.claimOwnerId !== this.runtimeOwnerId),
				)
			) {
				throw new Error(`Mailbox claim ${claimId} belongs to a different recipient`)
			}
			for (const entry of claimedEntries) {
				entry.deliveredAt ??= acknowledgedAt
				entry.acknowledgedAt ??= acknowledgedAt
			}

			const recipientEntries = draft.mailbox
				.filter((entry) => entry.rootTaskId === address.rootTaskId && entry.recipientTaskId === address.taskId)
				.sort((left, right) => left.sequence - right.sequence)
			let lastDeliveredSequence = 0
			let lastAcknowledgedSequence = 0
			for (const entry of recipientEntries) {
				if (entry.deliveredAt === undefined) break
				lastDeliveredSequence = entry.sequence
			}
			for (const entry of recipientEntries) {
				if (entry.acknowledgedAt === undefined) break
				lastAcknowledgedSequence = entry.sequence
			}
			const cursor: AgentMailboxCursor = {
				...this.cursorFor(draft, address),
				lastDeliveredSequence,
				lastAcknowledgedSequence,
				updatedAt: acknowledgedAt,
			}
			draft.mailboxCursors[this.cursorKey(address)] = cursor
			return clone(cursor)
		})
	}

	/** Release an unfinished claim so another consumer may retry it. */
	async releaseMailboxClaim(recipient: string, claimId: string, rootTaskId?: string): Promise<number> {
		return this.transact((draft) => {
			const address = this.requireOwnedAddress(draft, recipient, rootTaskId, "release its mailbox claim")
			const claimedEntries = draft.mailbox.filter((entry) => entry.claimId === claimId)
			if (
				claimedEntries.some(
					(entry) =>
						entry.rootTaskId !== address.rootTaskId ||
						entry.recipientTaskId !== address.taskId ||
						(entry.claimOwnerId !== undefined && entry.claimOwnerId !== this.runtimeOwnerId),
				)
			) {
				throw new Error(`Mailbox claim ${claimId} belongs to a different recipient`)
			}
			let released = 0
			for (const entry of claimedEntries) {
				if (entry.acknowledgedAt !== undefined) continue
				delete entry.claimId
				delete entry.claimedAt
				delete entry.claimChannel
				delete entry.claimOwnerId
				released++
			}
			return released
		})
	}

	/**
	 * Remember a mailbox-claim settlement until its durable write succeeds.
	 * The store outlives individual Task instances, so a same-host task replacement
	 * can finish an ACK or release without changing its exact-once disposition.
	 */
	async settleMailboxClaim(
		recipient: string,
		claimId: string,
		disposition: AgentMailboxClaimDisposition,
		rootTaskId?: string,
	): Promise<void> {
		this.assertInitialized()
		const normalizedClaimId = claimId.trim()
		if (!normalizedClaimId) throw new Error("A mailbox claim ID is required")
		const address = this.persistence.withTransaction
			? await this.transact((draft) =>
					clone(this.requireOwnedAddress(draft, recipient, rootTaskId, "settle its mailbox claim")),
				)
			: this.requireAddress(this.state, recipient, rootTaskId)
		const settlement: PendingMailboxClaimSettlement = {
			claimId: normalizedClaimId,
			recipientTaskId: address.taskId,
			rootTaskId: address.rootTaskId,
			disposition,
		}
		const pending = this.pendingMailboxClaimSettlements.get(normalizedClaimId)
		if (
			pending &&
			(pending.recipientTaskId !== settlement.recipientTaskId ||
				pending.rootTaskId !== settlement.rootTaskId ||
				pending.disposition !== settlement.disposition)
		) {
			throw new Error(`Mailbox claim ${normalizedClaimId} already has a different pending settlement`)
		}
		this.pendingMailboxClaimSettlements.set(normalizedClaimId, settlement)

		if (disposition === "acknowledge") {
			await this.acknowledgeMailboxClaim(address.taskId, normalizedClaimId, address.rootTaskId)
		} else {
			await this.releaseMailboxClaim(address.taskId, normalizedClaimId, address.rootTaskId)
		}
		if (this.pendingMailboxClaimSettlements.get(normalizedClaimId) === settlement) {
			this.pendingMailboxClaimSettlements.delete(normalizedClaimId)
		}
	}

	/** Retry same-host claim settlements retained across Task replacement. */
	async retryPendingMailboxClaimSettlements(recipient: string, rootTaskId?: string): Promise<number> {
		const pending = [...this.pendingMailboxClaimSettlements.values()].filter(
			(settlement) =>
				settlement.recipientTaskId === recipient &&
				(rootTaskId === undefined || settlement.rootTaskId === rootTaskId),
		)
		if (pending.length === 0) return 0
		this.assertInitialized()
		for (const settlement of pending) {
			await this.settleMailboxClaim(
				settlement.recipientTaskId,
				settlement.claimId,
				settlement.disposition,
				settlement.rootTaskId,
			)
		}
		return pending.length
	}

	getUnacknowledgedMailboxEntries(
		recipient: string,
		options: Pick<ReadAgentMailboxOptions, "rootTaskId" | "kinds"> = {},
	): AgentMailboxEntry[] {
		this.assertInitialized()
		const address = this.requireAddress(this.state, recipient, options.rootTaskId)
		const kinds = options.kinds ? new Set(options.kinds) : undefined
		return this.state.mailbox
			.filter(
				(entry) =>
					entry.rootTaskId === address.rootTaskId &&
					entry.recipientTaskId === address.taskId &&
					entry.acknowledgedAt === undefined &&
					(!kinds || kinds.has(entry.kind)),
			)
			.sort((left, right) => left.sequence - right.sequence)
			.map(clone)
	}

	/** Read only the bounded metadata window needed by the managed-tree UI. */
	getRecentRootMailboxEntries(
		rootTaskId: string,
		limit: number,
	): { entries: AgentMailboxEntry[]; totalCount: number } {
		this.assertInitialized()
		if (!rootTaskId.trim()) throw new Error("A root task ID is required")
		if (!Number.isInteger(limit) || limit < 0 || limit > 1_000) {
			throw new Error("Mailbox activity limit must be an integer between 0 and 1,000")
		}

		let totalCount = 0
		const entries: AgentMailboxEntry[] = []
		for (let index = this.state.mailbox.length - 1; index >= 0; index--) {
			const entry = this.state.mailbox[index]
			if (entry.rootTaskId !== rootTaskId) continue
			totalCount++
			if (entries.length < limit) entries.push(clone(entry))
		}
		entries.sort((left, right) => right.sequence - left.sequence)
		return { entries, totalCount }
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
			const address = this.requireOwnedAddress(
				draft,
				recipient,
				rootTaskId,
				acknowledge ? "acknowledge its mailbox" : "mark its mailbox delivered",
			)
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
			let committedState!: AgentControlState
			let publishedEntries: AgentMailboxEntry[] = []
			let value!: T
			await this.withPersistenceTransaction(async () => {
				await this.assertCurrentOwnerLease()
				const reloadDurableState = this.persistence.withTransaction !== undefined
				const persisted = reloadDurableState ? await this.readPersistedState() : undefined
				const base = persisted?.state ?? this.state
				const draft = clone(base)
				const previousMailboxLength = draft.mailbox.length
				value = mutate(draft)

				// A file transaction may have refreshed state while finding the
				// requested mutation already applied. Refresh the local projection but
				// avoid rewriting an identical complete snapshot.
				if (reloadDurableState && !persisted?.migrated && isDeepStrictEqual(draft, base)) {
					committedState = base
					return
				}

				draft.updatedAt = this.now()
				agentControlStateSchema.parse(draft)
				await this.assertCurrentOwnerLease()
				await this.assertPersistenceTransaction()
				await this.persistence.write(draft)
				committedState = draft
				publishedEntries = draft.mailbox.slice(previousMailboxLength)
			})
			this.state = committedState
			this.publish(publishedEntries)
			return value
		})
	}

	private ownerLeasePersistence(): AgentControlOwnerLeasePersistence | undefined {
		return hasOwnerLeasePersistence(this.persistence) ? this.persistence : undefined
	}

	private hasOwnerLeases(): boolean {
		return this.ownerLeasePersistence() !== undefined
	}

	private async acquireOwnerLease(): Promise<boolean> {
		const persistence = this.ownerLeasePersistence()
		if (!persistence || this.ownerLeaseHeld) return false
		this.ownerLeaseCompromisedError = undefined
		await persistence.acquireOwnerLease(this.runtimeOwnerId, {
			staleMs: this.ownerLeaseStaleMs,
			updateMs: this.ownerLeaseUpdateMs,
			onCompromised: (error) => {
				this.ownerLeaseHeld = false
				this.ownerLeaseCompromisedError = error
				console.error(`[AgentControlStore] Runtime owner lease ${this.runtimeOwnerId} was compromised`, error)
			},
		})
		this.ownerLeaseHeld = true
		return true
	}

	private async releaseOwnerLease(): Promise<void> {
		const persistence = this.ownerLeasePersistence()
		if (!persistence) return
		this.ownerLeaseHeld = false
		await persistence.releaseOwnerLease(this.runtimeOwnerId)
	}

	private async assertCurrentOwnerLease(): Promise<void> {
		const persistence = this.ownerLeasePersistence()
		if (!persistence) return
		if (this.ownerLeaseCompromisedError) {
			throw new Error(`Agent runtime owner lease ${this.runtimeOwnerId} was compromised`, {
				cause: this.ownerLeaseCompromisedError,
			})
		}
		if (!this.ownerLeaseHeld) throw new Error(`Agent runtime owner lease ${this.runtimeOwnerId} is not held`)
		if (!(await persistence.isOwnerLeaseLive(this.runtimeOwnerId, this.ownerLeaseStaleMs))) {
			await this.releaseOwnerLease()
			throw new Error(`Agent runtime owner lease ${this.runtimeOwnerId} expired`)
		}
	}

	private async resolveLiveOwnerIds(draft: AgentControlState): Promise<Set<AgentRuntimeOwnerId>> {
		const persistence = this.ownerLeasePersistence()
		if (!persistence) return new Set()
		const ownerIds = new Set<AgentRuntimeOwnerId>()
		for (const record of draft.agents) {
			if (ACTIVE_STATUSES.has(record.status) && record.runtimeOwnerId) ownerIds.add(record.runtimeOwnerId)
		}
		for (const entry of draft.mailbox) {
			if (entry.claimId && entry.acknowledgedAt === undefined && entry.claimOwnerId) {
				ownerIds.add(entry.claimOwnerId)
			}
		}

		const liveOwnerIds = new Set<AgentRuntimeOwnerId>()
		for (const ownerId of ownerIds) {
			const live = await persistence.isOwnerLeaseLive(ownerId, this.ownerLeaseStaleMs)
			if (live) {
				liveOwnerIds.add(ownerId)
				continue
			}
			// Acquiring a stale owner's lock while the state transaction is held
			// is the fencing step: a concurrent renewal wins with ELOCKED; a
			// successful acquire/release compromises the suspended old handle.
			const revoked = await persistence.tryRevokeOwnerLease(ownerId, this.ownerLeaseStaleMs)
			if (!revoked) liveOwnerIds.add(ownerId)
		}
		return liveOwnerIds
	}

	private async recoverAbandonedState(
		draft: AgentControlState,
		recoveredAt: number,
	): Promise<{ changed: boolean; recordCount: number; events: AgentMailboxEntry[] }> {
		const events: AgentMailboxEntry[] = []
		let recordCount = 0
		let claimCount = 0
		let inactiveOwnerCount = 0
		const liveOwnerIds = await this.resolveLiveOwnerIds(draft)
		for (const entry of draft.mailbox) {
			if (!entry.claimId || entry.acknowledgedAt !== undefined) continue
			if (entry.claimOwnerId && liveOwnerIds.has(entry.claimOwnerId)) continue
			if (entry.claimChannel === "wait") {
				// Preserve the receipt for API-history reconciliation, but do not
				// assign it to an unrelated periodic reaper. The eventual recipient
				// owner may settle an unowned retained claim.
				if (entry.claimOwnerId !== undefined) {
					delete entry.claimOwnerId
					claimCount++
				}
				continue
			}
			delete entry.claimId
			delete entry.claimedAt
			delete entry.claimChannel
			delete entry.claimOwnerId
			claimCount++
		}

		for (const record of draft.agents) {
			if (!ACTIVE_STATUSES.has(record.status)) {
				if (this.hasOwnerLeases() && record.runtimeOwnerId !== undefined) {
					delete record.runtimeOwnerId
					inactiveOwnerCount++
				}
				continue
			}
			if (record.runtimeOwnerId && liveOwnerIds.has(record.runtimeOwnerId)) continue

			const previousStatus = record.status
			const previousUpdatedAt = record.updatedAt
			const previousOwnerId = record.runtimeOwnerId
			record.status = "interrupted"
			record.updatedAt = recoveredAt
			record.interruptedAt = recoveredAt
			if (this.hasOwnerLeases()) delete record.runtimeOwnerId
			recordCount++

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
			if (!recoveryRecipient) continue

			const eventId = `agent-recovery:${record.rootTaskId}:${record.taskId}:${previousOwnerId ?? "legacy"}:${previousStatus}:${previousUpdatedAt}`
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
				events.push(entry)
			}

			const resultEventId = `agent-recovery-result:${record.rootTaskId}:${record.taskId}:${previousOwnerId ?? "legacy"}:${previousStatus}:${previousUpdatedAt}`
			if (!draft.mailbox.some((entry) => entry.eventId === resultEventId)) {
				const entry: AgentMailboxEntry = {
					eventId: resultEventId,
					sequence: draft.nextSequence++,
					rootTaskId: record.rootTaskId,
					senderTaskId: record.taskId,
					senderPath: record.path,
					recipientTaskId: recoveryRecipient.taskId,
					recipientPath: recoveryRecipient.path,
					kind: "result",
					name: "agent_interrupted",
					payload: {
						taskId: record.taskId,
						path: record.path,
						...(record.groupId ? { groupId: record.groupId } : {}),
						status: "interrupted",
						summary:
							stopReason === "orphaned"
								? "The sub-agent was orphaned because its parent was unavailable during recovery."
								: "The extension reloaded before this sub-agent finished.",
						stopReason,
						previousStatus,
					},
					createdAt: recoveredAt,
				}
				draft.mailbox.push(entry)
				events.push(entry)
			}
		}

		return { changed: recordCount > 0 || claimCount > 0 || inactiveOwnerCount > 0, recordCount, events }
	}

	private startRecoveryScan(): void {
		if (!this.hasOwnerLeases() || this.recoveryScanIntervalMs <= 0 || this.recoveryScanTimer) return
		this.recoveryScanTimer = setInterval(() => {
			if (this.recoveryScanInFlight) return
			const scan = this.recoverAbandonedOwners().then(
				() => undefined,
				(error) => {
					console.error("[AgentControlStore] Failed to recover abandoned runtime owners", error)
				},
			)
			this.recoveryScanInFlight = scan
			void scan.then(() => {
				if (this.recoveryScanInFlight === scan) this.recoveryScanInFlight = undefined
			})
		}, this.recoveryScanIntervalMs)
		this.recoveryScanTimer.unref?.()
	}

	private stopRecoveryScan(): void {
		if (!this.recoveryScanTimer) return
		clearInterval(this.recoveryScanTimer)
		this.recoveryScanTimer = undefined
	}

	private async readPersistedState(): Promise<PersistedAgentControlState> {
		const stored = await this.persistence.read()
		const state = stored === undefined ? initialState(this.now()) : agentControlStateSchema.parse(stored)
		const highestSequence = state.mailbox.reduce((highest, entry) => Math.max(highest, entry.sequence), 0)
		state.nextSequence = Math.max(state.nextSequence, highestSequence + 1)
		return {
			state,
			migrated:
				stored !== undefined &&
				typeof stored === "object" &&
				stored !== null &&
				"version" in stored &&
				stored.version === 1,
		}
	}

	private withPersistenceTransaction<T>(operation: () => Promise<T>): Promise<T> {
		return this.persistence.withTransaction ? this.persistence.withTransaction(operation) : operation()
	}

	private async assertPersistenceTransaction(): Promise<void> {
		await this.persistence.assertTransactionOwner?.()
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

	private assertRecordOwned(draft: AgentControlState, record: AgentRecord, action: string): void {
		this.assertTreeOwned(draft, record.rootTaskId, action)
	}

	private assertTreeOwned(draft: AgentControlState, rootTaskId: string, action: string): void {
		if (!this.hasOwnerLeases()) return
		const foreignClaim = draft.mailbox.find(
			(entry) =>
				entry.rootTaskId === rootTaskId &&
				entry.claimId !== undefined &&
				entry.acknowledgedAt === undefined &&
				entry.claimOwnerId !== undefined &&
				entry.claimOwnerId !== this.runtimeOwnerId,
		)
		if (foreignClaim) {
			throw new Error(
				`Agent tree ${rootTaskId} has a mailbox claim owned by another live extension host and this host cannot ${action}`,
			)
		}
		const foreignActiveRecord = draft.agents.find(
			(candidate) =>
				candidate.rootTaskId === rootTaskId &&
				ACTIVE_STATUSES.has(candidate.status) &&
				candidate.runtimeOwnerId !== undefined &&
				candidate.runtimeOwnerId !== this.runtimeOwnerId,
		)
		if (foreignActiveRecord) {
			throw new Error(
				`Agent tree ${rootTaskId} is owned by another live extension host and this host cannot ${action}`,
			)
		}
		for (const candidate of draft.agents) {
			if (
				candidate.rootTaskId === rootTaskId &&
				ACTIVE_STATUSES.has(candidate.status) &&
				candidate.runtimeOwnerId === undefined
			) {
				candidate.runtimeOwnerId = this.runtimeOwnerId
			}
		}
	}

	private assertParentMutationOwned(
		draft: AgentControlState,
		parentTaskId: string,
		rootTaskId: string | undefined,
		action: string,
	): void {
		const parent = this.resolveRecord(draft, parentTaskId, rootTaskId)
		if (parent) {
			this.assertRecordOwned(draft, parent, action)
			this.claimRecordOwnership(parent)
			return
		}
		const tombstone = this.resolveTombstone(draft, parentTaskId, rootTaskId)
		if (!tombstone) throw new Error(`Unknown parent agent target: ${parentTaskId}`)
		this.assertTreeOwned(draft, tombstone.rootTaskId, action)
	}

	private claimRecordOwnership(record: AgentRecord): void {
		if (!this.hasOwnerLeases()) return
		if (ACTIVE_STATUSES.has(record.status)) record.runtimeOwnerId = this.runtimeOwnerId
		else delete record.runtimeOwnerId
	}

	private requireOwnedAddress(
		draft: AgentControlState,
		target: string,
		rootTaskId: string | undefined,
		action: string,
	): MutableAddress {
		const record = this.resolveRecord(draft, target, rootTaskId)
		if (!record) {
			throw new Error(`Unknown or closed agent target: ${target}`)
		}
		this.assertRecordOwned(draft, record, action)
		this.claimRecordOwnership(record)
		return { taskId: record.taskId, path: record.path, rootTaskId: record.rootTaskId }
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
