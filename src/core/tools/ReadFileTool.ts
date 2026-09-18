/**
 * ReadFileTool - Codex-inspired file reading with indentation mode support.
 *
 * Supports two modes:
 * 1. Slice mode (default): Read contiguous lines with offset/limit
 * 2. Indentation mode: Extract semantic code blocks based on indentation hierarchy
 *
 * Also supports legacy format for backward compatibility:
 * - Legacy format: { files: [{ path: string, lineRanges?: [...] }] }
 */
import path from "path"
import * as fs from "fs/promises"
import { createHash } from "crypto"
import { isBinaryFile } from "isbinaryfile"

import type { ReadFileParams, ReadFileToolParams, FileEntry, LineRange } from "@alpha-code/types"
import { isLegacyReadFileParams, type AlphaSayTool } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { extractTextFromFile, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { FileReadSelectionError, prepareFileRead, renderFileRead, type FileReadContent } from "./readFileContent"
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../agent/ToolPolicy"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"
import type { ToolUse } from "../../shared/tools"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"
import { BaseTool, ToolCallbacks, type ToolApprovalResponse, type TrustedToolProgressObservation } from "./BaseTool"
import { getTaskDisplayPath, getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Internal entry structure for tracking file read parameters.
 */
interface InternalFileEntry extends FileEntry {
	anchor_line?: number
	max_levels?: number
	include_siblings?: boolean
	include_header?: boolean
	max_lines?: number
}

interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending"
	content?: string
	error?: string
	notice?: string
	preparedContent?: FileReadContent
	nativeContent?: string
	imageDataUrl?: string
	observedContent?: string
	feedbackText?: string
	feedbackImages?: string[]
	// Store the original entry for mode processing
	entry?: InternalFileEntry
}

function decodeTextBuffer(buffer: Buffer): string {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.subarray(3).toString("utf8")
	}
	return buffer.toString("utf8")
}

function readProgress(scope: string, content: string): TrustedToolProgressObservation {
	return { kind: "read", scope, stateFingerprint: createHash("sha256").update(content).digest("hex") }
}

interface FileReadFailure {
	message: string
	shouldShowDiagnostic: boolean
}

function describeFileReadFailure(error: unknown): FileReadFailure {
	// Bad offsets and stale/invalid cursors are tool-call errors the model can
	// repair. Keep the failed result, without presenting an extension failure.
	if (error instanceof FileReadSelectionError) {
		return { message: error.message, shouldShowDiagnostic: false }
	}
	const rawMessage = error instanceof Error ? error.message : String(error)
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code.toUpperCase()
			: undefined
	const pathIsUnavailable = code === "ENOENT" || code === "ENOTDIR" || /\b(?:ENOENT|ENOTDIR)\b/i.test(rawMessage)

	if (code === "EISDIR" || /\bEISDIR\b/i.test(rawMessage)) {
		return {
			message: "Cannot read the requested path because it is a directory. Use list_files tool instead.",
			shouldShowDiagnostic: false,
		}
	}

	if (pathIsUnavailable) {
		return {
			message:
				"File not found at the requested path. It may have been moved or deleted since it was discovered. " +
				"Use list_files or search_files to find its current path before retrying.",
			shouldShowDiagnostic: false,
		}
	}

	return { message: rawMessage, shouldShowDiagnostic: true }
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

export class ReadFileTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const

	async execute(params: ReadFileToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		if (!params || typeof params !== "object" || Array.isArray(params)) {
			callbacks.setResultMetadata?.({ status: "error" })
			task.didToolFailInCurrentTurn = true
			callbacks.pushToolResult("Error: read_file arguments must be an object.")
			return
		}
		const batch = isLegacyReadFileParams(params)
		if (batch && (!Array.isArray(params.files) || !params.files.length)) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult(`Error: ${await task.sayAndCreateMissingParamError("read_file", "files")}`)
			return
		}
		if (!batch && (typeof params.path !== "string" || !params.path.trim())) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult(`Error: ${await task.sayAndCreateMissingParamError("read_file", "path")}`)
			return
		}
		const entries = batch ? params.files : [params]
		if (entries.length > 8) {
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult("Error: read_file supports at most 8 files per request.")
			return
		}
		const defaults = {
			mode: params.mode,
			offset: params.offset,
			limit: params.limit,
			indentation: params.indentation,
			continuation: params.continuation,
		}
		const normalized = entries.map((entry) => {
			if (!entry || typeof entry !== "object") return { path: "" }
			const value: FileEntry = {
				...Object.fromEntries(Object.entries(defaults).filter(([, value]) => value != null)),
				...Object.fromEntries(Object.entries(entry).filter(([, value]) => value != null)),
				path: entry.path,
			}
			// Saved calls may retain raw legacy ranges beside the parser's normalized selection.
			value.lineRanges = value.lineRanges ?? value.line_ranges
			if (value.indentation && typeof value.indentation === "object")
				value.indentation = Object.fromEntries(
					Object.entries(value.indentation).filter(([, value]) => value != null),
				)
			return value
		})
		await this.executeNew(normalized, task, callbacks, batch)
	}

	/**
	 * Execute normalized file selections through shared approval, reading, and rendering.
	 */
	private async executeNew(
		entries: FileEntry[],
		task: Task,
		callbacks: ToolCallbacks,
		batch: boolean,
	): Promise<void> {
		const supportsImages = task.api.getModel().info.supportsImages ?? false
		const fileResults: FileResult[] = entries.map((entry) => {
			const error = this.validateLegacyEntry(entry) ?? this.validateNewParams(entry)
			if (error) {
				task.didToolFailInCurrentTurn = true
				callbacks.setResultMetadata?.({ status: "error" })
			}
			return {
				path: entry.path || "<missing path>",
				entry: { ...entry, ...entry.indentation },
				status: error ? "error" : "pending",
				...(error ? { error, nativeContent: `File: ${entry.path || "<missing path>"}\nError: ${error}` } : {}),
			}
		})

		const updateFileResult = (result: FileResult, updates: Partial<FileResult>) => {
			Object.assign(result, updates)
		}

		try {
			// Phase 1: Validate and filter files for approval
			const filesToApprove: FileResult[] = []

			for (const fileResult of fileResults) {
				if (fileResult.status !== "pending") continue
				const relPath = fileResult.path

				// RooIgnore validation
				const accessAllowed = task.alphaIgnoreController?.validateAccess(relPath)
				if (accessAllowed === false) {
					await task.say("rooignore_error", relPath)
					const errorMsg = formatResponse.alphaIgnoreError(relPath)
					updateFileResult(fileResult, {
						status: "blocked",
						error: errorMsg,
						nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
					})
					callbacks.setResultMetadata?.({ status: "denied" })
					continue
				}

				filesToApprove.push(fileResult)
			}

			// Phase 2: Request user approval
			const approvalResolved = await this.requestApproval(task, filesToApprove, updateFileResult, callbacks)
			if (!approvalResolved || this.isCancelled(task, callbacks)) {
				if (this.isCancelled(task, callbacks)) {
					callbacks.setResultMetadata?.({ status: "cancelled" })
				}
				return
			}

			// Phase 3: Process approved files
			const imageMemoryTracker = new ImageMemoryTracker()
			const state = await task.providerRef.deref()?.getState()
			const {
				maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			} = state ?? {}

			for (const fileResult of fileResults) {
				if (fileResult.status !== "approved") continue
				callbacks.signal?.throwIfAborted()

				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)
				const entry = fileResult.entry!

				try {
					// Check if path is a directory
					const stats = await fs.stat(fullPath)
					callbacks.signal?.throwIfAborted()
					if (stats.isDirectory()) {
						const errorMsg = `Cannot read '${relPath}' because it is a directory. Use list_files tool instead.`
						updateFileResult(fileResult, {
							status: "error",
							error: errorMsg,
							nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
						})
						callbacks.setResultMetadata?.({ status: "error" })
						// A model path mistake is recoverable through the tool result, like a missing file.
						continue
					}

					// Check for binary file
					const isBinary = await isBinaryFile(fullPath)
					callbacks.signal?.throwIfAborted()

					if (isBinary) {
						await this.handleBinaryFile(
							task,
							relPath,
							fullPath,
							entry,
							supportsImages,
							maxImageFileSize,
							maxTotalImageSize,
							imageMemoryTracker,
							(_path, updates) => updateFileResult(fileResult, updates),
							callbacks,
						)
						continue
					}

					// Read text file content with lossy UTF-8 conversion
					// Reading as Buffer first allows graceful handling of non-UTF8 bytes
					// (they become U+FFFD replacement characters instead of throwing)
					const buffer = callbacks.signal
						? await fs.readFile(fullPath, { signal: callbacks.signal })
						: await fs.readFile(fullPath)
					callbacks.signal?.throwIfAborted()
					const fileContent = decodeTextBuffer(buffer)
					const preparedContent = prepareFileRead(fileContent, fullPath, entry)

					await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

					updateFileResult(fileResult, {
						preparedContent,
					})
				} catch (error) {
					if (this.isCancelled(task, callbacks)) throw error
					const failure = describeFileReadFailure(error)
					updateFileResult(fileResult, {
						status: "error",
						error: `Error reading file: ${failure.message}`,
						nativeContent: `File: ${relPath}\nError: ${failure.message}`,
					})
					callbacks.setResultMetadata?.({ status: "error" })
					if (failure.shouldShowDiagnostic) {
						await task.say("error", `Error reading file ${relPath}: ${failure.message}`)
					}
				}
			}

			// Phase 4: Build and return result
			const hasErrors = fileResults.some((r) => r.status === "error" || r.status === "blocked")
			if (hasErrors) {
				task.didToolFailInCurrentTurn = true
			}

			this.buildAndPushResult(task, fileResults, callbacks)
			const observations = fileResults
				.filter((result) => result.status === "approved" && result.observedContent !== undefined)
				.map((result) => readProgress(path.resolve(task.cwd, result.path), result.observedContent!))
			if (observations.length)
				callbacks.setResultMetadata?.({
					trustedProgress: batch ? observations : observations[0],
					...(fileResults.every((result) => result.status === "approved")
						? { status: "success" as const }
						: {}),
				})
		} catch (error) {
			if (this.isCancelled(task, callbacks)) {
				callbacks.setResultMetadata?.({ status: "cancelled" })
				return
			}
			const failure = describeFileReadFailure(error)
			for (const result of fileResults) {
				if (result.status !== "pending" && result.status !== "approved") continue
				updateFileResult(result, {
					status: "error",
					error: failure.message,
					preparedContent: undefined,
					nativeContent: `File: ${result.path}\nError: ${failure.message}`,
				})
			}

			if (failure.shouldShowDiagnostic) {
				await task.say("error", `Error reading files: ${failure.message}`)
			}
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })

			this.buildAndPushResult(task, fileResults, callbacks)
		}
	}

	private validateNewParams(params: ReadFileParams): string | undefined {
		if (params.continuation != null) {
			if (typeof params.continuation !== "string" || !params.continuation)
				return "continuation must be a non-empty string."
			if (
				params.offset !== undefined ||
				params.limit !== undefined ||
				params.indentation !== undefined ||
				params.mode === "indentation" ||
				(params as FileEntry).lineRanges?.length
			)
				return "Use continuation without offset, limit, indentation, or line ranges."
		}
		if (params.mode !== undefined && params.mode !== "slice" && params.mode !== "indentation") {
			return `mode must be either 'slice' or 'indentation' (got ${String(params.mode)}).`
		}

		const validateInteger = (value: unknown, name: string, minimum: number, description: string) => {
			if (value === undefined) return undefined
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
				return `${name} must be ${description} (got ${String(value)}).`
			}
			return undefined
		}

		const offsetError = validateInteger(params.offset, "offset", 1, "a 1-indexed line number")
		if (offsetError) return `${offsetError} Line numbers start at 1.`

		const limitError = validateInteger(params.limit, "limit", 1, "a positive integer")
		if (limitError) return limitError

		if (
			params.indentation !== undefined &&
			(typeof params.indentation !== "object" || params.indentation === null)
		) {
			return "indentation must be an object."
		}

		const indentation = params.indentation
		if (!indentation) return undefined

		const anchorError = validateInteger(indentation.anchor_line, "anchor_line", 1, "a 1-indexed line number")
		if (anchorError) return `${anchorError} Line numbers start at 1.`

		const maxLevelsError = validateInteger(indentation.max_levels, "max_levels", 0, "a non-negative integer")
		if (maxLevelsError) return maxLevelsError

		const maxLinesError = validateInteger(indentation.max_lines, "max_lines", 1, "a positive integer")
		if (maxLinesError) return maxLinesError

		if (
			(indentation.include_siblings !== undefined && typeof indentation.include_siblings !== "boolean") ||
			(indentation.include_header !== undefined && typeof indentation.include_header !== "boolean")
		) {
			return "indentation.include_siblings and indentation.include_header must be booleans."
		}

		return undefined
	}

	private isCancelled(task: Task, callbacks: ToolCallbacks): boolean {
		return task.abort === true || callbacks.signal?.aborted === true
	}

	private askForApproval(
		task: Task,
		callbacks: ToolCallbacks,
		message: string,
	): Promise<ToolApprovalResponse | undefined> {
		return callbacks.askApprovalResponse
			? callbacks.askApprovalResponse("tool", message)
			: task.ask("tool", message, false)
	}

	/**
	 * Handle binary file processing (images, PDF, DOCX, etc.).
	 */
	private async handleBinaryFile(
		task: Task,
		relPath: string,
		fullPath: string,
		entry: InternalFileEntry,
		supportsImages: boolean,
		maxImageFileSize: number,
		maxTotalImageSize: number,
		imageMemoryTracker: ImageMemoryTracker,
		updateFileResult: (path: string, updates: Partial<FileResult>) => void,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const fileExtension = path.extname(relPath).toLowerCase()
		const supportedBinaryFormats = getSupportedBinaryFormats()

		// Handle image files
		if (isSupportedImageFormat(fileExtension)) {
			try {
				const validationResult = await validateImageForProcessing(
					fullPath,
					supportsImages,
					maxImageFileSize,
					maxTotalImageSize,
					imageMemoryTracker.getTotalMemoryUsed(),
				)

				if (!validationResult.isValid) {
					await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)
					updateFileResult(relPath, {
						nativeContent: `File: ${relPath}\nNote: ${validationResult.notice}`,
					})
					return
				}

				const imageResult = await processImageFile(fullPath)
				imageMemoryTracker.addMemoryUsage(imageResult.sizeInMB)
				await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(relPath, {
					nativeContent: `File: ${relPath}\nNote: ${imageResult.notice}`,
					imageDataUrl: imageResult.dataUrl,
					observedContent: imageResult.dataUrl,
				})
				return
			} catch (error) {
				if (this.isCancelled(task, callbacks)) throw error
				const failure = describeFileReadFailure(error)
				updateFileResult(relPath, {
					status: "error",
					error: `Error reading image file: ${failure.message}`,
					nativeContent: `File: ${relPath}\nError: ${failure.message}`,
				})
				callbacks.setResultMetadata?.({ status: "error" })
				if (failure.shouldShowDiagnostic) {
					await task.say("error", `Error reading image file ${relPath}: ${failure.message}`)
				}
				return
			}
		}

		// Handle other supported binary formats (PDF, DOCX, etc.)
		if (supportedBinaryFormats && supportedBinaryFormats.includes(fileExtension)) {
			try {
				const content = await extractTextFromFile(fullPath)

				await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(relPath, {
					preparedContent: prepareFileRead(content, fullPath, entry),
				})
				return
			} catch (error) {
				if (this.isCancelled(task, callbacks)) throw error
				const failure = describeFileReadFailure(error)
				updateFileResult(relPath, {
					status: "error",
					error: `Error extracting text: ${failure.message}`,
					nativeContent: `File: ${relPath}\nError: ${failure.message}`,
				})
				callbacks.setResultMetadata?.({ status: "error" })
				if (failure.shouldShowDiagnostic) {
					await task.say("error", `Error extracting text from ${relPath}: ${failure.message}`)
				}
				return
			}
		}

		// Unsupported binary format
		const fileFormat = fileExtension.slice(1) || "bin"
		updateFileResult(relPath, {
			notice: `Binary file format: ${fileFormat}`,
			nativeContent: `File: ${relPath}\nBinary file (${fileFormat}) - content not displayed`,
		})
	}

	/**
	 * Request user approval for file reads.
	 */
	private async requestApproval(
		task: Task,
		filesToApprove: FileResult[],
		updateFileResult: (result: FileResult, updates: Partial<FileResult>) => void,
		callbacks: ToolCallbacks,
	): Promise<boolean> {
		if (filesToApprove.length === 0) return true

		if (filesToApprove.length > 1) {
			// Batch approval
			const batchFiles = filesToApprove.map((fileResult) => {
				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)
				const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, fullPath)
				const readablePath = getTaskReadablePath(task, relPath)

				const lineSnippet = this.getLineSnippet(fileResult.entry!)
				const key = `${readablePath}${lineSnippet ? ` (${lineSnippet})` : ""}`

				return {
					path: readablePath,
					lineSnippet,
					isOutsideWorkspace,
					key,
					content: getTaskDisplayPath(task, fullPath),
				}
			})

			const completeMessage = JSON.stringify({ tool: "readFile", batchFiles } satisfies AlphaSayTool)
			// BatchFilePermission can return an objectResponse containing an
			// independent decision for each displayed file. The normal approval
			// callback intentionally reduces responses to a boolean, so use the
			// optional rich channel when the scheduler provides it. Keep the
			// Task.ask fallback for older hosts that do not expose that channel.
			const approval = await this.askForApproval(task, callbacks, completeMessage)

			if (!approval || this.isCancelled(task, callbacks)) return false
			if (
				approval.text &&
				(approval.response === "yesButtonClicked" || approval.response === "noButtonClicked")
			) {
				await task.say("user_feedback", approval.text, approval.images)
			}

			if (approval.response === "yesButtonClicked") {
				filesToApprove.forEach((fr) =>
					updateFileResult(fr, {
						status: "approved",
						...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
					}),
				)
			} else if (approval.response === "noButtonClicked") {
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				filesToApprove.forEach((fr) => {
					updateFileResult(fr, {
						status: "denied",
						nativeContent: `File: ${fr.path}\nStatus: Denied by user`,
						...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
					})
				})
			} else if (approval.response === "objectResponse") {
				try {
					const individualPermissions = JSON.parse(approval.text || "{}")
					if (
						!individualPermissions ||
						typeof individualPermissions !== "object" ||
						Array.isArray(individualPermissions)
					) {
						throw new Error("Batch permission response must be an object.")
					}

					let hasAnyDenial = false
					batchFiles.forEach((batchFile, index) => {
						const fileResult = filesToApprove[index]
						const approved = (individualPermissions as Record<string, unknown>)[batchFile.key] === true

						if (approved) {
							updateFileResult(fileResult, { status: "approved" })
						} else {
							hasAnyDenial = true
							updateFileResult(fileResult, {
								status: "denied",
								nativeContent: `File: ${fileResult.path}\nStatus: Denied by user`,
							})
						}
					})

					if (hasAnyDenial) {
						task.didRejectTool = true
						callbacks.setResultMetadata?.({ status: "denied" })
					}
				} catch {
					task.didRejectTool = true
					callbacks.setResultMetadata?.({ status: "denied" })
					filesToApprove.forEach((fr) => {
						updateFileResult(fr, {
							status: "denied",
							nativeContent: `File: ${fr.path}\nStatus: Denied by user`,
						})
					})
				}
			} else {
				// A free-form response cannot safely grant any file permission.
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				filesToApprove.forEach((fr) => {
					updateFileResult(fr, {
						status: "denied",
						nativeContent: `File: ${fr.path}\nStatus: Denied by user`,
					})
				})
			}
			return true
		} else {
			// Single file approval
			const fileResult = filesToApprove[0]
			const relPath = fileResult.path
			const fullPath = path.resolve(task.cwd, relPath)
			const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, fullPath)
			const lineSnippet = this.getLineSnippet(fileResult.entry!)

			const startLine = this.getStartLine(fileResult.entry!)

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getTaskReadablePath(task, relPath),
				isOutsideWorkspace,
				content: getTaskDisplayPath(task, fullPath),
				reason: lineSnippet,
				startLine,
			} satisfies AlphaSayTool)

			const approval = await this.askForApproval(task, callbacks, completeMessage)
			if (!approval || this.isCancelled(task, callbacks)) return false
			if (approval.text) await task.say("user_feedback", approval.text, approval.images)

			if (approval.response !== "yesButtonClicked") {
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				updateFileResult(fileResult, {
					status: "denied",
					nativeContent: `File: ${relPath}\nStatus: Denied by user`,
					...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
				})
			} else {
				updateFileResult(fileResult, {
					status: "approved",
					...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
				})
			}
			return true
		}
	}

	/**
	 * Get the starting line number for navigation purposes.
	 */
	private getStartLine(entry: InternalFileEntry): number | undefined {
		if (entry.lineRanges?.length) return entry.lineRanges[0].start
		if (entry.mode === "indentation") {
			// For indentation mode, always return the effective anchor line
			return entry.anchor_line ?? entry.offset ?? 1
		}
		const offset = entry.offset ?? 1
		return offset > 1 ? offset : undefined
	}

	/**
	 * Generate a human-readable line snippet for approval messages.
	 */
	private getLineSnippet(entry: InternalFileEntry): string {
		if (entry.continuation) return "(continuing the previous selection)"
		if (entry.lineRanges?.length)
			return `(lines ${entry.lineRanges.map(({ start, end }) => `${start}-${end}`).join(", ")})`
		if (entry.mode === "indentation") {
			// Always show indentation mode with the effective anchor line
			const effectiveAnchor = entry.anchor_line ?? entry.offset ?? 1
			return `(indentation mode at line ${effectiveAnchor})`
		}

		const limit = entry.limit ?? DEFAULT_LINE_LIMIT
		const offset1 = entry.offset ?? 1

		if (offset1 > 1) {
			return `(lines ${offset1}-${offset1 + limit - 1})`
		}

		// Always show the line limit, even when using the default
		return `(up to ${limit} lines)`
	}

	/**
	 * Build and push the final result to the tool output.
	 */
	private buildAndPushResult(task: Task, fileResults: FileResult[], callbacks: ToolCallbacks): void {
		const { pushToolResult } = callbacks

		const fileImageUrls = fileResults.filter((r) => r.imageDataUrl).map((r) => r.imageDataUrl as string)

		let statusMessage = ""
		let feedbackImages: string[] = []

		const deniedWithFeedback = fileResults.find((r) => r.status === "denied" && r.feedbackText)

		if (deniedWithFeedback?.feedbackText) {
			statusMessage = formatResponse.toolDeniedWithFeedback(deniedWithFeedback.feedbackText)
			feedbackImages = deniedWithFeedback.feedbackImages || []
		} else if (task.didRejectTool) {
			statusMessage = formatResponse.toolDenied()
		} else {
			const approvedWithFeedback = fileResults.find((r) => r.status === "approved" && r.feedbackText)
			if (approvedWithFeedback?.feedbackText) {
				statusMessage = formatResponse.toolApprovedWithFeedback(approvedWithFeedback.feedbackText)
				feedbackImages = approvedWithFeedback.feedbackImages || []
			}
		}

		let remaining = Math.max(
			0,
			(callbacks.getRemainingOutputChars?.() ?? DEFAULT_TOOL_OUTPUT_LIMIT) -
				statusMessage.length -
				(statusMessage ? 2 : 0) -
				Math.max(0, fileResults.length - 1) * 7,
		)
		const sections = fileResults.map((result, index) => {
			const allowance = Math.floor(remaining / (fileResults.length - index))
			if (result.preparedContent) {
				try {
					const rendered = renderFileRead(result.preparedContent, allowance)
					result.nativeContent = rendered.content
					result.observedContent = rendered.observedContent
				} catch (error) {
					result.status = "error"
					task.didToolFailInCurrentTurn = true
					callbacks.setResultMetadata?.({ status: "error" })
					result.nativeContent = `File: ${result.path}\nError: ${error instanceof Error ? error.message : String(error)}`
				}
			}
			let section = result.nativeContent ?? `File: ${result.path}\nStatus: Not read`
			if (section.length > allowance) {
				const notice = "\n[Details omitted: retry this file alone.]"
				section = (section.slice(0, Math.max(0, allowance - notice.length)) + notice).slice(0, allowance)
				result.observedContent = undefined
			}
			remaining -= section.length
			return section
		})
		const finalResult = sections.join("\n\n---\n\n")

		const allImages = [...feedbackImages, ...fileImageUrls]
		const finalModelSupportsImages = task.api.getModel().info.supportsImages ?? false
		const imagesToInclude = finalModelSupportsImages ? allImages : []

		if (statusMessage || imagesToInclude.length > 0) {
			const result = formatResponse.toolResult(
				statusMessage || finalResult,
				imagesToInclude.length > 0 ? imagesToInclude : undefined,
			)

			if (typeof result === "string") {
				pushToolResult(statusMessage ? `${result}\n${finalResult}` : result)
			} else {
				if (statusMessage) {
					const textBlock = { type: "text" as const, text: finalResult }
					pushToolResult([...result, textBlock] as any)
				} else {
					pushToolResult(result as any)
				}
			}
		} else {
			pushToolResult(finalResult)
		}
	}

	getReadFileToolDescription(blockName: string, blockParams: { path?: string }): string
	getReadFileToolDescription(blockName: string, nativeArgs: ReadFileParams): string
	getReadFileToolDescription(blockName: string, second: unknown): string {
		// If native typed args were provided
		if (second && typeof second === "object" && "path" in second && typeof (second as any).path === "string") {
			return `[${blockName} for '${(second as any).path}']`
		}

		const blockParams = second as Record<string, unknown>
		if (blockParams?.path) {
			return `[${blockName} for '${blockParams.path}']`
		}
		return `[${blockName} with missing path]`
	}

	override async handlePartial(task: Task, block: ToolUse<"read_file">): Promise<void> {
		// Handle both legacy and new format for partial display
		let filePath = ""
		if (block.nativeArgs) {
			if (isLegacyReadFileParams(block.nativeArgs)) {
				// Legacy format - show first file
				filePath = block.nativeArgs.files[0]?.path ?? ""
			} else {
				filePath = block.nativeArgs.path ?? ""
			}
		}

		const fullPath = filePath ? path.resolve(task.cwd, filePath) : ""
		const sharedMessageProps: AlphaSayTool = {
			tool: "readFile",
			path: getTaskReadablePath(task, filePath),
			isOutsideWorkspace: filePath ? isTaskPathOutsideWorkspace(task, fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies AlphaSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}

	private validateLegacyEntry(value: unknown): string | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return "Each files entry must be an object with a non-empty path."
		}

		const entry = value as { path?: unknown; lineRanges?: unknown }
		if (typeof entry.path !== "string" || entry.path.trim() === "") {
			return "Each files entry must include a non-empty path."
		}

		if (entry.lineRanges === undefined) return undefined
		if (!Array.isArray(entry.lineRanges)) return "lineRanges must be an array."
		if (entry.lineRanges.length > 64) return "At most 64 line ranges may be selected per file."

		for (const range of entry.lineRanges) {
			if (
				!range ||
				typeof range !== "object" ||
				Array.isArray(range) ||
				!Number.isSafeInteger((range as LineRange).start) ||
				!Number.isSafeInteger((range as LineRange).end) ||
				(range as LineRange).start < 1 ||
				(range as LineRange).end < (range as LineRange).start
			) {
				return "lineRanges must contain 1-based inclusive ranges with start <= end."
			}
		}

		return undefined
	}
}

export const readFileTool = new ReadFileTool()
