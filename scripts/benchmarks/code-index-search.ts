import assert from "node:assert/strict"

import { CodeIndexSearchService } from "../../src/services/code-index/search-service"
import type { CodeIndexConfigManager } from "../../src/services/code-index/config-manager"
import type { CodeIndexStateManager } from "../../src/services/code-index/state-manager"
import type { IEmbedder, IVectorStore, VectorStoreSearchResult } from "../../src/services/code-index/interfaces"
import { fuseSearchResults, packSearchResultsWithDiagnostics } from "../../src/services/code-index/shared/retrieval"

function chunk(id: string, codeChunk = "return ready"): VectorStoreSearchResult {
	return {
		id,
		score: 0.8,
		payload: {
			filePath: `${id}.ts`,
			codeChunk,
			startLine: 1,
			endLine: 1,
			startOffset: 0,
			endOffset: codeChunk.length,
		},
	}
}

const shortChunks = Array.from({ length: 250 }, (_, index) => chunk(`short-${index}`))
const mediumChunks = Array.from({ length: 250 }, (_, index) =>
	chunk(`medium-${index}`, "const value = compute(input)\n".repeat(50)),
)
const fixtures = [
	{
		name: "keyword-identifier",
		dense: [chunk("semantic-distractor")],
		lexical: [chunk("exactIdentifier")],
		evidence: "exactIdentifier",
	},
	{
		name: "agreement-after-rank-60",
		dense: [...Array.from({ length: 60 }, (_, index) => chunk(`dense-${index}`)), chunk("sharedEvidence")],
		lexical: [...Array.from({ length: 60 }, (_, index) => chunk(`lexical-${index}`)), chunk("sharedEvidence")],
		evidence: "sharedEvidence",
	},
	{ name: "short-chunk-cap", dense: shortChunks, lexical: shortChunks, evidence: "short-0" },
	{ name: "medium-chunk-budget", dense: mediumChunks, lexical: mediumChunks, evidence: "medium-0" },
]

async function main() {
	const observations = []
	for (const fixture of fixtures) {
		for (const configuredMaximum of [10, 20, 50, 100, 200]) {
			const maximum = Math.max(1, Math.min(100, configuredMaximum))
			// Replay the 3.1.8 candidate formula with the same fusion and packing implementation.
			// This establishes candidate/evidence counts, not a historical latency measurement.
			const legacyCandidateLimit = Math.min(200, Math.max(40, maximum * 4))
			const legacy = await packSearchResultsWithDiagnostics(
				fuseSearchResults([
					fixture.dense.slice(0, legacyCandidateLimit),
					fixture.lexical.slice(0, legacyCandidateLimit),
				]),
				maximum,
			)
			let embeddingOperations = 0
			const config = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				currentSearchMinScore: 0.4,
				currentSearchMaxResults: configuredMaximum,
			} as CodeIndexConfigManager
			const state = { getCurrentStatus: () => ({ systemStatus: "Indexed" }) } as unknown as CodeIndexStateManager
			const embedder = {
				createEmbeddings: async () => {
					embeddingOperations++
					return { embeddings: [[1, 0, 0]] }
				},
			} as unknown as IEmbedder
			const store = {
				search: async (_vector: number[], _prefix: string | undefined, _score: number, limit: number) =>
					fixture.dense.slice(0, limit),
				searchLexical: async (_query: string, _prefix: string | undefined, limit: number) =>
					fixture.lexical.slice(0, limit),
			} as unknown as IVectorStore
			const current = await new CodeIndexSearchService(config, state, embedder, store).searchIndexWithDiagnostics(
				fixture.name,
			)
			assert.equal(embeddingOperations, 1)
			assert.ok(current.results.length <= maximum)
			assert.ok(current.diagnostics.estimatedContextTokens <= current.diagnostics.contextTokenBudget)
			const summarize = (
				results: VectorStoreSearchResult[],
				estimatedContextTokens: number,
				candidateLimit: number,
			) => ({
				candidateLimit,
				returnedChunks: results.length,
				estimatedContextTokens,
				evidenceIncluded: results.some(({ id }) => id === fixture.evidence),
				evidenceRank: results.findIndex(({ id }) => id === fixture.evidence) + 1 || null,
			})
			observations.push({
				fixture: fixture.name,
				configuredMaximum,
				embeddingOperations,
				legacyFormula: summarize(
					legacy.results,
					legacy.diagnostics.estimatedContextTokens,
					legacyCandidateLimit,
				),
				current: summarize(
					current.results,
					current.diagnostics.estimatedContextTokens,
					current.diagnostics.candidateLimit,
				),
			})
		}
	}
	const recovery = observations.find(
		(entry) => entry.fixture === "agreement-after-rank-60" && entry.configuredMaximum === 10,
	)!
	assert.equal(recovery.legacyFormula.evidenceIncluded, false)
	assert.equal(recovery.current.evidenceRank, 1)
	for (const entry of observations.filter(({ configuredMaximum }) => configuredMaximum >= 50)) {
		assert.equal(entry.current.returnedChunks, entry.legacyFormula.returnedChunks)
		assert.equal(entry.current.estimatedContextTokens, entry.legacyFormula.estimatedContextTokens)
	}
	console.log(
		JSON.stringify(
			{
				benchmark: "code-index-candidate-and-context-contract",
				node: process.version,
				provider: "scripted; no network requests",
				cache: "same fixed ranked fixtures; no embedding or result cache",
				metric: "known evidence retained, candidate limits, returned chunks and estimated context cost",
				conditions:
					"Current search service versus a replay of the 3.1.8 candidate formula. Synthetic ranking fixtures; no relevance-quality or latency claim. Source access and freshness are covered separately by regression tests.",
				observations,
			},
			null,
			2,
		),
	)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
