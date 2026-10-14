import * as vscode from "vscode"
import path from "path"
import { createHash } from "crypto"
import type { Ignore } from "ignore"
import { AlphaIgnoreController } from "../../../core/ignore/AlphaIgnoreController"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { t } from "../../../i18n"
import { Package } from "../../../shared/package"
import { CacheManager } from "../cache-manager"
import {
	BATCH_SEGMENT_THRESHOLD,
	INITIAL_RETRY_DELAY_MS,
	MAX_BATCH_RETRIES,
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
} from "../constants"
import type { BatchProcessingSummary, FileProcessingResult, IEmbedder, IFileWatcher, IVectorStore } from "../interfaces"
import { relativeIndexPath } from "../shared/embedding-input"
import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../shared/embedding-rate-limiter"
import { prepareIndexPoints, withIndexingCancellation } from "../shared/file-indexing"
import { scannerExtensions } from "../shared/supported-extensions"
import { codeParser } from "./parser"

type FileEvent = { uri: vscode.Uri; type: "create" | "change" | "delete" }
type FileProgress = { processedInBatch: number; totalInBatch: number; currentFile?: string; message?: string }

/** One coalescing queue owns incremental work; stopped generations cannot commit or publish later results. */
export class FileWatcher implements IFileWatcher {
	private fileWatcher?: vscode.FileSystemWatcher
	private subscriptions: vscode.Disposable[] = []
	private readonly ignoreController: AlphaIgnoreController
	private readonly ownsIgnoreController: boolean
	private readonly initializeIgnoreController: boolean
	private accumulatedEvents = new Map<string, FileEvent>()
	private processingEvents?: Map<string, FileEvent>
	private batchProcessDebounceTimer?: NodeJS.Timeout
	private batchProcessingTail: Promise<void> = Promise.resolve()
	private processing = false
	private paused = false
	private lifecycleVersion = 0
	private disposed = false
	private runController = new AbortController()
	private activeFiles = new Map<string, AbortController>()
	private queueError?: Error
	private failedFiles = new Map<string, Error>()
	private firstPendingAt?: number
	private lastPendingAt = 0
	private readonly BATCH_QUIET_MS = 500
	private readonly BATCH_MAX_WAIT_MS = 2000
	private readonly FILE_PROCESSING_CONCURRENCY_LIMIT = 10
	private readonly batchSegmentThreshold: number
	private readonly embeddingRateLimiter: EmbeddingRateLimiter
	private readonly _onDidStartBatchProcessing = new vscode.EventEmitter<string[]>()
	private readonly _onBatchProgressUpdate = new vscode.EventEmitter<FileProgress>()
	private readonly _onDidFinishBatchProcessing = new vscode.EventEmitter<BatchProcessingSummary>()
	public readonly onDidStartBatchProcessing = this._onDidStartBatchProcessing.event
	public readonly onBatchProgressUpdate = this._onBatchProgressUpdate.event
	public readonly onDidFinishBatchProcessing = this._onDidFinishBatchProcessing.event
	public get hasPendingChanges(): boolean {
		return this.processing || this.accumulatedEvents.size > 0
	}

	public getPendingFilePaths(limit: number): readonly string[] {
		const paths = new Set<string>()
		const bound = Math.max(0, Math.min(64, Math.trunc(limit)))
		if (!bound) return []
		for (const keys of [
			this.failedFiles.keys(),
			this.activeFiles.keys(),
			this.processingEvents?.keys() ?? [],
			this.accumulatedEvents.keys(),
		]) {
			for (const filePath of keys) {
				paths.delete(filePath)
				paths.add(filePath)
				if (paths.size > bound) paths.delete(paths.values().next().value!)
			}
		}
		return [...paths].reverse()
	}

	constructor(
		private readonly workspacePath: string,
		_context: vscode.ExtensionContext,
		private readonly cacheManager: CacheManager,
		private readonly embedder?: IEmbedder,
		private readonly vectorStore?: IVectorStore,
		private readonly ignoreInstance?: Ignore,
		ignoreController?: AlphaIgnoreController,
		batchSegmentThreshold?: number,
		embeddingRateLimitSeconds?: number,
		disposeIgnoreController = !ignoreController,
	) {
		this.ownsIgnoreController = disposeIgnoreController
		this.initializeIgnoreController = !ignoreController
		this.ignoreController = ignoreController ?? new AlphaIgnoreController(workspacePath)
		this.batchSegmentThreshold =
			batchSegmentThreshold ??
			vscode.workspace
				.getConfiguration?.(Package.name)
				.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD) ??
			BATCH_SEGMENT_THRESHOLD
		this.embeddingRateLimiter = new EmbeddingRateLimiter(
			this.embedder?.embedderInfo.managesRateLimit ? 0 : (embeddingRateLimitSeconds ?? 0) * 1000,
		)
	}

	async initialize(options?: { deferProcessing?: boolean }): Promise<void> {
		if (this.disposed) throw new Error("Cannot initialize a disposed file watcher.")
		if (this.fileWatcher) {
			if (options?.deferProcessing) this.paused = true
			return
		}
		const version = this.lifecycleVersion
		await this.whenIdle()
		if (this.disposed) throw new Error("Cannot initialize a disposed file watcher.")
		if (version !== this.lifecycleVersion)
			throw new DOMException("File watcher initialization was stopped.", "AbortError")
		if (this.fileWatcher) return
		if (this.initializeIgnoreController) await this.ignoreController.initialize()
		if (version !== this.lifecycleVersion || this.disposed)
			throw new DOMException("File watcher initialization was stopped.", "AbortError")
		if (this.fileWatcher) return
		this.runController = new AbortController()
		this.paused = options?.deferProcessing ?? false
		this.queueError = undefined
		this.failedFiles.clear()
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.workspacePath, `**/*{${scannerExtensions.join(",")}}`),
		)
		const accept = (type: FileEvent["type"]) => (uri: vscode.Uri) => {
			if (version !== this.lifecycleVersion || this.disposed) return
			this.enqueue(uri, type)
		}
		this.subscriptions = [
			this.fileWatcher.onDidCreate(accept("create")),
			this.fileWatcher.onDidChange(accept("change")),
			this.fileWatcher.onDidDelete(accept("delete")),
		]
	}

	resumeProcessing(): void {
		this.paused = false
		if (this.accumulatedEvents.size) this.scheduleBatchProcessing()
	}

	stop(): void {
		this.lifecycleVersion++
		this.runController.abort()
		this.subscriptions.forEach((subscription) => subscription.dispose())
		this.subscriptions = []
		this.fileWatcher?.dispose()
		this.fileWatcher = undefined
		this.clearBatchTimer()
		this.accumulatedEvents.clear()
		this.firstPendingAt = undefined
		this.queueError = undefined
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.stop()
		if (this.ownsIgnoreController) this.ignoreController.dispose()
		this._onDidStartBatchProcessing.dispose()
		this._onBatchProgressUpdate.dispose()
		this._onDidFinishBatchProcessing.dispose()
	}

	private enqueue(uri: vscode.Uri, type: FileEvent["type"]): void {
		try {
			const relative = relativeIndexPath(uri.fsPath, this.workspacePath)
			if (
				!scannerExtensions.includes(path.extname(uri.fsPath).toLowerCase()) ||
				isPathInIgnoredDirectory(relative)
			)
				return
		} catch {
			return
		}
		if (!this.accumulatedEvents.has(uri.fsPath) && this.accumulatedEvents.size >= MAX_LIST_FILES_LIMIT_CODE_INDEX) {
			this.queueError = new Error(t("embeddings:incremental.queueOverflow"))
			this._onDidFinishBatchProcessing.fire({
				processedFiles: [],
				batchError: this.queueError,
				hasPendingChanges: true,
			})
			return
		}
		if (!this.accumulatedEvents.size) this.firstPendingAt = Date.now()
		this.lastPendingAt = Date.now()
		this.accumulatedEvents.delete(uri.fsPath)
		this.accumulatedEvents.set(uri.fsPath, { uri, type })
		this.activeFiles.get(uri.fsPath)?.abort()
		if (!this.processing && !this.paused)
			this._onBatchProgressUpdate.fire({
				processedInBatch: 0,
				totalInBatch: this.accumulatedEvents.size,
				currentFile: uri.fsPath,
				message: t("embeddings:incremental.pending"),
			})
		this.scheduleBatchProcessing()
	}

	private clearBatchTimer(): void {
		if (this.batchProcessDebounceTimer) clearTimeout(this.batchProcessDebounceTimer)
		this.batchProcessDebounceTimer = undefined
	}

	private scheduleBatchProcessing(): void {
		if (this.paused || this.processing || !this.accumulatedEvents.size) return
		this.clearBatchTimer()
		// Ordinary save bursts settle quickly, but continuous editing cannot starve reconciliation.
		const deadline = Math.min(
			(this.firstPendingAt ?? Date.now()) + this.BATCH_MAX_WAIT_MS,
			this.lastPendingAt + this.BATCH_QUIET_MS,
		)
		this.batchProcessDebounceTimer = setTimeout(
			() => {
				this.batchProcessDebounceTimer = undefined
				void this.triggerBatchProcessing()
			},
			Math.max(0, deadline - Date.now()),
		)
	}

	private triggerBatchProcessing(): Promise<void> {
		this.clearBatchTimer()
		if (this.processing || this.paused || this.runController.signal.aborted || !this.accumulatedEvents.size)
			return this.batchProcessingTail
		this.processing = true
		const signal = this.runController.signal
		const drain = async () => {
			if (!signal.aborted && !this.paused && this.accumulatedEvents.size) {
				const events = new Map<string, FileEvent>()
				for (const [filePath, event] of this.accumulatedEvents) {
					events.set(filePath, event)
					this.accumulatedEvents.delete(filePath)
					if (events.size >= 100) break
				}
				if (!this.accumulatedEvents.size) this.firstPendingAt = undefined
				// Retain the batch snapshot while files wait for a bounded worker, so search can still see their saves.
				this.processingEvents = events
				this._onDidStartBatchProcessing.fire([...events.keys()])
				await this.processBatch(events, signal)
			}
		}
		this.batchProcessingTail = drain()
			.catch((error: unknown) => {
				if (!signal.aborted)
					this._onDidFinishBatchProcessing.fire({
						processedFiles: [],
						batchError: error instanceof Error ? error : new Error(String(error)),
						hasPendingChanges: this.accumulatedEvents.size > 0,
					})
			})
			.finally(() => {
				this.processingEvents = undefined
				this.processing = false
				if (!signal.aborted && this.accumulatedEvents.size) this.scheduleBatchProcessing()
			})
		return this.batchProcessingTail
	}

	async whenIdle(): Promise<void> {
		let tail: Promise<void>
		do {
			if (!this.paused && this.accumulatedEvents.size) this.triggerBatchProcessing()
			tail = this.batchProcessingTail
			await tail
		} while (tail !== this.batchProcessingTail || (!this.paused && this.accumulatedEvents.size > 0))
	}

	private async processBatch(events: Map<string, FileEvent>, signal: AbortSignal): Promise<void> {
		const files = [...events.entries()]
		const results: FileProcessingResult[] = []
		let processed = 0
		let next = 0
		let writes = Promise.resolve()
		const report = (currentFile?: string, message?: string) => {
			if (!signal.aborted)
				this._onBatchProgressUpdate.fire({
					processedInBatch: processed,
					totalInBatch: files.length,
					currentFile,
					message,
				})
		}
		report()
		await Promise.all(
			Array.from({ length: Math.min(this.FILE_PROCESSING_CONCURRENCY_LIMIT, files.length) }, async () => {
				while (!signal.aborted && next < files.length) {
					const [filePath, event] = files[next++]
					const fileController = new AbortController()
					this.activeFiles.set(filePath, fileController)
					// New events can supersede a snapshot before its file reaches a bounded worker.
					if (this.accumulatedEvents.has(filePath)) fileController.abort()
					const fileSignal = AbortSignal.any([signal, fileController.signal])
					const progress = (message: string) => report(filePath, message)
					let result: FileProcessingResult
					try {
						fileSignal.throwIfAborted()
						progress(t("embeddings:incremental.reading"))
						result =
							event.type === "delete"
								? { path: filePath, status: "processed_for_batching", pointsToUpsert: [] }
								: await this.processFile(filePath, fileSignal, progress)
						if (result.status === "processed_for_batching" && this.vectorStore) {
							const commit = writes.then(async () => {
								fileSignal.throwIfAborted()
								progress(t("embeddings:incremental.saving"))
								// Once a write starts it settles before Stop/Clear/restart can retire this generation.
								for (let attempt = 0; ; attempt++) {
									try {
										await this.vectorStore!.replaceFilePoints(filePath, result.pointsToUpsert ?? [])
										break
									} catch (error) {
										if (attempt >= MAX_BATCH_RETRIES - 1 || fileSignal.aborted) throw error
										await waitForEmbeddingDelay(INITIAL_RETRY_DELAY_MS * 2 ** attempt, fileSignal)
									}
								}
								if (result.newHash) this.cacheManager.updateHash(filePath, result.newHash)
								else this.cacheManager.deleteHash(filePath)
							})
							writes = commit.catch(() => {})
							await commit
							result = { path: filePath, status: "success" }
						}
					} catch (error) {
						result = fileSignal.aborted
							? { path: filePath, status: "skipped", reason: "Superseded or stopped" }
							: {
									path: filePath,
									status: "error",
									error: error instanceof Error ? error : new Error(String(error)),
								}
					} finally {
						this.activeFiles.delete(filePath)
						this.processingEvents?.delete(filePath)
					}
					results.push(result)
					if (result.error) {
						if (this.failedFiles.size < MAX_LIST_FILES_LIMIT_CODE_INDEX)
							this.failedFiles.set(filePath, result.error)
						else this.queueError = new Error(t("embeddings:incremental.queueOverflow"))
					} else if (result.status === "success" || result.reason === "File has not changed")
						this.failedFiles.delete(filePath)
					processed++
					report(filePath)
				}
			}),
		)
		if (!signal.aborted)
			this._onDidFinishBatchProcessing.fire({
				processedFiles: results,
				batchError: this.queueError ?? this.failedFiles.values().next().value,
				hasPendingChanges: this.accumulatedEvents.size > 0,
			})
	}

	async processFile(
		filePath: string,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<FileProcessingResult> {
		try {
			signal?.throwIfAborted()
			const relative = relativeIndexPath(filePath, this.workspacePath)
			if (
				!scannerExtensions.includes(path.extname(filePath).toLowerCase()) ||
				isPathInIgnoredDirectory(relative) ||
				!this.ignoreController.validateAccess(filePath) ||
				this.ignoreInstance?.ignores(relative)
			) {
				return { path: filePath, status: "skipped", reason: "File is excluded from indexing" }
			}
			const uri = vscode.Uri.file(filePath)
			const stats = await withIndexingCancellation(vscode.workspace.fs.stat(uri), signal)
			if (stats.size > MAX_FILE_SIZE_BYTES)
				return { path: filePath, status: "processed_for_batching", pointsToUpsert: [] }
			const content = Buffer.from(
				await withIndexingCancellation(vscode.workspace.fs.readFile(uri), signal),
			).toString("utf8")
			const newHash = createHash("sha256").update(content).digest("hex")
			const cachedHash = this.cacheManager.getHash(filePath)
			if (cachedHash === newHash) return { path: filePath, status: "skipped", reason: "File has not changed" }
			const blocks = await withIndexingCancellation(
				codeParser.parseFile(filePath, { content, fileHash: newHash, signal }),
				signal,
			)
			const pointsToUpsert =
				this.embedder && this.vectorStore
					? await prepareIndexPoints(blocks, this.workspacePath, {
							embedder: this.embedder,
							vectorStore: this.vectorStore,
							rateLimiter: this.embeddingRateLimiter,
							batchSize: this.batchSegmentThreshold,
							signal,
							onProgress,
							reusableFilePaths: new Set(cachedHash ? [filePath] : []),
							priority: "incremental",
						})
					: []
			return { path: filePath, status: "processed_for_batching", newHash, pointsToUpsert }
		} catch (error) {
			if (signal?.aborted) throw signal.reason
			return {
				path: filePath,
				status: "local_error",
				error: error instanceof Error ? error : new Error(String(error)),
			}
		}
	}
}
