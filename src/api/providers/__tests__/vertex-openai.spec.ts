// npx vitest run src/api/providers/__tests__/vertex-openai.spec.ts

import OpenAI from "openai"

import { vertexModels } from "@alpha-code/types"

import { buildApiHandler } from "../../index"
import { VertexOpenAiHandler } from "../vertex-openai"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	getOrCreate: vi.fn(),
	configureTransport: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(() => ({ chat: { completions: { create: mocks.create } } })),
	AzureOpenAI: vi.fn(() => ({ chat: { completions: { create: mocks.create } } })),
}))

vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: mocks.getOrCreate,
	},
}))

vi.mock("../utils/vertex-gateway-transport", () => ({
	configureVertexGatewayTransport: mocks.configureTransport,
}))

const createAsyncStream = (chunks: unknown[]) => ({
	async *[Symbol.asyncIterator]() {
		for (const chunk of chunks) {
			yield chunk
		}
	},
})

describe("VertexOpenAiHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getToken.mockResolvedValue("cached-helix-token")
		mocks.forceRefreshToken.mockResolvedValue("refreshed-helix-token")
		mocks.getOrCreate.mockReturnValue({
			getToken: mocks.getToken,
			forceRefreshToken: mocks.forceRefreshToken,
		})
		mocks.configureTransport.mockResolvedValue("C:\\certs\\corp.pem")
	})

	const createHandler = (overrides: ConstructorParameters<typeof VertexOpenAiHandler>[0] = {}) =>
		new VertexOpenAiHandler({
			apiModelId: "xai/grok-4.6",
			gatewayBaseUrl: "https://vertex/v1",
			projectId: "pr71",
			location: "global",
			pemCaBundlePath: "C:\\certs\\corp.pem",
			helixCommand: "helix auth token print -a",
			...overrides,
		})

	it("exposes the Grok 4.6 Vertex catalog metadata", () => {
		expect(createHandler().getModel()).toMatchObject({
			id: "xai/grok-4.6",
			info: vertexModels["xai/grok-4.6"],
			temperature: 0,
		})
	})

	it("is selected by the Vertex provider factory for Grok models", () => {
		const handler = buildApiHandler({
			apiProvider: "vertex",
			apiModelId: "xai/grok-4.6",
			gatewayBaseUrl: "https://vertex/v1",
			projectId: "pr71",
			location: "global",
			pemCaBundlePath: "C:\\certs\\corp.pem",
			helixCommand: "helix auth token print -a",
		})

		expect(handler).toBeInstanceOf(VertexOpenAiHandler)
	})

	it("calls the Vertex OpenAI endpoint with PEM trust and the cached Helix token", async () => {
		mocks.create.mockResolvedValueOnce(
			createAsyncStream([
				{ choices: [{ delta: { content: "Grok response" } }] },
				{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
			]),
		)
		const handler = createHandler()
		const chunks = []

		for await (const chunk of handler.createMessage("system prompt", [])) {
			chunks.push(chunk)
		}

		expect(chunks).toEqual([
			{ type: "text", text: "Grok response" },
			expect.objectContaining({ type: "usage", inputTokens: 3, outputTokens: 4 }),
		])
		expect(mocks.configureTransport).toHaveBeenCalledWith("C:\\certs\\corp.pem")
		expect(mocks.getOrCreate).toHaveBeenCalledWith({
			helixCommand: "helix auth token print -a",
			helixParseMode: "raw_stdout",
			helixTokenKey: "access_token",
			refreshIntervalMinutes: 10,
		})
		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "https://vertex/v1/projects/pr71/locations/global/endpoints/openapi",
				apiKey: "cached-helix-token",
			}),
		)
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "xai/grok-4.6",
				temperature: 0,
				stream: true,
				messages: expect.arrayContaining([{ role: "system", content: "system prompt" }]),
			}),
			{},
		)
	})

	it("honors per-model project, location, model, and header routing", async () => {
		mocks.create.mockResolvedValueOnce(createAsyncStream([{ choices: [{ delta: { content: "routed" } }] }]))
		const handler = createHandler({
			modelRoutingMap: {
				"xai/grok-4.6": {
					projectId: "routed-project",
					location: "routed-location",
					modelOverride: "xai/internal-grok-4.6",
					extraHeaders: { "x-route": "grok" },
				},
			},
		})

		await handler.createMessage("system", []).next()

		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "https://vertex/v1/projects/routed-project/locations/routed-location/endpoints/openapi",
				defaultHeaders: expect.objectContaining({ "x-route": "grok" }),
			}),
		)
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: "xai/internal-grok-4.6" }), {})
	})

	it("forces one Helix refresh and retries an authentication failure", async () => {
		const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 })
		mocks.create
			.mockRejectedValueOnce(unauthorized)
			.mockResolvedValueOnce(createAsyncStream([{ choices: [{ delta: { content: "retried" } }] }]))
		const handler = createHandler()

		const firstChunk = await handler.createMessage("system", []).next()

		expect(firstChunk.value).toEqual({ type: "text", text: "retried" })
		expect(mocks.getToken).toHaveBeenCalledTimes(1)
		expect(mocks.forceRefreshToken).toHaveBeenCalledTimes(1)
		expect(mocks.create).toHaveBeenCalledTimes(2)
		expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "refreshed-helix-token" }))
	})

	it("supports non-streaming Vertex chat completions", async () => {
		mocks.create.mockResolvedValueOnce({
			choices: [{ message: { content: "non-streamed response" } }],
			usage: { prompt_tokens: 3, completion_tokens: 4 },
		})
		const handler = createHandler({ vertexStreamingEnabled: false })
		const chunks = []

		for await (const chunk of handler.createMessage("system", [])) {
			chunks.push(chunk)
		}

		expect(chunks).toEqual([
			{ type: "text", text: "non-streamed response" },
			expect.objectContaining({ type: "usage", inputTokens: 3, outputTokens: 4 }),
		])
		const [request] = mocks.create.mock.calls[0]
		expect(request).not.toHaveProperty("stream")
	})

	it("rejects incomplete, invalid, or malformed gateway settings", () => {
		expect(() => createHandler({ gatewayBaseUrl: undefined, vertexGatewayBaseUrl: undefined })).toThrow(
			"Missing required Vertex gateway settings: gatewayBaseUrl",
		)
		expect(() => createHandler({ gatewayBaseUrl: "not-a-url" })).toThrow("Invalid Vertex gatewayBaseUrl")
		expect(() => createHandler({ modelRoutingMap: "{not-json" })).toThrow("Invalid modelRoutingMap JSON")
	})

	it("supports the legacy Vertex gateway setting names", async () => {
		mocks.create.mockResolvedValueOnce(createAsyncStream([{ choices: [{ delta: { content: "legacy" } }] }]))
		const handler = new VertexOpenAiHandler({
			apiModelId: "xai/grok-4.6",
			vertexGatewayBaseUrl: "https://vertex/v1",
			vertexProjectId: "legacy-project",
			vertexRegion: "global",
			vertexGatewayCaBundlePath: "C:\\certs\\legacy.pem",
			vertexGatewayHelixCommand: "helix auth token print -a",
		})

		await handler.createMessage("system", []).next()

		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "https://vertex/v1/projects/legacy-project/locations/global/endpoints/openapi",
			}),
		)
		expect(mocks.configureTransport).toHaveBeenCalledWith("C:\\certs\\legacy.pem")
	})
})
