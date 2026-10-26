import type { AgentResponse } from "../../core/agent/AgentResponse"
import { MAX_MEMORY_CITATION_LENGTH, splitMemoryCitations } from "../../shared/memory-citations"

const MAX_REFERENCES = 128
const MAX_ASSISTANT_TEXT = 1_048_576
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const ENTRY =
	/^(rollout_summaries\/[A-Za-z0-9][A-Za-z0-9_-]{0,180}\.md):([1-9]\d{0,8})-([1-9]\d{0,8})\|note=\[[^\r\n[\]<>]{0,160}\]$/

/**
 * Original TypeScript parser for finalized assistant citations, following the usage contract in
 * openai/codex@970111f6cb62cc02fe36a82ea7d71b37a2889c97 (2026-10-23).
 * References are data only; the coordinator independently accepts only existing source IDs/paths.
 */
export function parseMemoryCitationReferences(block: string): string[] {
	if (block.length > MAX_MEMORY_CITATION_LENGTH) return []
	const references = new Set<string>()
	const seen = new Set<string>()
	let section: "citation_entries" | "rollout_ids" | undefined
	for (const raw of block.split("\n")) {
		const line = raw.trim()
		if (!line) continue
		if (!section) {
			if (line !== "<citation_entries>" && line !== "<rollout_ids>") return []
			const next = line === "<citation_entries>" ? "citation_entries" : "rollout_ids"
			if (seen.has(next)) return []
			seen.add(next)
			section = next
		} else if (line === `</${section}>`) {
			section = undefined
		} else if (section === "rollout_ids") {
			if (!SOURCE_ID.test(line)) return []
			references.add(line)
		} else {
			const entry = line.match(ENTRY)
			if (!entry || Number(entry[2]) > Number(entry[3])) return []
			references.add(entry[1])
		}
		if (references.size > MAX_REFERENCES) return []
	}
	return section ? [] : [...references]
}

/** Read only canonical user-facing assistant text; never reasonings, tool arguments, or replayed input. */
export function assistantMemoryCitationReferences(response: AgentResponse): string[] {
	const references = new Set<string>()
	let text = ""
	let messageKey = ""
	const flush = () => {
		if (text.length <= MAX_ASSISTANT_TEXT) {
			for (const block of splitMemoryCitations(text).blocks) {
				for (const reference of parseMemoryCitationReferences(block)) {
					if (references.size < MAX_REFERENCES) references.add(reference)
				}
			}
		}
		text = ""
	}
	for (const item of response.items) {
		if (item.type !== "text" || (item.phase && item.phase !== "final_answer")) {
			flush()
			messageKey = ""
			continue
		}
		const nextKey = JSON.stringify([item.id ?? "", item.outputIndex ?? "", item.phase ?? ""])
		if (messageKey && messageKey !== nextKey) flush()
		messageKey = nextKey
		if (text.length <= MAX_ASSISTANT_TEXT) text += item.text
	}
	flush()
	return [...references]
}
