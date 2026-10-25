import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as vscode from "vscode"
import { getTaskDirectoryPath } from "../../utils/storage"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { fileExistsAtPath } from "../../utils/fs"
import fs from "fs/promises"
import { ContextProxy } from "../config/ContextProxy"
import type { FileMetadataEntry, RecordSource, TaskMetadata } from "./FileContextTrackerTypes"
import { AlphaProvider } from "../webview/AlphaProvider"

export interface RecentlyModifiedFilesReceipt {
	readonly files: readonly string[]
	commit(): void
}

// This class is responsible for tracking file operations that may result in stale context.
// If a user modifies a file outside of Alpha, the context may become stale and need to be updated.
// We do not want Alpha to reload the context every time a file is modified, so we use this class merely
// to inform Alpha that the change has occurred, and tell Alpha to reload the file before making
// any changes to it. This fixes an issue with diff editing, where Alpha was unable to complete a diff edit.

// FileContextTracker
//
// This class is responsible for tracking file operations.
// If the full contents of a file are passed to Alpha via a tool, mention, or edit, the file is marked as active.
// If a file is modified outside of Alpha, we detect and track this change to prevent stale context.
export class FileContextTracker {
	readonly taskId: string
	private providerRef: WeakRef<AlphaProvider>

	// File tracking and watching
	private fileWatchers = new Map<string, vscode.FileSystemWatcher>()
	private recentlyModifiedFiles = new Map<string, number>()
	private recentlyModifiedFilesVersion = 0
	private checkpointPossibleFiles = new Set<string>()
	private metadataUpdateQueue: Promise<void> = Promise.resolve()
	private pendingMetadataUpdate?: {
		taskId: string
		filePath: string
		source: RecordSource
		promise: Promise<void>
	}
	private disposed = false

	constructor(
		provider: AlphaProvider,
		taskId: string,
		private readonly cwd: string,
	) {
		this.providerRef = new WeakRef(provider)
		this.taskId = taskId
	}

	// File watchers are set up for each file that is tracked in the task metadata.
	async setupFileWatcher(filePath: string) {
		// Only setup watcher if it doesn't already exist for this file
		if (this.disposed || this.fileWatchers.has(filePath)) {
			return
		}

		// Create a file system watcher for this specific file
		const fileUri = vscode.Uri.file(path.resolve(this.cwd, filePath))
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(fileUri.fsPath), path.basename(fileUri.fsPath)),
		)
		this.fileWatchers.set(filePath, watcher)

		// Deletion and recreation invalidate previously read content as well.
		const onFileEvent = () => {
			if (this.disposed || this.fileWatchers.get(filePath) !== watcher) return

			// A watcher event has no writer identity. Conservatively retain it rather than
			// letting an unmatched Alpha-write marker acknowledge an external change.
			void this.trackFileContext(filePath, "user_edited")
		}
		watcher.onDidCreate(onFileEvent)
		watcher.onDidChange(onFileEvent)
		watcher.onDidDelete(onFileEvent)
	}

	// Tracks a file operation in metadata and sets up a watcher for the file
	// This is the main entry point for FileContextTracker and is called when a file is passed to Alpha via a tool, mention, or edit.
	async trackFileContext(filePath: string, operation: RecordSource) {
		try {
			if (this.disposed) return

			await this.addFileToFileContextTracker(this.taskId, filePath, operation)

			// Set up file watcher for this file
			if (!this.disposed) await this.setupFileWatcher(filePath)
		} catch (error) {
			console.error("Failed to track file operation:", error)
		}
	}

	public getContextProxy(): ContextProxy | undefined {
		const provider = this.providerRef.deref()
		if (!provider) {
			console.error("AlphaProvider reference is no longer valid")
			return undefined
		}
		const context = provider.contextProxy

		if (!context) {
			console.error("Context is not available")
			return undefined
		}

		return context
	}

	// Gets task metadata from storage
	async getTaskMetadata(taskId: string): Promise<TaskMetadata> {
		const globalStoragePath = this.getContextProxy()?.globalStorageUri.fsPath ?? ""
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		try {
			if (await fileExistsAtPath(filePath)) {
				return JSON.parse(await fs.readFile(filePath, "utf8"))
			}
		} catch (error) {
			console.error("Failed to read task metadata:", error)
		}
		return { files_in_context: [] }
	}

	// Saves task metadata to storage
	async saveTaskMetadata(taskId: string, metadata: TaskMetadata) {
		try {
			const globalStoragePath = this.getContextProxy()!.globalStorageUri.fsPath
			const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
			const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
			await safeWriteJson(filePath, metadata)
		} catch (error) {
			console.error("Failed to save task metadata:", error)
		}
	}

	// Adds a file to the metadata tracker
	// This handles the business logic of determining if the file is new, stale, or active.
	// It also updates the metadata with the latest read/edit dates.
	async addFileToFileContextTracker(taskId: string, filePath: string, source: RecordSource) {
		if (this.disposed) return
		// Publish each observation before queued storage work. A receipt must not be
		// rearmed later merely because persistence for an already-observed event settles.
		if (source === "user_edited") this.markRecentlyModifiedFile(filePath)

		const pending = this.pendingMetadataUpdate
		if (pending?.taskId === taskId && pending.filePath === filePath && pending.source === source) {
			return pending.promise
		}

		// Only adjacent identical operations can share work: crossing a different
		// source would reorder read/edit authority. An in-flight save cannot absorb
		// a later observation, so remove it from admission before its first await.
		const update: Promise<void> = this.metadataUpdateQueue.then(() => {
			if (this.pendingMetadataUpdate?.promise === update) this.pendingMetadataUpdate = undefined
			return this.updateFileContextMetadata(taskId, filePath, source)
		})
		this.pendingMetadataUpdate = { taskId, filePath, source, promise: update }
		this.metadataUpdateQueue = update.catch(() => {})
		await update
	}

	private async updateFileContextMetadata(taskId: string, filePath: string, source: RecordSource) {
		try {
			if (this.disposed) return
			const metadata = await this.getTaskMetadata(taskId)
			if (this.disposed) return
			const now = Date.now()

			const otherEntries: FileMetadataEntry[] = []
			const entriesBySource = new Map<string, FileMetadataEntry>()
			let latestRead: number | null = null
			let latestEdit: number | null = null
			let latestUserEdit: number | null = null
			for (const entry of metadata.files_in_context) {
				if (entry.path !== filePath) {
					otherEntries.push(entry)
					continue
				}

				latestRead = latestTimestamp(latestRead, entry.roo_read_date)
				latestEdit = latestTimestamp(latestEdit, entry.roo_edit_date)
				latestUserEdit = latestTimestamp(latestUserEdit, entry.user_edit_date)
				const key = metadataSourceKey(entry)
				const previous = entriesBySource.get(key)
				entriesBySource.set(key, {
					...entry,
					record_state: "stale",
					roo_read_date: latestTimestamp(previous?.roo_read_date, entry.roo_read_date),
					roo_edit_date: latestTimestamp(previous?.roo_edit_date, entry.roo_edit_date),
					user_edit_date: latestTimestamp(previous?.user_edit_date, entry.user_edit_date),
				})
			}

			const newEntry: FileMetadataEntry = {
				path: filePath,
				record_state: "active",
				record_source: source,
				roo_read_date: latestRead,
				roo_edit_date: latestEdit,
				user_edit_date: latestUserEdit,
			}

			switch (source) {
				// user_edited: The user has edited the file
				case "user_edited":
					newEntry.user_edit_date = now
					break

				// roo_edited: Alpha has edited the file
				case "roo_edited":
					newEntry.roo_read_date = now
					newEntry.roo_edit_date = now
					this.checkpointPossibleFiles.add(filePath)
					break

				// read_tool/file_mentioned: Alpha has read the file via a tool or file mention
				case "read_tool":
				case "file_mentioned":
					newEntry.roo_read_date = now
					break
			}

			// Keep the existing wire shape while retaining the newest evidence for each
			// source. Undated legacy reads have a separate bucket because the reader
			// conservatively includes them for every sinceTimestamp. This bounds a
			// tracked path to four source records plus two undated read records.
			const key = metadataSourceKey(newEntry)
			const previous = entriesBySource.get(key)
			entriesBySource.set(key, {
				...previous,
				...newEntry,
				roo_read_date: latestTimestamp(previous?.roo_read_date, newEntry.roo_read_date),
				roo_edit_date: latestTimestamp(previous?.roo_edit_date, newEntry.roo_edit_date),
				user_edit_date: latestTimestamp(previous?.user_edit_date, newEntry.user_edit_date),
			})
			metadata.files_in_context = [...otherEntries, ...entriesBySource.values()]
			await this.saveTaskMetadata(taskId, metadata)
		} catch (error) {
			console.error("Failed to add file to metadata:", error)
		}
	}

	private markRecentlyModifiedFile(filePath: string): void {
		this.recentlyModifiedFiles.set(filePath, ++this.recentlyModifiedFilesVersion)
	}

	/**
	 * Captures a bounded snapshot of pending user modifications.
	 *
	 * The receipt only clears the versions it captured, so a later modification
	 * to a captured path remains pending when the receipt is committed.
	 * Paths that do not fit the character budget remain pending and are not
	 * acknowledged; later fitting paths can still be captured.
	 *
	 * @param limit Maximum number of file paths to capture.
	 * @param maxCharacters Maximum length of the captured paths joined with newlines.
	 */
	captureRecentlyModifiedFiles(limit = 200, maxCharacters = Number.MAX_SAFE_INTEGER): RecentlyModifiedFilesReceipt {
		const captureLimit = normalizeCaptureLimit(limit)
		const characterLimit = normalizeCharacterLimit(maxCharacters)
		const capturedEntries: Array<[string, number]> = []
		let capturedCharacters = 0

		for (const entry of this.recentlyModifiedFiles.entries()) {
			if (capturedEntries.length >= captureLimit) break

			const [filePath] = entry
			const candidateCharacters = capturedCharacters + filePath.length + (capturedEntries.length > 0 ? 1 : 0)
			if (candidateCharacters > characterLimit) continue

			capturedEntries.push(entry)
			capturedCharacters = candidateCharacters
		}

		const capturedVersions = new Map(capturedEntries)
		const files = Object.freeze(capturedEntries.map(([filePath]) => filePath))

		return {
			files,
			commit: () => {
				for (const [filePath, version] of capturedVersions) {
					if (this.recentlyModifiedFiles.get(filePath) === version) {
						this.recentlyModifiedFiles.delete(filePath)
					}
				}
			},
		}
	}

	// Returns (and then clears) all pending modified files for legacy callers.
	getAndClearRecentlyModifiedFiles(): string[] {
		const receipt = this.captureRecentlyModifiedFiles(this.recentlyModifiedFiles.size)
		receipt.commit()
		return [...receipt.files]
	}

	/**
	 * Gets a list of unique file paths that Alpha has read during this task.
	 * Files are sorted by most recently read first, so if there's a character
	 * budget during folded context generation, the most relevant (recent) files
	 * are prioritized.
	 *
	 * @param sinceTimestamp - Optional timestamp to filter files read after this time
	 * @returns Array of unique file paths that have been read, most recent first
	 */
	async getFilesReadByAlpha(sinceTimestamp?: number): Promise<string[]> {
		try {
			const metadata = await this.getTaskMetadata(this.taskId)

			const readEntries = metadata.files_in_context.filter((entry) => {
				// Only include files that were read by Alpha (not user edits)
				const isReadByAlpha = entry.record_source === "read_tool" || entry.record_source === "file_mentioned"
				if (!isReadByAlpha) {
					return false
				}

				// If sinceTimestamp is provided, only include files read after that time
				if (sinceTimestamp && entry.roo_read_date) {
					return entry.roo_read_date >= sinceTimestamp
				}

				return true
			})

			// Sort by roo_read_date descending (most recent first)
			// Entries without a date go to the end
			readEntries.sort((a, b) => {
				const dateA = a.roo_read_date ?? 0
				const dateB = b.roo_read_date ?? 0
				return dateB - dateA
			})

			// Deduplicate while preserving order (first occurrence = most recent read)
			const seen = new Set<string>()
			const uniquePaths: string[] = []
			for (const entry of readEntries) {
				if (!seen.has(entry.path)) {
					seen.add(entry.path)
					uniquePaths.push(entry.path)
				}
			}

			return uniquePaths
		} catch (error) {
			console.error("Failed to get files read by Alpha:", error)
			return []
		}
	}

	getAndClearCheckpointPossibleFile(): string[] {
		const files = Array.from(this.checkpointPossibleFiles)
		this.checkpointPossibleFiles.clear()
		return files
	}

	// Disposes all file watchers
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.pendingMetadataUpdate = undefined
		for (const watcher of this.fileWatchers.values()) {
			watcher.dispose()
		}
		this.fileWatchers.clear()
	}
}

function latestTimestamp(first: number | null | undefined, second: number | null | undefined): number | null {
	if (first == null) return second ?? null
	if (second == null) return first
	return Math.max(first, second)
}

function metadataSourceKey(entry: FileMetadataEntry): string {
	const isRead = entry.record_source === "read_tool" || entry.record_source === "file_mentioned"
	return isRead && !entry.roo_read_date ? `${entry.record_source}:undated` : entry.record_source
}

function normalizeCaptureLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 0
	return Math.max(0, Math.floor(limit))
}

function normalizeCharacterLimit(limit: number): number {
	if (limit === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER
	if (!Number.isFinite(limit)) return 0
	return Math.max(0, Math.floor(limit))
}
