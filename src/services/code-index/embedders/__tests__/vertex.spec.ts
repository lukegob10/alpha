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

import { describe, it, expect, beforeEach, vitest } from "vitest"

import { VertexGeminiEmbedder } from "../vertex"

describe("VertexGeminiEmbedder", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
		mockGetToken.mockResolvedValue("initial-token")
		mockForceRefreshToken.mockResolvedValue("refreshed-token")
		mockGetOrCreate.mockReturnValue({
			getToken: mockGetToken,
			forceRefreshToken: mockForceRefreshToken,
		})
		mockConfigureTransport.mockResolvedValue("C:\\certs\\gateway.pem")
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

		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [
				{ values: [0.1, 0.2], statistics: { tokenCount: 4 } },
				{ values: [0.3, 0.4], statistics: { tokenCount: 5 } },
			],
		})

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
		expect(mockEmbedContent).toHaveBeenCalledTimes(1)
		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gemini-embedding-001",
			contents: ["first text", "second text"],
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
			contents: [textOverGemini001Limit],
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
		})
	})
})
