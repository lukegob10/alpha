import type { Anthropic } from "@anthropic-ai/sdk"
import { normalizeAssistantMessageMetadata, type AssistantMessageMetadata } from "@alpha-code/types"

import type { AgentResponse } from "../agent/AgentResponse"
import { sanitizeToolUseId } from "../../utils/tool-id"

/** Ordered assistant history items, retaining provider reasoning metadata until provider projection. */
export type CanonicalAssistantHistoryItem =
	| CanonicalAssistantTextHistoryItem
	| Anthropic.ToolUseBlockParam
	| Anthropic.RedactedThinkingBlockParam
	| { type: "reasoning"; text: string; signature?: string; outputIndex?: number }
	| CanonicalEncryptedReasoningHistoryItem

/** Persisted source metadata is stripped only when projecting to a provider without message phases. */
export type CanonicalAssistantTextHistoryItem = Anthropic.TextBlockParam & AssistantMessageMetadata

function canMergeText(
	previous: CanonicalAssistantTextHistoryItem,
	current: CanonicalAssistantTextHistoryItem,
): boolean {
	return (
		// A matching phase describes meaning, not message identity. Only legacy
		// fragments with no metadata may merge without a known source boundary.
		(previous.id !== undefined || previous.outputIndex !== undefined || previous.phase === undefined) &&
		previous.id === current.id &&
		previous.phase === current.phase &&
		previous.outputIndex === current.outputIndex
	)
}

export interface CanonicalEncryptedReasoningHistoryItem {
	type: "reasoning"
	encrypted_content: string
	id?: string
	summary?: unknown[]
}

export function isCanonicalEncryptedReasoningHistoryItem(
	value: unknown,
): value is CanonicalEncryptedReasoningHistoryItem {
	if (!value || typeof value !== "object") return false
	const item = value as Record<string, unknown>
	return item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
}

/** Preserve response order and signatures before projecting to provider-specific history formats. */
export function buildCanonicalAssistantHistoryItems(response: AgentResponse): CanonicalAssistantHistoryItem[] {
	const items: CanonicalAssistantHistoryItem[] = []
	const seenToolUseIds = new Set<string>()

	for (const item of response.items) {
		if (item.type === "text") {
			const metadata = normalizeAssistantMessageMetadata(item)
			if (item.text || Object.keys(metadata).length > 0) {
				const current = { type: "text" as const, text: item.text, ...metadata }
				const previous = items.at(-1)
				if (previous?.type === "text" && canMergeText(previous, current)) previous.text += item.text
				else items.push(current)
			}
			continue
		}
		if (item.type === "reasoning") {
			if (item.redactedData !== undefined) {
				items.push({ type: "redacted_thinking", data: item.redactedData })
				continue
			}
			if (item.encryptedContent) {
				// Opaque reasoning seals a distinct provider item even when two items
				// are adjacent. Never merge encrypted bytes or their summaries.
				items.push({
					type: "reasoning",
					encrypted_content: item.encryptedContent,
					...(item.id !== undefined ? { id: item.id } : {}),
					...(item.summary !== undefined ? { summary: structuredClone(item.summary) } : {}),
				})
				continue
			}
			if (item.text || item.signature !== undefined) {
				const previous = items.at(-1)
				// A signature seals one provider block; later reasoning belongs to a new block.
				if (
					previous?.type === "reasoning" &&
					!("encrypted_content" in previous) &&
					previous.signature === undefined &&
					previous.outputIndex === item.outputIndex
				) {
					previous.text += item.text
					if (item.signature !== undefined) previous.signature = item.signature
				} else {
					items.push({
						type: "reasoning",
						text: item.text,
						...(item.signature !== undefined ? { signature: item.signature } : {}),
						...(item.outputIndex !== undefined ? { outputIndex: item.outputIndex } : {}),
					})
				}
			}
			continue
		}
		if (item.type !== "tool_call") continue

		const id = sanitizeToolUseId(item.id)
		if (!id || seenToolUseIds.has(id)) continue
		seenToolUseIds.add(id)
		items.push({ type: "tool_use", id, name: item.name, input: item.arguments })
	}

	return items
}

/**
 * Persist sealed Anthropic thinking with the canonical text metadata. Provider
 * wire filters own capability fallback; this history projection must retain
 * source identity and phase through task reload.
 */
export function buildCanonicalAnthropicAssistantHistoryContent(
	response: AgentResponse,
):
	| Array<
			| CanonicalAssistantTextHistoryItem
			| Anthropic.Messages.ToolUseBlockParam
			| Anthropic.Messages.ThinkingBlockParam
			| Anthropic.Messages.RedactedThinkingBlockParam
	  >
	| undefined {
	const items = buildCanonicalAssistantHistoryItems(response)
	if (!items.some((item) => item.type === "reasoning" || item.type === "redacted_thinking")) return undefined

	const content: Array<
		| CanonicalAssistantTextHistoryItem
		| Anthropic.Messages.ToolUseBlockParam
		| Anthropic.Messages.ThinkingBlockParam
		| Anthropic.Messages.RedactedThinkingBlockParam
	> = []
	for (const item of items) {
		if (item.type === "reasoning") {
			if ("encrypted_content" in item) return undefined
			if (!item.signature) {
				// Interrupted reasoning remains in canonical evidence, but cannot be
				// replayed with another block's signature. Keep already sealed blocks.
				if (response.outcome && response.outcome.status !== "completed") continue
				return undefined
			}
			content.push({ type: "thinking", thinking: item.text, signature: item.signature })
		} else {
			content.push(item)
		}
	}

	return content.length > 0 ? content : undefined
}

/** Project ordered canonical items into the legacy history view, including opaque provider state. */
export function buildCanonicalAssistantHistoryContent(
	response: AgentResponse,
): Array<CanonicalAssistantTextHistoryItem | Anthropic.ToolUseBlockParam | Anthropic.RedactedThinkingBlockParam> {
	const content: Array<
		| CanonicalAssistantTextHistoryItem
		| Anthropic.ToolUseBlockParam
		| Anthropic.RedactedThinkingBlockParam
		| CanonicalEncryptedReasoningHistoryItem
	> = []

	for (const item of buildCanonicalAssistantHistoryItems(response)) {
		if (item.type === "reasoning") {
			if (isCanonicalEncryptedReasoningHistoryItem(item)) content.push(item)
			continue
		}
		if (item.type === "text") {
			const previous = content.at(-1)
			if (previous?.type === "text" && canMergeText(previous, item)) previous.text += item.text
			else content.push(item)
			continue
		}
		content.push(item)
	}

	// The legacy Anthropic SDK shape does not declare Alpha's persisted opaque
	// reasoning blocks. Keep this compatibility cast at the projection boundary.
	return content as Array<
		CanonicalAssistantTextHistoryItem | Anthropic.ToolUseBlockParam | Anthropic.RedactedThinkingBlockParam
	>
}
