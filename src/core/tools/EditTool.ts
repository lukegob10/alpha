import fs from "fs/promises"
import path from "path"
import { isUtf8 } from "node:buffer"

import { type AlphaSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { fileEditContent, normalizeToLF } from "./fileEditContent"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"

interface EditParams {
	file_path: string
	old_string: string
	new_string: string
	replace_all?: boolean
}

export class EditTool extends BaseTool<"edit"> {
	readonly name = "edit" as const

	async execute(params: EditParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { file_path: relPath, old_string: oldString, new_string: newString, replace_all: replaceAll } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "file_path"))
				return
			}

			if (!oldString) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "old_string"))
				return
			}

			if (newString === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "new_string"))
				return
			}

			// Check old_string !== new_string
			if (oldString === newString) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(
					formatResponse.toolError(
						"'old_string' and 'new_string' are identical. No changes needed. If you want to make a change, ensure 'old_string' and 'new_string' are different.",
					),
				)
				return
			}

			const accessAllowed = task.alphaIgnoreController?.validateAccess(relPath)

			if (!accessAllowed) {
				callbacks.setResultMetadata?.({ status: "denied" })
				await task.say("alphaignore_error", relPath)
				pushToolResult(formatResponse.alphaIgnoreError(relPath))
				return
			}

			// Check if file is write-protected
			const isWriteProtected = task.alphaProtectedController?.isWriteProtected(relPath) || false

			const absolutePath = path.resolve(task.cwd, relPath)

			const fileExists = await fileExistsAtPath(absolutePath)
			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				const errorMessage = `File not found: ${relPath}. Cannot perform edit on a non-existent file.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			let bytes: Buffer
			try {
				bytes = await fs.readFile(absolutePath, { signal: callbacks.signal })
			} catch {
				callbacks.signal?.throwIfAborted()
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				const errorMessage = `Failed to read file '${relPath}'. Please verify file permissions and try again.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			if (!isUtf8(bytes) || bytes.includes(0)) {
				task.recordToolError("edit")
				pushToolResult(formatResponse.toolError("Exact-text editing requires a UTF-8 text file."))
				return
			}
			const originalFileContent = bytes.toString("utf8")
			const projection = fileEditContent(originalFileContent)
			const fileContent = projection.content

			// Normalize line endings in old_string/new_string to match file content
			const normalizedOld = normalizeToLF(oldString)
			const normalizedNew = normalizeToLF(newString)

			const firstMatch = fileContent.indexOf(normalizedOld)
			if (firstMatch === -1) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit", "no_match")
				pushToolResult(
					formatResponse.toolError(
						`No match found for 'old_string' in ${relPath}. Make sure the text to find appears exactly in the file, including whitespace and indentation.`,
					),
				)
				return
			}

			if (!replaceAll && fileContent.indexOf(normalizedOld, firstMatch + 1) !== -1) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(
					formatResponse.toolError(
						"Found multiple matches of 'old_string'. Include more context for a unique match, or use 'replace_all: true' to replace every occurrence.",
					),
				)
				return
			}

			// Multiple matches are allowed only when replace_all is enabled above.
			const newContent = projection.restore(fileContent.replaceAll(normalizedOld, () => normalizedNew))
			// Check if any changes were made
			if (newContent === originalFileContent) {
				pushToolResult(`No changes needed for '${relPath}'`)
				return
			}

			task.consecutiveMistakeCount = 0

			// Initialize diff view
			task.diffViewProvider.editType = "modify"
			task.diffViewProvider.originalContent = originalFileContent

			// Generate and validate diff
			const diff = formatResponse.createPrettyPatch(relPath, originalFileContent, newContent)
			if (!diff) {
				pushToolResult(`No changes needed for '${relPath}'`)
				await task.diffViewProvider.reset()
				return
			}

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS

			const sanitizedDiff = sanitizeUnifiedDiff(diff)
			const diffStats = computeDiffStats(sanitizedDiff) || undefined
			const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

			const sharedMessageProps: AlphaSayTool = {
				tool: "appliedDiff",
				path: getTaskReadablePath(task, relPath),
				diff: sanitizedDiff,
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: sanitizedDiff,
				originalContent: originalFileContent,
				finalContent: newContent,
				isProtected: isWriteProtected,
				diffStats,
			} satisfies AlphaSayTool)

			const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)
			callbacks.signal?.throwIfAborted()
			if (!didApprove) {
				callbacks.setResultMetadata?.({ status: "denied" })
				pushToolResult("Changes were rejected by the user.")
				await task.diffViewProvider.reset()
				return
			}

			// Approval is shown inline. Preserve the raw baseline when committing
			// without opening an editor; matching used a normalized projection.
			await task.diffViewProvider.saveDirectly(
				relPath,
				newContent,
				false,
				diagnosticsEnabled,
				writeDelayMs,
				{ exists: true, content: originalFileContent },
				() => {
					callbacks.signal?.throwIfAborted()
					if (!isWriteProtected && task.alphaProtectedController?.isWriteProtected(relPath)) {
						throw new Error("The file became write-protected after approval. Request a new edit.")
					}
				},
			)

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "alpha_edited" as RecordSource)
			}

			task.didEditFile = true

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
			pushToolResult(message)

			// Record successful tool usage and cleanup
			task.recordToolUsage("edit")
			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()
		} catch (error) {
			await handleError("edit", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"edit">): Promise<void> {
		const relPath: string | undefined = block.params.file_path

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		// relPath is guaranteed non-null after hasPathStabilized
		const absolutePath = path.resolve(task.cwd, relPath!)
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		const sharedMessageProps: AlphaSayTool = {
			tool: "appliedDiff",
			path: getTaskReadablePath(task, relPath!),
			diff: block.params.old_string ? "1 edit operation" : undefined,
			isOutsideWorkspace,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const editTool = new EditTool()
