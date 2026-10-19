import * as path from "path"
import { Task } from "../task/Task"
import { AlphaMessage } from "@alpha-code/types"
import { ApiMessage } from "../task-persistence/apiMessages"
import { cleanupAfterTruncation } from "../condense"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { getTaskDirectoryPath } from "../../utils/storage"
import {
	getCommandArtifactExecutionId,
	READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH,
} from "../tools/commandOutputContract"

/** Retain references in native inputs/results, summaries, and historical message representations. */
export function collectArtifactExecutionIds(messages: readonly (AlphaMessage | ApiMessage)[]): Set<string> {
	const ids = new Set<string>()
	const pending: unknown[] = [...messages]
	const seen = new WeakSet<object>()
	const artifactReferences = new RegExp(
		`cmd-[0-9a-f-]{1,${READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH - 8}}\\.txt`,
		"g",
	)
	for (const message of messages) {
		if (message.ts) ids.add(String(message.ts))
	}
	while (pending.length > 0) {
		const value = pending.pop()
		if (typeof value === "string") {
			// Candidate extraction is conservative; the shared validator owns accepted filenames.
			for (const match of value.matchAll(artifactReferences)) {
				const id = getCommandArtifactExecutionId(match[0])
				if (id !== undefined) ids.add(id)
			}
		} else if (value !== null && typeof value === "object" && !seen.has(value)) {
			seen.add(value)
			pending.push(...Object.values(value))
		}
	}
	return ids
}

export interface RewindOptions {
	/** Whether to include the target message in deletion (edit=true, delete=false) */
	includeTargetMessage?: boolean
	/** Skip cleanup for special cases (default: false) */
	skipCleanup?: boolean
}

interface ContextEventIds {
	condenseIds: Set<string>
	truncationIds: Set<string>
}

/**
 * MessageManager provides centralized handling for all conversation rewind operations.
 *
 * This ensures that whenever UI chat history is rewound (delete, edit, checkpoint restore, etc.),
 * the API conversation history is properly maintained, including:
 * - Removing orphaned Summary messages when their condense_context is removed
 * - Removing orphaned truncation markers when their sliding_window_truncation is removed
 * - Cleaning up orphaned condenseParent/truncationParent tags
 *
 * Usage (always access via Task.messageManager getter):
 * ```typescript
 * await task.messageManager.rewindToTimestamp(messageTs, { includeTargetMessage: false })
 * ```
 *
 * @see Task.messageManager - The getter that provides lazy-initialized access to this manager
 */
export class MessageManager {
	constructor(private task: Task) {}

	/**
	 * Rewind conversation to a specific timestamp.
	 * This is the SINGLE entry point for all message deletion operations.
	 *
	 * @param ts - The timestamp to rewind to
	 * @param options - Rewind options
	 * @throws Error if timestamp not found in clineMessages
	 */
	async rewindToTimestamp(ts: number, options: RewindOptions = {}): Promise<void> {
		const { includeTargetMessage = false, skipCleanup = false } = options

		// Find the index in clineMessages
		const alphaIndex = this.task.clineMessages.findIndex((m) => m.ts === ts)
		if (alphaIndex === -1) {
			throw new Error(`Message with timestamp ${ts} not found in clineMessages`)
		}

		// Calculate the actual cutoff index
		const cutoffIndex = includeTargetMessage ? alphaIndex + 1 : alphaIndex

		await this.performRewind(cutoffIndex, ts, { skipCleanup })
	}

	/**
	 * Rewind conversation to a specific index in clineMessages.
	 * Keeps messages [0, toIndex) and removes [toIndex, end].
	 *
	 * @param toIndex - The index to rewind to (exclusive)
	 * @param options - Rewind options
	 */
	async rewindToIndex(toIndex: number, options: RewindOptions = {}): Promise<void> {
		const cutoffTs = this.task.clineMessages[toIndex]?.ts ?? Date.now()
		await this.performRewind(toIndex, cutoffTs, options)
	}

	/**
	 * Internal method that performs the actual rewind operation.
	 */
	private async performRewind(toIndex: number, cutoffTs: number, options: RewindOptions): Promise<void> {
		const { skipCleanup = false } = options
		const artifactCandidates = skipCleanup
			? undefined
			: collectArtifactExecutionIds([...this.task.clineMessages, ...this.task.apiConversationHistory])
		const firstMessage = this.task.clineMessages[0]
		const replacesOpeningPrompt =
			firstMessage?.ts === cutoffTs && firstMessage.type === "say" && firstMessage.say === "text"

		// Step 1: Collect context event IDs from messages being removed
		const removedIds = this.collectRemovedContextEventIds(toIndex)

		// Calculate both projections before persisting either. The task commits the durable
		// rollback receipt first, so reload can distinguish this deletion from crash damage.
		const uiMessages = this.task.clineMessages.slice(0, toIndex)
		const apiHistory = this.truncateApiHistoryWithCleanup(cutoffTs, removedIds, skipCleanup, replacesOpeningPrompt)
		if ((await this.task.commitConversationRewind(uiMessages, apiHistory)) !== true) {
			throw new Error("Conversation rewind could not be persisted")
		}
		if (artifactCandidates && this.isArtifactCleanupIdle()) {
			const retainedIds = collectArtifactExecutionIds([
				...this.task.clineMessages,
				...this.task.apiConversationHistory,
			])
			await this.cleanupOrphanedArtifacts(retainedIds, artifactCandidates)
		}
	}

	/**
	 * Collect condenseIds and truncationIds from context-management events
	 * that will be removed during the rewind.
	 *
	 * This is critical for maintaining the linkage between:
	 * - condense_context (clineMessage) ↔ Summary (apiMessage)
	 * - sliding_window_truncation (clineMessage) ↔ Truncation marker (apiMessage)
	 */
	private collectRemovedContextEventIds(fromIndex: number): ContextEventIds {
		const condenseIds = new Set<string>()
		const truncationIds = new Set<string>()

		for (let i = fromIndex; i < this.task.clineMessages.length; i++) {
			const msg = this.task.clineMessages[i]

			// Collect condenseIds from condense_context events
			if (msg.say === "condense_context" && msg.contextCondense?.condenseId) {
				condenseIds.add(msg.contextCondense.condenseId)
				console.log(`[MessageManager] Found condense_context to remove: ${msg.contextCondense.condenseId}`)
			}

			// Collect truncationIds from sliding_window_truncation events
			if (msg.say === "sliding_window_truncation" && msg.contextTruncation?.truncationId) {
				truncationIds.add(msg.contextTruncation.truncationId)
				console.log(
					`[MessageManager] Found sliding_window_truncation to remove: ${msg.contextTruncation.truncationId}`,
				)
			}
		}

		return { condenseIds, truncationIds }
	}

	/**
	 * Calculate the API rewind projection by timestamp and clean up context tags.
	 * The caller commits this together with the UI projection through the task.
	 *
	 * Note on timestamp handling:
	 * Due to async execution during streaming, clineMessage timestamps may not
	 * perfectly align with API message timestamps. Specifically, a "user_feedback"
	 * clineMessage can have a timestamp BEFORE the assistant API message that
	 * triggered it (because tool execution happens concurrently with stream
	 * completion). To handle this race condition, we find the first API user
	 * message at or after the cutoff and use its timestamp as the actual boundary.
	 */
	private truncateApiHistoryWithCleanup(
		cutoffTs: number,
		removedIds: ContextEventIds,
		skipCleanup: boolean,
		replacesOpeningPrompt: boolean,
	): ApiMessage[] {
		const originalHistory = this.task.apiConversationHistory
		let apiHistory = [...originalHistory]

		// Step 1: Determine the actual cutoff timestamp
		// Check if there's an API message with an exact timestamp match
		const hasExactMatch = apiHistory.some((m) => m.ts === cutoffTs)
		// Check if there are any messages before the cutoff that would be preserved
		const hasMessageBeforeCutoff = apiHistory.some((m) => m.ts !== undefined && m.ts < cutoffTs)

		let actualCutoff: number = cutoffTs

		if (!hasExactMatch && hasMessageBeforeCutoff) {
			// No exact match but there are earlier messages means we might have a race
			// condition where the clineMessage timestamp is earlier than any API message
			// due to async execution. In this case, look for the first API user message
			// at or after the cutoff to use as the actual boundary.
			// This ensures assistant messages that preceded the user's response are preserved.
			const firstUserMsgIndexToRemove = apiHistory.findIndex(
				(m) =>
					m.ts !== undefined &&
					m.ts >= cutoffTs &&
					m.role === "user" &&
					!m.isSummary &&
					!m.isTruncationMarker,
			)

			if (firstUserMsgIndexToRemove !== -1) {
				// Use the user message's timestamp as the actual cutoff
				actualCutoff = apiHistory[firstUserMsgIndexToRemove].ts!
			}
			// else: no user message found, use original cutoffTs (fallback)
		}

		// Step 2: Filter by the actual cutoff timestamp
		// Nothing precedes the opening prompt, including legacy records without timestamps.
		apiHistory = replacesOpeningPrompt ? [] : apiHistory.filter((m) => !m.ts || m.ts < actualCutoff)

		// Step 3: Remove Summaries whose condense_context was removed
		if (removedIds.condenseIds.size > 0) {
			apiHistory = apiHistory.filter((msg) => {
				if (msg.isSummary && msg.condenseId && removedIds.condenseIds.has(msg.condenseId)) {
					console.log(`[MessageManager] Removing orphaned Summary with condenseId: ${msg.condenseId}`)
					return false
				}
				return true
			})
		}

		// Step 4: Remove truncation markers whose sliding_window_truncation was removed
		if (removedIds.truncationIds.size > 0) {
			apiHistory = apiHistory.filter((msg) => {
				if (msg.isTruncationMarker && msg.truncationId && removedIds.truncationIds.has(msg.truncationId)) {
					console.log(
						`[MessageManager] Removing orphaned truncation marker with truncationId: ${msg.truncationId}`,
					)
					return false
				}
				return true
			})
		}

		// Step 5: Cleanup orphaned tags (unless skipped)
		if (!skipCleanup) {
			apiHistory = cleanupAfterTruncation(apiHistory)
		}

		return apiHistory
	}

	private isArtifactCleanupIdle(): boolean {
		// Abort can precede process termination; it is not evidence that cancellation has joined.
		return (
			!this.task.abort &&
			!this.task.isTurnActive?.() &&
			!this.task.hasActiveCommandExecutions?.() &&
			!this.task.hasPendingSteerMessage?.() &&
			!this.task.messageQueueService?.hasUnconsumedInput()
		)
	}

	/**
	 * Remove only artifacts referenced before this committed rewind and no longer retained.
	 * New or untracked command output is outside this cleanup's ownership.
	 */
	private async cleanupOrphanedArtifacts(
		validIds: ReadonlySet<string>,
		candidates: ReadonlySet<string>,
	): Promise<void> {
		try {
			// Access globalStoragePath and taskId through the task reference
			const task = this.task as any // Access private member
			const globalStoragePath = task.globalStoragePath
			const taskId = task.taskId

			if (!globalStoragePath || !taskId) {
				return
			}

			const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
			const outputDir = path.join(taskDir, "command-output")
			if (this.isArtifactCleanupIdle()) {
				await OutputInterceptor.cleanupByIds(outputDir, validIds, candidates, (id) => {
					// Directory reads and prior unlinks yield. A follow-up may have resumed or
					// retained this same artifact in the meantime; recheck at effect admission.
					return (
						this.isArtifactCleanupIdle() &&
						!collectArtifactExecutionIds([
							...this.task.clineMessages,
							...this.task.apiConversationHistory,
						]).has(id)
					)
				})
			}
		} catch (error) {
			// Silently fail - cleanup is best-effort
			console.debug("[MessageManager] Artifact cleanup skipped:", error)
		}
	}
}
