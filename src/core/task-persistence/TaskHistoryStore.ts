import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"

import {
	historyItemSchema,
	taskDisplayNameSchema,
	taskGeneratedTitleSchema,
	type HistoryItem,
	type TaskRenameErrorCode,
} from "@alpha-code/types"
import deepEqual from "fast-deep-equal"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeWriteJson } from "../../utils/safeWriteJson"
import {
	getStorageBasePath,
	resolveExistingTaskDirectoryPathReadOnly,
	resolveTaskDirectoryPath,
} from "../../utils/storage"
import { withFileLock } from "./atomicWrite"

/**
 * Index file format for fast startup reads.
 */
interface HistoryIndex {
	version: number
	updatedAt: number
	entries: HistoryItem[]
}

/**
 * Providers in the same extension host share one global-storage directory.
 * Serialize their derived index refreshes before they reach the inter-process
 * lease so sibling views cannot contend with each other for `_index.json`.
 */
const indexWriteQueues = new Map<string, Promise<void>>()

function workspaceKey(workspace: string): string {
	const resolved = path.resolve(workspace)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isStoredHistoryItem(value: unknown): value is HistoryItem {
	// Validation proves the known fields; keep the raw representation and unknown metadata for a name-only edit.
	return historyItemSchema.safeParse(value).success
}

export class TaskRenameError extends Error {
	constructor(readonly code: TaskRenameErrorCode) {
		super(`Chat rename failed: ${code}`)
	}
}

/**
 * TaskHistoryStore encapsulates all task history persistence logic.
 *
 * Each task's HistoryItem is stored as an individual JSON file in its
 * existing task directory (`globalStorage/tasks/<taskId>/history_item.json`).
 * A single index file (`globalStorage/tasks/_index.json`) is maintained
 * as a cache for fast list reads at startup.
 *
 * Cross-process safety comes from `safeWriteJson`'s `proper-lockfile`
 * on per-task file writes. Within a single extension host process,
 * an instance lock serializes mutations and a path-scoped queue serializes
 * index refreshes from sibling providers.
 */
/**
 * Options for TaskHistoryStore constructor.
 */
export interface TaskHistoryStoreOptions {
	/**
	 * Optional callback invoked inside the write lock after each mutation
	 * (upsert, rename, generated title, delete, deleteMany). Used for serialized write-through to
	 * globalState during the transition period.
	 */
	onWrite?: (items: HistoryItem[]) => Promise<void>
}

export class TaskHistoryStore {
	private readonly globalStoragePath: string
	private readonly onWrite?: (items: HistoryItem[]) => Promise<void>
	private cache: Map<string, HistoryItem> = new Map()
	private writeLock: Promise<void> = Promise.resolve()
	private indexWriteTimer: ReturnType<typeof setTimeout> | null = null
	private fsWatcher: fsSync.FSWatcher | null = null
	private watchDebounce: ReturnType<typeof setTimeout> | null = null
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private disposal: Promise<void> | undefined

	/**
	 * Promise that resolves when initialization is complete.
	 * Callers can await this to ensure the store is ready before reading.
	 */
	public readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	/** Debounce window for index writes in milliseconds. */
	private static readonly INDEX_WRITE_DEBOUNCE_MS = 2000

	/** Periodic reconciliation interval in milliseconds. */
	private static readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000

	/** Bound startup reconciliation reads so large histories do not serialize every file read. */
	private static readonly RECONCILE_READ_CONCURRENCY = 32

	/** Bound temporary workspace matching independently of the number of saved projects. */
	private static readonly WORKSPACE_MATCH_CACHE_MAX_ENTRIES = 64

	constructor(globalStoragePath: string, options?: TaskHistoryStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.onWrite = options?.onWrite
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Load index, reconcile if needed, start watchers.
	 */
	async initialize(): Promise<void> {
		try {
			const tasksDir = await this.getTasksDir()
			await fs.mkdir(tasksDir, { recursive: true })

			// 1. Load existing index into the cache
			await this.loadIndex()

			// 2. Reconcile cache against actual task directories on disk
			await this.reconcile()

			// 3. Start fs.watch for cross-instance reactivity
			this.startWatcher()

			// 4. Start periodic reconciliation as a defensive fallback
			this.startPeriodicReconciliation()
		} finally {
			// Mark initialization as complete so callers awaiting `initialized` can proceed
			this.resolveInitialized()
		}
	}

	/**
	 * Flush pending writes, clear watchers, release resources.
	 */
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.disposed = true

		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
			this.indexWriteTimer = null
		}

		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer)
			this.reconcileTimer = null
		}

		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}
		if (this.watchDebounce) {
			clearTimeout(this.watchDebounce)
			this.watchDebounce = null
		}

		// The final cache snapshot follows every already-admitted mutation. Keep
		// legacy fire-and-forget callers observed while exposing the same join to
		// asynchronous resource owners before they release task storage.
		const disposal = this.flushIndex()
		this.disposal = disposal
		void disposal.catch((err) => {
			if (this.disposal === disposal) this.disposal = undefined
			console.error("[TaskHistoryStore] Error flushing index on dispose:", err)
		})
		return disposal
	}

	// ────────────────────────────── Reads ──────────────────────────────

	/**
	 * Get a single history item by task ID.
	 */
	get(taskId: string): HistoryItem | undefined {
		return this.cache.get(taskId)
	}

	/**
	 * Get all history items, sorted by timestamp descending (newest first).
	 */
	getAll(): HistoryItem[] {
		return Array.from(this.cache.values()).sort((a, b) => b.ts - a.ts)
	}

	/**
	 * Get history items filtered by workspace path.
	 */
	getByWorkspace(workspace: string): HistoryItem[] {
		if (!workspace) return []
		const currentWorkspace = workspaceKey(workspace)
		// A single read can contain thousands of records from the same few projects.
		// Discard these bounded matches after the read so refreshed metadata remains visible.
		const workspaceMatches = new Map<string, boolean>()
		return Array.from(this.cache.values())
			.filter((item) => {
				if (!item.workspace) return false
				const known = workspaceMatches.get(item.workspace)
				if (known !== undefined) return known
				const matches = workspaceKey(item.workspace) === currentWorkspace
				if (workspaceMatches.size < TaskHistoryStore.WORKSPACE_MATCH_CACHE_MAX_ENTRIES) {
					workspaceMatches.set(item.workspace, matches)
				}
				return matches
			})
			.sort((a, b) => b.ts - a.ts)
	}

	/** Compare persisted workspace identity without changing or migrating older records. */
	isForWorkspace(item: Pick<HistoryItem, "workspace"> | undefined, workspace: string): boolean {
		if (!item?.workspace || !workspace) return false
		return workspaceKey(item.workspace) === workspaceKey(workspace)
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Insert or update a history item.
	 *
	 * Writes the per-task file immediately (source of truth),
	 * updates the in-memory Map, and schedules a debounced index write.
	 */
	async upsert(item: HistoryItem, options: { preserveMode?: boolean } = {}): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const existing = this.cache.get(item.id)

			// Merge: preserve existing metadata unless explicitly overwritten
			let merged = existing ? { ...existing, ...item } : item

			// Write per-task file (source of truth)
			merged = await this.writeTaskFile(merged, options)

			// Update in-memory cache
			this.cache.set(merged.id, merged)

			// Schedule debounced index write
			this.scheduleIndexWrite()

			const all = this.getAll()

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(all)
			}

			return all
		})
	}

	/** Compensate only an unchanged provisional inference selection, preserving newer task metadata. */
	async restoreModelRoute(
		taskId: string,
		expected: HistoryItem,
		previous: HistoryItem,
		guard: () => boolean = () => true,
	): Promise<boolean> {
		return this.withLock(async () => {
			if (!guard()) return false
			const taskDirectory = await resolveExistingTaskDirectoryPathReadOnly(this.globalStoragePath, taskId)
			const filePath = path.join(taskDirectory, GlobalFileNames.historyItem)
			const selection = (item: HistoryItem) => ({
				apiConfigName: item.apiConfigName,
				threadModelOverride: item.threadModelOverride,
				threadModelRoute: item.threadModelRoute,
				reasoningPreference: item.reasoningPreference,
				reasoningState: item.reasoningState,
			})
			let updated: HistoryItem | undefined
			let expectedContent: string | undefined
			let changed = false
			await safeWriteJson(filePath, null, {
				atomicReplace: true,
				prepareData: async () => {
					if (!guard()) throw new Error("Task model route recovery no longer owns the task")
					const current = await this.readHistoryForMutation(filePath, taskId)
					if (!current) throw new Error("Task history disappeared during model route recovery")
					expectedContent = current.content
					updated = current.item
					if (!deepEqual(selection(current.item), selection(expected))) return updated
					changed = true
					updated = {
						...current.item,
						...selection(previous),
						...(current.item.status === "interrupted" && expected.status === "interrupted"
							? { status: previous.status }
							: {}),
					}
					return updated
				},
				commitTempFile: (temporaryPath, destinationPath) => {
					if (!guard()) throw new Error("Task model route recovery no longer owns the task")
					this.commitTaskFile(temporaryPath, destinationPath, expectedContent)
				},
			})
			if (!updated) return false
			this.cache.set(taskId, updated)
			if (!changed) return false
			this.scheduleIndexWrite()
			await this.onWrite?.(this.getAll())
			return true
		})
	}

	/** Rename only the user-owned label. Validate workspace ownership inside the same file lease as the write. */
	async renameTask(taskId: string, displayName: string, workspace: string): Promise<HistoryItem> {
		const parsed = taskDisplayNameSchema.safeParse(displayName)
		if (!parsed.success) throw new TaskRenameError("invalid")
		return this.withLock(async () => {
			let taskDirectory: string
			try {
				taskDirectory = await resolveExistingTaskDirectoryPathReadOnly(this.globalStoragePath, taskId)
			} catch {
				throw new TaskRenameError("invalid")
			}
			const filePath = path.join(taskDirectory, GlobalFileNames.historyItem)
			// Do not create storage directories for an unknown task. Ownership is rechecked under the lease below.
			if (!(await this.readHistoryForMutation(filePath, taskId))) throw new TaskRenameError("notFound")
			let renamed: HistoryItem | undefined
			let expectedContent: string | undefined
			await safeWriteJson(filePath, null, {
				atomicReplace: true,
				prepareData: async () => {
					const current = await this.readHistoryForMutation(filePath, taskId)
					if (!current) throw new TaskRenameError("notFound")
					if (!this.isForWorkspace(current.item, workspace)) throw new TaskRenameError("wrongWorkspace")
					expectedContent = current.content
					renamed = { ...current.item, displayName: parsed.data }
					return renamed
				},
				commitTempFile: (temporaryPath, destinationPath) => {
					this.commitTaskFile(temporaryPath, destinationPath, expectedContent)
				},
			})
			if (!renamed) throw new TaskRenameError("saveFailed")
			this.cache.set(taskId, renamed)
			this.scheduleIndexWrite()
			if (this.onWrite) {
				try {
					await this.onWrite(this.getAll())
				} catch {
					// The file is authoritative; a derived mirror failure cannot undo an acknowledged label.
					console.error("[TaskHistoryStore] Chat rename compatibility projection failed")
				}
			}
			return renamed
		})
	}

	/** Persist a generated label only while the user has not supplied one. */
	async setGeneratedTitle(taskId: string, title: string, workspace: string): Promise<HistoryItem | undefined> {
		const parsed = taskGeneratedTitleSchema.safeParse(title)
		if (!parsed.success) return undefined
		return this.withLock(async () => {
			let taskDirectory: string
			try {
				taskDirectory = await resolveExistingTaskDirectoryPathReadOnly(this.globalStoragePath, taskId)
			} catch {
				return undefined
			}
			const filePath = path.join(taskDirectory, GlobalFileNames.historyItem)
			if (!(await this.readHistoryForMutation(filePath, taskId))) return undefined
			let updated: HistoryItem | undefined
			let expectedContent: string | undefined
			let changed = false
			await safeWriteJson(filePath, null, {
				atomicReplace: true,
				prepareData: async () => {
					const current = await this.readHistoryForMutation(filePath, taskId)
					if (!current) throw new Error("Task history disappeared during title generation")
					expectedContent = current.content
					updated = current.item
					if (
						!this.isForWorkspace(current.item, workspace) ||
						current.item.displayName ||
						current.item.generatedTitle
					) {
						return current.item
					}
					changed = true
					updated = { ...current.item, generatedTitle: parsed.data }
					return updated
				},
				commitTempFile: (temporaryPath, destinationPath) => {
					this.commitTaskFile(temporaryPath, destinationPath, expectedContent)
				},
			})
			if (!updated) return undefined
			this.cache.set(taskId, updated)
			if (!changed) return undefined
			this.scheduleIndexWrite()
			if (this.onWrite) {
				try {
					await this.onWrite(this.getAll())
				} catch {
					// The task file is authoritative; a compatibility mirror cannot undo a generated label.
					console.error("[TaskHistoryStore] Generated title compatibility projection failed")
				}
			}
			return updated
		})
	}

	/** Patch only matching profile names under the history lock, preserving newer task metadata. */
	async renameProviderProfile(oldName: string, newName: string): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			if (oldName === newName) return []
			const changed: HistoryItem[] = []
			let failed = false
			let failure: unknown
			try {
				for (const [taskId, cached] of this.cache) {
					if (cached.apiConfigName !== oldName) continue
					// Missing or unreadable durable history must never be recreated from a stale cache.
					const taskDirectory = await resolveExistingTaskDirectoryPathReadOnly(this.globalStoragePath, taskId)
					const filePath = path.join(taskDirectory, GlobalFileNames.historyItem)
					const fileStats = await fs.lstat(filePath)
					if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
						throw new Error("Task history is not a regular file during provider profile rename")
					}
					const expectedContent = await fs.readFile(filePath, "utf8")
					const current: unknown = JSON.parse(expectedContent)
					if (!isStoredHistoryItem(current) || current.id !== taskId) {
						throw new Error("Task history identity is invalid during provider profile rename")
					}
					if (current.apiConfigName !== oldName) {
						this.cache.set(taskId, current)
						continue
					}
					const renamed = {
						...current,
						apiConfigName: newName,
						...(current.threadModelRoute?.profileName === oldName
							? { threadModelRoute: { ...current.threadModelRoute, profileName: newName } }
							: {}),
					}
					await safeWriteJson(filePath, renamed, {
						prettyPrint: true,
						atomicReplace: true,
						commitTempFile: (temporaryPath, destinationPath) => {
							// The advisory write lease is held here. Fence a sibling save that won it first,
							// then perform the small metadata-file replacement without an async gap.
							const destinationStats = fsSync.lstatSync(destinationPath)
							if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
								throw new Error("Task history is not a regular file during provider profile rename")
							}
							if (fsSync.readFileSync(destinationPath, "utf8") !== expectedContent) {
								throw new Error("Task history changed during provider profile rename")
							}
							fsSync.renameSync(temporaryPath, destinationPath)
						},
					})
					this.cache.set(taskId, renamed)
					changed.push(renamed)
				}
			} catch (error) {
				failed = true
				failure = error
			}
			if (changed.length > 0) {
				// Retain successful canonical writes even if a later file or compatibility write rejects.
				this.scheduleIndexWrite()
				if (this.onWrite) {
					try {
						await this.onWrite(this.getAll())
					} catch (error) {
						if (!failed) failure = error
						failed = true
					}
				}
			}
			if (failed) throw failure
			return changed
		})
	}

	/**
	 * Delete a single task's history item.
	 */
	async delete(taskId: string): Promise<void> {
		return this.withLock(async () => {
			await this.removeTaskFile(taskId)
			this.cache.delete(taskId)

			this.scheduleIndexWrite()

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	/**
	 * Delete multiple tasks' history items in a batch.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withLock(async () => {
			const failures: unknown[] = []

			for (const taskId of taskIds) {
				try {
					await this.removeTaskFile(taskId)
					this.cache.delete(taskId)
				} catch (error) {
					failures.push(error)
				}
			}

			// Keep successful deletions durable even when another item in the batch
			// could not be removed. Failed items remain cached and authoritative.
			if (failures.length < taskIds.length || taskIds.length === 0) {
				this.scheduleIndexWrite()

				// Call onWrite callback inside the lock for serialized write-through
				if (this.onWrite) {
					await this.onWrite(this.getAll())
				}
			}

			if (failures.length === 1) {
				throw failures[0]
			}
			if (failures.length > 1) {
				throw new AggregateError(failures, "Failed to delete one or more task history files")
			}
		})
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

	/**
	 * Scan task directories vs index and fix any drift.
	 *
	 * - Tasks on disk: refresh from their authoritative per-task file
	 * - Tasks in cache but missing from disk: remove
	 */
	async reconcile(): Promise<void> {
		// Run through the write lock to prevent interleaving with upsert/delete
		return this.withLock(async () => {
			// Keep every read in this scan on the listed root, without revalidating custom storage per task.
			const tasksDir = await this.getTasksDir()

			let dirEntries: string[]
			try {
				dirEntries = await fs.readdir(tasksDir)
			} catch {
				return // tasks dir doesn't exist yet
			}

			// Filter out the index file and hidden files
			const taskDirNames = dirEntries.filter((name) => !name.startsWith("_") && !name.startsWith("."))

			const onDiskIds = new Set(taskDirNames)
			const cacheIds = new Set(this.cache.keys())
			let changed = false

			// Per-task files are authoritative. Refresh existing cache entries too:
			// the index can lag a successful per-task write after a crash, and other
			// extension instances update these files without changing task IDs. Read
			// bounded batches in parallel so startup does not serialize every file read.
			const taskIds = Array.from(onDiskIds)
			for (let offset = 0; offset < taskIds.length; offset += TaskHistoryStore.RECONCILE_READ_CONCURRENCY) {
				const batch = taskIds.slice(offset, offset + TaskHistoryStore.RECONCILE_READ_CONCURRENCY)
				const entries = await Promise.all(
					batch.map(async (taskId) => {
						try {
							return { taskId, item: await this.readTaskFile(taskId, { tasksDir }) }
						} catch {
							// Corrupted or missing file, keep the last known-good cache entry.
							return { taskId, item: null }
						}
					}),
				)

				for (const { taskId, item } of entries) {
					if (item && !deepEqual(this.cache.get(taskId), item)) {
						this.cache.set(taskId, item)
						changed = true
					}
				}
			}

			// Tasks in cache but not on disk: remove from cache
			for (const taskId of cacheIds) {
				if (!onDiskIds.has(taskId)) {
					this.cache.delete(taskId)
					changed = true
				}
			}

			if (changed) {
				this.scheduleIndexWrite()
			}
		})
	}

	// ────────────────────────────── Cache invalidation ──────────────────────────────

	/**
	 * Invalidate a single task's cache entry (re-read from disk on next access).
	 */
	async invalidate(taskId: string, options: { requireExisting?: boolean } = {}): Promise<void> {
		// A refresh owns a cache mutation too. Serialize the read and publication
		// so a delayed read cannot restore metadata older than a completed save.
		return this.withLock(async () => {
			if (options.requireExisting) {
				// Effect fences retain their cached owner if durable metadata cannot be verified.
				const item = await this.readTaskFile(taskId, options)
				if (!item) throw new Error(`Task ${taskId} has no durable history metadata`)
				this.cache.set(taskId, item)
				return
			}
			try {
				const item = await this.readTaskFile(taskId)
				if (item) {
					this.cache.set(taskId, item)
				} else {
					this.cache.delete(taskId)
				}
			} catch {
				this.cache.delete(taskId)
			}
		})
	}

	/**
	 * Clear all in-memory cache and reload from index.
	 */
	invalidateAll(): void {
		this.cache.clear()
	}

	// ────────────────────────────── Migration ──────────────────────────────

	/**
	 * Migrate from globalState taskHistory array to per-task files.
	 *
	 * For each entry in the globalState array, writes a `history_item.json`
	 * file if one doesn't already exist. This is idempotent and safe to re-run.
	 */
	async migrateFromGlobalState(taskHistoryEntries: HistoryItem[]): Promise<void> {
		if (!taskHistoryEntries || taskHistoryEntries.length === 0) {
			return
		}

		return this.withLock(async () => {
			// Legacy task files and their derived index share one configured root snapshot.
			const tasksDir = await this.getTasksDir()
			for (const item of taskHistoryEntries) {
				if (!item.id) continue
				const filePath = await this.getTaskFilePath(item.id, tasksDir)
				try {
					await fs.access(path.dirname(filePath))
				} catch (error) {
					// Preserve orphaned legacy records; only a missing directory permits skipping.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
					throw error
				}

				await withFileLock(filePath, async () => {
					// A sibling writer may have created canonical metadata while migration waited.
					let currentContent: string | undefined
					try {
						const stats = await fs.lstat(filePath)
						if (!stats.isFile() || stats.isSymbolicLink())
							throw new Error("Task history is not a regular file")
						currentContent = await fs.readFile(filePath, "utf8")
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					}
					if (currentContent !== undefined) {
						// Existing evidence wins even when malformed or from an incompatible schema.
						// Backfill must still recover other tasks; parsing tolerance never covers I/O.
						let current: unknown
						try {
							current = JSON.parse(currentContent)
						} catch {
							return
						}
						if (isStoredHistoryItem(current) && current.id === item.id) this.cache.set(item.id, current)
						return
					}
					await safeWriteJson(filePath, item, {
						atomicReplace: true,
						externalTransaction: true,
						commitTempFile: (temporaryPath, destinationPath) => {
							this.commitTaskFile(temporaryPath, destinationPath, undefined)
						},
					})
					this.cache.set(item.id, item)
				})
			}

			await this.writeIndex(tasksDir)
		})
	}

	// ────────────────────────────── Private: Index management ──────────────────────────────

	/**
	 * Load the `_index.json` file into the in-memory cache.
	 */
	private async loadIndex(): Promise<void> {
		const indexPath = await this.getIndexPath()

		try {
			const raw = await fs.readFile(indexPath, "utf8")
			const index: HistoryIndex = JSON.parse(raw)

			if (index.version === 1 && Array.isArray(index.entries)) {
				for (const entry of index.entries) {
					if (entry.id) {
						this.cache.set(entry.id, entry)
					}
				}
			}
		} catch {
			// Index doesn't exist or is corrupted; cache stays empty.
			// Reconciliation will rebuild it from per-task files.
		}
	}

	/**
	 * Write the full index to disk.
	 */
	private async writeIndex(tasksDir?: string): Promise<void> {
		const indexPath = await this.getIndexPath(tasksDir)
		const previous = indexWriteQueues.get(indexPath) ?? Promise.resolve()
		const write = previous
			.catch(() => undefined)
			.then(async () => {
				// Snapshot at execution time so mutations applied to this store while it
				// waited are included in the refresh.
				const index: HistoryIndex = {
					version: 1,
					updatedAt: Date.now(),
					entries: this.getAll(),
				}

				await safeWriteJson(indexPath, index)
			})
		const settled = write.then(
			() => undefined,
			() => undefined,
		)
		indexWriteQueues.set(indexPath, settled)
		void settled.then(() => {
			if (indexWriteQueues.get(indexPath) === settled) {
				indexWriteQueues.delete(indexPath)
			}
		})

		return write
	}

	/**
	 * Schedule a debounced index write.
	 */
	private scheduleIndexWrite(): void {
		if (this.disposed) {
			return
		}

		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
		}

		this.indexWriteTimer = setTimeout(async () => {
			this.indexWriteTimer = null
			try {
				await this.flushIndex()
			} catch (err) {
				console.error("[TaskHistoryStore] Failed to write index:", err)
			}
		}, TaskHistoryStore.INDEX_WRITE_DEBOUNCE_MS)
	}

	/**
	 * Force an immediate index write (called on dispose/shutdown).
	 */
	async flushIndex(): Promise<void> {
		if (this.indexWriteTimer) {
			clearTimeout(this.indexWriteTimer)
			this.indexWriteTimer = null
		}

		// Admit the refresh before resolving its path so legacy dispose-then-flush
		// callers and already-running timer refreshes share the mutation boundary.
		await this.withLock(() => this.writeIndex())
	}

	// ────────────────────────────── Private: Per-task file I/O ──────────────────────────────

	/**
	 * Write a HistoryItem to its per-task `history_item.json` file.
	 */
	private async writeTaskFile(item: HistoryItem, options: { preserveMode?: boolean }): Promise<HistoryItem> {
		const filePath = await this.getTaskFilePath(item.id)
		let merged = item
		let expectedContent: string | undefined
		await safeWriteJson(filePath, item, {
			atomicReplace: true,
			prepareData: async () => {
				const current = await this.readHistoryForMutation(filePath, item.id)
				expectedContent = current?.content
				// A stale full-record save may never undo user naming or generated-title state.
				if (current) {
					merged = {
						...current.item,
						...item,
						// Metadata projections cannot undo a host mode change committed while
						// their metadata was being prepared. Legacy records still initialize it.
						...(options.preserveMode && current.item.mode !== undefined ? { mode: current.item.mode } : {}),
						displayName: current.item.displayName,
						generatedTitle: current.item.generatedTitle,
					}
				}
				return merged
			},
			commitTempFile: (temporaryPath, destinationPath) => {
				this.commitTaskFile(temporaryPath, destinationPath, expectedContent)
			},
		})
		return merged
	}

	private async readHistoryForMutation(
		filePath: string,
		taskId: string,
	): Promise<{ content: string; item: HistoryItem } | undefined> {
		try {
			const stats = await fs.lstat(filePath)
			if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Task history is not a regular file")
			const content = await fs.readFile(filePath, "utf8")
			const item: unknown = JSON.parse(content)
			if (!isStoredHistoryItem(item) || item.id !== taskId) throw new Error("Task history identity is invalid")
			return { content, item }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}

	/** Fence a replaced/deleted file or a compromised advisory lease before the atomic replacement. */
	private commitTaskFile(temporaryPath: string, destinationPath: string, expectedContent: string | undefined): void {
		let currentContent: string | undefined
		try {
			const stats = fsSync.lstatSync(destinationPath)
			if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Task history is not a regular file")
			currentContent = fsSync.readFileSync(destinationPath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		if (currentContent !== expectedContent) throw new Error("Task history changed during metadata write")
		fsSync.renameSync(temporaryPath, destinationPath)
	}

	/**
	 * Remove a per-task history file. An absent file already satisfies deletion;
	 * every other I/O failure must remain visible to the caller.
	 */
	private async removeTaskFile(taskId: string): Promise<void> {
		const filePath = await this.getTaskFilePath(taskId)
		try {
			await fs.unlink(filePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error
			}
		}
	}

	/**
	 * Read a HistoryItem from its per-task `history_item.json` file.
	 */
	private async readTaskFile(
		taskId: string,
		options: { requireExisting?: boolean; tasksDir?: string } = {},
	): Promise<HistoryItem | null> {
		const filePath = await this.getTaskFilePath(taskId, options.tasksDir)

		try {
			const raw = await fs.readFile(filePath, "utf8")
			const parsed: unknown = JSON.parse(raw)
			const item: HistoryItem = options.requireExisting
				? historyItemSchema.parse(parsed)
				: (parsed as HistoryItem)
			if (options.requireExisting && item.id !== taskId) throw new Error("Task history identity does not match")
			return item.id ? item : null
		} catch (error) {
			if (options.requireExisting)
				throw new Error(`Cannot verify durable history metadata for task ${taskId}`, { cause: error })
			return null
		}
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	/**
	 * Watch the tasks directory for changes from other instances.
	 */
	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, _filename) => {
						if (this.disposed) {
							return
						}

						// Debounce the reconciliation triggered by fs.watch
						if (this.watchDebounce) {
							clearTimeout(this.watchDebounce)
						}
						this.watchDebounce = setTimeout(() => {
							this.watchDebounce = null
							if (this.disposed) return
							this.reconcile().catch((err) => {
								console.error("[TaskHistoryStore] Reconciliation after fs.watch failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						console.error("[TaskHistoryStore] fs.watch error:", err)
						// fs.watch is unreliable on some platforms; periodic reconciliation
						// serves as the fallback.
					})
				} catch (err) {
					console.error("[TaskHistoryStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				console.error("[TaskHistoryStore] Failed to get tasks dir for watcher:", err)
			})
	}

	/**
	 * Start periodic reconciliation as a defensive fallback for platforms
	 * where fs.watch is unreliable.
	 */
	private startPeriodicReconciliation(): void {
		if (this.disposed) {
			return
		}

		this.reconcileTimer = setTimeout(async () => {
			if (this.disposed) {
				return
			}
			try {
				await this.reconcile()
			} catch (err) {
				console.error("[TaskHistoryStore] Periodic reconciliation failed:", err)
			}
			this.startPeriodicReconciliation()
		}, TaskHistoryStore.RECONCILE_INTERVAL_MS)
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	/**
	 * Serializes all read-modify-write operations within a single extension
	 * host process to prevent concurrent interleaving.
	 */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: Path helpers ──────────────────────────────

	/**
	 * Get the tasks base directory path, resolving custom storage paths.
	 */
	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	/**
	 * Get the path to a task's `history_item.json` file.
	 */
	private async getTaskFilePath(taskId: string, tasksDir?: string): Promise<string> {
		const tasksRoot = tasksDir ?? (await this.getTasksDir())
		return path.join(resolveTaskDirectoryPath(path.dirname(tasksRoot), taskId), GlobalFileNames.historyItem)
	}

	/**
	 * Get the path to the `_index.json` file.
	 */
	private async getIndexPath(tasksDir?: string): Promise<string> {
		return path.join(tasksDir ?? (await this.getTasksDir()), GlobalFileNames.historyIndex)
	}
}
