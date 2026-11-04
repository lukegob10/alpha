import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HttpEmbedder } from "../http"
const { bedrockFetch, createBedrockFetch } = vi.hoisted(() => ({ bedrockFetch: vi.fn(), createBedrockFetch: vi.fn() }))
vi.mock("../../../../api/providers/bedrock", () => ({ createBedrockFetch }))
const fetchMock = vi.fn()
function response(vectors: number[][], indexes = vectors.map((_, i) => i)) {
	return new Response(
		JSON.stringify({
			data: vectors.map((embedding, i) => ({ index: indexes[i], embedding })),
			usage: { prompt_tokens: 4, total_tokens: 4 },
		}),
	)
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal("fetch", fetchMock)
	createBedrockFetch.mockReturnValue(bedrockFetch)
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})
describe("HTTP indexing embeddings", () => {
	it("rejects unsupported Bedrock wire formats and unsafe compatible URLs before dispatch", () => {
		expect(() => new HttpEmbedder("bedrock", "cohere.embed-english-v3", { region: "us-west-2" })).toThrow()
		for (const baseUrl of [
			"file:///tmp/models",
			"https://user:secret@example.com",
			"https://example.com/v1?key=secret",
		])
			expect(() => new HttpEmbedder("openai", "model", { baseUrl })).toThrow()
		expect(fetchMock).not.toHaveBeenCalled()
	})
	it("sends each Titan input separately and preserves batch order and token usage", async () => {
		let active = 0,
			maximum = 0
		bedrockFetch.mockImplementation(async (_url, options) => {
			active++
			maximum = Math.max(maximum, active)
			const body = JSON.parse(options.body)
			expect(body).toEqual({ inputText: expect.any(String), dimensions: 1024, normalize: true })
			await Promise.resolve()
			active--
			return new Response(
				JSON.stringify({ embedding: new Array(1024).fill(Number(body.inputText)), inputTextTokenCount: 2 }),
			)
		})
		const texts = Array.from({ length: 5 }, (_, index) => String(index + 1))
		const result = await new HttpEmbedder("bedrock", "amazon.titan-embed-text-v2:0", {
			region: "us-west-2",
			profile: "index-profile",
		}).createEmbeddings(texts)
		expect(result.embeddings.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5])
		expect(result.usage).toEqual({ promptTokens: 10, totalTokens: 10 })
		expect(maximum).toBeLessThanOrEqual(2)
		expect(bedrockFetch).toHaveBeenCalledTimes(5)
		expect(bedrockFetch).toHaveBeenCalledWith(
			"https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke",
			expect.anything(),
		)
	})
	it.each([{}, { embedding: [0.5] }])("rejects missing or wrong-sized Titan vectors: %j", async (body) => {
		bedrockFetch.mockResolvedValue(new Response(JSON.stringify(body)))
		await expect(
			new HttpEmbedder("bedrock", "amazon.titan-embed-text-v2:0", { region: "us-west-2" }).createEmbeddings([
				"text",
			]),
		).rejects.toThrow()
		expect(bedrockFetch).toHaveBeenCalledOnce()
	})
	it.each([
		["cohere/embed-5-pro", 2048, "query", "search_query"],
		["cohere/embed-5-fast", 2048, "document", "search_document"],
		["mongodb/voyage-code-4", 1024, "query", "query"],
		["mongodb/voyage-code-4", 1024, "document", "document"],
	] as const)("passes retrieval purpose for %s (%s dimensions, %s)", async (model, dimension, purpose, inputType) => {
		fetchMock.mockResolvedValue(response([new Array(dimension).fill(0.5)]))
		await new HttpEmbedder("openrouter", model, { apiKey: "key" }).createEmbeddings(["text"], undefined, purpose)
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			input: ["text"],
			model,
			encoding_format: "float",
			input_type: inputType,
		})
	})
	it.each([
		[
			"openrouter",
			"qwen/qwen3-embedding-4b",
			2560,
			"query",
			"Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		],
		[
			"openai",
			"Qwen/Qwen3-Embedding-8B",
			4096,
			"query",
			"Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: ",
		],
		["openai", "nomic-ai/nomic-embed-text-v1.5", 768, "query", "search_query: "],
		["openai", "nomic-ai/nomic-embed-text-v1.5", 768, "document", "search_document: "],
	] as const)("formats %s / %s for retrieval", async (provider, model, dimension, purpose, prefix) => {
		fetchMock.mockResolvedValue(response([new Array(dimension).fill(0.5)]))
		await new HttpEmbedder(provider, model, { baseUrl: "https://compatible.test/v1" }).createEmbeddings(
			["text"],
			undefined,
			purpose,
		)
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual([`${prefix}text`])
	})
	it.each([
		["openai-native", "https://api.openai.com/v1/embeddings"],
		["openrouter", "https://openrouter.ai/api/v1/embeddings"],
		["openai", "https://compatible.test/v1/embeddings"],
	] as const)("uses the independent %s endpoint and restores response ordering", async (provider, endpoint) => {
		fetchMock.mockResolvedValue(
			response(
				[
					[2, 0],
					[1, 0],
				],
				[1, 0],
			),
		)
		const result = await new HttpEmbedder(
			provider,
			"custom-model",
			{ apiKey: "index-secret", baseUrl: "https://compatible.test/v1/" },
			undefined,
			2,
		).createEmbeddings(["first", "second"])
		expect(result).toEqual({
			embeddings: [
				[1, 0],
				[2, 0],
			],
			usage: { promptTokens: 4, totalTokens: 4 },
		})
		expect(fetchMock).toHaveBeenCalledWith(
			endpoint,
			expect.objectContaining({
				headers: { "Content-Type": "application/json", Authorization: "Bearer index-secret" },
				body: JSON.stringify({ input: ["first", "second"], model: "custom-model", encoding_format: "float" }),
			}),
		)
	})
	it("uses Bedrock credentials and Cohere's query format", async () => {
		bedrockFetch.mockResolvedValue(
			new Response(JSON.stringify({ embeddings: { float: [new Array(1536).fill(0.5)] } })),
		)
		await new HttpEmbedder("bedrock", "cohere.embed-v4:0", {
			region: "us-west-2",
			profile: "index-profile",
		}).createEmbeddings(["find code"], undefined, "query")
		expect(createBedrockFetch).toHaveBeenCalledWith(
			expect.objectContaining({
				awsRegion: "us-west-2",
				awsUseProfile: true,
				awsProfile: "index-profile",
				awsUseApiKey: false,
			}),
			"us-west-2",
		)
		expect(bedrockFetch).toHaveBeenCalledWith(
			"https://bedrock-runtime.us-west-2.amazonaws.com/model/cohere.embed-v4%3A0/invoke",
			expect.objectContaining({
				body: JSON.stringify({
					texts: ["find code"],
					input_type: "search_query",
					embedding_types: ["float"],
					output_dimension: 1536,
					truncate: "NONE",
				}),
			}),
		)
	})
	it("preserves the input format and dimensions of a saved compatible deployment that now has a preset", async () => {
		fetchMock.mockImplementation(async () => response([new Array(384).fill(0.5)]))
		const embedder = new HttpEmbedder(
			"openai",
			"nomic-ai/nomic-embed-text-v1.5",
			{ baseUrl: "https://compatible.test/v1" },
			undefined,
			384,
		)
		await embedder.createEmbeddings(["query"], undefined, "query")
		await embedder.createEmbeddings(["document"])
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(["query"])
		expect(JSON.parse(fetchMock.mock.calls[1][1].body).input).toEqual(["document"])
	})
	it("adds Qwen's retrieval instructions", async () => {
		fetchMock.mockResolvedValue(response([new Array(4096).fill(0.5)]))
		await new HttpEmbedder("openrouter", "qwen/qwen3-embedding-8b", { apiKey: "key" }).createEmbeddings(
			["find code"],
			undefined,
			"query",
		)
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual([
			"Instruct: Given a code search query, retrieve relevant code snippets.\nQuery: find code",
		])
	})
	it.each([
		{ data: [{ index: 1, embedding: [1, 0] }] },
		{ data: [{ index: 0, embedding: [1] }] },
		{ data: [] },
		{ data: [{ index: 0, embedding: [null, 0] }] },
	])("rejects incomplete, misindexed, or wrong-sized vectors: %j", async (body) => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify(body)))
		await expect(
			new HttpEmbedder(
				"openai",
				"custom",
				{ baseUrl: "http://localhost:8080/v1" },
				undefined,
				2,
			).createEmbeddings(["text"]),
		).rejects.toThrow()
		expect(fetchMock).toHaveBeenCalledOnce()
	})
	it("bounds concurrency, batches every input, and preserves order", async () => {
		let active = 0,
			maximum = 0
		fetchMock.mockImplementation(async (_url, options) => {
			active++
			maximum = Math.max(maximum, active)
			await Promise.resolve()
			const input = JSON.parse(options.body).input as string[]
			active--
			return response(input.map((text) => [Number(text), 0]))
		})
		const texts = Array.from({ length: 130 }, (_, i) => String(i))
		const result = await new HttpEmbedder(
			"openai",
			"custom",
			{ baseUrl: "http://localhost:8080/v1" },
			undefined,
			2,
		).createEmbeddings(texts)
		expect(result.embeddings.map((vector) => vector[0])).toEqual(texts.map(Number))
		expect(maximum).toBeLessThanOrEqual(2)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})
	it("retries a quota response with the provider delay", async () => {
		vi.useFakeTimers()
		fetchMock
			.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
			.mockResolvedValueOnce(response([[1, 0]]))
		const pending = new HttpEmbedder(
			"openai",
			"custom",
			{ baseUrl: "http://localhost:8080/v1" },
			undefined,
			2,
		).createEmbeddings(["text"])
		await vi.runAllTimersAsync()
		await expect(pending).resolves.toMatchObject({ embeddings: [[1, 0]] })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
	it("rejects cancellation despite a late transport success", async () => {
		const controller = new AbortController()
		fetchMock.mockImplementationOnce(async (_url, options) => {
			controller.abort(new Error("cancelled"))
			expect(options.signal.aborted).toBe(true)
			return response([[1, 0]])
		})
		await expect(
			new HttpEmbedder(
				"openai",
				"custom",
				{ baseUrl: "http://localhost:8080/v1" },
				undefined,
				2,
			).createEmbeddings(["text"], undefined, "document", controller.signal),
		).rejects.toThrow("cancelled")
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
