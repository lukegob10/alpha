import nock from "nock"

import i18n from "../../../../i18n"
import embeddingTranslations from "../../../../i18n/locales/en/embeddings.json"
import { VertexGeminiEmbedder } from "../vertex"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

// Exercise the adapter and installed SDK together, stubbing only HTTP and credentials.
describe("Native Vertex embedding wire contract", () => {
	beforeEach(() => {
		i18n.addResourceBundle("en", "embeddings", embeddingTranslations)
		nock("https://oauth2.googleapis.com").post("/token").reply(200, {
			access_token: "test-token",
			expires_in: 3600,
			token_type: "Bearer",
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		nock.cleanAll()
		i18n.removeResourceBundle("en", "embeddings")
	})

	function createEmbedder(model: string, location: string) {
		return new VertexGeminiEmbedder(
			{
				apiProvider: "vertex",
				projectId: "test-project",
				location,
				vertexJsonCredentials: JSON.stringify({
					type: "authorized_user",
					client_id: "test-client",
					client_secret: "test-secret",
					refresh_token: "test-refresh-token",
				}),
			},
			model,
		)
	}

	it.each([
		["global", "https://aiplatform.googleapis.com"],
		["us", "https://aiplatform.us.rep.googleapis.com"],
	])("uses embedContent for Gemini 2 in %s during validation, indexing, and search", async (location, baseUrl) => {
		const fetch = vi
			.fn()
			.mockImplementation(
				async () => new Response(JSON.stringify({ embedding: { values: [1, 0] } }), { status: 200 }),
			)
		vi.stubGlobal("fetch", fetch)
		const embedder = createEmbedder("gemini-embedding-2", location)

		const validation = await embedder.validateConfiguration()
		expect(fetch.mock.calls[0][0]).toBe(
			`${baseUrl}/v1beta1/projects/test-project/locations/${location}/publishers/google/models/gemini-embedding-2:embedContent`,
		)
		expect(validation).toEqual({ valid: true })
		await expect(embedder.createEmbeddings(["first", "second"])).resolves.toMatchObject({
			embeddings: [
				[1, 0],
				[1, 0],
			],
		})
		await embedder.createEmbeddings(["find source"], undefined, "query")

		expect(fetch).toHaveBeenCalledTimes(4)
		for (const [index, [url, request]] of fetch.mock.calls.entries()) {
			expect(url).toBe(
				`${baseUrl}/v1beta1/projects/test-project/locations/${location}/publishers/google/models/gemini-embedding-2:embedContent`,
			)
			expect(request.method).toBe("POST")
			expect(new Headers(request.headers).get("Authorization")).toBe("Bearer test-token")
			expect(JSON.parse(request.body)).toEqual({
				content: {
					parts: [
						{
							text: [
								"title: none | text: test",
								"title: none | text: first",
								"title: none | text: second",
								"task: code retrieval | query: find source",
							][index],
						},
					],
				},
			})
		}
	})

	it("preserves Gemini 001 predictions and retrieval task types", async () => {
		const fetch = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						predictions: [{ embeddings: { values: [1, 0], statistics: { token_count: 2 } } }],
					}),
					{ status: 200 },
				),
		)
		vi.stubGlobal("fetch", fetch)
		const embedder = createEmbedder("gemini-embedding-001", "us-central1")

		await expect(embedder.createEmbeddings(["document"])).resolves.toEqual({
			embeddings: [[1, 0]],
			usage: { promptTokens: 2, totalTokens: 2 },
		})
		await embedder.createEmbeddings(["query"], undefined, "query")
		expect(fetch).toHaveBeenCalledTimes(2)
		for (const [index, [url, request]] of fetch.mock.calls.entries()) {
			expect(url).toBe(
				"https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/publishers/google/models/gemini-embedding-001:predict",
			)
			expect(JSON.parse(request.body)).toEqual({
				instances: [
					{
						content: index === 0 ? "document" : "query",
						task_type: index === 0 ? "RETRIEVAL_DOCUMENT" : "CODE_RETRIEVAL_QUERY",
					},
				],
			})
		}
	})

	it("reports the actual request count for a non-retryable 404", async () => {
		const fetch = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(JSON.stringify({ error: { code: 404, message: "Model not found" } }), { status: 404 }),
			)
		vi.stubGlobal("fetch", fetch)
		const embedder = createEmbedder("gemini-embedding-2", "global")

		await expect(embedder.createEmbeddings(["test"])).rejects.toThrow("after 1 attempts: HTTP 404")
		expect(fetch).toHaveBeenCalledOnce()
	})
})
