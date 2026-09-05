import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolResponse, ToolUse } from "../../shared/tools"
import { parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange } from "./apply-patch"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"
import type { ExpectedFileState } from "../../integrations/editor/DiffViewProvider"

interface ApplyPatchParams {
	patch: string
}

interface ApplyPatchChangeOutcome {
	status: "success" | "denied" | "error"
	result: ToolResponse
}

function combineToolResponses(responses: ToolResponse[]): ToolResponse {
	if (responses.length === 1) return responses[0]
	if (responses.every((response) => typeof response === "string")) {
		return (responses as string[]).join("\n\n")
	}

	return responses.flatMap((response) =>
		typeof response === "string" ? [{ type: "text" as const, text: response }] : response,
	)
}

export class ApplyPatchTool extends BaseTool<"apply_patch"> {
	readonly name = "apply_patch" as const

	private static readonly FILE_HEADER_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const

	private extractFirstPathFromPatch(patch: string | undefined): string | undefined {
		if (!patch) {
			return undefined
		}

		const lines = patch.split("\n")
		const hasTrailingNewline = patch.endsWith("\n")
		const completeLines = hasTrailingNewline ? lines : lines.slice(0, -1)

		for (const rawLine of completeLines) {
			const line = rawLine.trim()

			for (const marker of ApplyPatchTool.FILE_HEADER_MARKERS) {
				if (!line.startsWith(marker)) {
					continue
				}

				const candidatePath = line.substring(marker.length).trim()
				if (candidatePath.length > 0) {
					return candidatePath
				}
			}
		}

		return undefined
	}

	async execute(params: ApplyPatchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { patch } = params
		const { handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!patch) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_patch", "patch"))
				return
			}

			// Parse the patch
			let parsedPatch
			try {
				parsedPatch = parsePatch(patch)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage =
					error instanceof ParseError
						? `Invalid patch format: ${error.message}`
						: `Failed to parse patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			if (parsedPatch.hunks.length === 0) {
				pushToolResult("No file operations found in patch.")
				return
			}

			// Validate the complete patch before reading any source file. In
			// particular, an ignored later hunk must prevent reads of earlier hunks.
			for (const hunk of parsedPatch.hunks) {
				const paths = [hunk.path, hunk.type === "UpdateFile" ? hunk.movePath : undefined]
				for (const candidatePath of paths) {
					if (!candidatePath || task.rooIgnoreController?.validateAccess(candidatePath) !== false) continue

					await task.say("rooignore_error", candidatePath)
					pushToolResult(formatResponse.rooIgnoreError(candidatePath))
					return
				}
			}

			// Process each hunk
			const readFile = async (filePath: string): Promise<string> => {
				const absolutePath = path.resolve(task.cwd, filePath)
				return await fs.readFile(absolutePath, "utf8")
			}

			let changes: ApplyPatchFileChange[]
			try {
				changes = await processAllHunks(parsedPatch.hunks, readFile)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Failed to process patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			const results: ApplyPatchChangeOutcome[] = []

			// Process each file change, stopping after the first denial or failure.
			for (const change of changes) {
				const relPath = change.path
				const absolutePath = path.resolve(task.cwd, relPath)

				// Check access permissions
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					pushToolResult(formatResponse.rooIgnoreError(relPath))
					return
				}

				// Check if file is write-protected
				const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

				let outcome: ApplyPatchChangeOutcome
				if (change.type === "add") {
					// Create new file
					outcome = await this.handleAddFile(change, absolutePath, relPath, task, callbacks, isWriteProtected)
				} else if (change.type === "delete") {
					// Delete file
					outcome = await this.handleDeleteFile(absolutePath, relPath, task, callbacks, isWriteProtected)
				} else {
					// Update file
					outcome = await this.handleUpdateFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
				}

				results.push(outcome)
				if (outcome.status !== "success") {
					pushToolResult(combineToolResponses(results.map(({ result }) => result)))
					return
				}
			}

			pushToolResult(combineToolResponses(results.map(({ result }) => result)))
			task.consecutiveMistakeCount = 0
			task.recordToolUsage("apply_patch")
		} catch (error) {
			await handleError("apply patch", error as Error)
			await task.diffViewProvider.reset()
		}
	}

	private async handleAddFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchChangeOutcome> {
		const { askApproval } = callbacks

		// Check if file already exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File already exists: ${relPath}. Use Update File instead.`
			await task.say("error", errorMessage)
			return { status: "error", result: formatResponse.toolError(errorMessage) }
		}

		const newContent = change.newContent || ""
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		// Initialize diff view for new file
		task.diffViewProvider.editType = "create"
		task.diffViewProvider.originalContent = undefined

		const diff = formatResponse.createPrettyPatch(relPath, "", newContent)

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const sanitizedDiff = sanitizeUnifiedDiff(diff || "")
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getTaskReadablePath(task, relPath),
			diff: sanitizedDiff,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: sanitizedDiff,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			task.didRejectTool = true
			return { status: "denied", result: "Changes were rejected by the user." }
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.saveDirectly(
				relPath,
				newContent,
				true,
				diagnosticsEnabled,
				writeDelayMs,
				{ exists: false },
			)
		} else {
			await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
		return { status: "success", result: message }
	}

	private async handleDeleteFile(
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchChangeOutcome> {
		const { askApproval } = callbacks

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot delete a non-existent file.`
			await task.say("error", errorMessage)
			return { status: "error", result: formatResponse.toolError(errorMessage) }
		}

		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getTaskReadablePath(task, relPath),
			diff: `File will be deleted: ${relPath}`,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: `Delete file: ${relPath}`,
			isProtected: isWriteProtected,
		} satisfies ClineSayTool)

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			task.didRejectTool = true
			return { status: "denied", result: "Delete operation was rejected by the user." }
		}

		// Delete the file
		try {
			await fs.unlink(absolutePath)
		} catch (error) {
			const errorMessage = `Failed to delete file '${relPath}': ${error instanceof Error ? error.message : String(error)}`
			await task.say("error", errorMessage)
			task.recordToolError("apply_patch")
			return { status: "error", result: formatResponse.toolError(errorMessage) }
		}

		task.didEditFile = true
		task.processQueuedMessages()
		return { status: "success", result: `Successfully deleted ${relPath}` }
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchChangeOutcome> {
		const { askApproval } = callbacks

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot update a non-existent file.`
			await task.say("error", errorMessage)
			return { status: "error", result: formatResponse.toolError(errorMessage) }
		}

		const originalContent = change.originalContent || ""
		const newContent = change.newContent || ""
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		// Initialize diff view
		task.diffViewProvider.editType = "modify"
		task.diffViewProvider.originalContent = originalContent

		// Generate and validate diff
		const diff = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
		if (!diff) {
			await task.diffViewProvider.reset()
			return { status: "success", result: `No changes needed for '${relPath}'` }
		}

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const moveAbsolutePath = change.movePath ? path.resolve(task.cwd, change.movePath) : undefined
		const effectiveMovePath =
			change.movePath && moveAbsolutePath && path.relative(absolutePath, moveAbsolutePath) !== ""
				? change.movePath
				: undefined
		const expectedSourceFileState: ExpectedFileState = { exists: true, content: originalContent }
		let expectedMoveFileState: ExpectedFileState | undefined

		// Validate and snapshot the move destination before showing the diff or
		// asking for approval. Both save paths re-check this snapshot before
		// writing so an approval cannot authorize a changed destination.
		if (effectiveMovePath && moveAbsolutePath) {
			const moveAccessAllowed = task.rooIgnoreController?.validateAccess(effectiveMovePath)
			if (!moveAccessAllowed) {
				await task.say("rooignore_error", effectiveMovePath)
				await task.diffViewProvider.reset()
				return { status: "error", result: formatResponse.rooIgnoreError(effectiveMovePath) }
			}

			const isMovePathWriteProtected = task.rooProtectedController?.isWriteProtected(effectiveMovePath) || false
			if (isMovePathWriteProtected) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to write-protected path: ${effectiveMovePath}`
				await task.say("error", errorMessage)
				await task.diffViewProvider.reset()
				return { status: "error", result: formatResponse.toolError(errorMessage) }
			}

			const isMoveOutsideWorkspace = isTaskPathOutsideWorkspace(task, moveAbsolutePath)
			if (isMoveOutsideWorkspace) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to path outside workspace: ${effectiveMovePath}`
				await task.say("error", errorMessage)
				await task.diffViewProvider.reset()
				return { status: "error", result: formatResponse.toolError(errorMessage) }
			}

			expectedMoveFileState = await captureExpectedFileState(moveAbsolutePath)
			await task.diffViewProvider.assertExpectedFileState(
				moveAbsolutePath,
				effectiveMovePath,
				expectedMoveFileState,
			)
		}

		const sanitizedDiff = sanitizeUnifiedDiff(diff)
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getTaskReadablePath(task, relPath),
			diff: sanitizedDiff,
			originalContent,
			isOutsideWorkspace,
		}
		const approvalContent = effectiveMovePath
			? `${sanitizedDiff}\n\nMove destination: ${getTaskReadablePath(task, effectiveMovePath)}`
			: sanitizedDiff

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: approvalContent,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			task.didRejectTool = true
			return { status: "denied", result: "Changes were rejected by the user." }
		}

		// Handle file move if specified and distinct from the source path.
		if (effectiveMovePath && moveAbsolutePath && expectedMoveFileState) {
			await task.diffViewProvider.assertExpectedFileState(absolutePath, relPath, expectedSourceFileState)

			// Save new content to the new path
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(
					effectiveMovePath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
					expectedMoveFileState,
				)
			} else {
				// Write to new path and delete old file
				const parentDir = path.dirname(moveAbsolutePath)
				await fs.mkdir(parentDir, { recursive: true })
				await task.diffViewProvider.assertExpectedFileState(
					moveAbsolutePath,
					effectiveMovePath,
					expectedMoveFileState,
				)
				await writeWithExpectedFileState(moveAbsolutePath, effectiveMovePath, newContent, expectedMoveFileState)
			}

			// Re-check immediately before removing the source. If it changed after
			// the destination write, report the partial move and preserve the source.
			try {
				await task.diffViewProvider.assertExpectedFileState(absolutePath, relPath, expectedSourceFileState)
			} catch (error) {
				await task.fileContextTracker.trackFileContext(effectiveMovePath, "roo_edited" as RecordSource)
				task.didEditFile = true
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Updated '${effectiveMovePath}', but the source '${relPath}' changed before it could be removed; the source was preserved: ${
					error instanceof Error ? error.message : String(error)
				}`
				await task.say("error", errorMessage)
				await task.diffViewProvider.reset()
				task.processQueuedMessages()
				return { status: "error", result: formatResponse.toolError(errorMessage) }
			}

			// Delete the original file
			try {
				await fs.unlink(absolutePath)
			} catch (error) {
				await task.fileContextTracker.trackFileContext(effectiveMovePath, "roo_edited" as RecordSource)
				task.didEditFile = true
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Updated '${effectiveMovePath}', but failed to remove original '${relPath}': ${
					error instanceof Error ? error.message : String(error)
				}`
				await task.say("error", errorMessage)
				await task.diffViewProvider.reset()
				task.processQueuedMessages()
				return { status: "error", result: formatResponse.toolError(errorMessage) }
			}

			await task.fileContextTracker.trackFileContext(effectiveMovePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs, {
					exists: true,
					content: originalContent,
				})
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
		return { status: "success", result: message }
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_patch">): Promise<void> {
		const patch: string | undefined = block.params.patch
		const candidateRelPath = this.extractFirstPathFromPatch(patch)
		const fallbackDisplayPath = path.basename(task.cwd) || "workspace"
		const resolvedRelPath = candidateRelPath ?? ""
		const absolutePath = path.resolve(task.cwd, resolvedRelPath)
		const displayPath = candidateRelPath ? getTaskReadablePath(task, candidateRelPath) : fallbackDisplayPath

		let patchPreview: string | undefined
		if (patch) {
			// Show first few lines of the patch
			const lines = patch.split("\n").slice(0, 5)
			patchPreview = lines.join("\n") + (patch.split("\n").length > 5 ? "\n..." : "")
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: displayPath || path.basename(task.cwd) || "workspace",
			diff: patchPreview || "Parsing patch...",
			isOutsideWorkspace: isTaskPathOutsideWorkspace(task, absolutePath),
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

async function captureExpectedFileState(absolutePath: string): Promise<ExpectedFileState> {
	try {
		return { exists: true, content: await fs.readFile(absolutePath, "utf8") }
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { exists: false }
		}

		throw error
	}
}

async function writeWithExpectedFileState(
	absolutePath: string,
	relPath: string,
	content: string,
	expectedState: ExpectedFileState,
): Promise<void> {
	try {
		await fs.writeFile(
			absolutePath,
			content,
			expectedState.exists ? "utf8" : { encoding: "utf-8", flag: "wx" },
		)
	} catch (error) {
		if (!expectedState.exists && isFileExistsError(error)) {
			throw createMoveConflict(relPath, "the destination was created while approval was pending")
		}

		throw error
	}
}

function createMoveConflict(relPath: string, reason: string): Error {
	return new Error(
		`Cannot move '${relPath}': ${reason}. Re-read the affected files and retry so the user's changes are preserved.`,
	)
}

function isFileNotFoundError(error: unknown): boolean {
	return isFileSystemError(error, "ENOENT")
}

function isFileExistsError(error: unknown): boolean {
	return isFileSystemError(error, "EEXIST")
}

function isFileSystemError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

export const applyPatchTool = new ApplyPatchTool()
