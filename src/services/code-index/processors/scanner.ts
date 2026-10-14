import { relativeIndexPath } from "../shared/embedding-input"
import { prepareIndexPoints } from "../shared/file-indexing"
import { listFiles } from "../../glob/list-files"
import { Ignore } from "ignore"
import { AlphaIgnoreController } from "../../../core/ignore/AlphaIgnoreController"
import { stat } from "fs/promises"
import * as path from "path"
import { generateRelativeFilePath } from "../shared/get-relative-path"
import { getWorkspacePathForContext } from "../../../utils/path"
import { scannerExtensions } from "../shared/supported-extensions"
import * as vscode from "vscode"
import { CodeBlock, PointStruct, ICodeParser, IEmbedder, IVectorStore, IDirectoryScanner } from "../interfaces"
import { createHash } from "crypto"
import pLimit from "p-limit"
import { Mutex } from "async-mutex"
import { CacheManager } from "../cache-manager"
import { t } from "../../../i18n"
import {
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	PARSING_CONCURRENCY,
	BATCH_PROCESSING_CONCURRENCY,
	MAX_PENDING_BATCHES,
} from "../constants"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { TelemetryService } from "@alpha-code/telemetry"
import { TelemetryEventName } from "@alpha-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { Package } from "../../../shared/package"
import { EmbeddingRateLimiter, waitForEmbeddingDelay } from "../shared/embedding-rate-limiter"
import { EmbeddingRequestError } from "../shared/embedding-retry"

export class DirectoryScanner implements IDirectoryScanner {
	private readonly batchSegmentThreshold: number
	private readonly batchDispatchThreshold: number
	private readonly embeddingRateLimiter: EmbeddingRateLimiter

	constructor(
		private readonly embedder: IEmbedder,
		private readonly qdrantClient: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: CacheManager,
		private readonly ignoreInstance: Ignore,
		batchSegmentThreshold?: number,
		embeddingRateLimitSeconds?: number,
	) {
		// Get the configurable batch size from VSCode settings, fallback to default
		// If not provided in constructor, try to get from VSCode settings
		if (batchSegmentThreshold !== undefined) {
			this.batchSegmentThreshold = batchSegmentThreshold
		} else {
			try {
				this.batchSegmentThreshold = vscode.workspace
					.getConfiguration(Package.name)
					.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			} catch {
				// In test environment, vscode.workspace might not be available
				this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
			}
		}
		// Single-input providers gain no network batching benefit from accumulating many files.
		// Keep the configured segment size for writes; dispatch smaller whole-file groups sooner.
		this.batchDispatchThreshold = Math.min(
			this.batchSegmentThreshold,
			this.embedder?.embedderInfo.preferredBatchSize ?? this.batchSegmentThreshold,
		)
		this.embeddingRateLimiter = new EmbeddingRateLimiter(
			this.embedder?.embedderInfo.managesRateLimit ? 0 : (embeddingRateLimitSeconds ?? 0) * 1000,
		)
	}

	/**
	 * Recursively scans a directory for code blocks in supported files.
	 * @param directoryPath The directory to scan
	 * @param alphaIgnoreController Optional AlphaIgnoreController instance for filtering
	 * @param context VS Code ExtensionContext for cache storage
	 * @param onError Optional error handler callback
	 * @returns Promise<{codeBlocks: CodeBlock[], stats: {processed: number, skipped: number}}> Array of parsed code blocks and processing stats
	 */
	public async scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal?: AbortSignal,
	): Promise<{ stats: { processed: number; skipped: number }; totalBlockCount: number }> {
		if (signal?.aborted) return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		const directoryPath = directory
		// Capture workspace context at scan start
		const scanWorkspace = getWorkspacePathForContext(directoryPath)

		// Ripgrep already traverses the tree and applies Git ignore rules. The indexer
		// needs only files, so avoid the listing helper's second walk for directory entries.
		const [filePaths, hitFileLimit] = await listFiles(
			directoryPath,
			true,
			MAX_LIST_FILES_LIMIT_CODE_INDEX,
			signal,
			{
				includeDirectories: false,
			},
		)

		// Reject unsupported paths before Alpha ignore validation resolves symlinks on disk.
		const candidatePaths = filePaths.filter((filePath) => {
			if (!scannerExtensions.includes(path.extname(filePath).toLowerCase())) return false
			const relativeFilePath = generateRelativeFilePath(filePath, scanWorkspace)

			// Check if file is in an ignored directory using the shared helper
			// Use relative path to avoid matching parent directories outside the workspace
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				return false
			}

			return !this.ignoreInstance.ignores(relativeFilePath)
		})
		const ignoreController = new AlphaIgnoreController(directoryPath)
		let supportedPaths: string[]
		try {
			await ignoreController.initialize()
			signal?.throwIfAborted()
			supportedPaths = ignoreController.filterPaths(candidatePaths)
		} finally {
			// This controller is used only for discovery; the file watcher owns ongoing policy updates.
			ignoreController.dispose()
		}

		// Initialize tracking variables
		const processedFiles = new Set<string>()
		let processedCount = 0
		let skippedCount = 0

		// Initialize parallel processing tools
		const parseLimiter = pLimit(PARSING_CONCURRENCY) // Concurrency for file parsing
		const batchLimiter = pLimit(BATCH_PROCESSING_CONCURRENCY) // Concurrency for batch processing
		const mutex = new Mutex()

		// Shared batch accumulators (protected by mutex)
		let currentBatchBlocks: CodeBlock[] = []
		let currentBatchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[] = []
		const activeBatchPromises = new Set<Promise<void>>()
		let pendingBatchCount = 0

		// Dispatch only at file boundaries. A file may exceed the configured segment
		// threshold, but keeping all of its blocks in one logical batch guarantees
		// that old points are deleted once and its hash is committed only after every
		// segment has been upserted successfully.
		const dispatchCurrentBatch = async (): Promise<void> => {
			if (currentBatchFileInfos.length === 0) return

			while (pendingBatchCount >= MAX_PENDING_BATCHES) {
				if (signal?.aborted) {
					throw new DOMException("Indexing aborted", "AbortError")
				}
				await Promise.race(activeBatchPromises)
			}

			const batchBlocks = currentBatchBlocks
			const batchFileInfos = currentBatchFileInfos
			currentBatchBlocks = []
			currentBatchFileInfos = []
			pendingBatchCount++

			const batchPromise = batchLimiter(() =>
				this.processBatch(batchBlocks, batchFileInfos, scanWorkspace, onError, onBlocksIndexed, signal),
			)
			activeBatchPromises.add(batchPromise)
			const cleanup = () => {
				activeBatchPromises.delete(batchPromise)
				pendingBatchCount--
			}
			void batchPromise.then(cleanup, cleanup)
		}

		// Initialize block counter
		let totalBlockCount = 0

		// Process all files in parallel with concurrency control
		const parsePromises = supportedPaths.map((filePath) =>
			parseLimiter(async () => {
				// Check abort signal before processing each file
				if (signal?.aborted) return

				try {
					// Check file size
					const stats = await stat(filePath)
					if (stats.size > MAX_FILE_SIZE_BYTES) {
						skippedCount++ // Skip large files
						return
					}
					// The file is present and still indexable. Keep its existing index entry if
					// a later read or parse fails transiently instead of treating it as deleted.
					processedFiles.add(filePath)

					// Read file content
					const content = await vscode.workspace.fs
						.readFile(vscode.Uri.file(filePath))
						.then((buffer) => Buffer.from(buffer).toString("utf-8"))

					// Calculate current hash
					const currentFileHash = createHash("sha256").update(content).digest("hex")
					// Check against cache
					const cachedFileHash = this.cacheManager.getHash(filePath)
					const isNewFile = !cachedFileHash
					if (cachedFileHash === currentFileHash) {
						// File is unchanged
						skippedCount++
						return
					}

					// File is new or changed - parse it using the injected parser function
					const blocks = await this.codeParser.parseFile(filePath, {
						content,
						fileHash: currentFileHash,
						signal,
					})
					const fileBlockCount = blocks.length
					onFileParsed?.(fileBlockCount)
					processedCount++

					// Process embeddings if configured
					if (this.embedder && this.qdrantClient) {
						const indexedBlocks = blocks.filter((block) => block.content.trim().length > 0)
						const release = await mutex.acquire()
						try {
							if (signal?.aborted) {
								throw new DOMException("Indexing aborted", "AbortError")
							}

							if (
								currentBatchBlocks.length > 0 &&
								indexedBlocks.length > 0 &&
								currentBatchBlocks.length + indexedBlocks.length > this.batchDispatchThreshold
							) {
								await dispatchCurrentBatch()
							}

							currentBatchBlocks.push(...indexedBlocks)
							currentBatchFileInfos.push({ filePath, fileHash: currentFileHash, isNew: isNewFile })
							if (indexedBlocks.length > 0) {
								totalBlockCount += fileBlockCount
							}

							if (
								currentBatchBlocks.length >= this.batchDispatchThreshold ||
								(this.embedder.embedderInfo.preferredBatchSize !== undefined &&
									pendingBatchCount === 0) ||
								(currentBatchBlocks.length === 0 &&
									currentBatchFileInfos.length >= this.batchDispatchThreshold)
							) {
								await dispatchCurrentBatch()
							}
						} finally {
							release()
						}
					} else {
						// Only update hash if not being processed in a batch
						await this.cacheManager.updateHash(filePath, currentFileHash)
					}
				} catch (error) {
					// Discovery confirmed this path; a transient stat/read failure is not evidence of deletion.
					processedFiles.add(filePath)
					// Re-throw AbortError — it's not a file processing error, just a user-initiated stop
					if (error instanceof DOMException && error.name === "AbortError") {
						throw error
					}
					console.error(`Error processing file ${filePath} in workspace ${scanWorkspace}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "scanDirectory:processFile",
					})
					if (onError) {
						onError(
							error instanceof Error
								? new Error(`${error.message} (Workspace: ${scanWorkspace}, File: ${filePath})`)
								: new Error(
										t("embeddings:scanner.unknownErrorProcessingFile", { filePath }) +
											` (Workspace: ${scanWorkspace})`,
									),
						)
					}
				}
			}),
		)

		// Wait for all parsing to complete
		const parsing = await Promise.allSettled(parsePromises)
		const failure = parsing.find((result) => result.status === "rejected")
		if (failure?.status === "rejected") {
			await Promise.allSettled(activeBatchPromises)
			throw failure.reason
		}

		// Check abort signal before processing remaining batch
		if (signal?.aborted) {
			await Promise.allSettled(activeBatchPromises)
			return {
				stats: {
					processed: processedCount,
					skipped: skippedCount,
				},
				totalBlockCount,
			}
		}

		// Process any remaining items in batch
		if (currentBatchFileInfos.length > 0) {
			const release = await mutex.acquire()
			try {
				await dispatchCurrentBatch()
			} finally {
				release()
			}
		}

		// Wait for all batch processing to complete
		await Promise.all(activeBatchPromises)

		// Check abort signal before handling deleted files
		if (signal?.aborted) {
			return {
				stats: {
					processed: processedCount,
					skipped: skippedCount,
				},
				totalBlockCount,
			}
		}

		// Handle deleted files
		if (hitFileLimit) {
			onError?.(new Error(t("embeddings:incremental.scanLimit", { limit: MAX_LIST_FILES_LIMIT_CODE_INDEX })))
			return { stats: { processed: processedCount, skipped: skippedCount }, totalBlockCount }
		}
		const oldHashes = this.cacheManager.getAllHashes()
		for (const cachedFilePath of Object.keys(oldHashes)) {
			if (!processedFiles.has(cachedFilePath)) {
				// File was deleted or is no longer supported/indexed
				if (this.qdrantClient) {
					try {
						await this.qdrantClient.deletePointsByFilePath(cachedFilePath)
						await this.cacheManager.deleteHash(cachedFilePath)
					} catch (error: any) {
						const errorStatus = error?.status || error?.response?.status || error?.statusCode
						const errorMessage = error instanceof Error ? error.message : String(error)

						console.error(
							`[DirectoryScanner] Failed to delete points for ${cachedFilePath} in workspace ${scanWorkspace}:`,
							error,
						)

						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: sanitizeErrorMessage(errorMessage),
							stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
							location: "scanDirectory:deleteRemovedFiles",
							errorStatus: errorStatus,
						})

						if (onError) {
							// Report error to error handler
							onError(
								error instanceof Error
									? new Error(
											`${error.message} (Workspace: ${scanWorkspace}, File: ${cachedFilePath})`,
										)
									: new Error(
											t("embeddings:scanner.unknownErrorDeletingPoints", {
												filePath: cachedFilePath,
											}) + ` (Workspace: ${scanWorkspace})`,
										),
							)
						}
						// Log error and continue processing instead of re-throwing
						console.error(`Failed to delete points for removed file: ${cachedFilePath}`, error)
					}
				}
			}
		}

		return {
			stats: {
				processed: processedCount,
				skipped: skippedCount,
			},
			totalBlockCount,
		}
	}

	private async processBatch(
		batchBlocks: CodeBlock[],
		batchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[],
		scanWorkspace: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		signal?: AbortSignal,
	): Promise<void> {
		let attempts = 0
		let success = false
		let lastError: Error | null = null
		// Validated vectors survive storage retries; retrying an upsert must not re-embed source files.
		let pendingPoints: PointStruct[] | undefined

		while (attempts < MAX_BATCH_RETRIES && !success) {
			if (signal?.aborted) return
			attempts++
			try {
				pendingPoints ??= await prepareIndexPoints(batchBlocks, scanWorkspace, {
					embedder: this.embedder,
					vectorStore: this.qdrantClient,
					rateLimiter: this.embeddingRateLimiter,
					batchSize: this.batchSegmentThreshold,
					signal,
					reusableFilePaths: new Set(
						batchFileInfos.filter((info) => !info.isNew).map((info) => info.filePath),
					),
				})
				if (signal?.aborted) return
				// Settle replacement writes before teardown, retaining prepared vectors across storage retries.
				for (const fileInfo of batchFileInfos) {
					const points = pendingPoints.filter(
						(point) => point.payload.filePath === relativeIndexPath(fileInfo.filePath, scanWorkspace),
					)
					await this.qdrantClient.replaceFilePoints(fileInfo.filePath, points)
				}

				// Update hashes for successfully processed files in this batch
				for (const fileInfo of batchFileInfos) {
					await this.cacheManager.updateHash(fileInfo.filePath, fileInfo.fileHash)
				}
				onBlocksIndexed?.(pendingPoints.length)
				success = true
			} catch (error) {
				if (signal?.aborted) return
				lastError = error as Error
				console.error(
					`[DirectoryScanner] Error processing batch (attempt ${attempts}) in workspace ${scanWorkspace}:`,
					error,
				)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
					stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
					location: "processBatch:retry",
					attemptNumber: attempts,
					batchSize: batchBlocks.length,
				})

				if (error instanceof EmbeddingRequestError) break
				if (attempts < MAX_BATCH_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1)
					try {
						await waitForEmbeddingDelay(delay, signal)
					} catch (delayError) {
						if (signal?.aborted) return
						throw delayError
					}
				}
			}
		}

		if (!success && lastError) {
			console.error(`[DirectoryScanner] Failed to process batch after ${attempts} attempts`)
			if (onError) {
				// Preserve the original error message from embedders which now have detailed i18n messages
				const errorMessage = lastError.message || "Unknown error"

				// For other errors, provide context
				onError(
					new Error(
						t("embeddings:scanner.failedToProcessBatchWithError", {
							maxRetries: attempts,
							errorMessage,
						}),
					),
				)
			}
		}
	}
}
