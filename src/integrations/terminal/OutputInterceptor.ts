import * as fs from "fs"
import * as path from "path"

import { TerminalOutputPreviewSize, TERMINAL_PREVIEW_BYTES, PersistedCommandOutput } from "@alpha-code/types"
import { getCommandArtifactExecutionId } from "../../core/tools/commandOutputContract"
import { terminalOutputPrefix, terminalOutputSuffix } from "./TerminalOutputBuffer"

const OUTPUT_ARTIFACT_FLUSH_TIMEOUT_MS = 5_000

/** Expected interruption, reported only after the partial archive has closed. */
export class OutputArchiveInterruptedError extends Error {
	constructor(cause: Error) {
		super("Command output archive was interrupted", { cause })
		this.name = "OutputArchiveInterruptedError"
	}
}

/**
 * Configuration options for creating an OutputInterceptor instance.
 */
export interface OutputInterceptorOptions {
	/** Unique identifier for this command execution (typically a timestamp) */
	executionId: string
	/** ID of the task that initiated this command */
	taskId: string
	/** The command string being executed */
	command: string
	/** Directory path where command output artifacts will be stored */
	storageDir: string
	/** Size category for the preview buffer (small/medium/large) */
	previewSize: TerminalOutputPreviewSize
}

/**
 * OutputInterceptor buffers terminal command output and spills to disk when threshold exceeded.
 *
 * This implements a "persisted output" pattern where large command outputs are saved to disk
 * files, with only a preview shown to the LLM. The LLM can then use the `write_stdin` artifact branch
 * to retrieve full contents or search through the output.
 *
 * The interceptor uses a **head/tail buffer** strategy (inspired by Codex):
 * - 50% of the preview budget is allocated to the "head" (beginning of output)
 * - 50% of the preview budget is allocated to the "tail" (end of output)
 * - Middle content is dropped when output exceeds the preview threshold
 *
 * This approach ensures the LLM sees both:
 * - The beginning (command startup, environment info, early errors)
 * - The end (final results, exit codes, error summaries)
 *
 * @example
 * ```typescript
 * const interceptor = new OutputInterceptor({
 *   executionId: Date.now().toString(),
 *   taskId: 'task-123',
 *   command: 'npm test',
 *   storageDir: '/path/to/task/command-output',
 *   previewSize: 'medium',
 * });
 *
 * // Write output chunks as they arrive
 * interceptor.write('Running tests...\n');
 * interceptor.write('Test 1 passed\n');
 *
 * // Finalize and get the result
 * const result = interceptor.finalize();
 * // result.preview contains head + [omitted] + tail for display
 * // result.artifactPath contains path to full output if truncated
 * ```
 */
export class OutputInterceptor {
	/** Buffer for the head (beginning) of output */
	private headBuffer: string = ""
	/** Buffer for the tail (end) of output - rolling buffer that drops front when full */
	private tailBuffer: string = ""
	/** Number of bytes currently in the head buffer */
	private headBytes: number = 0
	private headClosed = false
	/** Number of bytes currently in the tail buffer */
	private tailBytes: number = 0
	/** Number of bytes omitted from the middle */
	private omittedBytes: number = 0

	/**
	 * Pending chunks accumulated before spilling to disk.
	 * These contain ALL content (lossless) until we decide to spill.
	 * Once spilled, this array is cleared and subsequent writes go directly to disk.
	 */
	private pendingChunks: string[] = []

	private writeStream: fs.WriteStream | null = null
	private artifactPath: string
	private totalBytes: number = 0
	private spilledToDisk: boolean = false
	private writeFailure?: Error
	private storagePrepared = false
	private interrupted = false
	private failureClose?: Promise<void>
	private readonly previewBytes: number
	/** Budget for the head buffer (50% of total preview) */
	private readonly headBudget: number
	/** Budget for the tail buffer (50% of total preview) */
	private readonly tailBudget: number

	/**
	 * Creates a new OutputInterceptor instance.
	 *
	 * @param options - Configuration options for the interceptor
	 */
	constructor(private readonly options: OutputInterceptorOptions) {
		this.previewBytes = TERMINAL_PREVIEW_BYTES[options.previewSize]
		this.headBudget = Math.floor(this.previewBytes / 2)
		this.tailBudget = this.previewBytes - this.headBudget
		this.artifactPath = path.join(options.storageDir, `cmd-${options.executionId}.txt`)
	}

	/**
	 * Write a chunk of output to the interceptor.
	 *
	 * Output is first added to the head buffer until it's full (50% of preview budget).
	 * Subsequent output goes to a rolling tail buffer that keeps the most recent content.
	 *
	 * If the total output exceeds the preview threshold, the interceptor spills to disk
	 * for full output storage while maintaining head/tail buffers for the preview.
	 *
	 * @param chunk - The output string to write
	 *
	 * @example
	 * ```typescript
	 * interceptor.write('Building project...\n');
	 * interceptor.write('Compiling 42 files\n');
	 * ```
	 */
	write(chunk: string): void {
		if (this.writeFailure) throw this.writeFailure
		if (!chunk) return
		const chunkBytes = Buffer.byteLength(chunk, "utf8")
		this.totalBytes += chunkBytes

		// Always update the head/tail preview buffers
		this.addToPreviewBuffers(chunk)

		// Handle disk spilling for full output preservation
		if (!this.spilledToDisk) {
			// Accumulate ALL chunks for lossless disk storage
			this.pendingChunks.push(chunk)

			if (this.totalBytes > this.previewBytes) {
				this.spillToDisk()
			}
		} else {
			// Already spilling - write directly to disk
			this.writeStream?.write(chunk)
		}
	}

	/** The command reader owns one awaited write, preventing a second output queue. */
	async writeWithBackpressure(chunk: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		if (
			!this.spilledToDisk &&
			!this.storagePrepared &&
			this.totalBytes + Buffer.byteLength(chunk, "utf8") > this.previewBytes
		) {
			try {
				await fs.promises.mkdir(path.dirname(this.artifactPath), { recursive: true })
			} catch (error) {
				this.writeFailure = error instanceof Error ? error : new Error(String(error))
				throw this.writeFailure
			}
			this.storagePrepared = true
			signal?.throwIfAborted()
		}
		try {
			this.write(chunk)
		} catch (error) {
			this.writeFailure = error instanceof Error ? error : new Error(String(error))
			throw this.writeFailure
		}
		const stream = this.writeStream
		if (this.writeFailure) throw this.writeFailure
		if (!stream?.writableNeedDrain) return
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				stream.off("drain", onDrain)
				stream.off("error", onError)
				stream.off("close", onClose)
				signal?.removeEventListener("abort", onAbort)
			}
			const onDrain = () => {
				cleanup()
				resolve()
			}
			const onError = (error: Error) => {
				this.writeFailure = error
				cleanup()
				reject(error)
			}
			const onClose = () => onError(this.writeFailure ?? new Error("Command output artifact closed before drain"))
			const onAbort = () => {
				const error =
					signal?.reason instanceof Error ? signal.reason : new Error("Command output write cancelled")
				this.writeFailure = error
				this.interrupted = true
				stream.destroy(error)
				onError(error)
			}
			stream.once("drain", onDrain)
			stream.once("error", onError)
			stream.once("close", onClose)
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) onAbort()
			else if (this.writeFailure) onError(this.writeFailure)
			else if (stream.destroyed) onClose()
			else if (!stream.writableNeedDrain) onDrain()
		})
	}

	/**
	 * Add a chunk to the head/tail preview buffers using 50/50 split strategy.
	 *
	 * Fill head first until budget exhausted, then maintain a rolling tail buffer.
	 *
	 * @private
	 */
	private addToPreviewBuffers(chunk: string): void {
		let remaining = chunk
		let remainingBytes = Buffer.byteLength(chunk, "utf8")

		// First, fill the head buffer if there's room
		if (!this.headClosed && this.headBytes < this.headBudget) {
			const headRoom = this.headBudget - this.headBytes
			if (remainingBytes <= headRoom) {
				// Entire chunk fits in head
				this.headBuffer += remaining
				this.headBytes += remainingBytes
				return
			}
			// Split: part goes to head, rest goes to tail
			const headPortion = this.sliceByBytes(remaining, headRoom)
			this.headBuffer += headPortion
			this.headBytes += Buffer.byteLength(headPortion, "utf8")
			this.headClosed = true
			remaining = remaining.slice(headPortion.length)
			remainingBytes = Buffer.byteLength(remaining, "utf8")
		}

		// Add remainder to tail buffer
		this.addToTailBuffer(remaining, remainingBytes)
	}

	/**
	 * Add content to the rolling tail buffer, dropping old content as needed.
	 *
	 * @private
	 */
	private addToTailBuffer(chunk: string, chunkBytes: number): void {
		if (this.tailBudget === 0) {
			this.omittedBytes += chunkBytes
			return
		}

		// If this single chunk is larger than the tail budget, keep only the last tailBudget bytes
		if (chunkBytes >= this.tailBudget) {
			this.tailBuffer = this.sliceByBytesFromEnd(chunk, this.tailBudget)
			const retainedBytes = Buffer.byteLength(this.tailBuffer, "utf8")
			this.omittedBytes += this.tailBytes + chunkBytes - retainedBytes
			this.tailBytes = retainedBytes
			return
		}

		// Append to tail
		this.tailBuffer += chunk
		this.tailBytes += chunkBytes

		// Trim from front if over budget
		this.trimTailToFit()
	}

	/**
	 * Trim the tail buffer from the front to fit within the tail budget.
	 *
	 * @private
	 */
	private trimTailToFit(): void {
		if (this.tailBytes <= this.tailBudget) return
		this.tailBuffer = terminalOutputSuffix(this.tailBuffer, this.tailBudget)
		const retainedBytes = Buffer.byteLength(this.tailBuffer, "utf8")
		this.omittedBytes += this.tailBytes - retainedBytes
		this.tailBytes = retainedBytes
	}

	/**
	 * Slice a string to get approximately the first N bytes (UTF-8).
	 *
	 * @private
	 */
	private sliceByBytes(str: string, maxBytes: number): string {
		return terminalOutputPrefix(str, maxBytes)
	}

	/**
	 * Slice a string to get approximately the last N bytes (UTF-8).
	 *
	 * @private
	 */
	private sliceByBytesFromEnd(str: string, maxBytes: number): string {
		return terminalOutputSuffix(str, maxBytes)
	}

	/**
	 * Spill buffered content to disk and switch to streaming mode.
	 *
	 * This is called automatically when the buffer exceeds the preview threshold.
	 * Creates the storage directory if it doesn't exist, writes the current buffer
	 * to the artifact file, and prepares for streaming subsequent output.
	 *
	 * @private
	 */
	private spillToDisk(): void {
		// Ensure directory exists
		const dir = path.dirname(this.artifactPath)
		if (!this.storagePrepared && !fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
		}
		this.storagePrepared = true

		this.writeStream = fs.createWriteStream(this.artifactPath)
		// Errors can arrive before finalize or while no producer waits for drain.
		this.writeStream.on("error", (error) => {
			this.writeFailure = error
		})

		// Write ALL pending chunks to disk for lossless storage.
		// This ensures no content is lost, even if the preview buffers have dropped middle content.
		for (const chunk of this.pendingChunks) {
			this.writeStream.write(chunk)
		}

		// Clear pending chunks to free memory - subsequent writes go directly to disk
		this.pendingChunks = []

		this.spilledToDisk = true
	}

	/**
	 * Finalize the interceptor and return the persisted output result.
	 *
	 * Closes any open file streams and waits for them to fully flush before returning.
	 * This ensures the artifact file is completely written and ready for reading.
	 *
	 * Returns a summary object containing:
	 * - A preview of the output (head + [omitted indicator] + tail)
	 * - The total byte count of all output
	 * - The path to the full output file (if truncated)
	 * - A flag indicating whether the output was truncated
	 *
	 * @returns The persisted command output summary
	 *
	 * @example
	 * ```typescript
	 * const result = await interceptor.finalize();
	 * console.log(`Preview: ${result.preview}`);
	 * console.log(`Total bytes: ${result.totalBytes}`);
	 * if (result.truncated) {
	 *   console.log(`Full output at: ${result.artifactPath}`);
	 * }
	 * ```
	 */
	async finalize(signal?: AbortSignal): Promise<PersistedCommandOutput> {
		if (signal?.aborted) {
			const error = signal.reason instanceof Error ? signal.reason : new Error("Command output flush cancelled")
			this.writeFailure = error
			this.interrupted = true
		}
		if (this.writeFailure) {
			const failure = this.writeFailure
			await this.closeFailedStream(failure)
			if (this.interrupted) throw new OutputArchiveInterruptedError(failure)
			throw failure
		}
		// Close write stream if open and wait for it to fully flush.
		// This ensures the artifact is completely written before we advertise the artifact_id.
		if (this.writeStream) {
			const stream = this.writeStream
			try {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						const error = new Error("Command output artifact did not finish flushing within 5000 ms")
						this.writeFailure = error
						stream.destroy(error)
						onError(error)
					}, OUTPUT_ARTIFACT_FLUSH_TIMEOUT_MS)
					const cleanup = () => {
						clearTimeout(timeout)
						stream.off("finish", onFinish)
						stream.off("error", onError)
						stream.off("close", onClose)
						signal?.removeEventListener("abort", onAbort)
					}
					const onFinish = () => {
						if (!stream.closed) return
						cleanup()
						resolve()
					}
					const onError = (error: Error) => {
						cleanup()
						reject(error)
					}
					const onClose = () => {
						if (stream.writableFinished) onFinish()
						else onError(this.writeFailure ?? new Error("Command output artifact closed before flush"))
					}
					const onAbort = () => {
						const error =
							signal?.reason instanceof Error
								? signal.reason
								: new Error("Command output flush cancelled")
						this.writeFailure = error
						this.interrupted = true
						stream.destroy(error)
						onError(error)
					}
					stream.once("finish", onFinish)
					stream.once("error", onError)
					stream.once("close", onClose)
					signal?.addEventListener("abort", onAbort, { once: true })
					if (signal?.aborted) onAbort()
					else if (stream.closed) onClose()
					else if (stream.destroyed && !stream.writableFinished)
						onError(this.writeFailure ?? new Error("Command output artifact was destroyed before flush"))
					else if (stream.writableFinished) onFinish()
					else stream.end()
				})
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error))
				this.writeFailure = failure
				await this.closeFailedStream(failure)
				if (this.interrupted) throw new OutputArchiveInterruptedError(failure)
				throw failure
			}
		}

		// Prepare preview: head + [omission indicator] + tail
		let preview: string
		if (this.omittedBytes > 0) {
			const omissionIndicator = `\n[...${this.omittedBytes} bytes omitted...]\n`
			preview = this.headBuffer + omissionIndicator + this.tailBuffer
		} else {
			// No truncation, just combine head and tail (or head alone if tail is empty)
			preview = this.headBuffer + this.tailBuffer
		}

		return {
			preview,
			totalBytes: this.totalBytes,
			artifactPath: this.spilledToDisk ? this.artifactPath : null,
			truncated: this.spilledToDisk,
		}
	}

	private closeFailedStream(error: Error): Promise<void> {
		if (this.failureClose) return this.failureClose
		const stream = this.writeStream
		if (!stream || stream.closed) return Promise.resolve()
		this.failureClose = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup()
				reject(new Error("Command output artifact did not close within 5000 ms", { cause: error }))
			}, OUTPUT_ARTIFACT_FLUSH_TIMEOUT_MS)
			const cleanup = () => {
				clearTimeout(timeout)
				stream.off("close", onClose)
			}
			const onClose = () => {
				cleanup()
				resolve()
			}
			stream.once("close", onClose)
			try {
				stream.destroy(error)
				if (stream.closed) onClose()
			} catch (failure) {
				cleanup()
				reject(failure)
			}
		})
		return this.failureClose
	}

	/** Actual sink lifetime, independent of finalization-attempt success or failure. */
	isOutputClosed(): boolean {
		return !this.writeStream || this.writeStream.closed
	}

	isInterrupted(): boolean {
		return this.interrupted
	}

	/**
	 * Get the current buffer content for UI display.
	 *
	 * Returns the combined head + tail content for real-time UI updates.
	 * Note: Does not include the omission indicator to avoid flickering during streaming.
	 *
	 * @returns The current buffer content as a string
	 */
	getBufferForUI(): string {
		// For UI, return combined head + tail without omission indicator
		// This provides a smoother streaming experience
		return this.headBuffer + this.tailBuffer
	}

	/**
	 * Get the artifact file path for this command execution.
	 *
	 * Returns the path where the full output would be/is stored on disk.
	 * The file may not exist if output hasn't exceeded the preview threshold.
	 *
	 * @returns The absolute path to the artifact file
	 */
	getArtifactPath(): string {
		return this.artifactPath
	}

	/**
	 * Check if the output has been spilled to disk.
	 *
	 * @returns `true` if output exceeded threshold and was written to disk
	 */
	hasSpilledToDisk(): boolean {
		return this.spilledToDisk
	}

	/**
	 * Remove all command output artifact files from a directory.
	 *
	 * Deletes only recognized numeric and UUID command artifact filenames in the specified directory.
	 * This is typically called when a task is cleaned up or reset.
	 *
	 * @param storageDir - The directory containing artifact files to clean
	 *
	 * @example
	 * ```typescript
	 * await OutputInterceptor.cleanup('/path/to/task/command-output');
	 * ```
	 */
	static async cleanup(storageDir: string): Promise<void> {
		try {
			const files = await fs.promises.readdir(storageDir)
			for (const file of files) {
				if (getCommandArtifactExecutionId(file) !== undefined) {
					await fs.promises.unlink(path.join(storageDir, file)).catch(() => {})
				}
			}
		} catch {
			// Directory doesn't exist, nothing to clean
		}
	}

	/**
	 * Remove artifact files that are NOT in the provided set of execution IDs.
	 *
	 * This is used for selective cleanup, preserving artifacts that are still
	 * referenced in the conversation history while removing orphaned files.
	 *
	 * @param storageDir - The directory containing artifact files
	 * @param executionIds - Set of execution IDs to preserve (files NOT in this set are deleted)
	 * @param candidates - Optional pre-rewind execution IDs; untracked or newer output is preserved
	 * @param canRemove - Synchronous owner check repeated immediately before each unlink
	 *
	 * @example
	 * ```typescript
	 * // Keep only artifacts for executions 123 and 456
	 * const keepIds = new Set(['123', '456']);
	 * await OutputInterceptor.cleanupByIds('/path/to/command-output', keepIds);
	 * ```
	 */
	static async cleanupByIds(
		storageDir: string,
		executionIds: ReadonlySet<string>,
		candidates?: ReadonlySet<string>,
		canRemove?: (executionId: string) => boolean,
	): Promise<void> {
		try {
			const files = await fs.promises.readdir(storageDir)
			for (const file of files) {
				const executionId = getCommandArtifactExecutionId(file)
				if (
					executionId !== undefined &&
					!executionIds.has(executionId) &&
					(!candidates || candidates.has(executionId)) &&
					(!canRemove || canRemove(executionId))
				) {
					await fs.promises.unlink(path.join(storageDir, file)).catch(() => {})
				}
			}
		} catch {
			// Directory doesn't exist, nothing to clean
		}
	}
}
