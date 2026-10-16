import type Anthropic from "@anthropic-ai/sdk"
import type { ProcessUserContentMentionsResult } from "./processUserContentMentions"
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../agent/ToolPolicy"

type TextPart = Anthropic.Messages.TextBlockParam

/** Admit one source-ordered batch of generated excerpts without clipping user instructions. */
export function finalizeUserContentMentionAttachments(
	results: readonly ProcessUserContentMentionsResult[],
): ProcessUserContentMentionsResult[] {
	const attachmentParts = new Set(results.flatMap((result) => [...(result.deferredAttachmentParts ?? [])]))
	const finalized = results.map((result) => {
		const prepared = { ...result }
		delete prepared.deferredAttachmentParts
		return prepared
	})
	const orderedParts: TextPart[] = []
	for (const result of results) {
		for (const block of result.content) {
			if (block.type === "text" && attachmentParts.has(block)) orderedParts.push(block)
			if (block.type === "tool_result" && Array.isArray(block.content)) {
				for (const part of block.content) {
					if (part.type === "text" && attachmentParts.has(part)) orderedParts.push(part)
				}
			}
		}
	}
	if (orderedParts.reduce((total, part) => total + part.text.length, 0) <= DEFAULT_TOOL_OUTPUT_LIMIT) {
		return finalized
	}

	const notice: TextPart = {
		type: "text",
		text:
			"[Attachment excerpts omitted: generated file/folder context shares the " +
			DEFAULT_TOOL_OUTPUT_LIMIT +
			"-character output allowance. The referenced paths remain in the source messages. " +
			"Recover needed content with available approved file or document-reading tools; " +
			"use bounded reads and copy any returned continuation exactly.]",
	}
	let remaining = DEFAULT_TOOL_OUTPUT_LIMIT - notice.text.length
	const omitted = new Set<TextPart>()
	for (const part of orderedParts) {
		if (part.text.length <= remaining) remaining -= part.text.length
		else omitted.add(part)
	}
	const bounded = finalized.map((result) => {
		const blockOrigins = result.blockOrigins ? new Map(result.blockOrigins) : undefined
		const content = result.content.flatMap<Anthropic.Messages.ContentBlockParam>((block) => {
			if (block.type === "text" && omitted.has(block)) {
				blockOrigins?.delete(block)
				return []
			}
			if (block.type === "tool_result" && Array.isArray(block.content)) {
				const parts = block.content.filter((part) => part.type !== "text" || !omitted.has(part))
				if (parts.length !== block.content.length) {
					const nextBlock = { ...block, content: parts }
					const origin = blockOrigins?.get(block)
					blockOrigins?.delete(block)
					if (origin) blockOrigins?.set(nextBlock, origin)
					return [nextBlock]
				}
			}
			return [block]
		})
		return { ...result, content, ...(blockOrigins ? { blockOrigins } : {}) }
	})
	const last = bounded[bounded.length - 1]!
	last.content.push(notice)
	if (last.blockOrigins) last.blockOrigins = new Map(last.blockOrigins).set(notice, "agent")
	return bounded
}
