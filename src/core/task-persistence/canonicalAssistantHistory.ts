import type { Anthropic } from "@anthropic-ai/sdk"

import type { AgentResponse } from "../agent/AgentResponse"
import { sanitizeToolUseId } from "../../utils/tool-id"

/** Ordered assistant history items, retaining provider reasoning metadata until provider projection. */
export type CanonicalAssistantHistoryItem =
	| Anthropic.TextBlockParam
	| Anthropic.ToolUseBlockParam
	| { type: "reasoning"; text: string; signature?: string }

/** Preserve response order and signatures before projecting to provider-specific history formats. */
export function buildCanonicalAssistantHistoryItems(response: AgentResponse): CanonicalAssistantHistoryItem[] {
	const items: CanonicalAssistantHistoryItem[] = []
	const seenToolUseIds = new Set<string>()

	for (const item of response.items) {
		if (item.type === "text") {
			if (item.text) {
				const previous = items.at(-1)
				if (previous?.type === "text") previous.text += item.text
				else items.push({ type: "text", text: item.text })
			}
			continue
		}
		if (item.type === "reasoning") {
			if (item.text || item.signature !== undefined) {
				const previous = items.at(-1)
				// A signature seals one provider block; later reasoning belongs to a new block.
				if (previous?.type === "reasoning" && previous.signature === undefined) {
					previous.text += item.text
					if (item.signature !== undefined) previous.signature = item.signature
				} else {
					items.push({
						type: "reasoning",
						text: item.text,
						...(item.signature !== undefined ? { signature: item.signature } : {}),
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

/** Build a provider-ready Anthropic history projection when every thinking block is signed. */
export function buildCanonicalAnthropicAssistantHistoryContent(
	response: AgentResponse,
):
	| Array<
			| Anthropic.Messages.TextBlockParam
			| Anthropic.Messages.ToolUseBlockParam
			| Anthropic.Messages.ThinkingBlockParam
	  >
	| undefined {
	const items = buildCanonicalAssistantHistoryItems(response)
	if (!items.some((item) => item.type === "reasoning")) return undefined

	const content: Array<
		Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam | Anthropic.Messages.ThinkingBlockParam
	> = []
	for (const item of items) {
		if (item.type === "reasoning") {
			if (!item.signature) return undefined
			content.push({ type: "thinking", thinking: item.text, signature: item.signature })
		} else {
			content.push(item)
		}
	}

	return content
}

/** Project the ordered canonical items into the legacy text/tool history view. */
export function buildCanonicalAssistantHistoryContent(
	response: AgentResponse,
): Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> {
	const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

	for (const item of buildCanonicalAssistantHistoryItems(response)) {
		if (item.type === "reasoning") continue
		if (item.type === "text") {
			const previous = content.at(-1)
			if (previous?.type === "text") previous.text += item.text
			else content.push(item)
			continue
		}
		content.push(item)
	}

	return content
}
