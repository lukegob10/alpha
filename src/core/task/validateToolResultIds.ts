import { Anthropic } from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"
import { findLastIndex } from "../../shared/array"
import { getToolCallId, getToolResultId } from "../../utils/tool-id"

/**
 * Custom error class for tool result ID mismatches.
 * Used for structured error tracking via PostHog.
 */
export class ToolResultIdMismatchError extends Error {
	constructor(
		message: string,
		public readonly toolResultIds: string[],
		public readonly toolUseIds: string[],
	) {
		super(message)
		this.name = "ToolResultIdMismatchError"
	}
}

/**
 * Custom error class for missing tool results.
 * Used for structured error tracking via PostHog when tool_use blocks
 * don't have corresponding tool_result blocks.
 */
export class MissingToolResultError extends Error {
	constructor(
		message: string,
		public readonly missingToolUseIds: string[],
		public readonly existingToolResultIds: string[],
	) {
		super(message)
		this.name = "MissingToolResultError"
	}
}

/**
 * Validates and fixes tool_result IDs in a user message against the previous assistant message.
 *
 * This is a centralized validation that catches all tool_use/tool_result issues
 * before messages are added to the API conversation history. It handles scenarios like:
 * - Race conditions during streaming
 * - Message editing scenarios
 * - Resume/delegation scenarios
 * - Missing tool_result blocks for tool_use calls
 *
 * @param userMessage - The user message being added to history
 * @param apiConversationHistory - The conversation history to find the previous assistant message from
 * @returns The validated user message with corrected tool_use_ids and any missing tool_results added
 */
export function validateAndFixToolResultIds(
	userMessage: Anthropic.MessageParam,
	apiConversationHistory: Anthropic.MessageParam[],
): Anthropic.MessageParam {
	// Only process user messages with array content
	if (userMessage.role !== "user" || !Array.isArray(userMessage.content)) {
		return userMessage
	}

	// Find the previous assistant message from conversation history
	const prevAssistantIdx = findLastIndex(apiConversationHistory, (msg) => msg.role === "assistant")
	if (prevAssistantIdx === -1) {
		return userMessage
	}

	const previousAssistantMessage = apiConversationHistory[prevAssistantIdx]

	// Get tool_use blocks from the assistant message
	const assistantContent = previousAssistantMessage.content
	if (!Array.isArray(assistantContent)) {
		return userMessage
	}

	const toolUseIds = assistantContent.map(getToolCallId).filter((id): id is string => id !== undefined)

	// No tool_use blocks to match against - no validation needed
	if (toolUseIds.length === 0) {
		return userMessage
	}

	// Find tool_result blocks in the user message
	let toolResults = userMessage.content.filter(
		(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
	)

	// Deduplicate tool_result blocks to prevent API protocol violations (GitHub #10465)
	// This serves as a safety net for any potential race conditions that could generate
	// duplicate tool_results with the same tool_use_id. The root cause (approval feedback
	// creating duplicate results) has been fixed in presentAssistantMessage.ts, but this
	// deduplication remains as a defensive measure for unknown edge cases.
	const seenToolResultIds = new Set<string>()
	const deduplicatedContent = userMessage.content.filter((block) => {
		if (block.type !== "tool_result") {
			return true
		}
		const id = getToolResultId(block)
		if (id !== undefined && seenToolResultIds.has(id)) {
			return false // Duplicate - filter out
		}
		if (id !== undefined) seenToolResultIds.add(id)
		return true
	})

	userMessage = {
		...userMessage,
		content: deduplicatedContent,
	}

	toolResults = deduplicatedContent.filter(
		(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
	)

	// Build a set of valid tool_use IDs
	const validToolUseIds = new Set(toolUseIds)

	// Build a set of existing tool_result IDs
	const existingToolResultIds = new Set(toolResults.map(getToolResultId))

	// Check for missing tool_results (tool_use IDs that don't have corresponding tool_results)
	const missingToolUseIds = toolUseIds.filter((id) => !existingToolResultIds.has(id))

	// Check if any tool_result has an invalid ID
	const hasInvalidIds = toolResults.some((result) => !validToolUseIds.has(getToolResultId(result) ?? ""))

	// If no missing tool_results and no invalid IDs, no changes needed
	if (missingToolUseIds.length === 0 && !hasInvalidIds) {
		return userMessage
	}

	// We have issues - need to fix them
	const toolResultIdList = toolResults.map((result) => getToolResultId(result) ?? "")
	const toolUseIdList = toolUseIds

	// Report missing tool_results to PostHog error tracking
	if (missingToolUseIds.length > 0 && TelemetryService.hasInstance()) {
		TelemetryService.instance.captureException(
			new MissingToolResultError(
				`Detected missing tool_result blocks. Missing tool_use IDs: [${missingToolUseIds.join(", ")}], existing tool_result IDs: [${toolResultIdList.join(", ")}]`,
				missingToolUseIds,
				toolResultIdList,
			),
			{
				missingToolUseIds,
				existingToolResultIds: toolResultIdList,
				toolUseCount: toolUseIds.length,
				toolResultCount: toolResults.length,
			},
		)
	}

	// Report ID mismatches to PostHog error tracking
	if (hasInvalidIds && TelemetryService.hasInstance()) {
		TelemetryService.instance.captureException(
			new ToolResultIdMismatchError(
				`Detected tool_result ID mismatch. tool_result IDs: [${toolResultIdList.join(", ")}], tool_use IDs: [${toolUseIdList.join(", ")}]`,
				toolResultIdList,
				toolUseIdList,
			),
			{
				toolResultIds: toolResultIdList,
				toolUseIds: toolUseIdList,
				toolResultCount: toolResults.length,
				toolUseCount: toolUseIds.length,
			},
		)
	}

	// Match tool_results to tool_uses by position and fix incorrect IDs
	// Identified receipts outrank positional legacy repair regardless of their
	// arrival order. An orphan must never steal a later receipt's identity/status.
	const identifiedToolUseIds = new Set(
		toolResults.map(getToolResultId).filter((id): id is string => id !== undefined && validToolUseIds.has(id)),
	)
	const usedToolUseIds = new Set<string>()
	const contentArray = userMessage.content as Anthropic.Messages.ContentBlockParam[]

	const correctedContent = contentArray
		.map((block: Anthropic.Messages.ContentBlockParam) => {
			if (block.type !== "tool_result") {
				return block
			}

			// If the ID is already valid and not yet used, keep it
			const id = getToolResultId(block)
			if (id !== undefined && validToolUseIds.has(id) && !usedToolUseIds.has(id)) {
				usedToolUseIds.add(id)
				return block
			}

			// Find which tool_result index this block is by comparing references.
			// This correctly handles duplicate tool_use_ids - we find the actual block's
			// position among all tool_results, not the first block with a matching ID.
			const toolResultIndex = toolResults.indexOf(block as Anthropic.ToolResultBlockParam)

			// Try to match by position - only fix if there's a corresponding tool_use
			if (toolResultIndex !== -1 && toolResultIndex < toolUseIds.length) {
				const correctId = toolUseIds[toolResultIndex]
				// Only use this ID if it hasn't been used yet
				if (!usedToolUseIds.has(correctId) && !identifiedToolUseIds.has(correctId)) {
					usedToolUseIds.add(correctId)
					return {
						...block,
						tool_use_id: correctId,
					}
				}
			}

			// No corresponding tool_use for this tool_result, or the ID is already used
			return null
		})
		.filter((block): block is NonNullable<typeof block> => block !== null)

	// Add missing tool_result blocks for any tool_use that doesn't have one
	const coveredToolUseIds = new Set(
		correctedContent
			.filter(
				(b: Anthropic.Messages.ContentBlockParam): b is Anthropic.ToolResultBlockParam =>
					b.type === "tool_result",
			)
			.map(getToolResultId),
	)

	const stillMissingToolUseIds = toolUseIds.filter((id) => !coveredToolUseIds.has(id))

	// Build final content: add missing tool_results at the beginning if any
	const missingToolResults: Anthropic.ToolResultBlockParam[] = stillMissingToolUseIds.map((id) => ({
		type: "tool_result" as const,
		tool_use_id: id,
		content: "Tool execution was interrupted before completion.",
		is_error: true,
	}))

	// Insert missing tool_results at the beginning of the content array
	// This ensures they come before any text blocks that may summarize the results
	const finalContent = missingToolResults.length > 0 ? [...missingToolResults, ...correctedContent] : correctedContent

	return {
		...userMessage,
		content: finalContent,
	}
}
