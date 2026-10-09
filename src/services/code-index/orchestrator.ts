import * as vscode from "vscode"
import * as path from "path"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager, IndexingState } from "./state-manager"
import { IFileWatcher, IVectorStore, BatchProcessingSummary } from "./interfaces"
import { DirectoryScanner } from "./processors"
import { CacheManager } from "./cache-manager"
import { TelemetryService } from "@alpha-code/telemetry"
import { TelemetryEventName } from "@alpha-code/types"
import { t } from "../../i18n"

/**
 * Manages the code indexing workflow, coordinating between different services and managers.
 */
export class CodeIndexOrchestrator {
	private _fileWatcherSubscriptions: vscode.Disposable[] = []
	private _isProcessing: boolean = false
	private _abortController: AbortController | null = null
	private _activeRunToken: symbol | null = null
	private _activeRunCompletion: Promise<void> = Promise.resolve()
	private _resolveActiveRunCompletion: (() => void) | undefined
	private _clearOperation: Promise<void> | null = null
	private _isClearing = false
	private _watcherError?: Error

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		private readonly scanner: DirectoryScanner,
		private readonly fileWatcher: IFileWatcher,
	) {}

	/**
	 * Starts the file watcher if not already running.
	 */
	private async _startWatcher(deferProcessing = false): Promise<void> {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error("Cannot start watcher: Service not configured.")
		}

		this.stateManager.setSystemState("Indexing", "Initializing file watcher...")

		try {
			await this.fileWatcher.initialize({ deferProcessing })
			this.disposeWatcherSubscriptions()

			this._fileWatcherSubscriptions = [
				this.fileWatcher.onDidStartBatchProcessing(() => {
					if (!this._isProcessing)
						this.stateManager.setSystemState("Indexing", t("embeddings:incremental.pending"))
				}),
				this.fileWatcher.onBatchProgressUpdate(({ processedInBatch, totalInBatch, currentFile, message }) => {
					if (processedInBatch < totalInBatch && this.stateManager.state !== "Indexing") {
						this.stateManager.setSystemState("Indexing", "Processing file changes...")
					}
					this.stateManager.reportFileQueueProgress(
						processedInBatch,
						totalInBatch,
						currentFile ? path.basename(currentFile) : undefined,
						message,
					)
				}),
				this.fileWatcher.onDidFinishBatchProcessing((summary: BatchProcessingSummary) => {
					const failedFiles = summary.processedFiles.filter(
						(file) => file.status === "error" || file.status === "local_error",
					)
					const batchError =
						summary.batchError ??
						(failedFiles.length
							? (failedFiles[0]?.error ?? new Error(t("embeddings:orchestrator.unknownError")))
							: undefined)
					this._watcherError = batchError
					if (batchError || failedFiles.length > 0) {
						console.error("[CodeIndexOrchestrator] Batch processing failed:", batchError)
						this.stateManager.setSystemState(
							"Error",
							batchError?.message ?? `${failedFiles.length} file change(s) failed to process.`,
						)
					} else if (!summary.hasPendingChanges && !this._isProcessing) {
						this.stateManager.setSystemState("Indexed", t("embeddings:incremental.upToDate"))
					}
				}),
			]
		} catch (error) {
			console.error("[CodeIndexOrchestrator] Failed to start file watcher:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_startWatcher",
			})
			throw error
		}
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 */
	public async startIndexing(): Promise<void> {
		if (!vscode.workspace.workspaceFolders?.length) {
			this.stateManager.setSystemState("Error", t("embeddings:orchestrator.indexingRequiresWorkspace"))
			return
		}
		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState("Standby", "Missing configuration. Save your settings to start indexing.")
			return
		}
		if (
			this._isClearing ||
			this._isProcessing ||
			!["Standby", "Error", "Indexed"].includes(this.stateManager.state)
		)
			return

		const runToken = Symbol("code-index-run")
		this._activeRunToken = runToken
		this._activeRunCompletion = new Promise<void>((resolve) => {
			this._resolveActiveRunCompletion = resolve
		})
		this._isProcessing = true
		this._watcherError = undefined
		const abortController = new AbortController()
		this._abortController = abortController
		const signal = abortController.signal
		this.stateManager.setSystemState("Indexing", "Initializing services...")
		try {
			// A manual reconciliation must settle the previous generation's writes before scanning.
			this.fileWatcher.stop()
			this.disposeWatcherSubscriptions()
			await this.fileWatcher.whenIdle()
			signal.throwIfAborted()
			const collectionCreated = await this.vectorStore.initialize()
			signal.throwIfAborted()
			if (collectionCreated) await this.cacheManager.clearCacheFile()
			await this.vectorStore.markIndexingIncomplete()
			signal.throwIfAborted()
			// Capture edits during discovery/parsing without racing the scan's replacements.
			await this._startWatcher(true)
			signal.throwIfAborted()
			this.stateManager.setSystemState("Indexing", "Checking for new or modified files...")
			let indexed = 0
			let found = 0
			const errors: Error[] = []
			const result = await this.scanner.scanDirectory(
				this.workspacePath,
				(error) => {
					if (!errors.length) errors.push(error)
				},
				(count) => {
					indexed += count
					this.stateManager.reportBlockIndexingProgress(indexed, found)
				},
				(count) => {
					found += count
					this.stateManager.reportBlockIndexingProgress(indexed, found)
				},
				signal,
			)
			signal.throwIfAborted()
			if (!result) throw new Error(t("embeddings:orchestrator.scanFailed"))
			if (errors.length) throw errors[0]
			if (found > 0 && indexed === 0) throw new Error(t("embeddings:orchestrator.indexingFailedNoBlocks"))
			this.fileWatcher.resumeProcessing()
			await this.fileWatcher.whenIdle()
			signal.throwIfAborted()
			if (this._watcherError) throw this._watcherError
			await this.cacheManager.flush()
			await this.vectorStore.markIndexingComplete()
			await this.fileWatcher.whenIdle()
			signal.throwIfAborted()
			if (this._watcherError) throw this._watcherError
			this.stateManager.setSystemState(
				this.fileWatcher.hasPendingChanges ? "Indexing" : "Indexed",
				t(
					this.fileWatcher.hasPendingChanges
						? "embeddings:incremental.pending"
						: "embeddings:incremental.upToDate",
				),
			)
		} catch (error) {
			this.stopWatcher()
			await this.fileWatcher.whenIdle()
			await this.cacheManager.flush()
			if (signal.aborted)
				this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingStopped"))
			else {
				// Keep validated per-file commits and their hashes so retry can resume instead of rebuilding everything.
				this.stateManager.setSystemState(
					"Error",
					t("embeddings:orchestrator.failedDuringInitialScan", {
						errorMessage:
							error instanceof Error ? error.message : t("embeddings:orchestrator.unknownError"),
					}),
				)
			}
		} finally {
			if (this._activeRunToken === runToken) {
				this._isProcessing = false
				if (this._abortController === abortController) this._abortController = null
				this._activeRunToken = null
				const resolveCompletion = this._resolveActiveRunCompletion
				this._resolveActiveRunCompletion = undefined
				resolveCompletion?.()
			}
		}
	}

	/**
	 * Stops any in-progress indexing by aborting the scan and stopping the file watcher.
	 */
	public stopIndexing(): void {
		if (this._abortController) {
			this.stateManager.setSystemState("Stopping", t("embeddings:orchestrator.indexingStoppedPartial"))
			this._abortController.abort()
		}
		this.stopWatcher()
	}

	/**
	 * Stops the file watcher and cleans up resources.
	 */
	public stopWatcher(): void {
		this.fileWatcher.stop()
		this.disposeWatcherSubscriptions()

		if (this.stateManager.state !== "Error" && this.stateManager.state !== "Stopping") {
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.fileWatcherStopped"))
		}
	}

	public dispose(): void {
		this._abortController?.abort()
		this.fileWatcher.dispose()
		this.disposeWatcherSubscriptions()
	}

	private disposeWatcherSubscriptions(): void {
		this._fileWatcherSubscriptions.forEach((subscription) => subscription.dispose())
		this._fileWatcherSubscriptions = []
	}

	public async whenIdle(): Promise<void> {
		await this._activeRunCompletion
		await this.fileWatcher.whenIdle()
	}

	/**
	 * Clears all index data by stopping the watcher, clearing the vector store,
	 * and resetting the cache file.
	 */
	public clearIndexData(): Promise<void> {
		if (this._clearOperation) {
			return this._clearOperation
		}
		const operation = this.clearIndexDataExclusive()
		this._clearOperation = operation
		const clearOperation = () => {
			if (this._clearOperation === operation) {
				this._clearOperation = null
			}
		}
		void operation.then(clearOperation, clearOperation)
		return operation
	}

	private async clearIndexDataExclusive(): Promise<void> {
		this._isClearing = true
		this._isProcessing = true

		try {
			this.stopIndexing()
			await this._activeRunCompletion
			await this.fileWatcher.whenIdle()

			try {
				if (this.configManager.isFeatureConfigured) {
					await this.vectorStore.deleteCollection()
				} else {
					console.warn("[CodeIndexOrchestrator] Service not configured, skipping vector collection clear.")
				}
			} catch (error: any) {
				console.error("[CodeIndexOrchestrator] Failed to clear vector collection:", error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "clearIndexData",
				})
				this.stateManager.setSystemState("Error", `Failed to clear vector collection: ${error.message}`)
			}

			await this.cacheManager.clearCacheFile()

			if (this.stateManager.state !== "Error") {
				this.stateManager.setSystemState("Standby", "Index data cleared successfully.")
			}
		} finally {
			this._isClearing = false
			this._isProcessing = false
		}
	}

	/**
	 * Gets the current state of the indexing system.
	 */
	public get state(): IndexingState {
		return this.stateManager.state
	}
}
