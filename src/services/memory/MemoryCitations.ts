import type { AgentResponse } from "../../core/agent/AgentResponse"
import { memoryCitationSchema, type MemoryCitation, type MemoryCitationEntry } from "@alpha-code/types"
import { MAX_MEMORY_CITATION_LENGTH, splitMemoryCitations } from "../../shared/memory-citations"

const MAX_REFERENCES = 128
const MAX_ASSISTANT_TEXT = 1_048_576
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const ENTRY =
	/^((?:MEMORY\.md|memory_summary\.md|rollout_summaries\/[A-Za-z0-9][A-Za-z0-9_-]{0,180}\.md)):([1-9]\d{0,8})-([1-9]\d{0,8})\|note=\[([^\r\n[\]<>]{0,160})\]$/

/**
 * Original TypeScript parser for finalized assistant citations, following the usage contract in
 * openai/codex@b75d1e89665d256bf2c674b9590776f440c9bae7 (2026-10-29).
 * References are data only; the coordinator independently accepts only existing source IDs/paths.
 */
function parseCitation(block: string): { citation: MemoryCitation; references: string[] } | undefined {
	if (block.length > MAX_MEMORY_CITATION_LENGTH) return undefined
	const references = new Set<string>()
	const entries: MemoryCitationEntry[] = []
	const rolloutIds = new Set<string>()
	const seen = new Set<string>()
	let section: "citation_entries" | "rollout_ids" | undefined
	for (const raw of block.split("\n")) {
		const line = raw.trim()
		if (!line) continue
		if (!section) {
			if (line !== "<citation_entries>" && line !== "<rollout_ids>") return undefined
			const next = line === "<citation_entries>" ? "citation_entries" : "rollout_ids"
			if (seen.has(next)) return undefined
			seen.add(next)
			section = next
		} else if (line === `</${section}>`) {
			section = undefined
		} else if (section === "rollout_ids") {
			if (!SOURCE_ID.test(line)) return undefined
			references.add(line)
			rolloutIds.add(line)
		} else {
			const entry = line.match(ENTRY)
			if (!entry || Number(entry[2]) > Number(entry[3])) return undefined
			entries.push({ path: entry[1], lineStart: Number(entry[2]), lineEnd: Number(entry[3]), note: entry[4] })
			// Index locations retain attribution without becoming rollout usage authority.
			if (entry[1].startsWith("rollout_summaries/")) references.add(entry[1])
		}
		if (references.size > MAX_REFERENCES || entries.length > MAX_REFERENCES) return undefined
	}
	if (section || (!entries.length && !rolloutIds.size)) return undefined
	return { citation: { entries, rolloutIds: [...rolloutIds] }, references: [...references] }
}

export function parseMemoryCitation(block: string): MemoryCitation | undefined {
	return parseCitation(block)?.citation
}

/** Backward-compatible usage projection; only rollout identities and locations can mark source usage. */
export function parseMemoryCitationReferences(block: string): string[] {
	return parseCitation(block)?.references ?? []
}

/** Read only canonical user-facing assistant text; never reasonings, tool arguments, or replayed input. */
function assistantCitationGroups(response: AgentResponse): Array<{ index: number; citation: MemoryCitation }> {
	const groups: Array<{ index: number; citation: MemoryCitation }> = []
	let text = ""
	let messageKey = ""
	let lastTextIndex = -1
	const flush = () => {
		if (text.length <= MAX_ASSISTANT_TEXT) {
			const entries: MemoryCitationEntry[] = []
			const rolloutIds = new Set<string>()
			for (const block of splitMemoryCitations(text).blocks) {
				const citation = parseMemoryCitation(block)
				if (!citation) continue
				for (const entry of citation.entries) if (entries.length < MAX_REFERENCES) entries.push(entry)
				for (const id of citation.rolloutIds) if (rolloutIds.size < MAX_REFERENCES) rolloutIds.add(id)
			}
			if (entries.length || rolloutIds.size)
				groups.push({ index: lastTextIndex, citation: { entries, rolloutIds: [...rolloutIds] } })
		}
		text = ""
	}
	for (const [index, item] of response.items.entries()) {
		if (item.type !== "text" || (item.phase && item.phase !== "final_answer")) {
			flush()
			messageKey = ""
			continue
		}
		const nextKey = JSON.stringify([item.id ?? "", item.outputIndex ?? "", item.phase ?? ""])
		if (messageKey && messageKey !== nextKey) flush()
		messageKey = nextKey
		lastTextIndex = index
		if (text.length <= MAX_ASSISTANT_TEXT) text += item.text
	}
	flush()
	return groups
}

/** Add structured provenance at the final fragment without altering raw provider text or item order. */
export function withAssistantMemoryCitations(response: AgentResponse): AgentResponse {
	if (response.outcome && response.outcome.status !== "completed") return response
	const groups = assistantCitationGroups(response)
	if (!groups.length) return response
	const items = [...response.items]
	for (const { index, citation } of groups) {
		const item = items[index]
		if (item.type === "text") items[index] = { ...item, memoryCitation: citation }
	}
	return { ...response, items }
}

export function assistantMemoryCitationReferences(response: AgentResponse): string[] {
	const references = new Set<string>()
	for (const item of withAssistantMemoryCitations(response).items) {
		if (item.type !== "text" || (item.phase && item.phase !== "final_answer")) continue
		const parsed = memoryCitationSchema.safeParse(item.memoryCitation)
		if (!parsed.success) continue
		for (const entry of parsed.data.entries) {
			if (entry.path.startsWith("rollout_summaries/") && references.size < MAX_REFERENCES)
				references.add(entry.path)
		}
		for (const id of parsed.data.rolloutIds) if (references.size < MAX_REFERENCES) references.add(id)
	}
	return [...references]
}
