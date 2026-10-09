import type { VectorStoreSearchResult } from "../interfaces"
import { CODEBASE_INDEX_SEARCH_LIMITS, type CodebaseSearchDiagnostics } from "@alpha-code/types"
import { countCodeTokens } from "../processors/chunking"

export const SEARCH_CONTEXT_TOKEN_BUDGET = CODEBASE_INDEX_SEARCH_LIMITS.CONTEXT_TOKEN_BUDGET
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
	return (await packSearchResultsWithDiagnostics(results, maxResults, tokenBudget, accept)).results
}

export async function packSearchResultsWithDiagnostics(
	results: VectorStoreSearchResult[],
	maxResults: number,
	tokenBudget: number = SEARCH_CONTEXT_TOKEN_BUDGET,
	accept?: (result: VectorStoreSearchResult) => Promise<boolean>,
) {
	const selected: VectorStoreSearchResult[] = []
	let remaining = tokenBudget
	const diagnostics: Pick<
		CodebaseSearchDiagnostics,
		| "estimatedContextTokens"
		| "returnedChunks"
		| "candidatesExamined"
		| "skippedDuplicates"
		| "skippedBudget"
		| "skippedSource"
		| "skippedInvalid"
		| "remainingCandidates"
	> = {
		estimatedContextTokens: 0,
		returnedChunks: 0,
		candidatesExamined: 0,
		skippedDuplicates: 0,
		skippedBudget: 0,
		skippedSource: 0,
		skippedInvalid: 0,
		remainingCandidates: 0,
	}
	for (const result of results) {
		diagnostics.candidatesExamined++
		const payload = result.payload
		if (!payload) {
			diagnostics.skippedInvalid++
			continue
		}
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
		if (duplicate) {
			diagnostics.skippedDuplicates++
			continue
		}
		const cost = (await countCodeTokens(`${payload.filePath}\n${payload.context ?? ""}\n${payload.codeChunk}`)) + 40
		if (cost > remaining) {
			diagnostics.skippedBudget++
			continue
		}
		if (accept && !(await accept(result))) {
			diagnostics.skippedSource++
			continue
		}
		selected.push(result)
		remaining -= cost
		if (selected.length >= maxResults) break
	}
	diagnostics.estimatedContextTokens = tokenBudget - remaining
	diagnostics.returnedChunks = selected.length
	diagnostics.remainingCandidates = results.length - diagnostics.candidatesExamined
	return { results: selected, diagnostics }
}
