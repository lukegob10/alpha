import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@alpha-code/telemetry"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import {
	MAX_CONDENSE_THRESHOLD,
	MIN_CONDENSE_THRESHOLD,
	countContextTokens,
	getEffectiveApiHistory,
	getLogicalStepStarts,
	getToolCallResultPairs,
	hasToolCallResultIntegrity,
	selectRecentTail,
	summarizeConversation,
	SummarizeResponse,
} from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@alpha-code/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	DEFAULT_COMPACTION_TARGET_PERCENT,
	DEFAULT_MIN_REDUCTION_PERCENT,
	evaluateCompactionProgress,
	getCompactionTargetTokens,
} from "./recovery"
import type { ContextRecoveryStatus } from "./recovery"
export * from "./recovery"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate.
 * Used by Context Management to determine when to trigger condensation or (fallback) sliding window truncation.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)

	const truncationId = crypto.randomUUID()

	// A summary is a fresh-start boundary: messages before the latest summary remain
	// stored for rewind, but they are not visible to the API and must not consume a
	// later truncation quota. Track original indices so tagging stays non-destructive.
	let effectiveStartIndex = 0
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].isSummary) {
			effectiveStartIndex = index
			break
		}
	}

	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (index >= effectiveStartIndex && !msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	// Calculate how many visible messages to truncate (excluding first visible message).
	// The even rounding is retained as the default for ordinary user/assistant
	// turns, but tool call/result pairs are treated as indivisible units below.
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const requestedMessagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	if (requestedMessagesToRemove <= 0) {
		// Nothing to truncate
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	// Get the indices of visible messages to truncate (skip first visible, take
	// the requested number), then remove any candidate that would split a
	// tool_call/tool_result pair.  A pair whose two sides are both candidates is
	// hidden together; an incomplete candidate is kept visible instead.
	const candidateIndices = new Set(visibleIndices.slice(1, requestedMessagesToRemove + 1))
	const indicesToTruncate = new Set(candidateIndices)
	const visibleIndexSet = new Set(visibleIndices)
	const firstVisibleIndex = visibleIndices[0]

	for (const pair of getToolCallResultPairs(messages).values()) {
		const pairIndices = new Set(
			[...pair.callMessageIndexes, ...pair.resultMessageIndexes].filter((index) => visibleIndexSet.has(index)),
		)
		if (pairIndices.size === 0) continue

		const intersectsCandidate = [...pairIndices].some((index) => candidateIndices.has(index))
		if (!intersectsCandidate) continue

		const canHideWholePair = [...pairIndices].every(
			(index) => index !== firstVisibleIndex && candidateIndices.has(index),
		)
		if (canHideWholePair) {
			for (const index of pairIndices) indicesToTruncate.add(index)
		} else {
			// Keep both sides visible when one side is outside the removable
			// window (or is the first retained message).
			for (const index of pairIndices) indicesToTruncate.delete(index)
		}
	}

	if (indicesToTruncate.size === 0) {
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	const messagesToRemove = indicesToTruncate.size

	// Tag messages that are being "truncated" (hidden from API calls)
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Find the actual boundary - the index right after the last truncated
	// message.  Pair-safe selection can leave a candidate visible, so deriving
	// the boundary from the selected indexes avoids placing the marker in the
	// middle of a preserved pair.
	const lastTruncatedVisibleIndex = Math.max(...indicesToTruncate)
	// If all visible messages except the first are truncated, insert marker at the end
	const firstKeptVisibleIndex =
		visibleIndices.find((index) => index > lastTruncatedVisibleIndex && !indicesToTruncate.has(index)) ??
		taggedMessages.length

	// Insert truncation marker at the actual boundary (between last truncated and first kept)
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	// Insert marker at the boundary position
	// Find where to insert: right before the first kept visible message
	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return {
		messages: result,
		truncationId,
		messagesRemoved: messagesToRemove,
	}
}

/**
 * Bounded fallback when summarization fails or is disabled. Keep the first
 * complete step (instruction provenance) and an exact recent suffix. If even
 * that minimum cannot fit, report exhaustion without changing saved history.
 */
async function truncateToTokenBudget(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	maxContextTokens: number,
	taskId: string,
	metadata?: ApiHandlerCreateMessageMetadata,
	forcedRecoveryTokens?: number,
): Promise<TruncationResult & { tokens: number; status: ContextRecoveryStatus }> {
	const signal = metadata?.signal
	signal?.throwIfAborted()
	const active = getEffectiveApiHistory(messages)
	const truncationId = crypto.randomUUID()
	const unchanged = { messages, truncationId, messagesRemoved: 0, tokens: 0, status: "exhausted" as const }
	const storedMessages = new Set(messages)
	if (!hasToolCallResultIntegrity(active) || active.some((message) => !storedMessages.has(message))) return unchanged
	const starts = getLogicalStepStarts(active)
	if (starts.length < 2) return unchanged
	const firstStepEnd = starts[1]
	const firstStep = active.slice(0, firstStepEnd)
	const marker: ApiMessage = {
		role: "user",
		content:
			"[Sliding window truncation: older complete steps hidden to fit the context budget. Original records remain in saved history.]",
		ts: messages.reduce((latest, message) => Math.max(latest, message.ts ?? 0), Date.now()) + 1,
		isTruncationMarker: true,
		truncationId,
	}
	const fixedTokens = await countContextTokens([...firstStep, marker], apiHandler, systemPrompt, metadata)
	// A provider may have rejected this request despite a lower local estimate.
	// Still make one real reduction, then tighten further if the budget requires it.
	const requestedStart = firstStepEnd + Math.max(1, Math.floor((active.length - firstStepEnd) / 2))
	const eligibleStarts = starts.filter((start) => start > firstStepEnd)
	const minimumTailStart =
		eligibleStarts.filter((start) => start <= requestedStart).at(-1) ?? eligibleStarts[0] ?? active.length
	const tail = await selectRecentTail(active, apiHandler, maxContextTokens - fixedTokens, minimumTailStart, signal)
	if (tail.startIndex === active.length || tail.startIndex <= firstStepEnd) return unchanged
	const hidden = new Set(active.slice(firstStepEnd, tail.startIndex))
	const insertIndex = messages.indexOf(active[tail.startIndex])
	const tagged = messages.map((message) =>
		hidden.has(message) ? { ...message, truncationParent: truncationId } : message,
	)
	tagged.splice(insertIndex, 0, marker)
	const tokens = await countContextTokens(getEffectiveApiHistory(tagged), apiHandler, systemPrompt, metadata)
	signal?.throwIfAborted()
	if (
		!Number.isFinite(tokens) ||
		tokens > maxContextTokens ||
		(forcedRecoveryTokens !== undefined &&
			(!Number.isFinite(forcedRecoveryTokens) || tokens >= forcedRecoveryTokens))
	)
		return { ...unchanged, tokens }
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)
	return { messages: tagged, truncationId, messagesRemoved: hidden.size, tokens, status: "reduced" }
}

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
		return prevContextTokens > allowedTokens
	}

	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = (100 * prevContextTokens) / contextWindow
	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Alpha during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
	recentTailTokenBudget?: number
	/** The provider rejected this input even if the local token estimate is lower. */
	forceCompaction?: boolean
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
	/** Explicit terminal state for a bounded recovery attempt. */
	status?: ContextRecoveryStatus
	/** The target input budget used for compaction decisions. */
	targetContextTokens?: number
	/** Reduction measured against prevContextTokens, when available. */
	reductionPercent?: number
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
	recentTailTokenBudget,
	forceCompaction = false,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	metadata?.signal?.throwIfAborted()
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	let forceTruncation = forceCompaction
	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const targetContextTokens = getCompactionTargetTokens({
		contextWindow,
		reservedTokens,
		targetPercent: DEFAULT_COMPACTION_TARGET_PERCENT,
	})

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage?.content ?? ""
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Provider rejection invalidates the historical estimate. Forced recovery
	// must reduce active input using the same counter as the resulting candidate.
	const prevContextTokens = forceCompaction
		? await countContextTokens(getEffectiveApiHistory(messages), apiHandler, systemPrompt, metadata)
		: totalTokens + lastMessageTokens
	metadata?.signal?.throwIfAborted()

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold
		} else {
			// Invalid threshold value, fall back to global setting
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	if (autoCondenseContext) {
		const contextPercent = (100 * prevContextTokens) / contextWindow
		if (forceCompaction || contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the context
			const result = await summarizeConversation({
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd,
				rooIgnoreController,
				maxContextTokens: targetContextTokens,
				recentTailTokenBudget,
			})
			metadata?.signal?.throwIfAborted()
			cost = result.cost
			if (result.error) {
				error = result.error
				errorDetails = result.errorDetails
				// A failed compaction must not leave the caller retrying the same
				// oversized input.  Truncation is the bounded fallback; the
				// context-window check remains useful for preserving the original
				// forced-recovery semantics and diagnostics.
				const isContextWindowError = checkContextWindowExceededError(
					new Error([result.error, result.errorDetails].filter(Boolean).join("\n\n")),
				)
				forceTruncation = isContextWindowError || Boolean(result.error)
			} else {
				const progress = evaluateCompactionProgress({
					beforeTokens: prevContextTokens,
					afterTokens: result.newContextTokens,
					targetTokens: targetContextTokens,
					minReductionPercent: DEFAULT_MIN_REDUCTION_PERCENT,
				})

				if (
					progress.status === "reduced" &&
					progress.targetReached &&
					(!forceCompaction || (Number.isFinite(prevContextTokens) && progress.reductionTokens > 0))
				) {
					return {
						...result,
						prevContextTokens,
						status: progress.status,
						targetContextTokens,
						reductionPercent: progress.reductionPercent,
					}
				}

				// A successful API call is not enough: if it did not produce a
				// measurable reduction, continue to the one bounded truncation
				// fallback below instead of silently accepting unchanged input.
				forceTruncation = true
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens || forceTruncation) {
		const truncationResult = await truncateToTokenBudget(
			messages,
			apiHandler,
			systemPrompt,
			targetContextTokens,
			taskId,
			metadata,
			forceCompaction ? prevContextTokens : undefined,
		)
		metadata?.signal?.throwIfAborted()
		const newContextTokensAfterTruncation =
			truncationResult.messagesRemoved > 0
				? truncationResult.tokens
				: await countContextTokens(getEffectiveApiHistory(messages), apiHandler, systemPrompt, metadata)
		metadata?.signal?.throwIfAborted()

		const fallbackProgress = evaluateCompactionProgress({
			beforeTokens: prevContextTokens,
			afterTokens: newContextTokensAfterTruncation,
			targetTokens: targetContextTokens,
			minReductionPercent: DEFAULT_MIN_REDUCTION_PERCENT,
		})
		const status = truncationResult.status

		return {
			messages: truncationResult.messages,
			prevContextTokens,
			summary: "",
			cost,
			error,
			errorDetails,
			truncationId: truncationResult.messagesRemoved > 0 ? truncationResult.truncationId : undefined,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
			status,
			targetContextTokens,
			reductionPercent: fallbackProgress.reductionPercent,
		}
	}
	// No truncation or condensation needed
	return { messages, summary: "", cost, prevContextTokens, error, errorDetails }
}
