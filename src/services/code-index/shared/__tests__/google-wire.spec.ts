import { GoogleGenAI } from "@google/genai"
import { googleEmbeddingInput } from "../google-embedding"

// Exercise the installed SDK serializer rather than replacing the SDK with a mock.
describe("Google embedding wire contract", () => {
	afterEach(() => vi.unstubAllGlobals())
	it.each(["gemini-embedding-001", "gemini-embedding-2"])("keeps separate text requests for %s", async (model) => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		vi.stubGlobal("fetch", fetch)
		const client = new GoogleGenAI({ apiKey: "test-only", httpOptions: { baseUrl: "http://127.0.0.1:9" } })
		const response = await client.models.embedContent({
			model,
			...googleEmbeddingInput(["first", "second"], model, "document"),
		})
		expect(response.embeddings).toHaveLength(2)
		expect(fetch).toHaveBeenCalledOnce()
		const body = JSON.parse(fetch.mock.calls[0][1].body)
		expect(body.requests).toHaveLength(2)
		expect(
			body.requests.map((request: { content: { parts: { text: string }[] } }) => request.content.parts),
		).toEqual([
			[{ text: model.endsWith("-2") ? "title: none | text: first" : "first" }],
			[{ text: model.endsWith("-2") ? "title: none | text: second" : "second" }],
		])
	})
})
