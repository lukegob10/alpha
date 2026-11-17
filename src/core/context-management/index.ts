import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import {
	countContextTokens,
	createTokenCountContext,
	getEffectiveApiHistory,
	getLogicalStepStarts,
	hasToolCallResultIntegrity,
	selectRecentTail,
	summarizeConversation,
	SummarizeResponse,
	TokenCountContext,
	type CompactionUsageObserver,
} from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { getPendingAgentMailIds } from "../task-persistence/agentMailSampling"
import { ANTHROPIC_DEFAULT_MAX_TOKENS, type AutoCondenseContextScope } from "@alpha-code/types"
import { AlphaIgnoreController } from "../ignore/AlphaIgnoreController"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	DEFAULT_MIN_REDUCTION_PERCENT,
	evaluateCompactionProgress,
	getCompactionTargetTokens,
	getContextLimits,
	isAutoCondenseLimitReached,
	resolveCondenseThreshold,
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
 * Compaction and fallback share one input budget and preserve complete steps.
 */

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
	countContext?: TokenCountContext,
): Promise<number> {
	if (!content || content.length === 0) return 0
	const operation = countContext ?? createTokenCountContext(apiHandler)
	return operation.countTokens(content, apiHandler)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
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
	metadata?: ApiHandlerCreateMessageMetadata,
	beforeTokens?: number,
	countContext?: TokenCountContext,
): Promise<TruncationResult & { tokens: number; status: ContextRecoveryStatus }> {
	const signal = metadata?.signal
	const operation =
		countContext ??
		createTokenCountContext(apiHandler, {
			signal,
			remoteDeadline: metadata?.deadline,
		})
	signal?.throwIfAborted()
	const active = getEffectiveApiHistory(messages, apiHandler.nativeCompaction?.scope ?? null)
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
	const fixedTokens = await countContextTokens([...firstStep, marker], apiHandler, systemPrompt, metadata, operation)
	if (!Number.isFinite(fixedTokens) || fixedTokens < 0) {
		return { ...unchanged, tokens: Number.NaN, status: "no_progress" }
	}
	// A provider may have rejected this request despite a lower local estimate.
	// Still make one real reduction, then tighten further if the budget requires it.
	const requestedStart = firstStepEnd + Math.max(1, Math.floor((active.length - firstStepEnd) / 2))
	const eligibleStarts = starts.filter((start) => start > firstStepEnd)
	const minimumTailStart =
		eligibleStarts.filter((start) => start <= requestedStart).at(-1) ?? eligibleStarts[0] ?? active.length
	const tail = await selectRecentTail(
		active,
		apiHandler,
		maxContextTokens - fixedTokens,
		minimumTailStart,
		signal,
		operation,
	)
	if (!Number.isFinite(tail.tokens) || tail.tokens < 0) {
		return { ...unchanged, tokens: Number.NaN, status: "no_progress" }
	}
	if (tail.startIndex === active.length || tail.startIndex <= firstStepEnd) return unchanged
	const pendingMailIds = getPendingAgentMailIds(messages)
	const hidden = new Set(
		active
			.slice(firstStepEnd, tail.startIndex)
			.filter((message) => !message.agent_message_id || !pendingMailIds.has(message.agent_message_id)),
	)
	if (hidden.size === 0) return unchanged
	const insertIndex = messages.indexOf(active[tail.startIndex])
	const tagged = messages.map((message) =>
		hidden.has(message) ? { ...message, truncationParent: truncationId } : message,
	)
	tagged.splice(insertIndex, 0, marker)
	if (!hasToolCallResultIntegrity(getEffectiveApiHistory(tagged, apiHandler.nativeCompaction?.scope ?? null)))
		return unchanged
	const tokens = await countContextTokens(
		getEffectiveApiHistory(tagged, apiHandler.nativeCompaction?.scope ?? null),
		apiHandler,
		systemPrompt,
		metadata,
		operation,
	)
	signal?.throwIfAborted()
	if (
		!Number.isFinite(tokens) ||
		tokens < 0 ||
		tokens > maxContextTokens ||
		(beforeTokens !== undefined && (!Number.isFinite(beforeTokens) || tokens >= beforeTokens))
	)
		return { ...unchanged, tokens }
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
	autoCondenseContextScope?: AutoCondenseContextScope
	prefillContextTokens?: number
	/** @deprecated Retained only so old callers and saved settings remain readable. */
	profileThresholds?: Record<string, number>
	/** @deprecated Profile-specific compaction thresholds are no longer supported. */
	currentProfileId?: string
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
	autoCondenseContextScope,
	prefillContextTokens,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	const reservedTokens = maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const threshold = resolveCondenseThreshold(autoCondenseContextPercent)
	const { allowedTokens, triggerTokens } = getContextLimits(contextWindow, reservedTokens, threshold)
	return autoCondenseContext
		? isAutoCondenseLimitReached(
				prevContextTokens,
				triggerTokens,
				allowedTokens,
				autoCondenseContextScope,
				prefillContextTokens,
			)
		: prevContextTokens > allowedTokens
}

/** A safe text ceiling can rule out compaction without waiting for a provider tokenizer. */
export async function getContextManagementLastMessageTokens(
	content: ApiMessage["content"] | undefined,
	options: Omit<WillManageContextOptions, "lastMessageTokens">,
	apiHandler: ApiHandler,
	countContext: TokenCountContext,
): Promise<number> {
	countContext.signal?.throwIfAborted()
	const blocks = Array.isArray(content) ? content : [{ type: "text" as const, text: content ?? "" }]
	if (blocks.every((block) => block?.type === "text" && block.text === "")) return 0
	const textOnly = blocks.every(
		(block) =>
			(block?.type === "text" && typeof block.text === "string") ||
			(block?.type === "tool_result" &&
				(block.content === undefined ||
					typeof block.content === "string" ||
					(Array.isArray(block.content) &&
						block.content.every((part) => part?.type === "text" && typeof part.text === "string")))),
	)
	if (
		textOnly &&
		Number.isFinite(options.totalTokens) &&
		options.totalTokens >= 0 &&
		Number.isFinite(options.contextWindow) &&
		options.contextWindow > 0 &&
		(options.maxTokens == null || (Number.isFinite(options.maxTokens) && options.maxTokens >= 0)) &&
		options.autoCondenseContextPercent === resolveCondenseThreshold(options.autoCondenseContextPercent) &&
		(options.prefillContextTokens === undefined ||
			(Number.isFinite(options.prefillContextTokens) && options.prefillContextTokens >= 0))
	) {
		let ceiling: number | undefined
		try {
			// Codex 05ae1b0f (2026-11-17), context_manager/history.rs estimates unsampled
			// text locally. Alpha uses whole serialized UTF-8 bytes (not bytes / 4) only
			// to prove that compaction cannot be needed. Media and opaque state stay exact.
			ceiling = Buffer.byteLength(JSON.stringify(blocks), "utf8")
		} catch {
			// Keep malformed/non-serializable input under the existing counter's rules.
		}
		if (ceiling !== undefined && !willManageContext({ ...options, lastMessageTokens: ceiling })) {
			// This bound is not an exact count and must never enter the tokenizer cache.
			return ceiling
		}
	}
	return countContext.countTokens(blocks, apiHandler)
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Preserves the original history when condensation fails or misses its target.
 * Sliding window truncation remains available when condensation is disabled.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	/** One host admission for summarization or explicit sliding-window truncation. */
	beforeCompact?: () => Promise<void>
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	/** Optional previous model used only to summarize input that exceeds the selected model's window. */
	compactionApiHandler?: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	autoCondenseContextScope?: AutoCondenseContextScope
	prefillContextTokens?: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	/** @deprecated Retained only so old callers and saved settings remain readable. */
	profileThresholds?: Record<string, number>
	/** @deprecated Profile-specific compaction thresholds are no longer supported. */
	currentProfileId?: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Resolve tool overhead only after compaction is required; control metadata stays eager. */
	prepareTools?: () => Promise<
		Pick<ApiHandlerCreateMessageMetadata, "tools" | "tool_choice" | "parallelToolCalls" | "allowedFunctionNames">
	>
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Alpha during the task (will be folded via tree-sitter) */
	filesReadByAlpha?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByAlpha is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	alphaIgnoreController?: AlphaIgnoreController
	recentTailTokenBudget?: number
	/** The provider rejected this input even if the local token estimate is lower. */
	forceCompaction?: boolean
	/** Shared token-counting budget/cache for this context-preparation operation. */
	countContext?: TokenCountContext
	beforeAttempt?: () => Promise<void>
	observeUsage?: CompactionUsageObserver
	inputIncludesCache?: boolean
	/** Retain observed summary usage independently of the recovery outcome. */
	observeCost?: (cost: number) => void
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
 * Conditionally summarizes context or applies explicit sliding-window truncation.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	beforeCompact,
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	compactionApiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	autoCondenseContextScope,
	prefillContextTokens,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	metadata,
	prepareTools,
	environmentDetails,
	filesReadByAlpha,
	cwd,
	alphaIgnoreController,
	recentTailTokenBudget,
	forceCompaction = false,
	countContext,
	observeCost,
	observeUsage,
	beforeAttempt,
	inputIncludesCache,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	metadata?.signal?.throwIfAborted()
	let compactAdmission: Promise<void> | undefined
	const admitCompaction = async () => {
		compactAdmission ??= Promise.resolve().then(() => beforeCompact?.())
		await compactAdmission
		metadata?.signal?.throwIfAborted()
	}
	const operation =
		countContext ??
		createTokenCountContext(apiHandler, {
			signal: metadata?.signal,
			remoteDeadline: metadata?.deadline,
		})
	operation.signal?.throwIfAborted()
	const prepareToolMetadata = async () => {
		if (!prepareTools) return
		metadata?.signal?.throwIfAborted()
		operation.signal?.throwIfAborted()
		const { tools, tool_choice, parallelToolCalls, allowedFunctionNames } = await prepareTools()
		metadata?.signal?.throwIfAborted()
		operation.signal?.throwIfAborted()
		// Select only tool fields: deferred work cannot replace cancellation or request authority.
		metadata = { taskId, ...metadata, tools, tool_choice, parallelToolCalls, allowedFunctionNames }
		prepareTools = undefined
	}
	let diagnostic: SummarizeResponse["diagnostic"]
	let cost = 0
	const forceTruncation = forceCompaction
	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS
	const threshold = resolveCondenseThreshold(autoCondenseContextPercent)
	const { allowedTokens, triggerTokens, compactionInputLimit } = getContextLimits(
		contextWindow,
		reservedTokens,
		threshold,
		autoCondenseContextScope,
	)
	let targetContextTokens = getCompactionTargetTokens({
		contextWindow,
		reservedTokens,
		triggerTokens: autoCondenseContext ? compactionInputLimit : allowedTokens,
	})

	// Provider rejection invalidates the historical estimate. Forced recovery
	// must reduce active input using the same counter as the resulting candidate.
	// In that branch the full count already includes the newest message, so avoid
	// issuing a duplicate standalone tokenizer request for it.
	let prevContextTokens: number
	if (forceCompaction) {
		if (prepareTools) await prepareToolMetadata()
		prevContextTokens = await countContextTokens(
			getEffectiveApiHistory(messages, apiHandler.nativeCompaction?.scope ?? null),
			apiHandler,
			systemPrompt,
			metadata,
			operation,
		)
	} else {
		// Estimate tokens for the last message (which is always a user message).
		const lastMessageTokens = await getContextManagementLastMessageTokens(
			messages[messages.length - 1]?.content,
			{
				totalTokens,
				contextWindow,
				maxTokens,
				autoCondenseContext,
				autoCondenseContextPercent,
				autoCondenseContextScope,
				prefillContextTokens,
			},
			apiHandler,
			operation,
		)
		prevContextTokens = totalTokens + lastMessageTokens
	}
	metadata?.signal?.throwIfAborted()
	if (!Number.isFinite(prevContextTokens) || prevContextTokens < 0) {
		return {
			messages,
			summary: "",
			cost,
			prevContextTokens,
			status: "no_progress",
			targetContextTokens,
		}
	}

	if (autoCondenseContext) {
		if (
			forceCompaction ||
			isAutoCondenseLimitReached(
				prevContextTokens,
				triggerTokens,
				allowedTokens,
				autoCondenseContextScope,
				prefillContextTokens,
			)
		) {
			if (prepareTools) await prepareToolMetadata()
			// Charge fixed prompt and schema overhead before budgeting the summary and tail.
			const fixedTokens = await countContextTokens([], apiHandler, systemPrompt, metadata, operation)
			if (!Number.isFinite(fixedTokens) || fixedTokens < 0)
				return { messages, summary: "", cost, prevContextTokens, status: "no_progress" }
			targetContextTokens = getCompactionTargetTokens({
				contextWindow,
				reservedTokens,
				triggerTokens: compactionInputLimit,
				fixedTokens,
			})
			// Attempt to intelligently condense the context
			const result = await summarizeConversation({
				beforeCompact: admitCompaction,
				messages,
				apiHandler,
				compactionApiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByAlpha,
				cwd,
				alphaIgnoreController,
				maxContextTokens: targetContextTokens,
				recentTailTokenBudget,
				countContext: operation,
				forceCompaction,
				observeCost,
				observeUsage,
				beforeAttempt,
				inputIncludesCache,
			})
			metadata?.signal?.throwIfAborted()
			cost = result.cost
			diagnostic = result.diagnostic
			// Historical provider usage selects the trigger; the compactor measures
			// both sides with one counter for progress and the user-visible receipt.
			prevContextTokens = result.prevContextTokens ?? prevContextTokens
			if (
				result.status === "unchanged" &&
				!forceCompaction &&
				(result.newContextTokens ?? Infinity) < compactionInputLimit
			) {
				return { ...result, prevContextTokens, targetContextTokens }
			}
			if (result.error) {
				// Preserve a fitting history when summarization fails for reasons
				// unrelated to input size. Required recovery must stop without replacing
				// human instructions with an unsummarized sliding window.
				const isContextWindowError = checkContextWindowExceededError(
					new Error([result.error, result.errorDetails].filter(Boolean).join("\n\n")),
				)
				if (!forceCompaction && !isContextWindowError) {
					// A proactive summary failure is not context exhaustion. Recount the
					// retained input, including fixed overhead, before allowing a normal
					// request above the preferred trigger but within the safe input limit.
					const retainedTokens = await countContextTokens(
						getEffectiveApiHistory(messages, apiHandler.nativeCompaction?.scope ?? null),
						apiHandler,
						systemPrompt,
						metadata,
						operation,
					)
					metadata?.signal?.throwIfAborted()
					operation.signal?.throwIfAborted()
					if (!Number.isFinite(retainedTokens) || retainedTokens < 0) {
						return { ...result, messages, prevContextTokens, status: "no_progress", targetContextTokens }
					}
					prevContextTokens = retainedTokens
					if (retainedTokens <= allowedTokens) {
						return {
							...result,
							messages,
							prevContextTokens,
							newContextTokens: retainedTokens,
							status: result.status === "exhausted" ? "exhausted" : "unchanged",
							targetContextTokens,
						}
					}
				}
				// Codex 67f0994b, core/src/compact.rs (2026-11-01): failed compaction
				// leaves installed history intact so a later turn can retry safely.
				return {
					...result,
					messages,
					prevContextTokens,
					status: result.status === "exhausted" ? "exhausted" : "no_progress",
					targetContextTokens,
				}
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

				// A successful response cannot replace failed compaction with raw
				// truncation: the uninstalled summary may be the only representation
				// of human corrections outside the retained tail.
				return {
					...result,
					messages,
					summary: "",
					prevContextTokens,
					status: "no_progress",
					targetContextTokens,
					reductionPercent: progress.reductionPercent,
				}
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens || forceTruncation) {
		if (prepareTools) await prepareToolMetadata()
		// Truncation is recovery, not summarization. Preserve complete recent
		// steps with a wider budget while staying below the next trigger.
		const fixedTokens = await countContextTokens([], apiHandler, systemPrompt, metadata, operation)
		if (!Number.isFinite(fixedTokens) || fixedTokens < 0)
			return {
				messages,
				summary: "",
				cost,
				prevContextTokens,
				status: "no_progress",
				newContextTokensAfterTruncation: Number.NaN,
			}
		prevContextTokens = await countContextTokens(
			getEffectiveApiHistory(messages, apiHandler.nativeCompaction?.scope ?? null),
			apiHandler,
			systemPrompt,
			metadata,
			operation,
		)
		if (!Number.isFinite(prevContextTokens) || prevContextTokens < 0)
			return { messages, summary: "", cost, prevContextTokens, status: "no_progress" }
		// Historical usage can overstate retained input after a reduction or provider
		// change. Preserve a fitting recount unless recovery requires a real reduction.
		if (!forceTruncation && prevContextTokens <= allowedTokens) {
			return {
				messages,
				summary: "",
				cost,
				prevContextTokens,
				newContextTokens: prevContextTokens,
				diagnostic,
				status: "unchanged",
				targetContextTokens: allowedTokens,
			}
		}
		targetContextTokens = getCompactionTargetTokens({
			contextWindow,
			reservedTokens,
			triggerTokens: allowedTokens,
			fixedTokens,
			targetPercent: 75,
		})
		await admitCompaction()
		const truncationResult = await truncateToTokenBudget(
			messages,
			apiHandler,
			systemPrompt,
			targetContextTokens,
			metadata,
			prevContextTokens,
			operation,
		)
		metadata?.signal?.throwIfAborted()
		const newContextTokensAfterTruncation =
			truncationResult.status === "no_progress"
				? truncationResult.tokens
				: truncationResult.messagesRemoved > 0
					? truncationResult.tokens
					: await countContextTokens(
							getEffectiveApiHistory(messages, apiHandler.nativeCompaction?.scope ?? null),
							apiHandler,
							systemPrompt,
							metadata,
							operation,
						)
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
			truncationId: truncationResult.messagesRemoved > 0 ? truncationResult.truncationId : undefined,
			diagnostic,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
			status,
			targetContextTokens,
			reductionPercent: fallbackProgress.reductionPercent,
		}
	}
	// No truncation or condensation needed
	return { messages, summary: "", cost, prevContextTokens }
}
