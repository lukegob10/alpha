// npx vitest run src/api/providers/__tests__/stellar.spec.ts

import OpenAI from "openai"

import { stellarDefaultModelId, stellarModels } from "@alpha-code/types"

import { DEFAULT_STELLAR_HELIX_COMMAND, StellarHandler } from "../stellar"

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
	configurePemCaTransport: mocks.configureTransport,
}))

const createAsyncStream = (chunks: unknown[]) => ({
	async *[Symbol.asyncIterator]() {
		for (const chunk of chunks) {
			yield chunk
		}
	},
})

describe("StellarHandler", () => {
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

	const createHandler = (overrides: ConstructorParameters<typeof StellarHandler>[0] = {}) =>
		new StellarHandler({
			stellarBaseUrl: "https://gateway.example.com/stellar/v1",
			stellarPemCaBundlePath: "C:\\certs\\corp.pem",
			...overrides,
		})

	it("uses the sample model as the default and preserves custom internal model IDs", () => {
		const defaultHandler = createHandler()
		expect(defaultHandler.getModel()).toMatchObject({
			id: stellarDefaultModelId,
			info: stellarModels[stellarDefaultModelId],
		})

		const customHandler = createHandler({ apiModelId: "internal-model-v2" })
		expect(customHandler.getModel()).toMatchObject({
			id: "internal-model-v2",
			info: stellarModels[stellarDefaultModelId],
		})
	})

	it("configures the PEM transport and supplies the cached Helix token to the OpenAI client", async () => {
		mocks.create.mockResolvedValueOnce(
			createAsyncStream([{ choices: [{ delta: { content: "Stellar response" } }] }]),
		)
		const handler = createHandler()

		const firstChunk = await handler.createMessage("system prompt", []).next()

		expect(firstChunk.value).toEqual({ type: "text", text: "Stellar response" })
		expect(mocks.configureTransport).toHaveBeenCalledWith("C:\\certs\\corp.pem", "Stellar")
		expect(mocks.getOrCreate).toHaveBeenCalledWith({
			helixCommand: DEFAULT_STELLAR_HELIX_COMMAND,
			helixParseMode: "raw_stdout",
			helixTokenKey: "access_token",
			refreshIntervalMinutes: 10,
		})
		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "https://gateway.example.com/stellar/v1",
				apiKey: "cached-helix-token",
			}),
		)
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: stellarDefaultModelId,
				temperature: 0.7,
				stream: true,
				messages: expect.arrayContaining([{ role: "system", content: "system prompt" }]),
			}),
			{},
		)
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

	it("supports non-streaming chat completions", async () => {
		mocks.create.mockResolvedValueOnce({
			choices: [{ message: { content: "non-streamed response" } }],
			usage: { prompt_tokens: 3, completion_tokens: 4 },
		})
		const handler = createHandler({ stellarStreamingEnabled: false })
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

	it("rejects incomplete or invalid endpoint settings before making a request", () => {
		expect(() => new StellarHandler({ stellarPemCaBundlePath: "C:\\certs\\corp.pem" })).toThrow(
			"Missing required Stellar setting: stellarBaseUrl",
		)
		expect(
			() =>
				new StellarHandler({
					stellarBaseUrl: "not-a-url",
					stellarPemCaBundlePath: "C:\\certs\\corp.pem",
				}),
		).toThrow("Invalid Stellar base URL")
	})
})
