import type { Task } from "../task/Task"

export interface PresentAssistantMessageOptions {
	/** Fence pending webview updates from a later canonical response. */
	previewEpoch?: number
	onReasoningPreview?: (messageTs: number) => void
}

export function formatReasoningText(text: string): string {
	return text.includes("**") ? text.replace(/([.!?])\*\*([^*\n]+)\*\*/g, "$1\n\n**$2**") : text
}

function isCurrentStreamingPreview(alphaTask: Task, options: PresentAssistantMessageOptions): boolean {
	if (options.previewEpoch === undefined) return true
	return alphaTask.isStreamingPreviewEpochCurrent?.(options.previewEpoch) !== false
}

function throwIfAborted(alphaTask: Task): void {
	if (alphaTask.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${alphaTask.taskId}.${alphaTask.instanceId} aborted`)
	}
}

type PresentationLockState = Task & { presentAssistantMessageLockOwner?: unknown }

/**
 * Preview streamed assistant text and reasoning in order. Tool blocks are always skipped:
 * only the scheduler may execute the persisted canonical response.
 */
export async function presentAssistantMessage(alphaTask: Task, options: PresentAssistantMessageOptions = {}) {
	if (!isCurrentStreamingPreview(alphaTask, options)) return
	throwIfAborted(alphaTask)

	if (alphaTask.presentAssistantMessageLocked) {
		alphaTask.presentAssistantMessageHasPendingUpdates = true
		return
	}

	const lockState = alphaTask as PresentationLockState
	const lockOwner = options.previewEpoch ?? Symbol("presentAssistantMessage")
	alphaTask.presentAssistantMessageLocked = true
	lockState.presentAssistantMessageLockOwner = lockOwner
	alphaTask.presentAssistantMessageHasPendingUpdates = false
	try {
		do {
			alphaTask.presentAssistantMessageHasPendingUpdates = false
			await presentAssistantMessageContent(alphaTask, options)
			if (!isCurrentStreamingPreview(alphaTask, options)) return
		} while (alphaTask.presentAssistantMessageHasPendingUpdates)
	} finally {
		// A drained/invalidated preview must not release the next epoch's lock.
		if (lockState.presentAssistantMessageLockOwner === lockOwner) {
			delete lockState.presentAssistantMessageLockOwner
			alphaTask.presentAssistantMessageLocked = false
		}
	}
}

async function presentAssistantMessageContent(alphaTask: Task, options: PresentAssistantMessageOptions): Promise<void> {
	while (isCurrentStreamingPreview(alphaTask, options)) {
		throwIfAborted(alphaTask)

		if (alphaTask.currentStreamingContentIndex >= alphaTask.assistantMessageContent.length) {
			if (alphaTask.didCompleteReadingStream) alphaTask.userMessageContentReady = true
			return
		}

		const block = alphaTask.assistantMessageContent[alphaTask.currentStreamingContentIndex]
		if (block.type !== "text" && block.type !== "reasoning") {
			alphaTask.currentStreamingContentIndex++
			continue
		}

		// Snapshot the streamed text while a webview update is pending.
		const { content, partial, previewMessageTs } = block
		if (!alphaTask.didRejectTool) {
			// Strip streamed thinking tags before the markdown renderer sees them.
			const visibleText =
				block.type === "reasoning"
					? formatReasoningText(content)
					: content.replace(/<thinking>\s?/g, "").replace(/\s?<\/thinking>/g, "")
			if (options.previewEpoch === undefined) {
				await alphaTask.say(block.type, visibleText, undefined, partial)
			} else {
				await alphaTask.say(block.type, visibleText, undefined, partial, undefined, undefined, {
					previewEpoch: options.previewEpoch,
					previewMessageTs,
					onCreated: (message) => {
						block.previewMessageTs = message.ts
					},
				})
			}
			if (!isCurrentStreamingPreview(alphaTask, options)) return
			throwIfAborted(alphaTask)
			if (block.type === "reasoning" && block.previewMessageTs !== undefined) {
				options.onReasoningPreview?.(block.previewMessageTs)
			}
		}

		if (partial && !alphaTask.didRejectTool) {
			// Keep the lock owner's promise alive for updates queued during say().
			// The outer loop also checks after this async boundary for a final delta.
			if (alphaTask.presentAssistantMessageHasPendingUpdates) {
				alphaTask.presentAssistantMessageHasPendingUpdates = false
				continue
			}
			// Reasoning can be displayed while its preceding text item remains open.
			// The pump revisits that anchored text row when a continuation arrives.
			if (
				block.type !== "text" ||
				alphaTask.assistantMessageContent[alphaTask.currentStreamingContentIndex + 1]?.type !== "reasoning"
			) {
				return
			}
		}

		if (alphaTask.currentStreamingContentIndex === alphaTask.assistantMessageContent.length - 1) {
			alphaTask.userMessageContentReady = true
		}
		alphaTask.currentStreamingContentIndex++
		// Existing later blocks already include any update received during say().
		// A partial final block is retried by the lock owner's pending-update loop.
		if (alphaTask.currentStreamingContentIndex < alphaTask.assistantMessageContent.length) {
			alphaTask.presentAssistantMessageHasPendingUpdates = false
		}
	}
}
