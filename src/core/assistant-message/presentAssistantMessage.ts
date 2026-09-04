import type { Task } from "../task/Task"

export interface PresentAssistantMessageOptions {
	/** Fence pending webview updates from a later canonical response. */
	previewEpoch?: number
}

function isCurrentStreamingPreview(cline: Task, options: PresentAssistantMessageOptions): boolean {
	if (options.previewEpoch === undefined) return true
	return cline.isStreamingPreviewEpochCurrent?.(options.previewEpoch) !== false
}

function throwIfAborted(cline: Task): void {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}
}

type PresentationLockState = Task & { presentAssistantMessageLockOwner?: unknown }

/**
 * Preview streamed assistant text in order. Tool blocks are always skipped:
 * only the scheduler may execute the persisted canonical response.
 */
export async function presentAssistantMessage(cline: Task, options: PresentAssistantMessageOptions = {}) {
	if (!isCurrentStreamingPreview(cline, options)) return
	throwIfAborted(cline)

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	const lockState = cline as PresentationLockState
	const lockOwner = options.previewEpoch ?? Symbol("presentAssistantMessage")
	cline.presentAssistantMessageLocked = true
	lockState.presentAssistantMessageLockOwner = lockOwner
	cline.presentAssistantMessageHasPendingUpdates = false
	try {
		do {
			cline.presentAssistantMessageHasPendingUpdates = false
			await presentAssistantMessageContent(cline, options)
			if (!isCurrentStreamingPreview(cline, options)) return
		} while (cline.presentAssistantMessageHasPendingUpdates)
	} finally {
		// A drained/invalidated preview must not release the next epoch's lock.
		if (lockState.presentAssistantMessageLockOwner === lockOwner) {
			delete lockState.presentAssistantMessageLockOwner
			cline.presentAssistantMessageLocked = false
		}
	}
}

async function presentAssistantMessageContent(cline: Task, options: PresentAssistantMessageOptions): Promise<void> {
	while (isCurrentStreamingPreview(cline, options)) {
		throwIfAborted(cline)

		if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
			if (cline.didCompleteReadingStream) cline.userMessageContentReady = true
			return
		}

		// Snapshot the current text/partial fields while a webview update is pending.
		const block = { ...cline.assistantMessageContent[cline.currentStreamingContentIndex] }
		if (block.type !== "text") {
			cline.currentStreamingContentIndex++
			continue
		}

		if (!cline.didRejectTool) {
			// Strip streamed thinking tags before the markdown renderer sees them.
			const content = block.content.replace(/<thinking>\s?/g, "").replace(/\s?<\/thinking>/g, "")
			if (options.previewEpoch === undefined) {
				await cline.say("text", content, undefined, block.partial)
			} else {
				await cline.say("text", content, undefined, block.partial, undefined, undefined, {
					previewEpoch: options.previewEpoch,
				})
			}
			if (!isCurrentStreamingPreview(cline, options)) return
			throwIfAborted(cline)
		}

		if (block.partial && !cline.didRejectTool) {
			// Keep the lock owner's promise alive for updates queued during say().
			// The outer loop also checks after this async boundary for a final delta.
			if (!cline.presentAssistantMessageHasPendingUpdates) return
			cline.presentAssistantMessageHasPendingUpdates = false
			continue
		}

		if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
			cline.userMessageContentReady = true
		}
		cline.currentStreamingContentIndex++
		// Existing later blocks already include any update received during say().
		// A partial final block is retried by the lock owner's pending-update loop.
		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			cline.presentAssistantMessageHasPendingUpdates = false
		}
	}
}
