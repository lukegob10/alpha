import type { VectorStoreSearchResult } from "../interfaces"
import { countCodeTokens } from "../processors/chunking"

export const SEARCH_CONTEXT_TOKEN_BUDGET = 6000
const RRF_OFFSET = 60

/** Fuse ranks, not incomparable cosine and lexical scores. Keep channel scores for diagnostics. */
export function fuseSearchResults(channels: VectorStoreSearchResult[][]): VectorStoreSearchResult[] {
	const candidates = new Map<string, VectorStoreSearchResult>()
	for (const [channel, results] of channels.entries()) {
		const seen = new Set<string>()
		for (const [rank, result] of results.entries()) {
			if (!result.payload || !Number.isFinite(result.score)) continue
			const key = String(result.id)
			if (seen.has(key)) continue
			seen.add(key)
			const candidate = candidates.get(key) ?? { ...result, score: 0, scoreType: "hybrid" as const }
			candidate.score += (RRF_OFFSET + 1) / (RRF_OFFSET + rank + 1) / channels.length
			if (channel === 0) candidate.semanticScore = result.score
			else candidate.lexicalScore = result.score
			candidates.set(key, candidate)
		}
	}
	return [...candidates.values()].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
}

/** Spend context on distinct evidence; keep complete chunks and never truncate a symbol mid-result. */
export async function packSearchResults(
	results: VectorStoreSearchResult[],
	maxResults: number,
	tokenBudget = SEARCH_CONTEXT_TOKEN_BUDGET,
	accept?: (result: VectorStoreSearchResult) => Promise<boolean>,
): Promise<VectorStoreSearchResult[]> {
	const selected: VectorStoreSearchResult[] = []
	let remaining = tokenBudget
	for (const result of results) {
		const payload = result.payload
		if (!payload) continue
		const duplicate = selected.some(
			({ payload: other }) =>
				other &&
				other.filePath === payload.filePath &&
				(other.codeChunk === payload.codeChunk ||
					(Number.isInteger(payload.startOffset) &&
						payload.startOffset >= 0 &&
						Number.isInteger(other.startOffset) &&
						other.startOffset >= 0 &&
						payload.startOffset < other.endOffset &&
						payload.endOffset > other.startOffset)),
		)
		if (duplicate) continue
		const cost = (await countCodeTokens(`${payload.filePath}\n${payload.context ?? ""}\n${payload.codeChunk}`)) + 40
		if (cost > remaining) continue
		if (accept && !(await accept(result))) continue
		selected.push(result)
		remaining -= cost
		if (selected.length >= maxResults) break
	}
	return selected
}
