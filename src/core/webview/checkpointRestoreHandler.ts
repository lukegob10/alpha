import { Task } from "../task/Task"
import { AlphaProvider } from "./AlphaProvider"
import { saveTaskMessages } from "../task-persistence"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { t } from "../../i18n"
import { awaitTaskCancellationBoundary } from "./TaskCancellationBoundary"

export interface CheckpointRestoreConfig {
	provider: AlphaProvider
	currentAlpha: Task
	messageTs: number
	messageIndex: number
	checkpoint: { hash: string }
	operation: "delete" | "edit"
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

const pendingRestarts = new WeakSet<Task>()

/** Rewind only after the old task has stopped, then resume a fresh instance with the same identity. */
export async function restartTaskFromMessage(
	provider: AlphaProvider,
	task: Task,
	messageTs: number,
	text: string,
	images?: string[],
	checkpoint?: { hash: string },
): Promise<void> {
	if (pendingRestarts.has(task)) return
	if (!text.trim() && !images?.length) return
	pendingRestarts.add(task)
	try {
		const abortResult = task.abort ? undefined : await task.abortTask()
		await awaitTaskCancellationBoundary(task, abortResult)
		const rewind = async () => {
			if (provider.getLiveTask(task.taskId) !== task)
				throw new Error("The task changed before the prompt could be restarted")
			if (checkpoint) {
				const restored = await task.checkpointRestore({
					ts: messageTs,
					commitHash: checkpoint.hash,
					mode: "restore",
					operation: "edit",
				})
				if (restored === false) throw new Error("The checkpoint is no longer available")
			}
			await task.messageManager.rewindToTimestamp(messageTs, { includeTargetMessage: false })
		}
		if (checkpoint) {
			// Cancellation must join before taking the workspace gate: the old loop
			// may itself need the gate to finish. This host restore outlives that loop.
			await provider.runWorkspaceMutation(task, "restart from checkpoint", rewind, { allowStoppedTask: true })
		} else {
			await rewind()
		}
		const { historyItem } = await provider.getTaskWithId(task.taskId)
		const resumedTask = await provider.createTaskWithHistoryItem(historyItem, {
			startTask: false,
			preserveExisting: true,
			background: provider.getCurrentTask()?.taskId !== task.taskId,
		})
		await resumedTask.resumeWithEditedMessage(text, images)
	} finally {
		pendingRestarts.delete(task)
	}
}

/**
 * Handles checkpoint restoration for both delete and edit operations.
 * This consolidates the common logic while handling operation-specific behavior.
 */
export async function handleCheckpointRestoreOperation(config: CheckpointRestoreConfig): Promise<void> {
	const { provider, currentAlpha, messageTs, checkpoint, operation, editData } = config

	try {
		if (operation === "edit") {
			if (!editData) throw new Error("An edited prompt is required")
			await restartTaskFromMessage(
				provider,
				currentAlpha,
				messageTs,
				editData.editedContent,
				editData.images,
				checkpoint,
			)
			return
		}
		// For delete operations, ensure the task is properly aborted to handle any pending ask operations
		// This prevents "Current ask promise was ignored" errors
		if (operation === "delete" && currentAlpha) {
			const abortResult = currentAlpha.abort ? undefined : await currentAlpha.abortTask()
			await awaitTaskCancellationBoundary(currentAlpha, abortResult)
		}

		// Perform the checkpoint restoration
		await currentAlpha.checkpointRestore({
			ts: messageTs,
			commitHash: checkpoint.hash,
			mode: "restore",
			operation,
		})

		// Save messages and reload the stopped task after deletion.
		if (operation === "delete") {
			// Save the updated messages to disk after checkpoint restoration
			await saveTaskMessages({
				messages: currentAlpha.clineMessages,
				taskId: currentAlpha.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			// Get the updated history item and reinitialize
			const { historyItem } = await provider.getTaskWithId(currentAlpha.taskId)
			await provider.createTaskWithHistoryItem(historyItem)
		}
	} catch (error) {
		console.error(`Error in checkpoint restore (${operation}):`, error)
		vscode.window.showErrorMessage(
			`Error during checkpoint restore: ${error instanceof Error ? error.message : String(error)}`,
		)
		throw error
	}
}

/**
 * Common checkpoint restore validation and initialization utility.
 * This can be used by any checkpoint restore flow that needs to wait for initialization.
 */
export async function waitForAlphaInitialization(provider: AlphaProvider, timeoutMs: number = 3000): Promise<boolean> {
	try {
		await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, {
			timeout: timeoutMs,
		})
		return true
	} catch (error) {
		vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
		return false
	}
}
