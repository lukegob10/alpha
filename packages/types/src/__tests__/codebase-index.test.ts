import { codebaseIndexConfigSchema, codebaseIndexModelsSchema, codebaseSearchResultSchema } from "../codebase-index.js"

describe("codebase index provider migration compatibility", () => {
	it.each([100, 150, 200])("normalizes saved result limit %s to the supported cap", (maximum) => {
		expect(codebaseIndexConfigSchema.parse({ codebaseIndexSearchMaxResults: maximum })).toEqual({
			codebaseIndexSearchMaxResults: 100,
		})
	})

	it("retains legacy provider settings for the config manager to reject explicitly", () => {
		const parsed = codebaseIndexConfigSchema.parse({
			codebaseIndexEnabled: true,
			codebaseIndexEmbedderProvider: "openai-compatible",
			codebaseIndexOpenAiCompatibleBaseUrl: "https://legacy.example.test/v1",
			codebaseIndexOpenAiCompatibleApiKey: "retained-for-diagnostics",
		})

		expect(parsed).toEqual(
			expect.objectContaining({
				codebaseIndexEmbedderProvider: "openai-compatible",
				codebaseIndexOpenAiCompatibleBaseUrl: "https://legacy.example.test/v1",
				codebaseIndexOpenAiCompatibleApiKey: "retained-for-diagnostics",
			}),
		)
	})

	it("preserves legacy model maps without making them active providers", () => {
		const parsed = codebaseIndexModelsSchema.parse({
			openai: { "text-embedding-3-small": { dimension: 1536 } },
			vertex: { "gemini-embedding-001": { dimension: 3072 } },
		})

		expect(parsed).toEqual(
			expect.objectContaining({
				openai: { "text-embedding-3-small": { dimension: 1536 } },
				vertex: { "gemini-embedding-001": { dimension: 3072 } },
			}),
		)
	})
})

describe("saved code search results", () => {
	const legacy = {
		query: "ready",
		results: [{ filePath: "state.ts", score: 0.8, startLine: 1, endLine: 2, codeChunk: "return ready" }],
	}
	it("keeps older results without diagnostics or score metadata readable", () => {
		expect(codebaseSearchResultSchema.parse(legacy)).toEqual(legacy)
	})
	it("preserves bounded-search coverage diagnostics and rejects unknown states", () => {
		const diagnostics = {
			candidateLimit: 200,
			semanticCandidates: 0,
			lexicalCandidates: 1,
			fusedCandidates: 1,
			effectiveMaxResults: 50,
			contextTokenBudget: 6000,
			estimatedContextTokens: 10,
			returnedChunks: 1,
			candidatesExamined: 1,
			skippedDuplicates: 0,
			skippedBudget: 0,
			skippedSource: 0,
			skippedInvalid: 0,
			remainingCandidates: 0,
			freshCandidates: 1,
			semanticStatus: "timeout",
			lexicalStatus: "complete",
		}
		expect(codebaseSearchResultSchema.parse({ ...legacy, diagnostics }).diagnostics).toEqual(diagnostics)
		expect(
			codebaseSearchResultSchema.safeParse({
				...legacy,
				diagnostics: { ...diagnostics, semanticStatus: "ready" },
			}).success,
		).toBe(false)
	})
	it("preserves component scores without treating the hybrid score as semantic similarity", () => {
		const current = {
			...legacy,
			results: [{ ...legacy.results[0], score: 0.5, scoreType: "hybrid", semanticScore: 0.95, lexicalScore: 4 }],
		}
		expect(codebaseSearchResultSchema.parse(current)).toEqual(current)
	})
	it.each([null, { ...legacy, results: {} }, { ...legacy, results: [{ filePath: "state.ts" }] }])(
		"rejects malformed saved results safely (%j)",
		(value) => expect(codebaseSearchResultSchema.safeParse(value).success).toBe(false),
	)
})
