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
import { isBinaryFile } from "isbinaryfile"

import type { ReadFileParams, ReadFileMode, ReadFileToolParams, FileEntry, LineRange } from "@alpha-code/types"
import { isLegacyReadFileParams, type ClineSayTool } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import {
	formatWithLineNumbers,
	parseLines,
	readWithIndentation,
	readWithSlice,
} from "../../integrations/misc/indentation-reader"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"
import type { ToolUse, PushToolResult } from "../../shared/tools"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"
import { BaseTool, ToolCallbacks, type ToolApprovalResponse } from "./BaseTool"
import { getTaskDisplayPath, getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Internal entry structure for tracking file read parameters.
 */
interface InternalFileEntry {
	path: string
	mode?: ReadFileMode
	offset?: number
	limit?: number
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
	nativeContent?: string
	imageDataUrl?: string
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

interface FileReadFailure {
	message: string
	shouldShowDiagnostic: boolean
}

function describeFileReadFailure(error: unknown): FileReadFailure {
	const rawMessage = error instanceof Error ? error.message : String(error)
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code.toUpperCase()
			: undefined
	const pathIsUnavailable = code === "ENOENT" || code === "ENOTDIR" || /\b(?:ENOENT|ENOTDIR)\b/i.test(rawMessage)

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
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult("Error: read_file arguments must be an object.")
			return
		}

		// Dispatch to legacy or new execution path based on format
		if (isLegacyReadFileParams(params)) {
			return this.executeLegacy(params.files, task, callbacks)
		}

		return this.executeNew(params, task, callbacks)
	}

	/**
	 * Execute new single-file format with slice/indentation mode support.
	 */
	private async executeNew(params: ReadFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const modelInfo = task.api.getModel().info
		const filePath = params.path

		// Validate input
		if (typeof filePath !== "string" || filePath.trim() === "") {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			const errorMsg = await task.sayAndCreateMissingParamError("read_file", "path")
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		const supportsImages = modelInfo.supportsImages ?? false

		// Initialize file results tracking
		const validationError = this.validateNewParams(params)
		if (validationError) {
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			pushToolResult(`Error: ${validationError}`)
			return
		}

		const fileEntry: InternalFileEntry = {
			path: filePath,
			mode: params.mode,
			offset: params.offset,
			limit: params.limit,
			anchor_line: params.indentation?.anchor_line,
			max_levels: params.indentation?.max_levels,
			include_siblings: params.indentation?.include_siblings,
			include_header: params.indentation?.include_header,
			max_lines: params.indentation?.max_lines,
		}

		const fileResults: FileResult[] = [
			{
				path: filePath,
				status: "pending" as const,
				entry: fileEntry,
			},
		]

		const updateFileResult = (filePath: string, updates: Partial<FileResult>) => {
			const index = fileResults.findIndex((result) => result.path === filePath)
			if (index !== -1) {
				fileResults[index] = { ...fileResults[index], ...updates }
			}
		}

		try {
			// Phase 1: Validate and filter files for approval
			const filesToApprove: FileResult[] = []

			for (const fileResult of fileResults) {
				const relPath = fileResult.path

				// RooIgnore validation
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (accessAllowed === false) {
					await task.say("rooignore_error", relPath)
					const errorMsg = formatResponse.rooIgnoreError(relPath)
					updateFileResult(relPath, {
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
						updateFileResult(relPath, {
							status: "error",
							error: errorMsg,
							nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
						})
						callbacks.setResultMetadata?.({ status: "error" })
						await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
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
							supportsImages,
							maxImageFileSize,
							maxTotalImageSize,
							imageMemoryTracker,
							updateFileResult,
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
					const result = this.processTextFile(fileContent, entry)

					await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

					updateFileResult(relPath, {
						nativeContent: `File: ${relPath}\n${result}`,
					})
				} catch (error) {
					if (this.isCancelled(task, callbacks)) throw error
					const failure = describeFileReadFailure(error)
					updateFileResult(relPath, {
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

			this.buildAndPushResult(task, fileResults, pushToolResult)
		} catch (error) {
			if (this.isCancelled(task, callbacks)) {
				callbacks.setResultMetadata?.({ status: "cancelled" })
				return
			}
			const relPath = filePath || "unknown"
			const failure = describeFileReadFailure(error)

			updateFileResult(relPath, {
				status: "error",
				error: `Error reading file: ${failure.message}`,
				nativeContent: `File: ${relPath}\nError: ${failure.message}`,
			})

			if (failure.shouldShowDiagnostic) {
				await task.say("error", `Error reading file ${relPath}: ${failure.message}`)
			}
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })

			const errorResult = fileResults
				.filter((r) => r.nativeContent)
				.map((r) => r.nativeContent)
				.join("\n\n---\n\n")

			pushToolResult(errorResult || `Error: ${failure.message}`)
		}
	}

	private validateNewParams(params: ReadFileParams): string | undefined {
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
	 * Process a text file according to the requested mode.
	 */
	private processTextFile(content: string, entry: InternalFileEntry): string {
		if (content.length === 0) return "Note: File is empty"

		const mode = entry.mode || "slice"

		if (mode === "indentation") {
			// Indentation mode: semantic block extraction
			// When anchor_line is not provided, default to offset (which defaults to 1)
			const anchorLine = entry.anchor_line ?? entry.offset ?? 1
			const result = readWithIndentation(content, {
				anchorLine,
				maxLevels: entry.max_levels,
				includeSiblings: entry.include_siblings,
				includeHeader: entry.include_header,
				limit: entry.limit ?? DEFAULT_LINE_LIMIT,
				maxLines: entry.max_lines,
			})

			let output = result.content

			if (result.wasTruncated && result.includedRanges.length > 0) {
				const [start, end] = result.includedRanges[0]
				const nextOffset = end + 1
				const effectiveLimit = entry.limit ?? DEFAULT_LINE_LIMIT
				// Put truncation warning at TOP (before content) to match @ mention format
				output = `IMPORTANT: File content truncated.
	Status: Showing lines ${start}-${end} of ${result.totalLines} total lines.
	To read more: Use the read_file tool with offset=${nextOffset} and limit=${effectiveLimit}.

	${result.content}`
			} else if (result.includedRanges.length > 0) {
				const rangeStr = result.includedRanges.map(([s, e]) => `${s}-${e}`).join(", ")
				output += `\n\nIncluded ranges: ${rangeStr} (total: ${result.totalLines} lines)`
			}

			return output
		}

		// Slice mode (default): simple offset/limit reading
		// NOTE: read_file offset is 1-based externally; convert to 0-based for readWithSlice.
		const offset1 = entry.offset ?? 1
		const offset0 = Math.max(0, offset1 - 1)
		const limit = entry.limit ?? DEFAULT_LINE_LIMIT

		const result = readWithSlice(content, offset0, limit)

		let output = result.content

		if (result.wasTruncated) {
			const startLine = offset1
			const endLine = offset1 + result.returnedLines - 1
			const nextOffset = endLine + 1
			// Put truncation warning at TOP (before content) to match @ mention format
			output = `IMPORTANT: File content truncated.
	Status: Showing lines ${startLine}-${endLine} of ${result.totalLines} total lines.
	To read more: Use the read_file tool with offset=${nextOffset} and limit=${limit}.

	${result.content}`
		} else if (result.returnedLines === 0) {
			output = "Note: File is empty"
		}

		return output
	}

	/**
	 * Handle binary file processing (images, PDF, DOCX, etc.).
	 */
	private async handleBinaryFile(
		task: Task,
		relPath: string,
		fullPath: string,
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
				const numberedContent = addLineNumbers(content)
				const lineCount = content.split("\n").length

				await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(relPath, {
					nativeContent:
						lineCount > 0
							? `File: ${relPath}\nLines 1-${lineCount}:\n${numberedContent}`
							: `File: ${relPath}\nNote: File is empty`,
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
		updateFileResult: (path: string, updates: Partial<FileResult>) => void,
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

			const completeMessage = JSON.stringify({ tool: "readFile", batchFiles } satisfies ClineSayTool)
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
					updateFileResult(fr.path, {
						status: "approved",
						...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
					}),
				)
			} else if (approval.response === "noButtonClicked") {
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				filesToApprove.forEach((fr) => {
					updateFileResult(fr.path, {
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
							updateFileResult(fileResult.path, { status: "approved" })
						} else {
							hasAnyDenial = true
							updateFileResult(fileResult.path, {
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
						updateFileResult(fr.path, {
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
					updateFileResult(fr.path, {
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
			} satisfies ClineSayTool)

			const approval = await this.askForApproval(task, callbacks, completeMessage)
			if (!approval || this.isCancelled(task, callbacks)) return false
			if (approval.text) await task.say("user_feedback", approval.text, approval.images)

			if (approval.response !== "yesButtonClicked") {
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				updateFileResult(relPath, {
					status: "denied",
					nativeContent: `File: ${relPath}\nStatus: Denied by user`,
					...(approval.text ? { feedbackText: approval.text, feedbackImages: approval.images } : {}),
				})
			} else {
				updateFileResult(relPath, {
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
	private buildAndPushResult(task: Task, fileResults: FileResult[], pushToolResult: PushToolResult): void {
		const finalResult = fileResults
			.filter((r) => r.nativeContent)
			.map((r) => r.nativeContent)
			.join("\n\n---\n\n")

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
		const sharedMessageProps: ClineSayTool = {
			tool: "readFile",
			path: getTaskReadablePath(task, filePath),
			isOutsideWorkspace: filePath ? isTaskPathOutsideWorkspace(task, fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}

	/** Execute the bounded multi-file format. */
	private async executeLegacy(fileEntries: FileEntry[], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			const errorMsg = await task.sayAndCreateMissingParamError("read_file", "files")
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		if (fileEntries.length > 8) {
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			pushToolResult("Error: read_file supports at most 8 files per request.")
			return
		}

		if (this.isCancelled(task, callbacks)) {
			callbacks.setResultMetadata?.({ status: "cancelled" })
			return
		}

		let supportsImages = false
		try {
			supportsImages = task.api.getModel().info.supportsImages ?? false
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			pushToolResult(`Error reading file: ${errorMsg}`)
			return
		}

		// Process each file sequentially (legacy behavior)
		const results: string[] = []

		for (const rawEntry of fileEntries as unknown[]) {
			if (this.isCancelled(task, callbacks)) {
				callbacks.setResultMetadata?.({ status: "cancelled" })
				return
			}

			const entryError = this.validateLegacyEntry(rawEntry)
			const relPath =
				rawEntry && typeof rawEntry === "object" && typeof (rawEntry as { path?: unknown }).path === "string"
					? (rawEntry as { path: string }).path
					: "<missing path>"
			if (entryError) {
				task.didToolFailInCurrentTurn = true
				callbacks.setResultMetadata?.({ status: "error" })
				results.push(`File: ${relPath}\nError: ${entryError}`)
				continue
			}

			const entry = rawEntry as FileEntry
			const fullPath = path.resolve(task.cwd, relPath)

			// RooIgnore validation
			const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
			if (accessAllowed === false) {
				await task.say("rooignore_error", relPath)
				const errorMsg = formatResponse.rooIgnoreError(relPath)
				results.push(`File: ${relPath}\nError: ${errorMsg}`)
				task.didToolFailInCurrentTurn = true
				callbacks.setResultMetadata?.({ status: "denied" })
				continue
			}

			// Request approval for single file
			const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, fullPath)
			let lineSnippet = ""
			if (entry.lineRanges && entry.lineRanges.length > 0) {
				const ranges = entry.lineRanges.map((range: LineRange) => `(lines ${range.start}-${range.end})`)
				lineSnippet = ranges.join(", ")
			}

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getTaskReadablePath(task, relPath),
				isOutsideWorkspace,
				content: getTaskDisplayPath(task, fullPath),
				reason: lineSnippet || undefined,
			} satisfies ClineSayTool)

			const approval = await this.askForApproval(task, callbacks, completeMessage)
			if (!approval || this.isCancelled(task, callbacks)) {
				if (this.isCancelled(task, callbacks)) {
					callbacks.setResultMetadata?.({ status: "cancelled" })
				}
				return
			}
			if (approval.text && approval.response !== "objectResponse") {
				await task.say("user_feedback", approval.text, approval.images)
			}

			if (approval.response !== "yesButtonClicked") {
				task.didRejectTool = true
				callbacks.setResultMetadata?.({ status: "denied" })
				results.push(`File: ${relPath}\nStatus: Denied by user`)
				continue
			}

			try {
				callbacks.signal?.throwIfAborted()
				// Check if the path is a directory
				const stats = await fs.stat(fullPath)
				callbacks.signal?.throwIfAborted()
				if (stats.isDirectory()) {
					const errorMsg = `Cannot read '${relPath}' because it is a directory.`
					results.push(`File: ${relPath}\nError: ${errorMsg}`)
					task.didToolFailInCurrentTurn = true
					callbacks.setResultMetadata?.({ status: "error" })
					await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
					continue
				}

				const isBinary = await isBinaryFile(fullPath)
				callbacks.signal?.throwIfAborted()

				if (isBinary) {
					// Handle binary files (images)
					const fileExtension = path.extname(relPath).toLowerCase()
					if (supportsImages && isSupportedImageFormat(fileExtension)) {
						const state = await task.providerRef.deref()?.getState()
						const {
							maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
							maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
						} = state ?? {}
						const validation = await validateImageForProcessing(
							fullPath,
							supportsImages,
							maxImageFileSize,
							maxTotalImageSize,
							0, // Legacy path doesn't track cumulative memory
						)
						if (!validation.isValid) {
							results.push(`File: ${relPath}\nNotice: ${validation.notice ?? "Image validation failed"}`)
							continue
						}
						const imageResult = await processImageFile(fullPath)
						if (imageResult) {
							results.push(`File: ${relPath}\n[Image file - content processed for vision model]`)
						}
					} else {
						results.push(`File: ${relPath}\nError: Cannot read binary file`)
						task.didToolFailInCurrentTurn = true
						callbacks.setResultMetadata?.({ status: "error" })
					}
					continue
				}

				// Read text file
				const buffer = callbacks.signal
					? await fs.readFile(fullPath, { signal: callbacks.signal })
					: await fs.readFile(fullPath)
				callbacks.signal?.throwIfAborted()
				const rawContent = decodeTextBuffer(buffer)

				// Handle line ranges if specified
				let content: string
				if (entry.lineRanges && entry.lineRanges.length > 0) {
					// Keep source line numbers on every selected record. Passing bare
					// strings to formatWithLineNumbers would renumber disjoint ranges
					// from one, making the result unsafe for follow-up edits.
					const lines = parseLines(rawContent).map((line) =>
						line.content.endsWith("\r") ? { ...line, content: line.content.slice(0, -1) } : line,
					)
					const selectedLines = []

					for (const range of entry.lineRanges) {
						// Convert to 0-based index, ranges are 1-based inclusive
						const startIdx = Math.max(0, range.start - 1)
						const endIdx = Math.min(lines.length - 1, range.end - 1)

						for (let i = startIdx; i <= endIdx; i++) {
							selectedLines.push(lines[i])
						}
					}
					content =
						selectedLines.length > 0
							? formatWithLineNumbers(selectedLines)
							: "Note: No lines matched the requested ranges"
				} else {
					// Read with default limits using slice mode
					content =
						rawContent.length === 0
							? "Note: File is empty"
							: (() => {
									const result = readWithSlice(rawContent, 0, DEFAULT_LINE_LIMIT)
									let output = result.content
									if (result.wasTruncated) {
										output += `\n\n[File truncated: showing ${result.returnedLines} of ${result.totalLines} total lines]`
									}
									return output
								})()
				}

				results.push(`File: ${relPath}\n${content}`)

				// Track file in context
				await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			} catch (error) {
				if (this.isCancelled(task, callbacks)) {
					callbacks.setResultMetadata?.({ status: "cancelled" })
					return
				}
				const failure = describeFileReadFailure(error)
				results.push(`File: ${relPath}\nError: ${failure.message}`)
				task.didToolFailInCurrentTurn = true
				callbacks.setResultMetadata?.({ status: "error" })
				if (failure.shouldShowDiagnostic) {
					await task.say("error", `Error reading file ${relPath}: ${failure.message}`)
				}
			}
		}

		// Push combined results
		pushToolResult(results.join("\n\n---\n\n"))
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
