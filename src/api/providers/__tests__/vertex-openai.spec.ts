// npx vitest run src/api/providers/__tests__/vertex-openai.spec.ts

import OpenAI from "openai"

import { vertexModels } from "@alpha-code/types"

import { buildApiHandler } from "../../index"
import { isApiStreamAbortError } from "../../transform/stream"
import { AgentRetryPolicy } from "../../../core/agent/AgentRetryPolicy"
import { VertexOpenAiHandler } from "../vertex-openai"

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getToken: vi.fn(),
	forceRefreshToken: vi.fn(),
	getOrCreate: vi.fn(),
	configureTransport: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
	AzureOpenAI: vi.fn(function () {
		return { chat: { completions: { create: mocks.create } } }
	}),
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

	describe.each(["stream", "response", "single-prompt"])("%s error boundary", (surface) => {
		async function request(): Promise<void> {
			const handler = createHandler({ vertexStreamingEnabled: surface === "stream" })
			if (surface === "single-prompt") {
				await handler.completePrompt("hello")
				return
			}
			for await (const _chunk of handler.createMessage("system", [])) {
				// Consume all chunks so iteration failures reach the adapter boundary.
			}
		}

		it.each([429, 503])("preserves terminal retry authority and server advice for HTTP %s", async (status) => {
			const errorDetails = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "60s" }]
			mocks.create.mockRejectedValueOnce(
				Object.assign(new Error("OpenAI completion error: Opaque provider failure."), {
					name: "ProviderError",
					status,
					code: "provider_terminal",
					errorDetails,
					retryAfterMs: 60_000,
					retryable: false,
					retryCategory: "rate-limit",
				}),
			)

			await expect(request()).rejects.toMatchObject({
				message: "Vertex OpenAI-compatible completion error: Opaque provider failure.",
				name: "ProviderError",
				status,
				code: "provider_terminal",
				errorDetails,
				retryAfterMs: 60_000,
				retryable: false,
				retryCategory: "rate-limit",
			})
			expect(mocks.create).toHaveBeenCalledOnce()
			expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		})

		it("retains safe header advice for the owning retry policy", async () => {
			mocks.create.mockRejectedValueOnce(
				Object.assign(new Error("Opaque provider failure."), {
					status: 429,
					retryable: true,
					retryCategory: "rate-limit",
					headers: { "Retry-After": "60", authorization: "secret-header-fixture" },
				}),
			)
			const failure: unknown = await request().then(
				() => undefined,
				(error: unknown) => error,
			)

			expect(failure).toMatchObject({ retryable: true, retryCategory: "rate-limit", retryAfterMs: 60_000 })
			expect(failure).not.toHaveProperty("headers")
			expect(failure).not.toHaveProperty("error")
			if (
				!(failure instanceof Error) ||
				!("retryCategory" in failure) ||
				failure.retryCategory !== "rate-limit" ||
				!("retryAfterMs" in failure) ||
				typeof failure.retryAfterMs !== "number"
			) {
				throw new Error("Vertex discarded the retry classification or server delay")
			}
			expect(
				new AgentRetryPolicy({ jitter: "none", now: () => 1_000 }).decide({
					category: failure.retryCategory,
					attempt: 1,
					retryAfterMs: failure.retryAfterMs,
				}),
			).toMatchObject({ shouldRetry: true, category: "rate-limit", delayMs: 60_000, retryAt: 61_000 })
		})

		it("preserves opaque provider cancellation identity", async () => {
			mocks.create.mockRejectedValueOnce(Object.assign(new Error("Operation stopped"), { name: "AbortError" }))
			const failure: unknown = await request().then(
				() => undefined,
				(error: unknown) => error,
			)

			expect(failure).toMatchObject({ name: "AbortError" })
			expect(isApiStreamAbortError(failure)).toBe(true)
			expect(mocks.create).toHaveBeenCalledOnce()
			expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
		})
	})

	it("retains retry authority when a response iterator fails after visible output", async () => {
		mocks.create.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield { choices: [{ delta: { content: "partial answer" } }] }
				throw Object.assign(new Error("Opaque upstream failure."), {
					status: 503,
					retryable: false,
					retryCategory: "transport",
					retryAfterMs: 5_000,
				})
			},
		})
		const stream = createHandler().createMessage("system", [])

		await expect(stream.next()).resolves.toMatchObject({ value: { type: "text", text: "partial answer" } })
		await expect(stream.next()).rejects.toMatchObject({
			status: 503,
			retryable: false,
			retryCategory: "transport",
			retryAfterMs: 5_000,
		})
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(mocks.forceRefreshToken).not.toHaveBeenCalled()
	})

	it("exposes the Grok 4.6 Vertex catalog metadata", () => {
		const model = createHandler().getModel()

		expect(model).toMatchObject({
			id: "xai/grok-4.6",
			temperature: 0,
		})
		expect(model.info).toMatchObject({
			maxTokens: vertexModels["xai/grok-4.6"].maxTokens,
			contextWindow: vertexModels["xai/grok-4.6"].contextWindow,
			description: vertexModels["xai/grok-4.6"].description,
			includedTools: ["edit"],
		})
		expect(model.info.excludedTools ?? []).not.toContain("apply_diff")
	})

	it("keeps patch editing for a selected GPT model routed to an opaque model ID", () => {
		const handler = createHandler({
			apiModelId: "gpt-5.5",
			modelRoutingMap: {
				"gpt-5.5": { modelOverride: "provider-owned-route-id" },
			},
		})

		const model = handler.getModel()

		expect(model.id).toBe("provider-owned-route-id")
		expect(model.toolIdentity).toEqual({
			provider: "vertex",
			family: "gpt-5.5",
			id: "provider-owned-route-id",
		})
		expect(model.info.includedTools).toEqual(["apply_patch"])
		expect(model.info.excludedTools).toBeUndefined()
	})

	it("fails closed when recognized selected and routed model identities conflict", () => {
		const handler = createHandler({
			apiModelId: "gpt-5.5",
			modelRoutingMap: {
				"gpt-5.5": { modelOverride: "claude-opus-5" },
			},
		})

		const model = handler.getModel()

		expect(model.toolIdentity).toEqual({ provider: "vertex", family: "gpt-5.5", id: "claude-opus-5" })
		expect(model.info.includedTools ?? []).not.toContain("apply_patch")
		expect(model.info.includedTools ?? []).not.toContain("edit")
		expect(model.info.excludedTools ?? []).not.toContain("apply_patch")
		expect(model.info.excludedTools ?? []).not.toContain("edit")
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
		expect(handler.streamCapabilities?.cancellation).toBe(false)
		expect(handler.streamCapabilities?.lifecycle).toBe(true)
	})

	it("calls the Vertex OpenAI endpoint with PEM trust and the cached Helix token", async () => {
		mocks.create.mockResolvedValueOnce(
			createAsyncStream([
				{ choices: [{ delta: { content: "Grok response" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
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
			expect.objectContaining({ type: "outcome", status: "completed", terminal: true }),
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

	it("sends Grok reasoning effort on the routed wire model", async () => {
		mocks.create.mockResolvedValueOnce(createAsyncStream([{ choices: [{ delta: { content: "reasoned" } }] }]))
		const handler = createHandler({
			enableReasoningEffort: true,
			reasoningEffort: "high",
			modelRoutingMap: {
				"xai/grok-4.6": { modelOverride: "gateway-grok-4.6" },
			},
		})

		await handler.createMessage("system", []).next()

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gateway-grok-4.6", reasoning_effort: "high" }),
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

	it("supports non-streaming Vertex chat completions", async () => {
		mocks.create.mockResolvedValueOnce({
			choices: [{ message: { content: "non-streamed response" }, finish_reason: "stop" }],
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
			expect.objectContaining({ type: "outcome", status: "completed", terminal: true }),
		])
		const [request] = mocks.create.mock.calls[0]
		expect(request).not.toHaveProperty("stream")
	})

	it.each([true, false])(
		"honors sampling and server-default cap on the gateway with streaming=%s",
		async (streaming) => {
			mocks.create.mockResolvedValueOnce(
				streaming
					? createAsyncStream([{ choices: [{ delta: { content: "sampled" }, finish_reason: "stop" }] }])
					: { choices: [{ message: { content: "sampled" }, finish_reason: "stop" }] },
			)
			const handler = createHandler({
				vertexStreamingEnabled: streaming,
				modelTemperature: 0.4,
				includeMaxTokens: true,
				modelMaxTokens: -1,
				verbosity: "high",
				modelRoutingMap: { "xai/grok-4.6": { modelOverride: "gateway-model-id" } },
			})

			for await (const _chunk of handler.createMessage("system", [])) {
				// Consume the gateway response.
			}

			const [request] = mocks.create.mock.calls[0]
			expect(request).toMatchObject({ model: "gateway-model-id", temperature: 0.4 })
			expect(request).not.toHaveProperty("max_completion_tokens")
			expect(request).not.toHaveProperty("verbosity")
			expect(request).not.toHaveProperty("text.verbosity")
		},
	)

	it.each(["stream", "response", "single-prompt"])(
		"preserves saved sampling for an unknown partner model on %s",
		async (surface) => {
			mocks.create.mockResolvedValueOnce(
				surface === "stream"
					? createAsyncStream([{ choices: [{ delta: { content: "sampled" }, finish_reason: "stop" }] }])
					: { choices: [{ message: { content: "sampled" }, finish_reason: "stop" }] },
			)
			const handler = createHandler({
				apiModelId: "partner-future",
				vertexStreamingEnabled: surface === "stream",
				modelTemperature: 0.8,
			})
			if (surface === "single-prompt") {
				await handler.completePrompt("hello")
			} else {
				for await (const _chunk of handler.createMessage("system", [])) {
					// The compatible partner adapter retains its legacy sampling contract.
				}
			}
			expect(mocks.create.mock.calls[0][0]).toMatchObject({ model: "partner-future", temperature: 0.8 })
		},
	)

	it("omits explicitly unsupported sampling inherited from the selected catalog model", async () => {
		mocks.create.mockResolvedValueOnce(createAsyncStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]))
		const handler = createHandler({
			apiModelId: "claude-opus-5",
			modelTemperature: 0.4,
			modelRoutingMap: { "claude-opus-5": { modelOverride: "gateway-model-id" } },
		})

		for await (const _chunk of handler.createMessage("system", [])) {
			// This direct adapter test verifies its capability guard, independent of factory routing.
		}

		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("temperature")
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
