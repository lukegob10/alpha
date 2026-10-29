import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@alpha-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { getApiStreamErrorMessage } from "../../api/transform/stream"
import type { ApiStreamError, ApiStreamOutcomeChunk } from "../../api/transform/stream"
import { ApiMessage } from "../task-persistence/apiMessages"
import { isOpaqueProviderContentBlock } from "../task-persistence/providerStateScope"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { findLast, findLastIndex } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { AlphaIgnoreController } from "../ignore/AlphaIgnoreController"
import { generateFoldedFileContext } from "./foldedFileContext"
import type { ContextRecoveryStatus } from "../context-management/recovery"
import { evaluateCompactionProgress, getCompactionTargetTokens } from "../context-management/recovery"
import { getModelReservedOutputTokens } from "../../shared/api"
import { createTokenCountContext, TokenCountContext } from "./tokenCountContext"
import { getToolCallId, getToolResultId } from "../../utils/tool-id"

export {
	createTokenCountContext,
	DEFAULT_REMOTE_TOKENIZER_ALLOWANCE_MS,
	DEFAULT_TOKEN_COUNT_CACHE_ENTRIES,
} from "./tokenCountContext"
export type { CreateTokenCountContextOptions, TokenCountContext } from "./tokenCountContext"

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

	// Summarization rewrites tool transactions and instructions, so signed state
	// cannot be continued here. Exact recent-tail history remains untouched.
	return content
		.filter((block) => !isOpaqueProviderContentBlock(block))
		.map((block) => {
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
	return (
		messages
			// Legacy standalone reasoning records have opaque state but no role/content.
			// They remain in stored history; rewritten summary input cannot continue them.
			.filter((msg) => !("type" in msg && msg.type === "reasoning"))
			.map((msg) => ({
				...msg,
				content: convertToolBlocksToText(msg.content),
			}))
			// Stripping signed state can leave a reasoning-only assistant record empty.
			.filter((msg) => msg.content.length > 0)
	)
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
 * Reports whether each call has exactly one later result and every result has
 * a corresponding earlier call. This is intentionally pure and does not discard
 * history; callers that need recovery can use `injectSyntheticToolResults`.
 */
export function hasToolCallResultIntegrity(messages: ApiMessage[]): boolean {
	const pending = new Set<string>()
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			const callId = getToolCallId(block)
			if (callId) {
				if (pending.has(callId)) return false
				pending.add(callId)
			}
			const resultId = getToolResultId(block)
			if (resultId) {
				if (!pending.delete(resultId)) return false
			}
		}
	}
	return pending.size === 0
}

export const DEFAULT_RECENT_TAIL_TOKENS = 16_384

const MAX_PRESERVED_USER_MESSAGE_TOKENS = 20_000
const USER_MESSAGE_RECORD_PATTERN = /^<user_message>[\s\S]*<\/user_message>$/i
const USER_MESSAGE_TRUNCATION_GAP = "\n\n[... middle content omitted during compaction ...]\n\n"
const USER_MESSAGE_TRUNCATION_NOTE = "[This user message was shortened to fit the compaction budget.]"

const MAX_CONDENSE_STREAM_ERROR_DETAIL_LENGTH = 512

/** Keep provider stream failures useful without copying untrusted payloads into task history. */
function getCondenseStreamErrorDetail(error: ApiStreamError): string {
	const detail = getApiStreamErrorMessage(error, "Provider stream error").trim()
	if (detail.length === 0) return "Provider stream error"
	if (detail.length <= MAX_CONDENSE_STREAM_ERROR_DETAIL_LENGTH) return detail
	return `${detail.slice(0, MAX_CONDENSE_STREAM_ERROR_DETAIL_LENGTH - 3)}...`
}

function getSignalAbortReason(signal: AbortSignal): unknown {
	try {
		signal.throwIfAborted()
	} catch (error) {
		return error
	}
	return new DOMException("The operation was aborted", "AbortError")
}

/** Await one stream item without letting an unresponsive iterator delay caller cancellation. */
function nextStreamItem<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
	signal?.throwIfAborted()
	const pending = iterator.next()
	if (!signal) return pending

	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (callback: () => void) => {
			if (settled) return
			settled = true
			signal.removeEventListener("abort", onAbort)
			callback()
		}
		const onAbort = () => finish(() => reject(getSignalAbortReason(signal)))
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) onAbort()
		pending.then(
			(result) => finish(() => resolve(result)),
			(error) => finish(() => reject(error)),
		)
	})
}

/** Release an interrupted/terminal iterator without waiting for an uncooperative transport. */
function closeSummaryIterator(iterator: AsyncIterator<unknown>): void {
	try {
		const cleanup = iterator.return?.()
		if (cleanup) void Promise.resolve(cleanup).catch(() => undefined)
	} catch {
		// Cleanup must not replace caller cancellation or the observed provider outcome.
	}
}

/** Race non-provider preparation work with terminal caller cancellation. */
function waitForOperation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return pending
	signal.throwIfAborted()

	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (callback: () => void) => {
			if (settled) return
			settled = true
			signal.removeEventListener("abort", onAbort)
			callback()
		}
		const onAbort = () => finish(() => reject(getSignalAbortReason(signal)))
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) onAbort()
		pending.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		)
	})
}

const HISTORY_BOOKKEEPING_KEYS = new Set([
	"content",
	"ts",
	// These host receipts are stripped from provider requests. Canonical response
	// evidence contains the same output already counted through content.
	"input_origin",
	"queued_message_ids",
	"agent_message_id",
	"hook_prompt",
	"goal_usage_receipts",
	"agentResponseItems",
	"agentResponseOutcome",
	"provider_state_scope",
	"provider_state_replay_disabled",
	"isSummary",
	"condenseId",
	"condenseParent",
	"condenseCopyParent",
	"isTruncationMarker",
	"truncationId",
	"truncationParent",
])

/** Provider input can contain standalone encrypted reasoning without role/content. */
export type CountableHistoryMessage =
	| Anthropic.MessageParam
	| { type: "reasoning"; encrypted_content: string; id?: string; summary?: unknown[] }

/** Count provider content and opaque state, excluding local history bookkeeping. */
export async function countHistoryTokens(
	messages: readonly CountableHistoryMessage[],
	apiHandler: ApiHandler,
	countContext?: TokenCountContext,
): Promise<number> {
	const operation = countContext ?? createTokenCountContext(apiHandler)
	let tokens = 0
	for (const message of messages) {
		operation.signal?.throwIfAborted()
		const rawContent = "content" in message ? message.content : []
		const content = typeof rawContent === "string" ? [{ type: "text" as const, text: rawContent }] : rawContent
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
		const messageTokens = await operation.countTokens(blocks, apiHandler)
		operation.signal?.throwIfAborted()
		if (!Number.isFinite(messageTokens) || messageTokens < 0) return Number.NaN
		tokens += messageTokens
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
	const boundaryDeltas = new Array<number>(messages.length + 1).fill(0)
	const openCalls = new Map<string, number>()
	// Providers may reuse an ID after its terminal result. Only an open occurrence
	// crosses a boundary; grouping all occurrences by ID joins independent steps.
	for (let index = 0; index < messages.length; index++) {
		const content = messages[index].content
		if (!Array.isArray(content)) continue
		for (const block of content) {
			const callId = getToolCallId(block)
			if (callId && !openCalls.has(callId)) openCalls.set(callId, index)
			const resultId = getToolResultId(block)
			if (!resultId) continue
			const callIndex = openCalls.get(resultId)
			if (callIndex === undefined) continue
			boundaryDeltas[callIndex + 1]++
			boundaryDeltas[index + 1]--
			openCalls.delete(resultId)
		}
	}
	for (const callIndex of openCalls.values()) boundaryDeltas[callIndex + 1]++
	const hasResult = (message: ApiMessage) =>
		Array.isArray(message.content) && message.content.some((block) => getToolResultId(block) !== undefined)
	const hasUserInstruction = (message: ApiMessage) =>
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "text" && block.text.includes("<user_message>"))
	const starts = [0]
	let crossingPairs = 0
	let pendingUserInstruction = false
	for (let index = 1; index < messages.length; index++) {
		crossingPairs += boundaryDeltas[index]
		const current = messages[index]
		const previous = messages[index - 1]
		pendingUserInstruction ||= hasUserInstruction(previous)
		if (crossingPairs > 0 || hasResult(current)) continue
		if (
			current.isSummary ||
			previous.isSummary ||
			(current.role === "user" && previous.role === "assistant") ||
			// Carried user instructions precede the exact tail after compaction.
			// A later direct user turn must be eligible for exact retention on its own.
			(current.role === "user" &&
				previous.role === "user" &&
				!hasResult(previous) &&
				getVerbatimUserTextBlocks(current).length > 0) ||
			// A correction can accompany any of several result records. Keep it
			// through transaction completion and the assistant response it guides.
			(current.role === "assistant" && hasResult(previous) && !pendingUserInstruction)
		)
			starts.push(index)
		if (current.role === "assistant") pendingUserInstruction = false
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
	countContext?: TokenCountContext,
): Promise<RecentTailSelection> {
	const operation = countContext ?? createTokenCountContext(apiHandler, { signal })
	const starts = getLogicalStepStarts(messages)
	let startIndex = messages.length
	let tokens = 0
	let newestStepTooLarge = false
	for (let index = starts.length - 1; index >= 0; index--) {
		const start = starts[index]
		if (start < minimumStartIndex || messages[start].isSummary) break
		signal?.throwIfAborted()
		const stepTokens = await countHistoryTokens(messages.slice(start, startIndex), apiHandler, operation)
		signal?.throwIfAborted()
		if (!Number.isFinite(stepTokens) || stepTokens < 0) {
			return { startIndex: messages.length, tokens: Number.NaN, newestStepTooLarge: false }
		}
		if (tokens + stepTokens > tokenBudget) {
			newestStepTooLarge = startIndex === messages.length
			break
		}
		tokens += stepTokens
		startIndex = start
	}
	return { startIndex, tokens, newestStepTooLarge }
}

function getVerbatimUserTextBlocks(message: ApiMessage): Anthropic.Messages.TextBlockParam[] {
	if (message.role !== "user" || message.isSummary || message.isTruncationMarker) return []
	const content =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
	if (!Array.isArray(content)) return []
	return content.filter(
		(block): block is Anthropic.Messages.TextBlockParam =>
			block.type === "text" && USER_MESSAGE_RECORD_PATTERN.test(block.text),
	)
}

function createVerbatimUserMessage(
	source: ApiMessage,
	textBlocks: Anthropic.Messages.TextBlockParam[],
	isTruncated = false,
): ApiMessage {
	const message: ApiMessage = {
		...source,
		role: "user",
		content: [
			...textBlocks.map((block) => ({ ...block })),
			...(isTruncated ? [{ type: "text" as const, text: USER_MESSAGE_TRUNCATION_NOTE }] : []),
		],
	}
	delete message.condenseId
	delete message.condenseParent
	delete message.condenseCopyParent
	delete message.isSummary
	delete message.isTruncationMarker
	delete message.truncationId
	delete message.truncationParent
	return message
}

async function truncateVerbatimUserMessage(
	source: ApiMessage,
	textBlock: Anthropic.Messages.TextBlockParam,
	tokenBudget: number,
	apiHandler: ApiHandler,
	countContext: TokenCountContext,
): Promise<{ message?: ApiMessage; tokens: number }> {
	const match = /^<user_message>([\s\S]*)<\/user_message>$/i.exec(textBlock.text)
	if (!match || tokenBudget <= 0) return { tokens: 0 }
	const body = Array.from(match[1])
	if (body.length < 2) return { tokens: 0 }
	let low = 1
	let high = body.length - 1
	let bestMessage: ApiMessage | undefined
	let bestTokens = 0

	while (low <= high) {
		const keptCharacters = Math.floor((low + high) / 2)
		const prefixLength = Math.ceil(keptCharacters / 2)
		const suffixLength = Math.floor(keptCharacters / 2)
		const content = `${body.slice(0, prefixLength).join("")}${USER_MESSAGE_TRUNCATION_GAP}${
			suffixLength > 0 ? body.slice(-suffixLength).join("") : ""
		}`
		const truncatedBlock = { ...textBlock, text: `<user_message>${content}</user_message>` }
		const candidate = createVerbatimUserMessage(source, [truncatedBlock], true)
		const tokens = await countHistoryTokens([candidate], apiHandler, countContext)
		if (!Number.isFinite(tokens) || tokens < 0) return { tokens: Number.NaN }
		if (tokens <= tokenBudget) {
			bestMessage = candidate
			bestTokens = tokens
			low = keptCharacters + 1
		} else {
			high = keptCharacters - 1
		}
	}

	return { message: bestMessage, tokens: bestTokens }
}

type VerbatimUserMessageSelection = { messages: ApiMessage[]; tokens: number }

/** Retain recent direct user records verbatim without copying tool or generated user content. */
async function selectVerbatimUserMessages(
	prefixMessages: ApiMessage[],
	tailMessages: ApiMessage[],
	tokenBudget: number,
	apiHandler: ApiHandler,
	countContext: TokenCountContext,
): Promise<VerbatimUserMessageSelection> {
	const seenText = new Set(
		tailMessages.flatMap((message) => getVerbatimUserTextBlocks(message).map((block) => block.text)),
	)
	const selected: ApiMessage[] = []
	let tokens = 0

	for (let index = prefixMessages.length - 1; index >= 0; index--) {
		const source = prefixMessages[index]
		const textBlocks = getVerbatimUserTextBlocks(source).filter((block) => {
			if (seenText.has(block.text)) return false
			seenText.add(block.text)
			return true
		})
		if (textBlocks.length === 0) continue

		const candidate = createVerbatimUserMessage(source, textBlocks)
		const messageTokens = await countHistoryTokens([candidate], apiHandler, countContext)
		if (!Number.isFinite(messageTokens) || messageTokens < 0) {
			return { messages: [], tokens: Number.NaN }
		}
		if (tokens + messageTokens > tokenBudget) {
			// Newer user records win. If the next record is too large, retain a
			// clearly marked middle-truncated excerpt within the remaining budget,
			// then stop before older records.
			if (textBlocks.length !== 1) break
			const truncated = await truncateVerbatimUserMessage(
				source,
				textBlocks[0],
				tokenBudget - tokens,
				apiHandler,
				countContext,
			)
			if (!Number.isFinite(truncated.tokens) || truncated.tokens < 0) {
				return { messages: [], tokens: Number.NaN }
			}
			if (!truncated.message) break
			selected.push(truncated.message)
			tokens += truncated.tokens
			break
		}

		selected.push(candidate)
		tokens += messageTokens
	}

	return { messages: selected.reverse(), tokens }
}

export async function countContextTokens(
	messages: readonly CountableHistoryMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	metadata?: ApiHandlerCreateMessageMetadata,
	countContext?: TokenCountContext,
): Promise<number> {
	const operation =
		countContext ??
		createTokenCountContext(apiHandler, {
			signal: metadata?.signal,
			remoteDeadline: metadata?.deadline,
		})
	operation.signal?.throwIfAborted()
	const overhead: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: systemPrompt }]
	if (metadata?.tools?.length) overhead.push({ type: "text", text: JSON.stringify(metadata.tools) })
	const overheadTokens = await operation.countTokens(overhead, apiHandler)
	operation.signal?.throwIfAborted()
	if (!Number.isFinite(overheadTokens) || overheadTokens < 0) return Number.NaN
	return overheadTokens + (await countHistoryTokens(messages, apiHandler, operation))
}

/**
 * Removes tool_result blocks that point at calls no longer visible in the
 * supplied history.  Mixed user messages retain their ordinary text blocks;
 * a message made entirely of orphan results is removed.  This is useful after
 * truncation, where a call and result may have been hidden as a pair.
 */
export function filterOrphanToolResults(messages: ApiMessage[]): ApiMessage[] {
	const pendingCallIds = new Set<string>()
	let changed = false
	const filtered = messages
		.map((message) => {
			if (!Array.isArray(message.content)) return message
			const filteredContent = message.content.filter((block) => {
				const callId = getToolCallId(block)
				if (callId !== undefined) pendingCallIds.add(callId)
				const resultId = getToolResultId(block)
				// A later reused ID cannot acknowledge an earlier orphan result,
				// and each call occurrence owns only one terminal receipt.
				return resultId === undefined || pendingCallIds.delete(resultId)
			})
			if (filteredContent.length === message.content.length) return message
			changed = true
			if (filteredContent.length === 0) return null
			return { ...message, content: filteredContent }
		})
		.filter((message): message is ApiMessage => message !== null)

	return changed ? filtered : messages
}

export { MIN_CONDENSE_THRESHOLD, MAX_CONDENSE_THRESHOLD } from "../context-management/recovery"

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
	// A provider may reuse a completed call ID. Only a result for the currently
	// pending occurrence can satisfy that call; older receipts remain untouched.
	const pending = new Set<string>()
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			const callId = getToolCallId(block)
			if (callId !== undefined) pending.add(callId)
			const resultId = getToolResultId(block)
			if (resultId !== undefined) pending.delete(resultId)
		}
	}
	const orphanIds = [...pending]

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

export type CompactionDiagnostic = {
	reason:
		| "insufficient_history"
		| "recent_summary"
		| "invalid_history"
		| "invalid_handler"
		| "invalid_tail_count"
		| "provider_error"
		| "incomplete_outcome"
		| "unexpected_tool_output"
		| "empty_summary"
		| "invalid_candidate_count"
		| "candidate_over_budget"
		| "candidate_ready"
		| "already_compact"
		| "no_reduction"
		| "insufficient_budget"
	elapsedMs: number
	storedMessages: number
	activeMessages: number
	summaryCharacters: number
	textParts: number
	reasoningParts: number
	toolParts: number
	systemCharacters: number
	toolSchemaCharacters: number
	remoteDeadlineExpired: boolean
	targetTokens?: number
	tailTokens?: number
	tailMessages?: number
	candidateTokens?: number
	beforeTokens?: number
	summaryBudgetTokens?: number
	lifecycleRequired?: boolean
	completedOutcomeObserved?: boolean
	unsuccessfulOutcome?: ApiStreamOutcomeChunk["status"]
}

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	/** Active input measured with the same counter as newContextTokens. */
	prevContextTokens?: number
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
	errorDetails?: string // Detailed error information including stack trace and API error info
	condenseId?: string // The unique ID of the created Summary message, for linking to condense_context alphaMessage
	/** Explicit bounded outcome for callers that need to decide whether to fall back. */
	status?: ContextRecoveryStatus
	retainedTailTokens?: number
	retainedTailMessages?: number
	tailFallback?: "newest_step_exceeds_budget"
	targetContextTokens?: number
	/** Bounded numeric/enum evidence; never contains conversation or provider payloads. */
	diagnostic?: CompactionDiagnostic
}

export type SummarizeConversationOptions = {
	/** Host-owned lifecycle admission, after unchanged/invalid exits and before provider effects. */
	beforeCompact?: () => Promise<void>
	messages: ApiMessage[]
	apiHandler: ApiHandler
	/** Host-selected previous model for summary input; the current handler still owns replacement budgets. */
	compactionApiHandler?: ApiHandler
	systemPrompt: string
	taskId: string
	isAutomaticTrigger?: boolean
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByAlpha?: string[]
	cwd?: string
	alphaIgnoreController?: AlphaIgnoreController
	/** Hard input budget, including system prompt, tools, summary and exact tail. */
	maxContextTokens?: number
	/** Exact recent working set; clamped to the available input budget. */
	recentTailTokenBudget?: number
	/** Shared token-counting budget/cache for this context-preparation operation. */
	countContext?: TokenCountContext
	/** A provider rejection requires progress even when the local estimate fits. */
	forceCompaction?: boolean
	/** Latest provider-reported summary cost, retained even when the result is discarded. */
	observeCost?: (cost: number) => void
}

/**
 * Returns metadata suitable for a summarization-only request.
 *
 * Condensing converts historical tool blocks to text, so carrying the active
 * tool registry or a required/automatic tool choice into this request is both
 * unnecessary and provider-dependent.  Keep tracing/request controls intact,
 * but explicitly provide an empty tool list and disable tool selection.
 * Live instruction fragments must not override the summary system prompt, and
 * a provider must not append this operation to the live response chain. The
 * input object is never mutated. `undefined` remains `undefined` for callers
 * that did not provide metadata, preserving the historical API call shape.
 */
export function getToolFreeMetadata(
	metadata?: ApiHandlerCreateMessageMetadata,
): ApiHandlerCreateMessageMetadata | undefined {
	if (!metadata) return undefined

	const isolated: ApiHandlerCreateMessageMetadata = {
		...metadata,
		suppressPreviousResponseId: true,
		tools: [],
		tool_choice: "none",
		parallelToolCalls: false,
		allowedFunctionNames: [],
	}
	delete isolated.instructionFragments
	return isolated
}

/**
 * Summarizes the conversation messages using an LLM call.
 *
 * The older active prefix is summarized while a bounded recent suffix stays exact:
 * - The summary becomes a user message (not assistant)
 * - Post-condense, the model sees the summary, bounded verbatim user instructions, and complete recent steps
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
 *   getEnvironmentDetails() in runAgentRequests().
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
		filesReadByAlpha,
		cwd,
		alphaIgnoreController,
	} = options
	const signal = metadata?.signal
	const compactionApiHandler = options.compactionApiHandler ?? apiHandler
	signal?.throwIfAborted()
	const countContext =
		options.countContext ??
		createTokenCountContext(apiHandler, {
			signal,
			remoteDeadline: metadata?.deadline,
		})
	countContext.signal?.throwIfAborted()
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Summarize only the history that would be sent to the model. The stored history
	// also contains messages hidden by prior truncation and condensation markers.
	const activeMessages = getMessagesSinceLastSummary(getEffectiveApiHistory(messages))
	const startedAt = Date.now()
	const diagnostic: CompactionDiagnostic = {
		reason: "insufficient_history",
		elapsedMs: 0,
		storedMessages: messages.length,
		activeMessages: activeMessages.length,
		summaryCharacters: 0,
		textParts: 0,
		reasoningParts: 0,
		toolParts: 0,
		systemCharacters: systemPrompt.length,
		toolSchemaCharacters: metadata?.tools?.length ? JSON.stringify(metadata.tools).length : 0,
		remoteDeadlineExpired: false,
	}
	const finish = (result: SummarizeResponse, reason: CompactionDiagnostic["reason"]): SummarizeResponse => {
		const receipt = {
			...diagnostic,
			reason,
			elapsedMs: Date.now() - startedAt,
			remoteDeadlineExpired: Date.now() >= countContext.remoteDeadline,
		}
		return { ...result, diagnostic: receipt }
	}

	// Do not manufacture terminal results for a live or incomplete transaction.
	// Legacy repair helpers remain available to explicit history recovery callers.
	const storedMessages = new Set(messages)
	if (!hasToolCallResultIntegrity(activeMessages) || activeMessages.some((message) => !storedMessages.has(message))) {
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "exhausted" },
			"invalid_history",
		)
	}
	if (!apiHandler || typeof compactionApiHandler?.createMessage !== "function") {
		return finish(
			{ ...response, error: t("common:errors.condense_handler_invalid"), status: "no_progress" },
			"invalid_handler",
		)
	}
	const modelInfo = apiHandler.getModel().info
	const requestedTarget =
		options.maxContextTokens ??
		getCompactionTargetTokens({
			contextWindow: modelInfo.contextWindow,
			reservedTokens: getModelReservedOutputTokens({ modelId: apiHandler.getModel().id, model: modelInfo }),
		})
	const maxContextTokens = Number.isFinite(requestedTarget) ? Math.max(0, requestedTarget) : 0
	diagnostic.targetTokens = maxContextTokens
	const beforeTokens = await countContextTokens(activeMessages, apiHandler, systemPrompt, metadata, countContext)
	response.prevContextTokens = beforeTokens
	diagnostic.beforeTokens = beforeTokens
	if (!Number.isFinite(beforeTokens) || beforeTokens < 0) {
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "no_progress" },
			"invalid_candidate_count",
		)
	}
	const canLeaveUnchanged = !options.forceCompaction && beforeTokens <= maxContextTokens
	const unchanged = (cost = 0, reason: CompactionDiagnostic["reason"] = "already_compact") =>
		finish(
			{
				...response,
				cost,
				status: "unchanged",
				newContextTokens: beforeTokens,
				targetContextTokens: maxContextTokens,
			},
			reason,
		)
	if (activeMessages.length <= 1 && canLeaveUnchanged) return unchanged()
	if (activeMessages.length === 0) {
		return finish(
			{ ...response, error: t("common:errors.condense_not_enough_messages"), status: "exhausted" },
			"insufficient_history",
		)
	}
	const commandBlocks = messages[0] ? extractCommandBlocks(messages[0]) : ""
	const mandatoryContent: Anthropic.Messages.ContentBlockParam[] = []
	if (commandBlocks) {
		mandatoryContent.push({
			type: "text",
			text: `<system-reminder>
## Active Workflows
The following directives must be maintained across all future condensings:
${commandBlocks}
</system-reminder>`,
		})
	}
	if (isAutomaticTrigger && environmentDetails?.trim())
		mandatoryContent.push({ type: "text", text: environmentDetails })
	const fixedTokens = await countContextTokens(
		[{ role: "user", content: [{ type: "text", text: "## Conversation Summary\n" }, ...mandatoryContent] }],
		apiHandler,
		systemPrompt,
		metadata,
		countContext,
	)
	if (!Number.isFinite(fixedTokens) || fixedTokens < 0) {
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "no_progress" },
			"invalid_candidate_count",
		)
	}
	const availableHistoryTokens = Math.max(0, maxContextTokens - fixedTokens)
	if (availableHistoryTokens === 0) {
		if (canLeaveUnchanged) return unchanged()
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "exhausted" },
			"insufficient_budget",
		)
	}
	const requestedTailBudget =
		options.recentTailTokenBudget ?? Math.min(DEFAULT_RECENT_TAIL_TOKENS, availableHistoryTokens / 4)
	const tailBudget = Number.isFinite(requestedTailBudget)
		? Math.max(0, Math.min(requestedTailBudget, availableHistoryTokens))
		: 0
	const minimumTailStart = getLogicalStepStarts(activeMessages).length === 1 && !options.forceCompaction ? 0 : 1
	const tail = await selectRecentTail(activeMessages, apiHandler, tailBudget, minimumTailStart, signal, countContext)
	diagnostic.tailTokens = tail.tokens
	diagnostic.tailMessages = activeMessages.length - tail.startIndex
	if (!Number.isFinite(tail.tokens) || tail.tokens < 0) {
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "no_progress" },
			"invalid_tail_count",
		)
	}
	const messagesToSummarize = activeMessages.slice(0, tail.startIndex)
	const retainedMessages = activeMessages.slice(tail.startIndex)
	if (messagesToSummarize.length === 0) {
		if (canLeaveUnchanged) return unchanged()
		return finish(
			{ ...response, error: t("common:errors.condense_not_enough_messages"), status: "exhausted" },
			"insufficient_history",
		)
	}
	if (messagesToSummarize.length === 1 && messagesToSummarize[0].isSummary && canLeaveUnchanged) return unchanged()

	// Preserve a bounded set of direct user instructions verbatim. Reserve at
	// least a quarter of the available history budget for the generated summary;
	// the copied user records share the remaining budget with the exact recent tail.
	const minimumSummaryBudget = Math.floor(availableHistoryTokens / 4)
	const verbatimUserBudget = Math.max(
		0,
		Math.min(
			MAX_PRESERVED_USER_MESSAGE_TOKENS,
			Math.floor(availableHistoryTokens / 4),
			availableHistoryTokens - tail.tokens - minimumSummaryBudget,
		),
	)
	const verbatimUserSelection = await selectVerbatimUserMessages(
		messagesToSummarize,
		retainedMessages,
		verbatimUserBudget,
		apiHandler,
		countContext,
	)
	if (!Number.isFinite(verbatimUserSelection.tokens) || verbatimUserSelection.tokens < 0) {
		return finish(
			{ ...response, error: t("common:errors.condense_failed"), status: "no_progress" },
			"invalid_candidate_count",
		)
	}
	const verbatimUserMessages = verbatimUserSelection.messages

	// Use custom prompt if provided and non-empty, otherwise use the default CONDENSE prompt
	// This respects user's custom condensing prompt setting
	const condenseInstructions = customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE
	const summaryBudgetTokens = Math.max(
		0,
		Math.floor(availableHistoryTokens - tail.tokens - verbatimUserSelection.tokens),
	)
	diagnostic.summaryBudgetTokens = summaryBudgetTokens

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: `${condenseInstructions}\n\nKeep the handoff summary within ${summaryBudgetTokens} tokens.`,
	}

	// Transform tool_use and tool_result blocks to text representations.
	// This is necessary because some providers (like Bedrock via LiteLLM) require the `tools` parameter
	// when tool blocks are present. By converting them to text, we can send the conversation for
	// summarization without needing to pass the tools parameter.
	const messagesWithTextToolBlocks = transformMessagesForCondensing(
		maybeRemoveImageBlocks([...messagesToSummarize, finalRequestMessage], compactionApiHandler),
	)

	const requestMessages = messagesWithTextToolBlocks.map(({ role, content }) => ({ role, content }))

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	const promptToUse = SUMMARY_PROMPT

	let summary = ""
	let cost = 0
	let completedOutcomeObserved = false
	let unsuccessfulOutcome: ApiStreamOutcomeChunk | undefined
	let streamError: ApiStreamError | undefined
	let unexpectedToolOutput = false
	const getStreamErrorResponse = (errorChunk: ApiStreamError): SummarizeResponse => {
		const errorDetails = getCondenseStreamErrorDetail(errorChunk)
		return finish(
			{
				...response,
				cost,
				error: t("common:errors.condense_api_failed", { message: errorDetails }),
				errorDetails,
				status: "no_progress",
			},
			"provider_error",
		)
	}

	// Keep host stop/cancellation outside the provider-error fallback boundary.
	await options.beforeCompact?.()
	signal?.throwIfAborted()
	try {
		// Historical tool blocks were converted to text above.  Do not let the
		// active task tool registry leak into this summarization-only request.
		const stream = compactionApiHandler.createMessage(promptToUse, requestMessages, getToolFreeMetadata(metadata))
		const iterator = stream[Symbol.asyncIterator]()
		let reachedEof = false
		try {
			while (true) {
				const next = await nextStreamItem(iterator, signal)
				if (next.done) {
					reachedEof = true
					break
				}
				const chunk = next.value
				if (chunk.type === "usage") {
					// Preserve delivered accounting before cancellation can discard the summary.
					if (
						typeof chunk.totalCost === "number" &&
						Number.isFinite(chunk.totalCost) &&
						chunk.totalCost >= 0
					) {
						cost = chunk.totalCost
						options.observeCost?.(cost)
					}
					signal?.throwIfAborted()
					continue
				}
				signal?.throwIfAborted()
				if (chunk.type === "text") {
					diagnostic.textParts++
					diagnostic.summaryCharacters += chunk.text.length
				} else if (chunk.type === "reasoning") diagnostic.reasoningParts++
				else if (
					chunk.type === "tool_call" ||
					chunk.type === "tool_call_start" ||
					chunk.type === "tool_call_delta" ||
					chunk.type === "tool_call_end" ||
					chunk.type === "tool_call_partial"
				) {
					diagnostic.toolParts++
					unexpectedToolOutput = true
				}
				if (chunk.type === "error") {
					streamError ??= chunk
					continue
				}
				if (chunk.type === "outcome") {
					if (!streamError) {
						if (chunk.status === "completed" && chunk.terminal && !chunk.requiresContinuation) {
							completedOutcomeObserved = true
						} else {
							// An incomplete declaration cannot be repaired by a later completion.
							unsuccessfulOutcome ??= chunk
						}
					}
					// A canonical terminal outcome ends the response. Further reads can
					// stall indefinitely or append text belonging to a different response.
					if (chunk.terminal) break
					continue
				}
				if (!streamError && chunk.type === "text") summary += chunk.text
			}
		} finally {
			if (!reachedEof) closeSummaryIterator(iterator)
		}
	} catch (error) {
		signal?.throwIfAborted()
		if (error instanceof Error && error.name === "AbortError") throw error
		if (streamError) return getStreamErrorResponse(streamError)
		const errorMessage = getCondenseStreamErrorDetail({
			type: "error",
			error: "CondenseProviderError",
			message: error instanceof Error ? error.message : typeof error === "string" ? error : "Provider error",
		})
		// Error response/body objects can include credentials or echoed input. Keep
		// only bounded message text and scalar transport identifiers for diagnosis.
		let errorDetails = errorMessage
		if (error instanceof Error) {
			const anyError = error as unknown as Record<string, unknown>
			if (typeof anyError.status === "number" && Number.isInteger(anyError.status)) {
				errorDetails += `\n\nHTTP Status: ${anyError.status}`
			}
			if (typeof anyError.code === "string" && /^[\w.-]{1,64}$/.test(anyError.code)) {
				errorDetails += `\nError Code: ${anyError.code}`
			}
		}
		console.error("Error during condensing API call:", errorDetails)

		return finish(
			{
				...response,
				cost,
				error: t("common:errors.condense_api_failed", { message: errorMessage }),
				errorDetails,
				status: "no_progress",
			},
			"provider_error",
		)
	}
	signal?.throwIfAborted()
	if (streamError) return getStreamErrorResponse(streamError)
	diagnostic.lifecycleRequired = compactionApiHandler.streamCapabilities?.lifecycle === true
	diagnostic.completedOutcomeObserved = completedOutcomeObserved
	diagnostic.unsuccessfulOutcome = unsuccessfulOutcome?.status
	if (unexpectedToolOutput) {
		return finish(
			{ ...response, cost, error: t("common:errors.condense_failed"), status: "no_progress" },
			"unexpected_tool_output",
		)
	}

	// Lifecycle-capable providers promise an explicit terminal outcome, so EOF
	// without completed evidence must fail closed. Legacy providers have no such
	// contract and retain their established text-at-EOF behavior.
	if (
		unsuccessfulOutcome ||
		(compactionApiHandler.streamCapabilities?.lifecycle === true && !completedOutcomeObserved)
	) {
		return finish(
			{
				...response,
				cost,
				error: t("common:errors.condense_failed"),
				...(unsuccessfulOutcome?.reason ? { errorDetails: unsuccessfulOutcome.reason } : {}),
				status: "no_progress",
			},
			"incomplete_outcome",
		)
	}

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return finish({ ...response, cost, error, status: "no_progress" }, "empty_summary")
	}

	// Build the summary content as separate text blocks
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Conversation Summary\n${summary}` },
		...mandatoryContent,
	]
	if (tail.newestStepTooLarge) {
		summaryContent.push({
			type: "text",
			text: "[Recent context: the newest complete step exceeded the exact-tail token budget and was summarized in full. Original records remain in saved history.]",
		})
	}

	// Generate and add folded file context (smart code folding) if file paths are provided
	// Each file gets its own <system-reminder> block as a separate content block
	if (filesReadByAlpha && filesReadByAlpha.length > 0 && cwd) {
		try {
			const foldedResult = await waitForOperation(
				generateFoldedFileContext(filesReadByAlpha, {
					cwd,
					alphaIgnoreController,
					maxCharacters: Math.min(50_000, summaryBudgetTokens),
					signal,
				}),
				signal,
			)
			if (foldedResult.sections.length > 0) {
				for (const section of foldedResult.sections) {
					if (section.trim()) {
						const candidate = [...summaryContent, { type: "text" as const, text: section }]
						const tokens = await countContextTokens(
							[{ role: "user", content: candidate }, ...verbatimUserMessages, ...retainedMessages],
							apiHandler,
							systemPrompt,
							metadata,
							countContext,
						)
						if (
							!Number.isFinite(tokens) ||
							tokens < 0 ||
							tokens > maxContextTokens ||
							tokens >= beforeTokens
						)
							break
						summaryContent.push({ type: "text", text: section })
					}
				}
			}
		} catch (error) {
			signal?.throwIfAborted()
			console.error("[summarizeConversation] Failed to generate folded file context:", error)
			// Continue without folded context - non-critical failure
		}
	}

	// Generate a unique condenseId for this summary
	const condenseId = crypto.randomUUID()
	const carriedUserMessages = verbatimUserMessages.map((message) => ({ ...message, condenseCopyParent: condenseId }))

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
		[summaryMessage, ...carriedUserMessages, ...retainedMessages],
		apiHandler,
		systemPrompt,
		metadata,
		countContext,
	)
	signal?.throwIfAborted()
	diagnostic.candidateTokens = newContextTokens
	if (!Number.isFinite(newContextTokens) || newContextTokens > maxContextTokens) {
		if (Number.isFinite(newContextTokens) && canLeaveUnchanged) return unchanged(cost, "no_reduction")
		// The tail was excluded from the summary request, so silently dropping it
		// now would lose unsummarized evidence. Leave history unchanged for fallback.
		return finish(
			{ ...response, cost, error: t("common:errors.condense_failed"), status: "no_progress" },
			Number.isFinite(newContextTokens) ? "candidate_over_budget" : "invalid_candidate_count",
		)
	}
	if (
		evaluateCompactionProgress({ beforeTokens, afterTokens: newContextTokens, targetTokens: maxContextTokens })
			.status !== "reduced"
	) {
		if (canLeaveUnchanged) return unchanged(cost, "no_reduction")
		return finish(
			{ ...response, cost, error: t("common:errors.condense_failed"), status: "no_progress" },
			"no_reduction",
		)
	}
	const prefix = new Set(messagesToSummarize)
	const insertIndex = retainedMessages.length ? messages.indexOf(retainedMessages[0]) : messages.length
	const newMessages = messages.map((msg) =>
		prefix.has(msg) && !msg.condenseParent ? { ...msg, condenseParent: condenseId } : msg,
	)
	newMessages.splice(insertIndex, 0, summaryMessage, ...carriedUserMessages)
	return finish(
		{
			messages: newMessages,
			summary,
			cost,
			newContextTokens,
			prevContextTokens: beforeTokens,
			condenseId,
			status: "reduced",
			targetContextTokens: maxContextTokens,
			retainedTailTokens: tail.tokens,
			retainedTailMessages: retainedMessages.length,
			...(tail.newestStepTooLarge ? { tailFallback: "newest_step_exceeds_budget" as const } : {}),
		},
		"candidate_ready",
	)
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 *
 * Note: Summary messages are always created with role: "user" (fresh-start model),
 * so the first message since the last summary is guaranteed to be a user message.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndex = findLastIndex(messages, (message) => !!message.isSummary)
	return lastSummaryIndex === -1 ? messages : messages.slice(lastSummaryIndex)
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
	const lastSummary = findLast(messages, (msg) => msg.isSummary === true)
	const existingSummaryIds = new Set<string>()
	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) existingSummaryIds.add(msg.condenseId)
	}
	// Filter orphan results against the fresh-start history before truncation and
	// again afterward: a truncation marker can hide the only matching call.
	const activeMessages = lastSummary
		? filterOrphanToolResults(messages.slice(messages.indexOf(lastSummary)))
		: messages

	const existingTruncationIds = new Set<string>()
	for (const msg of activeMessages) {
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Deleted markers restore originals; carried user copies belong to the summary
	// that produced them and must disappear with it, including before cleanup runs.
	return filterOrphanToolResults(
		activeMessages.filter(
			(msg) =>
				!(msg.condenseCopyParent && !existingSummaryIds.has(msg.condenseCopyParent)) &&
				!(!lastSummary && msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) &&
				!(msg.truncationParent && existingTruncationIds.has(msg.truncationParent)),
		),
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

	// Copies are derived records, so rewind removes them instead of reactivating
	// them alongside their originals. Legacy records without ownership stay intact.
	return messages
		.filter((msg) => !msg.condenseCopyParent || existingSummaryIds.has(msg.condenseCopyParent))
		.map((msg) => {
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
