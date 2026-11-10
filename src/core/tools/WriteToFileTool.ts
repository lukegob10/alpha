import path from "path"
import fs from "fs/promises"

import { type AlphaSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ExpectedFileState } from "../../integrations/editor/DiffViewProvider"

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
		const newContent = params.content

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

		const accessAllowed = task.alphaIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("alphaignore_error", relPath)
			pushToolResult(formatResponse.alphaIgnoreError(relPath))
			return
		}

		const isWriteProtected = task.alphaProtectedController?.isWriteProtected(relPath) || false

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

		const sharedMessageProps: AlphaSayTool = {
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
				originalContent: fileExists ? task.diffViewProvider.originalContent || "" : "",
				finalContent: newContent,
				diffStats: computeDiffStats(unified) || undefined,
			} satisfies AlphaSayTool)

			// Alpha keeps editor presentation separate from approval: approve the full inline diff before a background write.
			// Codex 4688e49329637b8b50dd8450ef784020537e2215 (retrieved 2026-11-06),
			// core/src/apply_patch.rs: policy precedes writes.
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

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "alpha_edited" as RecordSource)
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
}

export const writeToFileTool = new WriteToFileTool()
