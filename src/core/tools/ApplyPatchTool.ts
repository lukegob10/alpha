import fs from "fs/promises"
import path from "path"
import * as vscode from "vscode"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolResponse, ToolUse } from "../../shared/tools"
import { parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange } from "./apply-patch"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"
import type { ExpectedFileState } from "../../integrations/editor/DiffViewProvider"
import { t } from "../../i18n"

interface ApplyPatchParams {
	patch: string
}

interface ApplyPatchChangeOutcome {
	status: "success" | "denied" | "error" | "cancelled"
	result: ToolResponse
}

interface PatchFileResult {
	path: string
	movePath?: string
	status: "applied" | "skipped" | "error"
	reason?: string
	result?: ToolResponse
}

interface PreflightChange {
	change: ApplyPatchFileChange
	isWriteProtected: boolean
	expectedMoveFileState?: ExpectedFileState
}

function isPatchCancelled(task: Task, callbacks: ToolCallbacks): boolean {
	return !!(callbacks.signal?.aborted || task.abort || task.abandoned)
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

			const files: PatchFileResult[] = parsedPatch.hunks.map((hunk) => ({
				path: hunk.path,
				movePath: hunk.type === "UpdateFile" ? (hunk.movePath ?? undefined) : undefined,
				status: "skipped",
				reason: "Not attempted",
			}))
			const prepared: Array<PreflightChange | undefined> = []
			let status: ApplyPatchChangeOutcome["status"] = "success"

			// Preflight is sequential and read-only. A bad file must not hide the
			// outcome of independent files, and ignored paths must never be read.
			for (const [index, hunk] of parsedPatch.hunks.entries()) {
				if (isPatchCancelled(task, callbacks)) {
					files[index].reason = "Patch cancelled before preflight"
					status = "cancelled"
					continue
				}
				try {
					const paths = [hunk.path, hunk.type === "UpdateFile" ? hunk.movePath : undefined]
					const ignored = paths.find(
						(candidate) => candidate && !task.rooIgnoreController?.validateAccess(candidate),
					)
					if (ignored) {
						files[index].reason = `Access denied by .alphaignore: ${ignored}`
						if (status === "success") status = "denied"
						await task.say("rooignore_error", ignored)
						continue
					}
					const absolutePath = path.resolve(task.cwd, hunk.path)
					const isWriteProtected = task.rooProtectedController?.isWriteProtected(hunk.path) || false
					if (hunk.type === "AddFile" && (await fileExistsAtPath(absolutePath))) {
						throw new Error(`File already exists: ${hunk.path}. Use Update File instead.`)
					}
					let expectedMoveFileState: ExpectedFileState | undefined
					if (
						hunk.type === "UpdateFile" &&
						hunk.movePath &&
						!arePathsEqual(absolutePath, path.resolve(task.cwd, hunk.movePath))
					) {
						if (task.rooProtectedController?.isWriteProtected(hunk.movePath)) {
							throw new Error(`Cannot move file to write-protected path: ${hunk.movePath}`)
						}
						const moveAbsolutePath = path.resolve(task.cwd, hunk.movePath)
						if (isTaskPathOutsideWorkspace(task, moveAbsolutePath) && task.taskKind !== "primary") {
							throw new Error(`Cannot move file to path outside workspace: ${hunk.movePath}`)
						}
						expectedMoveFileState = await captureExpectedFileState(moveAbsolutePath)
					}
					const [change] = await processAllHunks([hunk], (filePath) =>
						fs.readFile(path.resolve(task.cwd, filePath), "utf8"),
					)
					prepared[index] = { change, isWriteProtected, expectedMoveFileState }
				} catch (error) {
					files[index].status = "error"
					files[index].reason = error instanceof Error ? error.message : String(error)
					status = "error"
				}
			}

			let stopped: string | undefined
			for (const [index, entry] of prepared.entries()) {
				if (!entry) continue
				const file = files[index]
				if (isPatchCancelled(task, callbacks)) {
					stopped = "Patch cancelled"
					status = "cancelled"
				}
				if (stopped) {
					file.reason = stopped
					continue
				}
				const { change, expectedMoveFileState } = entry
				const isWriteProtected =
					entry.isWriteProtected || task.rooProtectedController?.isWriteProtected(change.path) || false
				const absolutePath = path.resolve(task.cwd, change.path)
				const markApplied = () => {
					file.status = "applied"
					task.didEditFile = true
				}
				let outcome: ApplyPatchChangeOutcome
				try {
					// Recheck access after earlier files' approval waits.
					const deniedPath = [change.path, change.movePath].find(
						(candidate) => candidate && !task.rooIgnoreController?.validateAccess(candidate),
					)
					if (deniedPath) {
						outcome = { status: "denied", result: `Access denied by .alphaignore: ${deniedPath}` }
					} else if (change.type === "add") {
						outcome = await this.handleAddFile(
							change,
							absolutePath,
							change.path,
							task,
							callbacks,
							isWriteProtected,
							markApplied,
						)
					} else if (change.type === "delete") {
						outcome = await this.handleDeleteFile(
							change,
							absolutePath,
							change.path,
							task,
							callbacks,
							isWriteProtected,
							markApplied,
						)
					} else {
						outcome = await this.handleUpdateFile(
							change,
							absolutePath,
							change.path,
							task,
							callbacks,
							isWriteProtected,
							markApplied,
							expectedMoveFileState,
						)
					}
				} catch (error) {
					outcome = {
						status: isPatchCancelled(task, callbacks) ? "cancelled" : "error",
						result: error instanceof Error ? error.message : String(error),
					}
					await task.diffViewProvider.reset()
				}
				file.status =
					file.status === "applied" || outcome.status === "success"
						? "applied"
						: outcome.status === "error"
							? "error"
							: "skipped"
				if (outcome.status === "success") {
					file.result = outcome.result
					delete file.reason
				} else {
					file.reason =
						(file.status === "applied" ? "Changes saved, but follow-up failed: " : "") +
						(typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result))
					status = outcome.status
					stopped = `Not attempted after ${outcome.status} in ${change.path}`
				}
			}

			callbacks.setResultMetadata?.({ status })
			if (status === "success") {
				task.consecutiveMistakeCount = 0
				task.recordToolUsage("apply_patch")
			} else if (status === "error") {
				task.consecutiveMistakeCount++
				task.didToolFailInCurrentTurn = true
				task.recordToolError("apply_patch")
			}
			pushToolResult(JSON.stringify({ files }))
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
		onApplied: () => void,
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
			await task.diffViewProvider.open(relPath, { exists: false })
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove || isPatchCancelled(task, callbacks)) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			task.didRejectTool = !isPatchCancelled(task, callbacks)
			return isPatchCancelled(task, callbacks)
				? { status: "cancelled", result: "Patch cancelled during approval" }
				: { status: "denied", result: "Changes were rejected by the user." }
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs, {
				exists: false,
			})
		} else {
			await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
		}

		onApplied()
		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
		return { status: "success", result: message }
	}

	private async handleDeleteFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		onApplied: () => void,
	): Promise<ApplyPatchChangeOutcome> {
		const { askApproval, signal } = callbacks
		const isCancelled = () => signal?.aborted || task.abort || task.abandoned
		const assertCanDelete = () => {
			if (isCancelled()) throw new Error(t("tools:applyPatch.deleteCancelled"))

			// Deletion never owns an editor buffer, including a previous managed diff.
			if (
				vscode.workspace.textDocuments.some(
					(document) =>
						document.uri.scheme === "file" &&
						arePathsEqual(document.uri.fsPath, absolutePath) &&
						document.isDirty,
				)
			) {
				throw new Error(
					t("tools:fileConflicts.delete", {
						path: relPath,
						reason: t("tools:fileConflicts.reasons.fileUnsavedChanges"),
					}),
				)
			}
		}

		try {
			assertCanDelete()
			if (!(await fileExistsAtPath(absolutePath))) {
				task.consecutiveMistakeCount++
				throw new Error(`File not found: ${relPath}. Cannot delete a non-existent file.`)
			}
			// Retain the parsed snapshot so an earlier hunk's approval wait cannot
			// silently adopt user edits to a later deletion target.
			const expectedState: ExpectedFileState = { exists: true, content: change.originalContent ?? "" }
			const expectedStat = await fs.lstat(absolutePath, { bigint: true })
			await task.diffViewProvider.assertExpectedFileState(absolutePath, relPath, expectedState)
			assertCanDelete()

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

			if (isCancelled()) throw new Error(t("tools:applyPatch.deleteCancelled"))
			if (!didApprove) {
				task.didRejectTool = true
				return { status: "denied", result: "Delete operation was rejected by the user." }
			}

			await task.diffViewProvider.assertExpectedFileState(absolutePath, relPath, expectedState)
			const currentStat = await fs.lstat(absolutePath, { bigint: true })
			// Content alone cannot distinguish a replacement containing the same text.
			if (
				(["dev", "ino", "birthtimeNs", "ctimeNs", "mtimeNs", "size"] as const).some(
					(key) => currentStat[key] !== expectedStat[key],
				)
			) {
				throw new Error(
					t("tools:fileConflicts.delete", {
						path: relPath,
						reason: t("tools:fileConflicts.reasons.fileChangedDuringApproval"),
					}),
				)
			}
			// Check editor changes and cancellation after all awaited validation, with
			// no intervening await before unlink. External filesystem writes are not atomic with unlink.
			assertCanDelete()
			await fs.unlink(absolutePath)
			onApplied()
		} catch (error) {
			if (isCancelled()) {
				return { status: "cancelled", result: t("tools:applyPatch.deleteCancelled") }
			}
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
		onApplied: () => void,
		expectedMoveFileState?: ExpectedFileState,
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
		let isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		// Initialize diff view
		task.diffViewProvider.editType = "modify"
		task.diffViewProvider.originalContent = originalContent

		// Generate and validate diff
		const diff = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
		if (!diff) {
			await task.diffViewProvider.reset()
			return { status: "success", result: `No changes needed for '${relPath}'` }
		}

		const moveAbsolutePath = change.movePath ? path.resolve(task.cwd, change.movePath) : undefined
		const effectiveMovePath =
			change.movePath && moveAbsolutePath && path.relative(absolutePath, moveAbsolutePath) !== ""
				? change.movePath
				: undefined
		const expectedSourceFileState: ExpectedFileState = { exists: true, content: originalContent }

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
			if (isMoveOutsideWorkspace && task.taskKind !== "primary") {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to path outside workspace: ${effectiveMovePath}`
				await task.say("error", errorMessage)
				await task.diffViewProvider.reset()
				return { status: "error", result: formatResponse.toolError(errorMessage) }
			}

			isOutsideWorkspace ||= isMoveOutsideWorkspace
			expectedMoveFileState ??= await captureExpectedFileState(moveAbsolutePath)
			await task.diffViewProvider.assertExpectedFileState(
				moveAbsolutePath,
				effectiveMovePath,
				expectedMoveFileState,
			)
		}

		// Check experiment settings only after all raw baselines have been captured.
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

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
			await task.diffViewProvider.open(relPath, expectedSourceFileState)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove || isPatchCancelled(task, callbacks)) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			await task.diffViewProvider.reset()
			task.didRejectTool = !isPatchCancelled(task, callbacks)
			return isPatchCancelled(task, callbacks)
				? { status: "cancelled", result: "Patch cancelled during approval" }
				: { status: "denied", result: "Changes were rejected by the user." }
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
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs, {
					relPath: effectiveMovePath,
					expectedFileState: expectedMoveFileState,
				})
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

			onApplied()
			await task.fileContextTracker.trackFileContext(effectiveMovePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(
					relPath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
					expectedSourceFileState,
				)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			onApplied()
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

function isFileNotFoundError(error: unknown): boolean {
	return isFileSystemError(error, "ENOENT")
}

function isFileSystemError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

export const applyPatchTool = new ApplyPatchTool()
