import type { VectorStoreSearchResult } from "../../interfaces"
import { fuseSearchResults, packSearchResultsWithDiagnostics } from "../retrieval"

function result(id: string, codeChunk = "return ready"): VectorStoreSearchResult {
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

describe("search context packing diagnostics", () => {
	it("counts exclusions without spending context or validating discarded chunks", async () => {
		const first = result("first")
		const overlapping = {
			...first,
			id: "overlap",
			payload: { ...first.payload!, codeChunk: "changed", startOffset: 1, endOffset: 2 },
		}
		const candidates = [
			{ id: "invalid", score: 0.8, payload: null },
			first,
			{ ...first, id: "duplicate" },
			overlapping,
			result("oversized", "function large() { return value }\n".repeat(2000)),
			result("stale"),
			result("second"),
			result("unexamined"),
		]
		const validate = vi.fn(async (candidate: VectorStoreSearchResult) => candidate.id !== "stale")
		const packed = await packSearchResultsWithDiagnostics(candidates, 2, 300, validate)
		expect(packed.results.map(({ id }) => id)).toEqual(["first", "second"])
		expect(packed.diagnostics).toMatchObject({
			returnedChunks: 2,
			candidatesExamined: 7,
			skippedInvalid: 1,
			skippedDuplicates: 2,
			skippedBudget: 1,
			skippedSource: 1,
			remainingCandidates: 1,
		})
		expect(packed.diagnostics.estimatedContextTokens).toBeGreaterThan(0)
		expect(packed.diagnostics.estimatedContextTokens).toBeLessThanOrEqual(300)
		expect(validate.mock.calls.map(([candidate]) => candidate.id)).toEqual(["first", "stale", "second"])
	})
	it("keeps score scales distinct and bases hybrid ordering on rank agreement", () => {
		const weak = { ...result("same"), score: 0.41 }
		const strong = { ...weak, score: 0.91 }
		expect(fuseSearchResults([[weak], []])[0]).toMatchObject({
			score: 0.5,
			semanticScore: 0.41,
			scoreType: "hybrid",
		})
		expect(fuseSearchResults([[strong], []])[0]).toMatchObject({ score: 0.5, semanticScore: 0.91 })
		expect(fuseSearchResults([[weak], [{ ...weak, score: 9 }]])[0]).toMatchObject({
			score: 1,
			semanticScore: 0.41,
			lexicalScore: 9,
		})
	})
})
