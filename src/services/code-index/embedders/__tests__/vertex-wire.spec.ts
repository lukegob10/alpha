import { VertexGeminiEmbedder } from "../vertex"

const { getToken, forceRefreshToken, configureTransport } = vi.hoisted(() => ({
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	configureTransport: vi.fn(),
}))

vi.mock("../../../../api/providers/utils/helix-token-manager", () => ({
	HelixTokenManager: { getOrCreate: () => ({ getToken, forceRefreshToken }) },
}))
vi.mock("../../../../api/providers/utils/vertex-gateway-transport", () => ({
	configureVertexGatewayTransport: configureTransport,
}))
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

// Keep the installed Google SDK real: assertions cover the final URL, headers, and JSON body.
describe("Vertex gateway embedding wire compatibility", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		getToken.mockResolvedValue("test-token")
		configureTransport.mockResolvedValue(undefined)
	})
	afterEach(() => vi.unstubAllGlobals())

	it.each(["canonical", "legacy"])("preserves the earlier Gemini 001 payload with %s settings", async (settings) => {
		const fetch = vi.fn().mockImplementation(async () => {
			expect(configureTransport).toHaveBeenCalledOnce()
			return new Response(
				JSON.stringify({ predictions: [{ embeddings: { values: [1, 0], statistics: { token_count: 2 } } }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)
		})
		vi.stubGlobal("fetch", fetch)
		const route = {
			"gemini-embedding-001": {
				projectId: "routed-project",
				location: "us-central1",
				modelOverride: "gateway-embedding-model",
				extraHeaders: { "x-route": "embedding" },
			},
		}
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			...(settings === "canonical"
				? {
						projectId: "default-project",
						location: "global",
						gatewayBaseUrl: "https://gateway.example.com/vertex",
						pemCaBundlePath: "test.pem",
						helixCommand: "test-token-command",
						modelRoutingMap: route,
					}
				: {
						vertexProjectId: "default-project",
						vertexRegion: "global",
						vertexGatewayBaseUrl: "https://gateway.example.com/vertex",
						vertexGatewayCaBundlePath: "test.pem",
						vertexGatewayHelixCommand: "test-token-command",
						vertexGatewayModelRoutingMap: JSON.stringify(route),
					}),
		})

		await expect(embedder.validateConfiguration()).resolves.toEqual({ valid: true })
		await expect(embedder.createEmbeddings(["first", "second"])).resolves.toEqual({
			embeddings: [
				[1, 0],
				[1, 0],
			],
			usage: { promptTokens: 4, totalTokens: 4 },
		})
		await embedder.createEmbeddings(["find source"], undefined, "query")

		expect(fetch).toHaveBeenCalledTimes(4)
		for (const [index, [url, request]] of fetch.mock.calls.entries()) {
			expect(url).toBe(
				"https://gateway.example.com/vertex/v1beta1/projects/routed-project/locations/us-central1/publishers/google/models/gateway-embedding-model:predict",
			)
			expect(request.method).toBe("POST")
			const headers = new Headers(request.headers)
			expect(headers.get("Authorization")).toBe("Bearer test-token")
			expect(headers.get("x-route")).toBe("embedding")
			// Before 6a04173, gateway instances contained only the original content.
			expect(JSON.parse(request.body)).toEqual({
				instances: [{ content: ["test", "first", "second", "find source"][index] }],
			})
		}
	})

	it("replays the same prediction with refreshed bearer auth after a gateway 401", async () => {
		getToken.mockResolvedValueOnce("expired-token").mockResolvedValue("refreshed-token")
		forceRefreshToken.mockResolvedValue("refreshed-token")
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { code: 401, message: "Unauthorized" } }), { status: 401 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ predictions: [{ embeddings: { values: [1, 0] } }] }), { status: 200 }),
			)
		vi.stubGlobal("fetch", fetch)
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			projectId: "project",
			location: "us-central1",
			gatewayBaseUrl: "https://gateway.example.com/vertex",
			pemCaBundlePath: "test.pem",
			helixCommand: "test-token-command",
		})

		await expect(embedder.createEmbeddings(["query"], undefined, "query")).resolves.toMatchObject({
			embeddings: [[1, 0]],
		})
		expect(forceRefreshToken).toHaveBeenCalledOnce()
		expect(fetch).toHaveBeenCalledTimes(2)
		const [[firstUrl, firstRequest], [retryUrl, retryRequest]] = fetch.mock.calls
		expect(firstUrl).toBe(
			"https://gateway.example.com/vertex/v1beta1/projects/project/locations/us-central1/publishers/google/models/gemini-embedding-001:predict",
		)
		expect(retryUrl).toBe(firstUrl)
		expect(JSON.parse(firstRequest.body)).toEqual({ instances: [{ content: "query" }] })
		expect(retryRequest.body).toBe(firstRequest.body)
		expect(new Headers(firstRequest.headers).get("Authorization")).toBe("Bearer expired-token")
		expect(new Headers(retryRequest.headers).get("Authorization")).toBe("Bearer refreshed-token")
	})
})
