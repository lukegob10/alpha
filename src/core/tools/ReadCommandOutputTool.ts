import * as fs from "fs/promises"
import * as path from "path"
import { StringDecoder } from "node:string_decoder"

import { Task } from "../task/Task"
import { getTaskDirectoryPath } from "../../utils/storage"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import {
	READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN,
	READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH,
	READ_COMMAND_OUTPUT_MAX_DISPLAY_PATTERN_BYTES,
	READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_OFFSET,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES,
	READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
} from "./commandOutputContract"

/** Reserve enough bytes for truthful read headers before rendering content. */
const READ_METADATA_RESERVE_BYTES = 256
/** Reserve enough bytes for search headers, status, and bounded explanations. */
const SEARCH_METADATA_RESERVE_BYTES = 448
const READ_CHUNK_SIZE = 64 * 1024
const LARGE_FIXED_QUANTIFIER_THRESHOLD = 64

type ReadArtifactResult = {
	content: string
	readStart: number
	readEnd: number
	nextOffset: number
}

type SearchArtifactResult = {
	content: string
	matchCount: number
	readStart: number
	readEnd: number
	nextOffset: number
	bytesRead: number
	truncated: boolean
	incomplete: boolean
}

function isUtf8ContinuationByte(value: number): boolean {
	return (value & 0xc0) === 0x80
}

function getUtf8SequenceLength(value: number): number {
	if (value <= 0x7f) return 1
	if (value >= 0xc2 && value <= 0xdf) return 2
	if (value >= 0xe0 && value <= 0xef) return 3
	if (value >= 0xf0 && value <= 0xf4) return 4
	return 0
}

/** Return the longest prefix that ends at a complete UTF-8 code point. */
function getUtf8SafePrefixLength(buffer: Buffer): number {
	if (buffer.length === 0) return 0

	let sequenceStart = buffer.length - 1
	while (sequenceStart > 0 && isUtf8ContinuationByte(buffer[sequenceStart])) sequenceStart--

	const sequenceLength = getUtf8SequenceLength(buffer[sequenceStart])
	if (sequenceLength === 0) {
		return isUtf8ContinuationByte(buffer[sequenceStart]) ? sequenceStart : buffer.length
	}

	const available = buffer.length - sequenceStart
	return available < sequenceLength ? sequenceStart : buffer.length
}

/** Reject known nested or overlapping constructs before invoking JavaScript RegExp. */
function isUnsafeSearchPattern(pattern: string): boolean {
	if (/\\[1-9]/.test(pattern) || /\\k<[^>]+>/.test(pattern) || /\(\?[=!<]/.test(pattern)) return true
	if (/\([^()]*[+*?{](?:[^()]*)\)(?:[+*?]|\{\d+(?:,\d*)?\})/.test(pattern)) return true
	if (/\([^()]*\|[^()]*\)(?:[+*?]|\{\d+(?:,\d*)?\})/.test(pattern)) return true
	if (/(?:[+*]|\{\d+(?:,\d*)?\})(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)) return true

	// A second variable-width quantifier can make an otherwise flat pattern
	// superlinear (for example, `a+a+$`). Keep one simple quantifier available
	// for useful controls such as `test\\d+`, but reject multiple quantifiers
	// conservatively because JavaScript RegExp has no execution timeout.
	let variableWidthQuantifiers = 0
	let hasLargeFixedQuantifier = false
	let inCharacterClass = false
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]
		if (character === "\\") {
			index++
			continue
		}
		if (character === "[") {
			inCharacterClass = true
			continue
		}
		if (character === "]") {
			inCharacterClass = false
			continue
		}
		if (inCharacterClass) continue

		if (character === "+" || character === "*") {
			variableWidthQuantifiers++
			if (variableWidthQuantifiers > 1) return true
			if (pattern[index + 1] === "?") index++
			continue
		}
		if (character === "?") {
			const previous = pattern[index - 1]
			if (previous === "(" || previous === "+" || previous === "*" || previous === "?" || previous === "}") {
				continue
			}
			variableWidthQuantifiers++
			if (variableWidthQuantifiers > 1) return true
			continue
		}
		if (character === "{") {
			const quantifier = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/)
			if (!quantifier) continue
			const lower = Number(quantifier[1])
			const upper = quantifier[2] === undefined ? lower : quantifier[2] === "" ? Number.POSITIVE_INFINITY : Number(quantifier[2])
			if (lower > 1000 || upper > 1000) return true
			if (upper !== lower) {
				variableWidthQuantifiers++
				if (variableWidthQuantifiers > 1) return true
			} else if (lower >= LARGE_FIXED_QUANTIFIER_THRESHOLD) {
				hasLargeFixedQuantifier = true
			}
			if (hasLargeFixedQuantifier && variableWidthQuantifiers > 0) return true
			index += quantifier[0].length - 1
		}
	}
	if (hasLargeFixedQuantifier && variableWidthQuantifiers > 0) return true

	const quantifierPattern = /\{(\d+)(?:,(\d*))?\}/g
	for (const match of pattern.matchAll(quantifierPattern)) {
		const lower = Number(match[1])
		const upper = match[2] === "" || match[2] === undefined ? lower : Number(match[2])
		if (lower > 1000 || upper > 1000) return true
	}
	return false
}

/**
 * Await an operation while still observing the scheduler cancellation signal.
 * The underlying promise is given rejection handlers even when cancellation wins
 * so a late filesystem result cannot become an unhandled rejection.
 */
function awaitWithAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) {
		return Promise.resolve(promise)
	}

	signal.throwIfAborted()

	return new Promise<T>((resolve, reject) => {
		let settled = false
		const cleanup = () => signal.removeEventListener("abort", onAbort)
		const onAbort = () => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			reject(signal.reason)
		}

		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
			return
		}

		Promise.resolve(promise).then(
			(value) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				resolve(value)
			},
			(error) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				reject(error)
			},
		)
	})
}

function closeArtifactQuietly(fileHandle: fs.FileHandle): Promise<void> {
	return Promise.resolve()
		.then(() => fileHandle.close())
		.catch(() => undefined)
}

/**
 * Open an artifact with cancellation support. `fs.open` has no AbortSignal
 * option, so a handle that arrives after cancellation is closed immediately.
 */
async function openArtifact(artifactPath: string, signal?: AbortSignal): Promise<fs.FileHandle> {
	signal?.throwIfAborted()
	const openPromise = fs.open(artifactPath, "r")
	let fileHandle: fs.FileHandle | undefined

	try {
		fileHandle = await awaitWithAbort(openPromise, signal)
		signal?.throwIfAborted()
		return fileHandle
	} catch (error) {
		if (signal?.aborted) {
			if (fileHandle) {
				await closeArtifactQuietly(fileHandle)
			} else {
				void openPromise.then((lateFileHandle) => closeArtifactQuietly(lateFileHandle), () => undefined)
			}
		}
		throw error
	}
}

/**
 * Parameters accepted by the read_command_output tool.
 */
interface ReadCommandOutputParams {
	/**
	 * The artifact file identifier (e.g., "cmd-1706119234567.txt").
	 * This is provided in the execute_command output when truncation occurs.
	 */
	artifact_id: string
	/**
	 * Optional search pattern (regex or literal string) to filter lines.
	 * When provided, only lines matching the pattern are returned.
	 */
	search?: string
	/**
	 * Integer byte offset to start reading from (default: 0).
	 * Used for paginating through large outputs. UTF-8 split points are advanced
	 * to the next complete code point and the actual range is reported in telemetry.
	 */
	offset?: number
	/**
	 * Maximum UTF-8 bytes in the complete formatted response, including headers,
	 * line numbers, and search metadata (default: 40 KiB; range: 512 bytes to 4 MiB).
	 */
	limit?: number
}

/**
 * ReadCommandOutputTool allows the LLM to retrieve full command output that was truncated.
 *
 * When `execute_command` produces output exceeding the preview threshold, the full output
 * is persisted to disk by the `OutputInterceptor`. This tool enables the LLM to:
 *
 * 1. **Read full output**: Retrieve the complete command output beyond the preview
 * 2. **Search output**: Filter lines matching a pattern (like grep)
 * 3. **Paginate**: Read large outputs in chunks using offset/limit
 *
 * ## Storage Location
 *
 * Artifacts are stored outside the workspace in the task directory:
 * `globalStoragePath/tasks/{taskId}/command-output/cmd-{executionId}.txt`
 *
 * ## Security
 *
 * The tool validates artifact_id format to prevent path traversal attacks.
 * Only files matching `cmd-{digits}.txt` pattern are accessible.
 *
 * ## Usage Flow
 *
 * 1. LLM calls `execute_command` which runs a command
 * 2. If output is large, response includes `artifact_id` and truncation notice
 * 3. LLM calls `read_command_output` with the artifact_id to get more content
 *
 * @example
 * ```typescript
 * // Basic usage - read from beginning
 * await readCommandOutputTool.execute({
 *   artifact_id: "cmd-1706119234567.txt"
 * }, task, callbacks);
 *
 * // Search for specific content
 * await readCommandOutputTool.execute({
 *   artifact_id: "cmd-1706119234567.txt",
 *   search: "error|failed"
 * }, task, callbacks);
 *
 * // Paginate through large output
 * await readCommandOutputTool.execute({
 *   artifact_id: "cmd-1706119234567.txt",
 *   offset: 40960,  // Start after the first 40 KiB
 *   limit: 40960    // Read the next 40 KiB of the complete response
 * }, task, callbacks);
 * ```
 */
export class ReadCommandOutputTool extends BaseTool<"read_command_output"> {
	readonly name = "read_command_output" as const

	/**
	 * Execute the read_command_output tool.
	 *
	 * Reads persisted command output from disk, supporting both full reads and
	 * search-based filtering. Results include line numbers for easy reference.
	 *
	 * @param params - The tool parameters including artifact_id and optional search/pagination
	 * @param task - The current task instance for error reporting and state management
	 * @param callbacks - Callbacks for pushing tool results
	 */
	async execute(params: ReadCommandOutputParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, signal } = callbacks
		const { artifact_id, search, offset = 0, limit = READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES } = params
		const markError = () => {
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
		}
		const reportError = async (errorMsg: string) => {
			markError()
			signal?.throwIfAborted()
			await awaitWithAbort(Promise.resolve(task.say("error", errorMsg)), signal)
			signal?.throwIfAborted()
			pushToolResult(`Error: ${errorMsg}`)
		}

		try {
			signal?.throwIfAborted()

			// Validate required parameters
			if (typeof artifact_id !== "string" || artifact_id.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_command_output")
				markError()
				const errorMsg = await awaitWithAbort(
					Promise.resolve(task.sayAndCreateMissingParamError("read_command_output", "artifact_id")),
					signal,
				)
				signal?.throwIfAborted()
				pushToolResult(`Error: ${errorMsg}`)
				return
			}
			const displayArtifactId = this.formatArtifactIdForError(artifact_id)

			// Validate artifact_id format to prevent path traversal
			if (!this.isValidArtifactId(artifact_id)) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_command_output")
				const errorMsg = `Invalid artifact_id format: ${displayArtifactId}. Expected format: cmd-{timestamp}.txt (e.g., "cmd-1706119234567.txt")`
				await reportError(errorMsg)
				return
			}

			if (!Number.isSafeInteger(offset) || offset < 0 || offset > READ_COMMAND_OUTPUT_MAX_OFFSET) {
				await reportError(
					`Invalid offset: ${offset}. Offset must be an integer between 0 and ${READ_COMMAND_OUTPUT_MAX_OFFSET}.`,
				)
				return
			}

			if (
				!Number.isSafeInteger(limit) ||
				limit < READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES ||
				limit > READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES
			) {
				await reportError(
					`Invalid limit: ${limit}. Limit must be an integer between ${READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES} and ${READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES} bytes, including formatted metadata.`,
				)
				return
			}

			if (search !== undefined) {
				if (typeof search !== "string" || search.length < 1 || search.length > READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH) {
					await reportError(
						`Invalid search pattern. It must be a string from 1 to ${READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH} characters.`,
					)
					return
				}
				if (isUnsafeSearchPattern(search)) {
					await reportError("Invalid search pattern. Potentially unsafe regular-expression constructs are rejected.")
					return
				}
			}

			// Get the task directory path
			const provider = await awaitWithAbort(Promise.resolve(task.providerRef.deref()), signal)
			const globalStoragePath = provider?.context?.globalStorageUri?.fsPath

			if (!globalStoragePath) {
				const errorMsg = "Unable to access command output storage. Global storage path is not available."
				await reportError(errorMsg)
				return
			}

			const taskDir = await awaitWithAbort(Promise.resolve(getTaskDirectoryPath(globalStoragePath, task.taskId)), signal)
			const artifactPath = path.join(taskDir, "command-output", artifact_id)

			// Check if artifact exists
			try {
				await awaitWithAbort(fs.access(artifactPath), signal)
			} catch (error) {
				if (signal?.aborted) {
					throw error
				}
				const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined
				const isMissingArtifact = errorCode === "ENOENT" || (error instanceof Error && error.message === "ENOENT")
				const errorMsg = isMissingArtifact
					? `Artifact not found: ${displayArtifactId}. Please verify the artifact_id from the command output message. Available artifacts are created when command output exceeds the preview size.`
					: `Unable to access artifact ${displayArtifactId}: ${error instanceof Error ? error.message : String(error)}`
				await reportError(errorMsg)
				return
			}

			// Get file stats for metadata
			const stats = await awaitWithAbort(fs.stat(artifactPath), signal)
			const totalSize = stats.size

			// Validate offset
			if (offset < 0 || offset >= totalSize) {
				const errorMsg = `Invalid offset: ${offset}. File size is ${totalSize} bytes. Offset must be between 0 and ${totalSize - 1}.`
				await reportError(errorMsg)
				return
			}

			let result: string
			let readStart = 0
			let readEnd = 0
			let nextOffset = 0
			let matchCount: number | undefined
			let searchTruncated = false
			let searchIncomplete = false

			if (search !== undefined) {
				// Search mode: filter lines matching the pattern
				const searchResult = await this.searchInArtifact(artifactPath, search, offset, totalSize, limit, signal)
				result = searchResult.content
				matchCount = searchResult.matchCount
				readStart = searchResult.readStart
				readEnd = searchResult.readEnd
				nextOffset = searchResult.nextOffset
				searchTruncated = searchResult.truncated
				searchIncomplete = searchResult.incomplete
			} else {
				// Normal read mode with offset/limit
				const readResult = await this.readArtifact(artifactPath, offset, limit, totalSize, signal)
				result = readResult.content
				readStart = readResult.readStart
				readEnd = readResult.readEnd
				nextOffset = readResult.nextOffset
			}

			// Report to UI that we read command output
			await awaitWithAbort(
				Promise.resolve(
					task.say(
						"tool",
						JSON.stringify({
							tool: "readCommandOutput",
							readStart,
							readEnd,
							totalBytes: totalSize,
							...(search !== undefined && {
								searchPattern: search,
								matchCount,
								searchMatchCountExact: !searchTruncated && !searchIncomplete,
								searchBytesRead: readEnd - readStart,
								searchTruncated,
								searchIncomplete,
							}),
							nextOffset,
						}),
					),
				),
				signal,
			)

			signal?.throwIfAborted()
			task.consecutiveMistakeCount = 0
			signal?.throwIfAborted()
			pushToolResult(result)
		} catch (error) {
			if (signal?.aborted) {
				throw error
			}
			const errorMsg = error instanceof Error ? error.message : String(error)
			await reportError(`Error reading command output: ${errorMsg}`)
		}
	}

	/**
	 * Validate artifact_id format to prevent path traversal attacks.
	 *
	 * Only accepts IDs matching the pattern `cmd-{digits}.txt` which are
	 * generated by the OutputInterceptor. This prevents malicious paths
	 * like `../../../etc/passwd` from being used.
	 *
	 * @param artifactId - The artifact ID to validate
	 * @returns `true` if the format is valid, `false` otherwise
	 * @private
	 */
	private isValidArtifactId(artifactId: unknown): artifactId is string {
		if (typeof artifactId !== "string" || artifactId.length > READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH) {
			return false
		}
		return new RegExp(READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN).test(artifactId)
	}

	private formatArtifactIdForError(artifactId: unknown): string {
		let value: string
		try {
			value = typeof artifactId === "string" ? artifactId : String(artifactId)
		} catch {
			value = "<unprintable>"
		}
		const maxBytes = READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH
		const encodedBytes = Buffer.byteLength(value, "utf8")
		const displayed =
			encodedBytes > maxBytes ? `${this.truncateUtf8(value, maxBytes - 3)}...` : value
		return JSON.stringify(displayed)
	}

	/**
	 * Read artifact content with offset and limit, adding line numbers.
	 *
	 * Performs efficient partial file reads using file handles and positional
	 * reads. Line numbers are calculated by counting newlines in the portion
	 * of the file before the offset.
	 *
	 * @param artifactPath - Absolute path to the artifact file
	 * @param offset - Byte offset to start reading from
	 * @param limit - Maximum bytes to read
	 * @param totalSize - Total size of the file in bytes
	 * @returns Formatted output with header metadata and line-numbered content
	 * @private
	 */
	private async readArtifact(
		artifactPath: string,
		offset: number,
		limit: number,
		totalSize: number,
		signal?: AbortSignal,
	): Promise<ReadArtifactResult> {
		const fileHandle = await openArtifact(artifactPath, signal)
		let result: ReadArtifactResult
		let closeError: unknown

		try {
			signal?.throwIfAborted()
			const readStart = await this.alignReadStart(fileHandle, offset, totalSize, signal)
			const maxReadableBytes = Math.min(limit, totalSize - readStart)
			const buffer = Buffer.alloc(maxReadableBytes)
			let bytesRead = 0
			while (bytesRead < maxReadableBytes) {
				signal?.throwIfAborted()
				const readResult = await awaitWithAbort(
					fileHandle.read(buffer, bytesRead, maxReadableBytes - bytesRead, readStart + bytesRead),
					signal,
				)
				const chunkBytes = Math.min(readResult.bytesRead, maxReadableBytes - bytesRead)
				if (chunkBytes === 0) break
				bytesRead += chunkBytes
			}
			signal?.throwIfAborted()

			const safeBytes = getUtf8SafePrefixLength(buffer.subarray(0, bytesRead))
			const content = buffer.subarray(0, safeBytes).toString("utf8")
			const startLineNumber =
				readStart > 0 ? await this.countNewlinesBeforeOffset(fileHandle, readStart, signal) : 1
			let contentBudget = Math.max(0, limit - READ_METADATA_RESERVE_BYTES)
			let rendered = this.renderNumberedContent(content, startLineNumber, contentBudget)
			let readEnd = readStart + rendered.sourceBytesConsumed
			let truncated = readEnd < totalSize || safeBytes < bytesRead
			let header = this.buildReadHeader(artifactPath, totalSize, readStart, readEnd, truncated)

			// Re-render with the exact header budget so the complete response,
			// including prefixes and metadata, stays within the requested UTF-8 limit.
			for (let attempt = 0; attempt < 3; attempt++) {
				const exactContentBudget = Math.max(0, limit - Buffer.byteLength(header, "utf8"))
				if (exactContentBudget >= contentBudget) break
				contentBudget = exactContentBudget
				rendered = this.renderNumberedContent(content, startLineNumber, contentBudget)
				readEnd = readStart + rendered.sourceBytesConsumed
				truncated = readEnd < totalSize || safeBytes < bytesRead
				header = this.buildReadHeader(artifactPath, totalSize, readStart, readEnd, truncated)
			}

			result = {
				content: header + rendered.content,
				readStart,
				readEnd,
				nextOffset: readEnd,
			}
		} finally {
			try {
				await fileHandle.close()
			} catch (error) {
				if (!signal?.aborted) {
					closeError = error
				}
			}
		}

		if (closeError) {
			throw closeError
		}
		return result
	}

	/** Advance a byte offset past continuation bytes so decoding starts at a code-point boundary. */
	private async alignReadStart(
		fileHandle: fs.FileHandle,
		offset: number,
		totalSize: number,
		signal?: AbortSignal,
	): Promise<number> {
		if (offset === 0) return 0
		const probeLength = Math.min(4, totalSize - offset)
		const probe = Buffer.alloc(probeLength)
		let probeBytes = 0
		while (probeBytes < probeLength) {
			signal?.throwIfAborted()
			const result = await awaitWithAbort(
				fileHandle.read(probe, probeBytes, probeLength - probeBytes, offset + probeBytes),
				signal,
			)
			const chunkBytes = Math.min(result.bytesRead, probeLength - probeBytes)
			if (chunkBytes === 0) break
			probeBytes += chunkBytes
		}

		let readStart = offset
		while (readStart < offset + probeBytes && isUtf8ContinuationByte(probe[readStart - offset])) readStart++
		return readStart
	}

	private buildReadHeader(
		artifactPath: string,
		totalSize: number,
		readStart: number,
		readEnd: number,
		truncated: boolean,
	): string {
		const artifactId = path.basename(artifactPath).slice(0, READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH)
		return [
			`[Command Output: ${artifactId}]`,
			`Total size: ${this.formatBytes(totalSize)} | Showing bytes ${readStart}-${readEnd} | ${truncated ? "TRUNCATED" : "COMPLETE"}`,
			"",
		].join("\n")
	}

	private renderNumberedContent(
		content: string,
		startLine: number,
		maxBytes: number,
	): { content: string; sourceBytesConsumed: number; truncated: boolean } {
		const lines = content.split("\n")
		const maxLineNumber = startLine + lines.length - 1
		const padding = String(maxLineNumber).length
		const renderedLines: string[] = []
		let renderedBytes = 0
		let sourceBytesConsumed = 0

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]
			const hasFollowingLine = index < lines.length - 1
			const prefix = `${String(startLine + index).padStart(padding)} | `
			const separatorBytes = renderedLines.length > 0 ? 1 : 0
			const fullLineBytes = separatorBytes + Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(line, "utf8")
			if (renderedBytes + fullLineBytes <= maxBytes) {
				renderedLines.push(prefix + line)
				renderedBytes += fullLineBytes
				sourceBytesConsumed += Buffer.byteLength(line, "utf8") + (hasFollowingLine ? 1 : 0)
				continue
			}

			const contentBudget = maxBytes - renderedBytes - separatorBytes - Buffer.byteLength(prefix, "utf8")
			if (contentBudget > 0) {
				const retainedLine = this.truncateUtf8(line, contentBudget)
				renderedLines.push(prefix + retainedLine)
				sourceBytesConsumed += Buffer.byteLength(retainedLine, "utf8")
			}
			return {
				content: renderedLines.join("\n"),
				sourceBytesConsumed,
				truncated: sourceBytesConsumed < Buffer.byteLength(content, "utf8"),
			}
		}

		return {
			content: renderedLines.join("\n"),
			sourceBytesConsumed,
			truncated: sourceBytesConsumed < Buffer.byteLength(content, "utf8"),
		}
	}

	/**
	 * Search artifact content for lines matching a pattern using chunked streaming.
	 *
	 * Performs grep-like searching through the artifact file using bounded memory.
	 * Instead of loading the entire file into memory, this reads in fixed-size chunks
	 * and processes lines as they are encountered. This keeps memory usage predictable
	 * even for very large command outputs (e.g., 100MB+ build logs).
	 *
	 * The pattern is treated as a case-insensitive regex. If the pattern is invalid
	 * regex syntax, it's escaped and treated as a literal string.
	 *
	 * Results are limited by the byte limit to prevent excessive output.
	 *
	 * @param artifactPath - Absolute path to the artifact file
	 * @param pattern - Search pattern (regex or literal string)
	 * @param totalSize - Total size of the file in bytes (for display)
	 * @param limit - Maximum bytes of matching content to return
	 * @returns Formatted output with matching lines and their line numbers
	 * @private
	 */
	private async searchInArtifact(
		artifactPath: string,
		pattern: string,
		offset: number,
		totalSize: number,
		limit: number,
		signal?: AbortSignal,
	): Promise<SearchArtifactResult> {
		if (pattern.length < 1 || pattern.length > READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH) {
			throw new Error(
				`Invalid search pattern. It must be a string from 1 to ${READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH} characters.`,
			)
		}
		if (isUnsafeSearchPattern(pattern)) {
			throw new Error("Invalid search pattern. Potentially unsafe regular-expression constructs are rejected.")
		}

		const CHUNK_SIZE = READ_CHUNK_SIZE

		// Create case-insensitive regex for search
		let regex: RegExp
		try {
			regex = new RegExp(pattern, "i")
		} catch {
			// If invalid regex, treat as literal string
			regex = new RegExp(this.escapeRegExp(pattern), "i")
		}

		const fileHandle = await openArtifact(artifactPath, signal)
		const matches: Array<{ lineNumber: number; content: string }> = []
		let renderedMatchBytes = 0
		let readStart = offset
		let lineNumber = 0
		let partialLine = "" // Bounded incomplete line from the current chunk sequence
		let partialLineBytes = 0
		let partialLineOverflow = false
		let loadedBytes = offset
		let processedBytes = offset
		let observedMatchCount = 0
		let truncated = false
		let incomplete = false
		const decoder = new StringDecoder("utf8")
		let decoderPendingBytes = 0
		let closeError: unknown
		const matchContentBudget = Math.max(0, limit - SEARCH_METADATA_RESERVE_BYTES)
		let budgetExhausted = false

		const retainMatch = (matchedLineNumber: number, line: string) => {
			observedMatchCount++

			const linePrefix = `${String(matchedLineNumber).padStart(5)} | `
			const linePrefixBytes = Buffer.byteLength(linePrefix, "utf8")
			const separatorBytes = matches.length > 0 ? 1 : 0
			const fullLineBytes = separatorBytes + linePrefixBytes + Buffer.byteLength(line, "utf8")
			const remainingBytes = matchContentBudget - renderedMatchBytes

			if (fullLineBytes <= remainingBytes) {
				matches.push({ lineNumber: matchedLineNumber, content: line })
				renderedMatchBytes += fullLineBytes
				budgetExhausted = renderedMatchBytes === matchContentBudget
				return
			}

			truncated = true
			const contentBudget = remainingBytes - separatorBytes - linePrefixBytes
			if (contentBudget <= 0) {
				return
			}

			const retainedContent = this.truncateUtf8(line, contentBudget)
			const retainedLineBytes = separatorBytes + Buffer.byteLength(linePrefix, "utf8") + Buffer.byteLength(retainedContent, "utf8")
			if (retainedLineBytes <= remainingBytes) {
				matches.push({ lineNumber: matchedLineNumber, content: retainedContent })
				renderedMatchBytes += retainedLineBytes
			}
		}

		const resetPartialLine = () => {
			partialLine = ""
			partialLineBytes = 0
			partialLineOverflow = false
		}
		const appendPartialLine = (segment: string) => {
			if (partialLineOverflow || segment.length === 0) return
			const segmentBytes = Buffer.byteLength(segment, "utf8")
			const remainingBytes = READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES - partialLineBytes
			if (segmentBytes <= remainingBytes) {
				partialLine += segment
				partialLineBytes += segmentBytes
				return
			}

			if (remainingBytes > 0) partialLine += this.truncateUtf8(segment, remainingBytes)
			partialLineBytes = READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES
			partialLineOverflow = true
		}
		const processCompleteLine = (lineEnd: number) => {
			lineNumber++
			if (partialLineOverflow) {
				incomplete = true
				truncated = true
				return
			}

			const line = partialLine.endsWith("\r") ? partialLine.slice(0, -1) : partialLine
			if (regex.test(line)) {
				retainMatch(lineNumber, line)
				if (budgetExhausted && lineEnd < totalSize) truncated = true
			} else if (budgetExhausted && lineEnd < totalSize) {
				truncated = true
			}
		}
		const processDecodedChunk = (decoded: string, chunkStart: number, pendingBytes: number) => {
			let segmentStart = 0
			let decodedBytesConsumed = 0
			let processedThrough = processedBytes
			for (let index = 0; index < decoded.length; index++) {
				signal?.throwIfAborted()
				if (decoded[index] !== "\n") continue
				const segment = decoded.slice(segmentStart, index)
				appendPartialLine(segment)
				decodedBytesConsumed += Buffer.byteLength(segment, "utf8") + 1
				const lineEnd = chunkStart + Math.max(0, decodedBytesConsumed - pendingBytes)
				processCompleteLine(lineEnd)
				processedThrough = lineEnd
				resetPartialLine()
				segmentStart = index + 1
				if (truncated) break
			}
			if (!truncated) {
				const remainder = decoded.slice(segmentStart)
				appendPartialLine(remainder)
				decodedBytesConsumed += Buffer.byteLength(remainder, "utf8")
				if (partialLineOverflow) {
					incomplete = true
					truncated = true
					processedThrough = chunkStart + Math.max(0, decodedBytesConsumed - pendingBytes)
				}
			}
			return processedThrough
		}

		try {
			readStart = await this.alignReadStart(fileHandle, offset, totalSize, signal)
			lineNumber = readStart > 0 ? (await this.countNewlinesBeforeOffset(fileHandle, readStart, signal)) - 1 : 0
			loadedBytes = readStart
			processedBytes = readStart

			while (loadedBytes < totalSize && !truncated) {
				signal?.throwIfAborted()
				const chunkSize = Math.min(CHUNK_SIZE, totalSize - loadedBytes)
				const buffer = Buffer.alloc(chunkSize)
				const chunkStart = loadedBytes
				const result = await awaitWithAbort(fileHandle.read(buffer, 0, chunkSize, chunkStart), signal)
				signal?.throwIfAborted()

				if (result.bytesRead === 0) {
					break
				}

				const chunkBytes = Math.min(result.bytesRead, chunkSize)
				if (chunkBytes === 0) break
				const pendingBytes = decoderPendingBytes
				const chunk = decoder.write(buffer.subarray(0, chunkBytes))
				loadedBytes += chunkBytes
				decoderPendingBytes = Math.max(0, pendingBytes + chunkBytes - Buffer.byteLength(chunk, "utf8"))

				processedBytes = Math.max(processedBytes, processDecodedChunk(chunk, chunkStart, pendingBytes))
			}

			if (!truncated) {
				const decoded = decoder.end()
				processedBytes = Math.max(processedBytes, processDecodedChunk(decoded, loadedBytes, decoderPendingBytes))
				decoderPendingBytes = 0
				// A non-empty unterminated line is a complete search candidate at EOF.
				if (!truncated && (partialLineBytes > 0 || partialLine.length > 0)) {
					processCompleteLine(totalSize)
					processedBytes = totalSize
				}
			}
		} finally {
			try {
				await fileHandle.close()
			} catch (error) {
				if (!signal?.aborted) {
					closeError = error
				}
			}
		}

		if (closeError) {
			throw closeError
		}

		const artifactId = path.basename(artifactPath).slice(0, READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH)
		const displayPattern = this.formatSearchPattern(pattern)
		const header = `[Command Output: ${artifactId}] (search: ${displayPattern})`
		const range = `Showing bytes ${readStart}-${processedBytes}`
		const matchedLines = matches.map((m) => `${String(m.lineNumber).padStart(5)} | ${m.content}`).join("\n")
		const status =
			observedMatchCount === 0
				? incomplete
					? "Search incomplete; no complete matches were observed."
					: "No matches found for the search pattern."
				: incomplete
					? `At least ${observedMatchCount} matches observed | Showing ${matches.length} | INCOMPLETE`
					: truncated
						? `At least ${observedMatchCount} matches observed | Showing ${matches.length} | TRUNCATED`
						: `Total matches: ${observedMatchCount} | Showing ${matches.length}`
		const explanation = incomplete
			? `Search stopped because a line exceeded the ${this.formatBytes(READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES)} scan bound; matching content may be omitted.`
			: truncated
				? `Search stopped at the ${this.formatBytes(limit)} output budget; the remaining artifact was not scanned.`
				: undefined
		const metadata = [
			header,
			`Total size: ${this.formatBytes(totalSize)} | ${range}`,
			status,
			...(explanation ? [explanation] : []),
			"",
		].join("\n")
		let content = metadata + (matchedLines ? matchedLines : observedMatchCount === 0 ? "" : "No matching lines fit within the requested output limit.")
		if (Buffer.byteLength(content, "utf8") > limit) {
			const availableBytes = limit - Buffer.byteLength(metadata, "utf8")
			content =
				availableBytes > 0
					? metadata + this.truncateUtf8(matchedLines, availableBytes)
					: this.truncateUtf8(metadata, limit)
			truncated = true
		}
		return {
			content,
			matchCount: observedMatchCount,
			readStart,
			readEnd: processedBytes,
			nextOffset: processedBytes,
			bytesRead: processedBytes,
			truncated,
			incomplete,
		}
	}

	/**
	 * Keep a UTF-8 string within a byte budget without splitting a code point.
	 * This is used for bounded read/search rendering and display metadata.
	 */
	private truncateUtf8(value: string, maxBytes: number): string {
		const boundedMaxBytes = Math.floor(maxBytes)
		if (boundedMaxBytes <= 0) {
			return ""
		}
		const encoded = Buffer.from(value, "utf8")
		if (encoded.length <= boundedMaxBytes) {
			return value
		}
		const safeBytes = getUtf8SafePrefixLength(encoded.subarray(0, boundedMaxBytes))
		return encoded.subarray(0, safeBytes).toString("utf8")
	}

	private formatSearchPattern(pattern: string): string {
		const patternBytes = Buffer.byteLength(pattern, "utf8")
		const displayPattern =
			patternBytes > READ_COMMAND_OUTPUT_MAX_DISPLAY_PATTERN_BYTES
				? `${this.truncateUtf8(pattern, READ_COMMAND_OUTPUT_MAX_DISPLAY_PATTERN_BYTES - 3)}...`
				: pattern
		const sanitized = [...displayPattern]
			.map((character) => {
				const code = character.charCodeAt(0)
				return code <= 0x1f || code === 0x7f ? "�" : character
			})
			.join("")
		return JSON.stringify(sanitized)
	}

	/**
	 * Format a byte count to a human-readable string.
	 *
	 * @param bytes - The byte count to format
	 * @returns Human-readable string (e.g., "1.5KB", "2.3MB")
	 * @private
	 */
	private formatBytes(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} bytes`
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)}KB`
		}
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
	}

	/**
	 * Escape special regex characters in a string for literal matching.
	 *
	 * @param string - The string to escape
	 * @returns The escaped string safe for use in a RegExp constructor
	 * @private
	 */
	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	/**
	 * Count newlines before a given byte offset using fixed-size chunks.
	 *
	 * This avoids allocating a buffer of size `offset` which could be huge
	 * for large files. Instead, we read in 64KB chunks and count newlines.
	 *
	 * @param fileHandle - Open file handle for reading
	 * @param offset - The byte offset to count newlines up to
	 * @returns The line number at the given offset (1-indexed)
	 * @private
	 */
	private async countNewlinesBeforeOffset(
		fileHandle: fs.FileHandle,
		offset: number,
		signal?: AbortSignal,
	): Promise<number> {
		const CHUNK_SIZE = 64 * 1024 // 64KB chunks
		let newlineCount = 0
		let bytesRead = 0

		while (bytesRead < offset) {
			signal?.throwIfAborted()
			const chunkSize = Math.min(CHUNK_SIZE, offset - bytesRead)
			const buffer = Buffer.alloc(chunkSize)
			const result = await awaitWithAbort(fileHandle.read(buffer, 0, chunkSize, bytesRead), signal)
			signal?.throwIfAborted()

			if (result.bytesRead === 0) {
				break
			}

			// Count newlines in this chunk
			for (let i = 0; i < result.bytesRead; i++) {
				if (buffer[i] === 0x0a) {
					// '\n'
					newlineCount++
				}
			}

			bytesRead += result.bytesRead
		}

		return newlineCount + 1 // Line numbers are 1-indexed
	}
}

/** Singleton instance of the ReadCommandOutputTool */
export const readCommandOutputTool = new ReadCommandOutputTool()
