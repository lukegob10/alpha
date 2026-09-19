import { codebaseIndexConfigSchema, codebaseIndexModelsSchema } from "../codebase-index.js"

describe("codebase index provider migration compatibility", () => {
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
