const {
	mockGoogleGenAI,
	mockEmbedContent,
	mockGetOrCreate,
	mockGetToken,
	mockForceRefreshToken,
	mockConfigureTransport,
} = vitest.hoisted(() => {
	const mockEmbedContent = vitest.fn()

	return {
		mockEmbedContent,
		mockGoogleGenAI: vitest.fn(() => ({
			models: {
				embedContent: mockEmbedContent,
			},
		})),
		mockGetToken: vitest.fn(),
		mockForceRefreshToken: vitest.fn(),
		mockGetOrCreate: vitest.fn(),
		mockConfigureTransport: vitest.fn(),
	}
})

vitest.mock("@google/genai", () => ({
	GoogleGenAI: mockGoogleGenAI,
}))

vitest.mock("../../../../api/providers/utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: mockGetOrCreate,
	},
}))

vitest.mock("../../../../api/providers/utils/vertex-gateway-transport", () => ({
	configureVertexGatewayTransport: mockConfigureTransport,
}))

vitest.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

import { describe, it, expect, beforeEach, afterEach, vitest } from "vitest"

import { VertexGeminiEmbedder } from "../vertex"

describe("VertexGeminiEmbedder", () => {
	beforeEach(() => {
		vitest.resetAllMocks()
		mockGetToken.mockResolvedValue("initial-token")
		mockForceRefreshToken.mockResolvedValue("refreshed-token")
		mockGetOrCreate.mockReturnValue({
			getToken: mockGetToken,
			forceRefreshToken: mockForceRefreshToken,
		})
		mockConfigureTransport.mockResolvedValue("C:\\certs\\gateway.pem")
	})

	afterEach(() => vitest.useRealTimers())

	it.each(["gemini-embedding-001", "gemini-embedding-2"])("spaces %s requests across batches, queries, and retries", async (model) => {
		vitest.useFakeTimers()
		vitest.setSystemTime(new Date("2026-09-12T12:00:00Z"))
		const startedAt: number[] = []
		const embedder = new VertexGeminiEmbedder(
			{
				apiProvider: "vertex",
				projectId: "project",
				location: "global",
				gatewayBaseUrl: "https://gateway.example.com/vertex",
				pemCaBundlePath: "test.pem",
				helixCommand: "test-token-command",
			},
			model,
			1,
		)
		mockEmbedContent.mockImplementation(async () => {
			startedAt.push(Date.now())
			if (startedAt.length === 1) throw Object.assign(new Error("Unauthorized"), { status: 401 })
			if (startedAt.length === 2) throw Object.assign(new Error("Rate limited"), { status: 429 })
			return { embeddings: [{ values: [1, 0] }] }
		})
		const responses = Promise.all([
			embedder.createEmbeddings(["first", "second"]),
			embedder.createEmbeddings(["query"], undefined, "query"),
		])
		await vitest.runAllTimersAsync()
		await responses
		// The 429 at one second retains the provider's five-second fallback backoff.
		expect(startedAt.map((time) => time - startedAt[0])).toEqual([0, 1000, 2000, 3000, 6000])
		expect(mockForceRefreshToken).toHaveBeenCalledOnce()
	})

	it("initializes GoogleGenAI with canonical Vertex gateway options and fake auth", () => {
		new VertexGeminiEmbedder(
			{
				apiProvider: "vertex",
				projectId: "test-project",
				location: "global",
				gatewayBaseUrl: "https://gateway.example.com/vertex",
				pemCaBundlePath: "C:\\certs\\gateway.pem",
				helixCommand: "helix auth access-token print -a",
				helixParseMode: "json_field",
				helixTokenKey: "token.access",
				refreshIntervalMinutes: 15,
			} as any,
			"gemini-embedding-001",
		)

		expect(mockGetOrCreate).toHaveBeenCalledWith({
			helixCommand: "helix auth access-token print -a",
			helixParseMode: "json_field",
			helixTokenKey: "token.access",
			refreshIntervalMinutes: 15,
		})
		expect(mockGoogleGenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				vertexai: true,
				project: "test-project",
				location: "global",
				httpOptions: {
					baseUrl: "https://gateway.example.com/vertex",
				},
				googleAuthOptions: {
					authClient: expect.objectContaining({
						getRequestHeaders: expect.any(Function),
					}),
				},
			}),
		)
	})

	it("returns ordered vectors for multiple texts", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		} as any)

		mockEmbedContent
			.mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 4 } }] })
			.mockResolvedValueOnce({ embeddings: [{ values: [0.3, 0.4], statistics: { tokenCount: 5 } }] })

		const response = await embedder.createEmbeddings(["first text", "second text"])

		expect(response).toEqual({
			embeddings: [
				[0.1, 0.2],
				[0.3, 0.4],
			],
			usage: {
				promptTokens: 9,
				totalTokens: 9,
			},
		})
		expect(mockEmbedContent).toHaveBeenCalledTimes(2)
		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gemini-embedding-001",
			contents: ["first text"],
			config: { taskType: "RETRIEVAL_DOCUMENT" },
		})
	})

	it("sends bearer auth, routed model, project, location, and extra headers through the gateway", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			projectId: "default-project",
			location: "global",
			gatewayBaseUrl: "https://gateway.example.com/vertex",
			pemCaBundlePath: "C:\\certs\\gateway.pem",
			helixCommand: "helix auth access-token print -a",
			modelRoutingMap: {
				"gemini-embedding-001": {
					projectId: "routed-project",
					location: "us-central1",
					modelOverride: "gateway-embedding-model",
					extraHeaders: {
						"x-route": "embedding",
					},
				},
			},
		} as any)
		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2 } }],
		})

		await embedder.createEmbeddings(["text"])

		expect(mockConfigureTransport).toHaveBeenCalledWith("C:\\certs\\gateway.pem")
		expect(mockGoogleGenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "routed-project",
				location: "us-central1",
			}),
		)
		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gateway-embedding-model",
			contents: ["text"],
			config: {
				httpOptions: {
					baseUrl: "https://gateway.example.com/vertex",
					headers: {
						Authorization: "Bearer initial-token",
						"x-route": "embedding",
					},
				},
			},
		})
	})

	it("treats legacy string routing entries as model overrides", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			vertexGatewayBaseUrl: "https://gateway.example.com/vertex",
			vertexGatewayCaBundlePath: "C:\\certs\\gateway.pem",
			vertexGatewayHelixCommand: "helix auth access-token print -a",
			vertexGatewayModelRoutingMap: '{"gemini-embedding-001":"gateway-embedding-model"}',
		} as any)
		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2 } }],
		})

		await embedder.createEmbeddings(["text"])

		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gateway-embedding-model",
			contents: ["text"],
			config: {
				httpOptions: {
					baseUrl: "https://gateway.example.com/vertex",
					headers: {
						Authorization: "Bearer initial-token",
					},
				},
			},
		})
	})

	it("retries once with a forced Helix refresh after gateway auth failure", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			projectId: "test-project",
			location: "global",
			gatewayBaseUrl: "https://gateway.example.com/vertex",
			pemCaBundlePath: "C:\\certs\\gateway.pem",
			helixCommand: "helix auth access-token print -a",
		} as any)
		mockGetToken.mockResolvedValueOnce("expired-token").mockResolvedValueOnce("refreshed-token")
		mockEmbedContent
			.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }))
			.mockResolvedValueOnce({
				embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2 } }],
			})

		const response = await embedder.createEmbeddings(["text"])

		expect(response.embeddings).toEqual([[0.1, 0.2]])
		expect(mockForceRefreshToken).toHaveBeenCalledTimes(1)
		expect(mockEmbedContent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				config: expect.objectContaining({
					httpOptions: expect.objectContaining({
						headers: expect.objectContaining({ Authorization: "Bearer expired-token" }),
					}),
				}),
			}),
		)
		expect(mockEmbedContent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				config: expect.objectContaining({
					httpOptions: expect.objectContaining({
						headers: expect.objectContaining({ Authorization: "Bearer refreshed-token" }),
					}),
				}),
			}),
		)
	})

	it("retries rate-limited batch requests instead of failing after one attempt", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		} as any)
		mockEmbedContent
			.mockRejectedValueOnce(
				Object.assign(new Error("Rate limit exceeded"), {
					status: 429,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce({
				embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2 } }],
			})

		const response = await embedder.createEmbeddings(["text"])

		expect(response.embeddings).toEqual([[0.1, 0.2]])
		expect(mockEmbedContent).toHaveBeenCalledTimes(2)
	})

	it("uses the larger item token limit for gemini-embedding-2", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "global",
		} as any)
		const textOverGemini001Limit = "a".repeat(2049 * 4)
		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2049 } }],
		})

		const response = await embedder.createEmbeddings([textOverGemini001Limit], "gemini-embedding-2")

		expect(response.embeddings).toEqual([[0.1, 0.2]])
		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gemini-embedding-2",
			contents: [{ parts: [{ text: "title: none | text: " + textOverGemini001Limit }] }],
			config: {},
		})
	})

	it("validates configuration with a small embedding probe", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
		} as any)
		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 1 } }],
		})

		await expect(embedder.validateConfiguration()).resolves.toEqual({ valid: true })
		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gemini-embedding-001",
			contents: ["test"],
			config: { taskType: "RETRIEVAL_DOCUMENT" },
		})
	})
	it.each([
		{ model: "gemini-embedding-001", concurrency: 8 },
		{ model: "gemini-embedding-2", concurrency: 16 },
	])("refills $model request slots before slower requests finish and preserves result order", async ({ model, concurrency }) => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "project",
			vertexRegion: "global",
		}, model)
		let firstStarted!: () => void
		let secondStarted!: () => void
		let slotRefilled!: () => void
		const first = new Promise<void>((resolve) => {
			firstStarted = resolve
		})
		const second = new Promise<void>((resolve) => {
			secondStarted = resolve
		})
		const refilled = new Promise<void>((resolve) => {
			slotRefilled = resolve
		})
		const pending: Array<() => void> = []
		mockEmbedContent.mockImplementation(
			({ contents }) =>
				new Promise((resolve) => {
					expect(contents).toHaveLength(1)
					const text = typeof contents[0] === "string" ? contents[0] : contents[0].parts[0].text
					const index = Number(text.match(/\d+$/)?.[0])
					pending.push(() => resolve({ embeddings: [{ values: [index, 1] }] }))
					if (pending.length === concurrency) firstStarted()
					if (pending.length === concurrency + 1) slotRefilled()
					if (pending.length === concurrency * 2) secondStarted()
				}),
		)
		const response = embedder.createEmbeddings(Array.from({ length: concurrency * 2 }, (_, index) => String(index)))
		await first
		expect(mockEmbedContent).toHaveBeenCalledTimes(concurrency)
		pending[concurrency - 1]()
		await refilled
		expect(mockEmbedContent).toHaveBeenCalledTimes(concurrency + 1)
		pending
			.slice(0, concurrency - 1)
			.reverse()
			.forEach((resolve) => resolve())
		await second
		pending
			.slice(concurrency)
			.reverse()
			.forEach((resolve) => resolve())
		expect((await response).embeddings).toEqual(Array.from({ length: concurrency * 2 }, (_, index) => [index, 1]))
	})

	it.each([
		{ model: "gemini-embedding-001", concurrency: 8 },
		{ model: "gemini-embedding-2", concurrency: 16 },
	])("drains accepted $model requests and stops scheduling more work after a failure", async ({ model, concurrency }) => {
		vitest.useFakeTimers()
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			projectId: "project",
			location: "global",
		}, model)
		let completed = 0
		mockEmbedContent.mockImplementation(async ({ contents }) => {
			const text = typeof contents[0] === "string" ? contents[0] : contents[0].parts[0].text
			if (text.match(/\d+$/)?.[0] === "0") throw Object.assign(new Error("Invalid input"), { status: 400 })
			await new Promise((resolve) => setTimeout(resolve, 100))
			completed++
			return { embeddings: [{ values: [1, 0] }] }
		})
		let settled = false
		const response = embedder.createEmbeddings(Array.from({ length: concurrency * 3 }, (_, index) => String(index)))
		const rejection = expect(response).rejects.toThrow()
		void response.catch(() => {
			settled = true
		})
		await vitest.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vitest.runAllTimersAsync()
		await rejection
		expect(completed).toBe(concurrency - 1)
		expect(mockEmbedContent).toHaveBeenCalledTimes(concurrency)
	})

	it.each([
		{ model: "gemini-embedding-001", concurrency: 8 },
		{ model: "gemini-embedding-2", concurrency: 16 },
	])("shares the $model request bound across indexing batches and queries", async ({ model, concurrency }) => {
		vitest.useFakeTimers()
		const embedder = new VertexGeminiEmbedder({ apiProvider: "vertex", projectId: "project", location: "global" }, model)
		let active = 0
		let maxActive = 0
		mockEmbedContent.mockImplementation(async () => {
			maxActive = Math.max(maxActive, ++active)
			await new Promise((resolve) => setTimeout(resolve, 100))
			active--
			return { embeddings: [{ values: [1, 0], statistics: { tokenCount: 3 } }] }
		})
		const texts = Array.from({ length: 40 }, (_, index) => String(index))
		const responses = Promise.all([
			embedder.createEmbeddings(texts),
			embedder.createEmbeddings(texts),
			embedder.createEmbeddings(["query"], undefined, "query"),
		])
		await vitest.runAllTimersAsync()
		const results = await responses
		expect(maxActive).toBe(concurrency)
		expect(active).toBe(0)
		expect(results.map((result) => result.embeddings.length)).toEqual([40, 40, 1])
		expect(results.map((result) => result.usage?.totalTokens)).toEqual([120, 120, 3])
		expect(mockEmbedContent).toHaveBeenCalledTimes(81)
	})
})
