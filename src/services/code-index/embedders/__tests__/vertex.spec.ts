const { mockGoogleGenAI, mockEmbedContent } = vitest.hoisted(() => ({
	mockEmbedContent: vitest.fn(),
	mockGoogleGenAI: vitest.fn(() => ({
		models: {
			embedContent: mockEmbedContent,
		},
	})),
}))

vitest.mock("@google/genai", () => ({
	GoogleGenAI: mockGoogleGenAI,
}))

vitest.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

import { describe, it, expect, beforeEach, afterAll, vitest } from "vitest"

import { resetVertexGatewayCaBundleForTests } from "../../../../api/providers/vertex-gateway"
import { VertexGeminiEmbedder } from "../vertex"

describe("VertexGeminiEmbedder", () => {
	const originalUsername = process.env.USERNAME
	const originalUser = process.env.USER

	beforeEach(() => {
		vitest.clearAllMocks()
		resetVertexGatewayCaBundleForTests()
		restoreEnv("USERNAME", originalUsername)
		restoreEnv("USER", originalUser)
	})

	afterAll(() => {
		resetVertexGatewayCaBundleForTests()
		restoreEnv("USERNAME", originalUsername)
		restoreEnv("USER", originalUser)
	})

	it("initializes GoogleGenAI with Vertex gateway options", () => {
		process.env.USERNAME = "soe123"

		new VertexGeminiEmbedder(
			{
				apiProvider: "vertex",
				vertexProjectId: "test-project",
				vertexRegion: "global",
				vertexGatewayBaseUrl: "https://gateway.example.com/vertex",
				vertexGatewayHelixCommand: "helix auth access-token print -a",
			} as any,
			"gemini-embedding-001",
		)

		expect(mockGoogleGenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				vertexai: true,
				project: "test-project",
				location: "global",
				httpOptions: {
					baseUrl: "https://gateway.example.com/vertex",
					headers: { "x-r2d2-soeid": "soe123" },
				},
				googleAuthOptions: {
					authClient: expect.objectContaining({
						refreshHandler: expect.any(Function),
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
			.mockResolvedValueOnce({
				embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 4 } }],
			})
			.mockResolvedValueOnce({
				embeddings: [{ values: [0.3, 0.4], statistics: { tokenCount: 5 } }],
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
		expect(mockEmbedContent).toHaveBeenNthCalledWith(1, {
			model: "gemini-embedding-001",
			contents: "first text",
		})
		expect(mockEmbedContent).toHaveBeenNthCalledWith(2, {
			model: "gemini-embedding-001",
			contents: "second text",
		})
	})

	it("routes model IDs through the Vertex gateway routing map", async () => {
		const embedder = new VertexGeminiEmbedder({
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			vertexGatewayModelRoutingMap: '{"gemini-embedding-001":"gateway-embedding-model"}',
		} as any)
		mockEmbedContent.mockResolvedValueOnce({
			embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 2 } }],
		})

		await embedder.createEmbeddings(["text"])

		expect(mockEmbedContent).toHaveBeenCalledWith({
			model: "gateway-embedding-model",
			contents: "text",
		})
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
			contents: textOverGemini001Limit,
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
			contents: "test",
		})
	})
})

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name]
		return
	}

	process.env[name] = value
}
