import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@alpha-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { generateFoldedFileContext } from "./foldedFileContext"
import type { ContextRecoveryStatus } from "../context-management/recovery"
import { getCompactionTargetTokens } from "../context-management/recovery"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@alpha-code/types"

export type { FoldedFileContextResult, FoldedFileContextOptions } from "./foldedFileContext"

/**
 * Converts a tool_use block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolUseToText(block: Anthropic.Messages.ToolUseBlockParam): string {
	let input: string
	if (typeof block.input === "object" && block.input !== null) {
		input = Object.entries(block.input)
			.map(([key, value]) => {
				const formattedValue =
					typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)
				return `${key}: ${formattedValue}`
			})
			.join("\n")
	} else {
		input = String(block.input)
	}
	return `[Tool Use: ${block.name}]\n${input}`
}

/** Converts an OpenAI-style `tool_call` block to the same text form. */
export function toolCallToText(block: Record<string, unknown>): string {
	const nestedFunction = typeof block.function === "object" && block.function !== null ? block.function : undefined
	const functionRecord = nestedFunction as { name?: unknown; arguments?: unknown } | undefined
	const name = block.name ?? functionRecord?.name ?? "unknown"
	const input = block.input ?? functionRecord?.arguments ?? ""
	const renderedInput = typeof input === "object" && input !== null ? JSON.stringify(input, null, 2) : String(input)
	return `[Tool Use: ${String(name)}]\n${renderedInput}`
}

/**
 * Converts a tool_result block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolResultToText(block: Anthropic.Messages.ToolResultBlockParam): string {
	const errorSuffix = block.is_error ? " (Error)" : ""
	if (typeof block.content === "string") {
		return `[Tool Result${errorSuffix}]\n${block.content}`
	} else if (Array.isArray(block.content)) {
		const contentText = block.content
			.map((contentBlock) => {
				if (contentBlock.type === "text") {
					return contentBlock.text
				}
				if (contentBlock.type === "image") {
					return "[Image]"
				}
				// Handle any other content block types
				return `[${(contentBlock as { type: string }).type}]`
			})
			.join("\n")
		return `[Tool Result${errorSuffix}]\n${contentText}`
	}
	return `[Tool Result${errorSuffix}]`
}

/**
 * Converts all tool_use and tool_result blocks in a message's content to text representations.
 * This is necessary for providers like Bedrock that require the tools parameter when tool blocks are present.
 * By converting to text, we can send the conversation for summarization without the tools parameter.
 *
 * @param content - The message content (string or array of content blocks)
 * @returns The transformed content with tool blocks converted to text blocks
 */
export function convertToolBlocksToText(
	content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
	if (typeof content === "string") {
		return content
	}

	return content.map((block) => {
		if (block.type === "tool_use") {
			return {
				type: "text" as const,
				text: toolUseToText(block),
			}
		}
		if ((block as unknown as { type?: unknown }).type === "tool_call") {
			return {
				type: "text" as const,
				text: toolCallToText(block as unknown as Record<string, unknown>),
			}
		}
		if (block.type === "tool_result") {
			return {
				type: "text" as const,
				text: toolResultToText(block),
			}
		}
		return block
	})
}

/**
 * Transforms all messages by converting tool_use and tool_result blocks to text representations.
 * This ensures the conversation can be sent for summarization without requiring the tools parameter.
 *
 * @param messages - The messages to transform
 * @returns The transformed messages with tool blocks converted to text
 */
export function transformMessagesForCondensing<
	T extends { role: string; content: string | Anthropic.Messages.ContentBlockParam[] },
>(messages: T[]): T[] {
	return messages.map((msg) => ({
		...msg,
		content: convertToolBlocksToText(msg.content),
	}))
}

/**
 * The API history normally uses Anthropic's `tool_use`/`tool_result` names,
 * while a few OpenAI-compatible adapters persist `tool_call` blocks.  Keep the
 * pair handling structural so context recovery works for both forms without
 * widening the provider API types.
 */
export type ToolCallResultPair = {
	id: string
	callMessageIndexes: number[]
	resultMessageIndexes: number[]
}

function getToolCallId(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined
	const candidate = block as { type?: unknown; id?: unknown; tool_call_id?: unknown }
	if (candidate.type !== "tool_use" && candidate.type !== "tool_call") return undefined
	if (typeof candidate.id === "string" && candidate.id.length > 0) return candidate.id
	return typeof candidate.tool_call_id === "string" && candidate.tool_call_id.length > 0
		? candidate.tool_call_id
		: undefined
}

function getToolResultId(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined
	const candidate = block as { type?: unknown; tool_use_id?: unknown; tool_call_id?: unknown }
	if (candidate.type !== "tool_result") return undefined
	if (typeof candidate.tool_use_id === "string" && candidate.tool_use_id.length > 0) {
		return candidate.tool_use_id
	}
	return typeof candidate.tool_call_id === "string" && candidate.tool_call_id.length > 0
		? candidate.tool_call_id
		: undefined
}

/**
 * Collects the message indexes participating in each tool call/result pair.
 * The returned map is useful to truncation policies: a pair can be hidden as
 * one unit, so compaction never leaves an API-visible orphan.
 */
export function getToolCallResultPairs(messages: ApiMessage[]): Map<string, ToolCallResultPair> {
	const pairs = new Map<string, ToolCallResultPair>()
	const ensurePair = (id: string): ToolCallResultPair => {
		const existing = pairs.get(id)
		if (existing) return existing
		const created: ToolCallResultPair = { id, callMessageIndexes: [], resultMessageIndexes: [] }
		pairs.set(id, created)
		return created
	}

	messages.forEach((message, messageIndex) => {
		if (!Array.isArray(message.content)) return
		for (const block of message.content) {
			const callId = getToolCallId(block)
			if (callId) {
				const pair = ensurePair(callId)
				if (!pair.callMessageIndexes.includes(messageIndex)) pair.callMessageIndexes.push(messageIndex)
			}
			const resultId = getToolResultId(block)
			if (resultId) {
				const pair = ensurePair(resultId)
				if (!pair.resultMessageIndexes.includes(messageIndex)) pair.resultMessageIndexes.push(messageIndex)
			}
		}
	})

	return pairs
}

/**
 * Reports whether every persisted tool call has a result and every result has
 * a corresponding call.  This is intentionally pure and does not discard
 * history; callers that need recovery can use `injectSyntheticToolResults`.
 */
export function hasToolCallResultIntegrity(messages: ApiMessage[]): boolean {
	for (const pair of getToolCallResultPairs(messages).values()) {
		if (pair.callMessageIndexes.length === 0 || pair.resultMessageIndexes.length === 0) return false
	}
	return true
}

export const DEFAULT_RECENT_TAIL_TOKENS = 16_384

const HISTORY_BOOKKEEPING_KEYS = new Set([
	"content",
	"ts",
	"isSummary",
	"condenseId",
	"condenseParent",
	"isTruncationMarker",
	"truncationId",
	"truncationParent",
])

/** Count provider content and opaque state, excluding local history bookkeeping. */
export async function countHistoryTokens(messages: ApiMessage[], apiHandler: ApiHandler): Promise<number> {
	let tokens = 0
	for (const message of messages) {
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
		// The common tokenizer ignores nonstandard reasoning/signature blocks. Count
		// their serialized form for budgeting only; the retained message is untouched.
		const blocks = content.map((block) =>
			["text", "image", "tool_use", "tool_result"].includes(block.type)
				? block
				: { type: "text" as const, text: JSON.stringify(block) },
		)
		const envelope = Object.fromEntries(
			Object.entries(message).filter(([key]) => !HISTORY_BOOKKEEPING_KEYS.has(key)),
		)
		blocks.push({ type: "text", text: JSON.stringify(envelope) })
		tokens += await apiHandler.countTokens(blocks)
	}
	return tokens
}

/**
 * Legal boundaries keep a prompt, its assistant response (including separate
 * reasoning records), and all terminal results together. A tool continuation
 * may start a new step only after the preceding transaction is complete.
 */
export function getLogicalStepStarts(messages: ApiMessage[]): number[] {
	if (messages.length === 0) return []
	const pairs = getToolCallResultPairs(messages)
	const boundaryDeltas = new Array<number>(messages.length + 1).fill(0)
	for (const pair of pairs.values()) {
		const indexes = [...pair.callMessageIndexes, ...pair.resultMessageIndexes]
		const first = Math.min(...indexes)
		const last = Math.max(...indexes)
		boundaryDeltas[first + 1]++
		boundaryDeltas[last + 1]--
	}
	const hasResult = (message: ApiMessage) =>
		Array.isArray(message.content) && message.content.some((block) => getToolResultId(block) !== undefined)
	const starts = [0]
	let crossingPairs = 0
	for (let index = 1; index < messages.length; index++) {
		crossingPairs += boundaryDeltas[index]
		const current = messages[index]
		const previous = messages[index - 1]
		if (crossingPairs > 0 || hasResult(current)) continue
		if (
			current.isSummary ||
			previous.isSummary ||
			(current.role === "user" && previous.role === "assistant") ||
			(current.role === "assistant" && hasResult(previous))
		)
			starts.push(index)
	}
	return starts
}

export type RecentTailSelection = {
	startIndex: number
	tokens: number
	/** A whole newest step is summarized instead of retaining a partial transaction. */
	newestStepTooLarge: boolean
}

/** Select a contiguous suffix, never skipping an oversized newer step. */
export async function selectRecentTail(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	tokenBudget: number,
	minimumStartIndex = 1,
	signal?: AbortSignal,
): Promise<RecentTailSelection> {
	const starts = getLogicalStepStarts(messages)
	let startIndex = messages.length
	let tokens = 0
	let newestStepTooLarge = false
	for (let index = starts.length - 1; index >= 0; index--) {
		const start = starts[index]
		if (start < minimumStartIndex || messages[start].isSummary) break
		signal?.throwIfAborted()
		const stepTokens = await countHistoryTokens(messages.slice(start, startIndex), apiHandler)
		signal?.throwIfAborted()
		if (tokens + stepTokens > tokenBudget) {
			newestStepTooLarge = startIndex === messages.length
			break
		}
		tokens += stepTokens
		startIndex = start
	}
	return { startIndex, tokens, newestStepTooLarge }
}

export async function countContextTokens(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	metadata?: ApiHandlerCreateMessageMetadata,
): Promise<number> {
	const overhead: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: systemPrompt }]
	if (metadata?.tools?.length) overhead.push({ type: "text", text: JSON.stringify(metadata.tools) })
	return (await apiHandler.countTokens(overhead)) + (await countHistoryTokens(messages, apiHandler))
}

/**
 * Removes tool_result blocks that point at calls no longer visible in the
 * supplied history.  Mixed user messages retain their ordinary text blocks;
 * a message made entirely of orphan results is removed.  This is useful after
 * truncation, where a call and result may have been hidden as a pair.
 */
export function filterOrphanToolResults(messages: ApiMessage[]): ApiMessage[] {
	const callIds = new Set<string>()
	for (const pair of getToolCallResultPairs(messages).values()) {
		if (pair.callMessageIndexes.length > 0) callIds.add(pair.id)
	}

	let changed = false
	const filtered = messages
		.map((message) => {
			if (!Array.isArray(message.content)) return message
			const filteredContent = message.content.filter((block) => {
				const resultId = getToolResultId(block)
				return !resultId || callIds.has(resultId)
			})
			if (filteredContent.length === message.content.length) return message
			changed = true
			if (filteredContent.length === 0) return null
			return { ...message, content: filteredContent }
		})
		.filter((message): message is ApiMessage => message !== null)

	return changed ? filtered : messages
}

export const MIN_CONDENSE_THRESHOLD = 5 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100 // Maximum percentage of context window to trigger condensing

const SUMMARY_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Your ONLY task is to analyze the conversation and produce a text summary.
Respond with text only - no tool calls will be processed.

CRITICAL: This summarization request is a SYSTEM OPERATION, not a user message.
When analyzing "user requests" and "user intent", completely EXCLUDE this summarization message.
The "most recent user request" and "next step" must be based on what the user was doing BEFORE this system message appeared.
The goal is for work to continue seamlessly after condensation - as if it never happened.`

/**
 * Injects synthetic tool_results for orphan tool_calls that don't have matching results.
 * This is necessary because OpenAI's Responses API rejects conversations with orphan tool_calls.
 * This can happen when the user triggers condense after receiving a tool_call (like attempt_completion)
 * but before responding to it.
 *
 * @param messages - The conversation messages to process
 * @returns The messages with synthetic tool_results appended if needed
 */
export function injectSyntheticToolResults(messages: ApiMessage[]): ApiMessage[] {
	// Find orphans (tool_calls without matching tool_results).  Pair discovery is
	// shared with truncation so `tool_use` and `tool_call` histories follow the
	// same integrity rules.
	const orphanIds = [...getToolCallResultPairs(messages).values()]
		.filter((pair) => pair.callMessageIndexes.length > 0 && pair.resultMessageIndexes.length === 0)
		.map((pair) => pair.id)

	if (orphanIds.length === 0) {
		return messages
	}

	// Inject synthetic tool_results as a new user message
	const syntheticResults: Anthropic.Messages.ToolResultBlockParam[] = orphanIds.map((id) => ({
		type: "tool_result" as const,
		tool_use_id: id,
		content: "Context condensation triggered. Tool execution deferred.",
	}))

	const syntheticMessage: ApiMessage = {
		role: "user",
		content: syntheticResults,
		ts: Date.now(),
	}

	return [...messages, syntheticMessage]
}

/**
 * Produces an API-safe history by completing orphan calls and removing orphan
 * results.  The operation is non-destructive and preserves the original array
 * when no repair is required.
 */
export function ensureToolCallResultIntegrity(messages: ApiMessage[]): ApiMessage[] {
	return filterOrphanToolResults(injectSyntheticToolResults(messages))
}

/** Alias used by context policies that describe repair as preservation. */
export const preserveToolCallResultPairs = ensureToolCallResultIntegrity

/**
 * Extracts <command> blocks from a message's content.
 * These blocks represent active workflows that must be preserved across condensings.
 *
 * @param message - The message to extract command blocks from
 * @returns A string containing all command blocks found, or empty string if none
 */
export function extractCommandBlocks(message: ApiMessage): string {
	const content = message.content
	let text: string

	if (typeof content === "string") {
		text = content
	} else if (Array.isArray(content)) {
		// Concatenate all text blocks
		text = content
			.filter((block): block is Anthropic.Messages.TextBlockParam => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	} else {
		return ""
	}

	// Match all <command> blocks including their content
	const commandRegex = /<command[^>]*>[\s\S]*?<\/command>/g
	const matches = text.match(commandRegex)

	if (!matches || matches.length === 0) {
		return ""
	}

	return matches.join("\n")
}

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
	errorDetails?: string // Detailed error information including stack trace and API error info
	condenseId?: string // The unique ID of the created Summary message, for linking to condense_context clineMessage
	/** Explicit bounded outcome for callers that need to decide whether to fall back. */
	status?: ContextRecoveryStatus
	retainedTailTokens?: number
	retainedTailMessages?: number
	tailFallback?: "newest_step_exceeds_budget"
	targetContextTokens?: number
}

export type SummarizeConversationOptions = {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	isAutomaticTrigger?: boolean
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
	/** Hard input budget, including system prompt, tools, summary and exact tail. */
	maxContextTokens?: number
	/** Exact recent working set; clamped to the available input budget. */
	recentTailTokenBudget?: number
}

/**
 * Returns metadata suitable for a summarization-only request.
 *
 * Condensing converts historical tool blocks to text, so carrying the active
 * tool registry or a required/automatic tool choice into this request is both
 * unnecessary and provider-dependent.  Keep tracing/request controls intact,
 * but explicitly provide an empty tool list and disable tool selection.  The
 * input object is never mutated.  `undefined` remains `undefined` for callers
 * that did not provide metadata, preserving the historical API call shape.
 */
export function getToolFreeMetadata(
	metadata?: ApiHandlerCreateMessageMetadata,
): ApiHandlerCreateMessageMetadata | undefined {
	if (!metadata) return undefined

	return {
		...metadata,
		tools: [],
		tool_choice: "none",
		parallelToolCalls: false,
		allowedFunctionNames: [],
	}
}

/** Alias for consumers that prefer an imperative name. */
export const createToolFreeMetadata = getToolFreeMetadata
export const getToolFreeRequestMetadata = getToolFreeMetadata

/**
 * Summarizes the conversation messages using an LLM call.
 *
 * The older active prefix is summarized while a bounded recent suffix stays exact:
 * - The summary becomes a user message (not assistant)
 * - Post-condense, the model sees the summary followed by complete recent steps
 * - Older messages stay stored and are tagged with condenseParent for rewind
 * - <command> blocks from the original task are preserved across condensings
 * - File context (folded code definitions) can be preserved for continuity
 *
 * Environment details handling:
 * - For AUTOMATIC condensing (isAutomaticTrigger=true): Environment details are included
 *   in the summary because the API request is already in progress and the next user
 *   message won't have fresh environment details injected.
 * - For MANUAL condensing (isAutomaticTrigger=false): Environment details are NOT included
 *   because fresh environment details will be injected on the very next turn via
 *   getEnvironmentDetails() in recursivelyMakeClineRequests().
 */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeResponse> {
	const {
		messages,
		apiHandler,
		systemPrompt,
		taskId,
		isAutomaticTrigger,
		customCondensingPrompt,
		metadata,
		environmentDetails,
		filesReadByRoo,
		cwd,
		rooIgnoreController,
	} = options
	const signal = metadata?.signal
	signal?.throwIfAborted()
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Summarize only the history that would be sent to the model. The stored history
	// also contains messages hidden by prior truncation and condensation markers.
	const activeMessages = getMessagesSinceLastSummary(getEffectiveApiHistory(messages))

	if (activeMessages.length <= 1) {
		const error =
			messages.length <= 1
				? t("common:errors.condense_not_enough_messages")
				: t("common:errors.condensed_recently")
		return { ...response, error, status: "exhausted" }
	}

	// Check if there's a recent summary in the messages (edge case)
	const recentSummaryExists = activeMessages.some((message: ApiMessage) => message.isSummary)

	if (recentSummaryExists && activeMessages.length <= 2) {
		const error = t("common:errors.condensed_recently")
		return { ...response, error, status: "exhausted" }
	}
	// Do not manufacture terminal results for a live or incomplete transaction.
	// Legacy repair helpers remain available to explicit history recovery callers.
	const storedMessages = new Set(messages)
	if (!hasToolCallResultIntegrity(activeMessages) || activeMessages.some((message) => !storedMessages.has(message))) {
		return { ...response, error: t("common:errors.condense_failed"), status: "exhausted" }
	}
	if (!apiHandler || typeof apiHandler.createMessage !== "function") {
		return { ...response, error: t("common:errors.condense_handler_invalid"), status: "no_progress" }
	}
	const modelInfo = apiHandler.getModel().info
	const requestedTarget =
		options.maxContextTokens ??
		getCompactionTargetTokens({
			contextWindow: modelInfo.contextWindow,
			reservedTokens: modelInfo.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
		})
	const maxContextTokens = Number.isFinite(requestedTarget) ? Math.max(0, requestedTarget) : 0
	const requestedTailBudget =
		options.recentTailTokenBudget ?? Math.min(DEFAULT_RECENT_TAIL_TOKENS, maxContextTokens / 4)
	const tailBudget = Number.isFinite(requestedTailBudget)
		? Math.max(0, Math.min(requestedTailBudget, maxContextTokens))
		: 0
	const minimumTailStart = getLogicalStepStarts(activeMessages).length === 1 ? 0 : 1
	const tail = await selectRecentTail(activeMessages, apiHandler, tailBudget, minimumTailStart, signal)
	const messagesToSummarize = activeMessages.slice(0, tail.startIndex)
	const retainedMessages = activeMessages.slice(tail.startIndex)
	if (messagesToSummarize.length === 0) {
		return { ...response, error: t("common:errors.condense_not_enough_messages"), status: "exhausted" }
	}
	if (messagesToSummarize.length === 1 && messagesToSummarize[0].isSummary) {
		return { ...response, error: t("common:errors.condensed_recently"), status: "exhausted" }
	}

	// Use custom prompt if provided and non-empty, otherwise use the default CONDENSE prompt
	// This respects user's custom condensing prompt setting
	const condenseInstructions = customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: condenseInstructions,
	}

	// Transform tool_use and tool_result blocks to text representations.
	// This is necessary because some providers (like Bedrock via LiteLLM) require the `tools` parameter
	// when tool blocks are present. By converting them to text, we can send the conversation for
	// summarization without needing to pass the tools parameter.
	const messagesWithTextToolBlocks = transformMessagesForCondensing(
		maybeRemoveImageBlocks([...messagesToSummarize, finalRequestMessage], apiHandler),
	)

	const requestMessages = messagesWithTextToolBlocks.map(({ role, content }) => ({ role, content }))

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	const promptToUse = SUMMARY_PROMPT

	let summary = ""
	let cost = 0

	try {
		// Historical tool blocks were converted to text above.  Do not let the
		// active task tool registry leak into this summarization-only request.
		const stream = apiHandler.createMessage(promptToUse, requestMessages, getToolFreeMetadata(metadata))

		for await (const chunk of stream) {
			signal?.throwIfAborted()
			if (chunk.type === "text") {
				summary += chunk.text
			} else if (chunk.type === "usage") {
				// Record final usage chunk only
				cost = chunk.totalCost ?? 0
			}
		}
	} catch (error) {
		signal?.throwIfAborted()
		if (error instanceof Error && error.name === "AbortError") throw error
		console.error("Error during condensing API call:", error)
		const errorMessage = error instanceof Error ? error.message : String(error)

		// Capture detailed error information for debugging
		let errorDetails = ""
		if (error instanceof Error) {
			errorDetails = `Error: ${error.message}`
			// Capture any additional API error properties
			const anyError = error as unknown as Record<string, unknown>
			if (anyError.status) {
				errorDetails += `\n\nHTTP Status: ${anyError.status}`
			}
			if (anyError.code) {
				errorDetails += `\nError Code: ${anyError.code}`
			}
			if (anyError.response) {
				try {
					errorDetails += `\n\nAPI Response:\n${JSON.stringify(anyError.response, null, 2)}`
				} catch {
					errorDetails += `\n\nAPI Response: [Unable to serialize]`
				}
			}
			if (anyError.body) {
				try {
					errorDetails += `\n\nResponse Body:\n${JSON.stringify(anyError.body, null, 2)}`
				} catch {
					errorDetails += `\n\nResponse Body: [Unable to serialize]`
				}
			}
		} else {
			errorDetails = String(error)
		}

		return {
			...response,
			cost,
			error: t("common:errors.condense_api_failed", { message: errorMessage }),
			errorDetails,
			status: "no_progress",
		}
	}
	signal?.throwIfAborted()

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error, status: "no_progress" }
	}

	// Extract command blocks from the first message (original task)
	// These represent active workflows that must persist across condensings
	const firstMessage = messages[0]
	const commandBlocks = firstMessage ? extractCommandBlocks(firstMessage) : ""

	// Build the summary content as separate text blocks
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Conversation Summary\n${summary}` },
	]
	if (tail.newestStepTooLarge) {
		summaryContent.push({
			type: "text",
			text: "[Recent context: the newest complete step exceeded the exact-tail token budget and was summarized in full. Original records remain in saved history.]",
		})
	}

	// Add command blocks (active workflows) in their own system-reminder block if present
	if (commandBlocks) {
		summaryContent.push({
			type: "text",
			text: `<system-reminder>
## Active Workflows
The following directives must be maintained across all future condensings:
${commandBlocks}
</system-reminder>`,
		})
	}

	// Generate and add folded file context (smart code folding) if file paths are provided
	// Each file gets its own <system-reminder> block as a separate content block
	if (filesReadByRoo && filesReadByRoo.length > 0 && cwd) {
		try {
			const foldedResult = await generateFoldedFileContext(filesReadByRoo, {
				cwd,
				rooIgnoreController,
			})
			if (foldedResult.sections.length > 0) {
				for (const section of foldedResult.sections) {
					if (section.trim()) {
						summaryContent.push({
							type: "text",
							text: section,
						})
					}
				}
			}
		} catch (error) {
			console.error("[summarizeConversation] Failed to generate folded file context:", error)
			// Continue without folded context - non-critical failure
		}
	}

	// Add environment details as a separate text block if provided AND this is an automatic trigger.
	// For manual condensing, fresh environment details will be injected on the next turn.
	// For automatic condensing, the API request is already in progress so we need them in the summary.
	if (isAutomaticTrigger && environmentDetails?.trim()) {
		summaryContent.push({
			type: "text",
			text: environmentDetails,
		})
	}

	// Generate a unique condenseId for this summary
	const condenseId = crypto.randomUUID()

	// Creation time stays newer than every original record even though the summary
	// is inserted before the tail. Timestamp-based rewind then restores the prefix.
	const lastMsgTs = messages.reduce((latest, message) => Math.max(latest, message.ts ?? 0), Date.now())

	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryContent,
		ts: lastMsgTs + 1, // Unique timestamp after last message
		isSummary: true,
		condenseId, // Unique ID for this summary, used to track which messages it replaces
	}

	const newContextTokens = await countContextTokens(
		[summaryMessage, ...retainedMessages],
		apiHandler,
		systemPrompt,
		metadata,
	)
	signal?.throwIfAborted()
	if (!Number.isFinite(newContextTokens) || newContextTokens > maxContextTokens) {
		// The tail was excluded from the summary request, so silently dropping it
		// now would lose unsummarized evidence. Leave history unchanged for fallback.
		return { ...response, cost, error: t("common:errors.condense_failed"), status: "no_progress" }
	}
	const prefix = new Set(messagesToSummarize)
	const insertIndex = retainedMessages.length ? messages.indexOf(retainedMessages[0]) : messages.length
	const newMessages = messages.map((msg) =>
		prefix.has(msg) && !msg.condenseParent ? { ...msg, condenseParent: condenseId } : msg,
	)
	newMessages.splice(insertIndex, 0, summaryMessage)
	return {
		messages: newMessages,
		summary,
		cost,
		newContextTokens,
		condenseId,
		status: "reduced",
		targetContextTokens: maxContextTokens,
		retainedTailTokens: tail.tokens,
		retainedTailMessages: retainedMessages.length,
		...(tail.newestStepTooLarge ? { tailFallback: "newest_step_exceeds_budget" as const } : {}),
	}
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 *
 * Note: Summary messages are always created with role: "user" (fresh-start model),
 * so the first message since the last summary is guaranteed to be a user message.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	return messages.slice(lastSummaryIndex)
}

/**
 * Filters the API conversation history to get the "effective" messages to send to the API.
 *
 * Fresh Start Model:
 * - When a summary exists, return only messages from the summary onwards (fresh start)
 * - Messages with a condenseParent pointing to an existing summary are filtered out
 *
 * Messages with a truncationParent that points to an existing truncation marker are also filtered out,
 * as they have been hidden by sliding window truncation.
 *
 * This allows non-destructive condensing and truncation where messages are tagged but not deleted,
 * enabling accurate rewind operations while still sending condensed/truncated history to the API.
 *
 * @param messages - The full API conversation history including tagged messages
 * @returns The filtered history that should be sent to the API
 */
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
	// Find the most recent summary message
	const lastSummary = findLast(messages, (msg) => msg.isSummary === true)

	if (lastSummary) {
		// Fresh start model: return only messages from the summary onwards
		const summaryIndex = messages.indexOf(lastSummary)
		let messagesFromSummary = messages.slice(summaryIndex)

		// Filter orphan results against the active fresh-start history.  This is
		// intentionally done before truncation filtering and again afterward: a
		// truncation marker can hide the only matching call.
		messagesFromSummary = filterOrphanToolResults(messagesFromSummary)

		// Still need to filter out any truncated messages within this range
		const existingTruncationIds = new Set<string>()
		for (const msg of messagesFromSummary) {
			if (msg.isTruncationMarker && msg.truncationId) {
				existingTruncationIds.add(msg.truncationId)
			}
		}

		return filterOrphanToolResults(
			messagesFromSummary.filter((msg) => {
				// Filter out truncated messages if their truncation marker exists
				if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
					return false
				}
				return true
			}),
		)
	}

	// No summary - filter based on condenseParent and truncationParent as before
	// This handles the case of orphaned condenseParent tags (summary was deleted via rewind)

	// Collect all condenseIds of summaries that exist in the current history
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that exist in the current history
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Filter out messages whose condenseParent points to an existing summary
	// or whose truncationParent points to an existing truncation marker.
	// Messages with orphaned parents (summary/marker was deleted) are included.
	return filterOrphanToolResults(
		messages.filter((msg) => {
			// Filter out condensed messages if their summary exists
			if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
				return false
			}
			// Filter out truncated messages if their truncation marker exists
			if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
				return false
			}
			return true
		}),
	)
}

/**
 * Cleans up orphaned condenseParent and truncationParent references after a truncation operation (rewind/delete).
 * When a summary message or truncation marker is deleted, messages that were tagged with its ID
 * should have their parent reference cleared so they become active again.
 *
 * This function should be called after any operation that truncates the API history
 * to ensure messages are properly restored when their summary or truncation marker is deleted.
 *
 * @param messages - The API conversation history after truncation
 * @returns The cleaned history with orphaned condenseParent and truncationParent fields cleared
 */
export function cleanupAfterTruncation(messages: ApiMessage[]): ApiMessage[] {
	// Collect all condenseIds of summaries that still exist
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that still exist
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Clear orphaned parent references for messages whose summary or truncation marker was deleted
	return messages.map((msg) => {
		let needsUpdate = false

		// Check for orphaned condenseParent
		if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
			needsUpdate = true
		}

		// Check for orphaned truncationParent
		if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
			needsUpdate = true
		}

		if (needsUpdate) {
			// Create a new object without orphaned parent references
			const { condenseParent, truncationParent, ...rest } = msg
			const result: ApiMessage = rest as ApiMessage

			// Keep condenseParent if its summary still exists
			if (condenseParent && existingSummaryIds.has(condenseParent)) {
				result.condenseParent = condenseParent
			}

			// Keep truncationParent if its truncation marker still exists
			if (truncationParent && existingTruncationIds.has(truncationParent)) {
				result.truncationParent = truncationParent
			}

			return result
		}
		return msg
	})
}
