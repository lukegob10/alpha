import { GoogleGenAI } from "@google/genai"
import { GeminiEmbedder } from "../gemini"

vi.mock("@google/genai", () => ({ GoogleGenAI: vi.fn() }))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

describe("GeminiEmbedder", () => {
	const embedContent = vi.fn()
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(GoogleGenAI).mockImplementation(() => ({ models: { embedContent } }) as unknown as GoogleGenAI)
		embedContent.mockImplementation(async ({ contents }) => ({
			embeddings: contents.map(() => ({ values: [0.1, 0.2] })),
		}))
	})
	it("requires credentials", () => expect(() => new GeminiEmbedder("")).toThrow())
	it("migrates the retired model and keeps document/query roles distinct", async () => {
		const embedder = new GeminiEmbedder("key", "text-embedding-004")
		await embedder.createEmbeddings(["source"])
		expect(embedContent).toHaveBeenLastCalledWith({
			model: "gemini-embedding-001",
			contents: ["source"],
			config: { taskType: "RETRIEVAL_DOCUMENT" },
		})
		await embedder.createEmbeddings(["find source"], undefined, "query")
		expect(embedContent).toHaveBeenLastCalledWith({
			model: "gemini-embedding-001",
			contents: ["find source"],
			config: { taskType: "CODE_RETRIEVAL_QUERY" },
		})
	})
	it("uses instructed inputs for Gemini 2 without unsupported taskType", async () => {
		const embedder = new GeminiEmbedder("key", "gemini-embedding-2")
		await embedder.createEmbeddings(["find source"], undefined, "query")
		expect(embedContent).toHaveBeenLastCalledWith({
			model: "gemini-embedding-2",
			contents: [{ parts: [{ text: "task: code retrieval | query: find source" }] }],
			config: {},
		})
		await embedder.createEmbeddings(["source"])
		expect(embedContent).toHaveBeenLastCalledWith({
			model: "gemini-embedding-2",
			contents: [{ parts: [{ text: "title: none | text: source" }] }],
			config: {},
		})
	})
	it("bounds batches and preserves cardinality and order", async () => {
		embedContent.mockImplementation(async ({ contents }) => ({
			embeddings: contents.map((text: string) => ({ values: [Number(text)] })),
		}))
		const result = await new GeminiEmbedder("key").createEmbeddings(
			Array.from({ length: 65 }, (_, index) => String(index)),
		)
		expect(embedContent.mock.calls.map((call) => call[0].contents.length)).toEqual([32, 32, 1])
		expect(result.embeddings).toEqual(Array.from({ length: 65 }, (_, index) => [index]))
	})
	it("rejects partial provider output instead of shifting vector-to-source assignments", async () => {
		embedContent.mockResolvedValue({ embeddings: [{ values: [1, 2] }] })
		await expect(new GeminiEmbedder("key").createEmbeddings(["a", "b"])).rejects.toThrow(
			"incomplete or invalid batch",
		)
		expect(embedContent).toHaveBeenCalledTimes(1)
	})
	it("propagates permanent API errors without retry", async () => {
		embedContent.mockRejectedValue(Object.assign(new Error("Invalid key"), { status: 401 }))
		await expect(new GeminiEmbedder("key").createEmbeddings(["source"])).rejects.toThrow("Invalid key")
		expect(embedContent).toHaveBeenCalledTimes(1)
	})
	it("does not call the provider for empty input", async () => {
		expect((await new GeminiEmbedder("key").createEmbeddings([])).embeddings).toEqual([])
		expect(embedContent).not.toHaveBeenCalled()
	})
})
