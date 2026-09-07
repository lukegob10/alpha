import path from "path"
import delay from "delay"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"
import type { ExpectedFileState } from "../../integrations/editor/DiffViewProvider"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"

interface WriteToFileParams {
	path: string
	content: string
}

export class WriteToFileTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const relPath = params.path
		let newContent = params.content

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))
			await task.diffViewProvider.reset()
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		let fileExists: boolean
		const absolutePath = path.resolve(task.cwd, relPath)

		if (task.diffViewProvider.editType !== undefined) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		const fullPath = relPath ? path.resolve(task.cwd, relPath) : ""
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, fullPath)

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getTaskReadablePath(task, relPath),
			content: newContent,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0

			// Capture the raw source state before reading settings or asking for
			// approval. A partial diff may already own this snapshot, in which case
			// the provider retains it across streamed updates.
			let expectedFileState: ExpectedFileState | undefined
			if (!task.diffViewProvider.isEditing) {
				expectedFileState = fileExists
					? { exists: true, content: await fs.readFile(absolutePath, "utf-8") }
					: { exists: false }
			}

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			if (isPreventFocusDisruptionEnabled) {
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
				const directExpectedFileState =
					expectedFileState ??
					(fileExists
						? { exists: true, content: task.diffViewProvider.originalContent ?? "" }
						: { exists: false })
				task.diffViewProvider.originalContent = directExpectedFileState.exists
					? directExpectedFileState.content
					: ""

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.reset()
					this.resetPartialState()
					return
				}

				await task.diffViewProvider.saveDirectly(
					relPath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
					directExpectedFileState,
				)
			} else {
				if (!task.diffViewProvider.isEditing) {
					const partialMessage = JSON.stringify(sharedMessageProps)
					await task.ask("tool", partialMessage, true).catch(() => {})
					if (!expectedFileState) {
						throw new Error(t("tools:diffView.missingExpectedFileState"))
					}
					await task.diffViewProvider.open(relPath, expectedFileState)
				}

				await task.diffViewProvider.update(newContent, true)

				await delay(300)
				task.diffViewProvider.scrollToFirstDiff()

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					await task.diffViewProvider.reset()
					this.resetPartialState()
					return
				}

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			pushToolResult(message)

			await task.diffViewProvider.reset()
			this.resetPartialState()

			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("writing file", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const relPath: string | undefined = block.params.path
		let newContent: string | undefined = block.params.content

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath) || newContent === undefined) {
			return
		}

		if (task.rooIgnoreController && !task.rooIgnoreController.validateAccess(relPath!)) {
			return
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		if (isPreventFocusDisruptionEnabled) {
			return
		}

		// relPath is guaranteed non-null after hasPathStabilized
		const absolutePath = path.resolve(task.cwd, relPath!)
		let fileExists: boolean

		if (task.diffViewProvider.editType !== undefined) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		// Capture the raw source before the partial tool row can yield. The first
		// open stores this state on the provider; later partial updates reuse it
		// instead of recapturing the current disk contents.
		let expectedFileState: ExpectedFileState | undefined
		if (!task.diffViewProvider.isEditing) {
			expectedFileState = fileExists
				? { exists: true, content: await fs.readFile(absolutePath, "utf-8") }
				: { exists: false }
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath!) || false
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getTaskReadablePath(task, relPath!),
			content: newContent || "",
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})

		if (newContent !== undefined) {
			if (!task.diffViewProvider.isEditing) {
				if (!expectedFileState) {
					throw new Error(t("tools:diffView.missingExpectedFileState"))
				}
				await task.diffViewProvider.open(relPath!, expectedFileState)
			}

			await task.diffViewProvider.update(newContent, false)
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
