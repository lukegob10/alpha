import { beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexServiceFactory } from "../service-factory"
import { VertexGeminiEmbedder } from "../embedders/vertex"
import { LanceDbVectorStore } from "../vector-store/lancedb-client"
import { QdrantVectorStore } from "../vector-store/qdrant-client"
import { getDefaultModelId, getModelDimension } from "../../../shared/embeddingModels"

vi.mock("../embedders/vertex", () => ({ VertexGeminiEmbedder: vi.fn() }))
vi.mock("../vector-store/lancedb-client", () => ({ LanceDbVectorStore: vi.fn() }))
vi.mock("../vector-store/qdrant-client", () => ({ QdrantVectorStore: vi.fn() }))
vi.mock("../../../shared/embeddingModels", () => ({
	getDefaultModelId: vi.fn(() => "gemini-embedding-001"),
	getModelDimension: vi.fn(() => 3072),
}))
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

describe("CodeIndexServiceFactory", () => {
	let factory: CodeIndexServiceFactory
	let configManager: {
		getConfig: ReturnType<typeof vi.fn>
		isFeatureConfigured: boolean
		configurationError?: string
	}
	const cacheManager = {}

	beforeEach(() => {
		vi.clearAllMocks()
		configManager = {
			getConfig: vi.fn(),
			isFeatureConfigured: true,
		}
		factory = new CodeIndexServiceFactory(configManager as any, "/workspace", cacheManager as any)
	})

	it("creates the Vertex embedder with the selected model and rate limit", () => {
		const vertexOptions = { apiProvider: "vertex", projectId: "project", location: "global" }
		configManager.getConfig.mockReturnValue({
			isConfigured: true,
			embedderProvider: "vertex",
			modelId: "gemini-embedding-2",
			vertexOptions,
			embeddingRateLimitSeconds: 0.5,
		})

		factory.createEmbedder()

		expect(VertexGeminiEmbedder).toHaveBeenCalledWith(vertexOptions, "gemini-embedding-2", 0.5)
	})

	it("does not fall back to Vertex when a legacy provider is loaded", () => {
		configManager.isFeatureConfigured = false
		configManager.configurationError = "unsupported provider: openai"
		configManager.getConfig.mockReturnValue({
			isConfigured: false,
			embedderProvider: "vertex",
			vertexOptions: { apiProvider: "vertex", projectId: "project", location: "global" },
		})

		expect(() => factory.createEmbedder()).toThrow("unsupported provider: openai")
		expect(VertexGeminiEmbedder).not.toHaveBeenCalled()
	})

	it("creates a local vector store with the model profile dimension", () => {
		configManager.getConfig.mockReturnValue({
			isConfigured: true,
			embedderProvider: "vertex",
			modelId: "gemini-embedding-001",
			vertexOptions: { apiProvider: "vertex", projectId: "project", location: "global" },
			vectorStoreProvider: "lancedb",
			localIndexPath: ".alpha/code-index/lancedb",
		})

		factory.createVectorStore()

		expect(getDefaultModelId).toHaveBeenCalledWith("vertex")
		expect(getModelDimension).toHaveBeenCalledWith("vertex", "gemini-embedding-001")
		expect(LanceDbVectorStore).toHaveBeenCalledWith(
			"/workspace",
			".alpha/code-index/lancedb",
			3072,
			expect.any(String),
		)
	})

	it("creates a Qdrant vector store when configured", () => {
		configManager.getConfig.mockReturnValue({
			isConfigured: true,
			embedderProvider: "vertex",
			modelId: "gemini-embedding-001",
			vertexOptions: { apiProvider: "vertex", projectId: "project", location: "global" },
			vectorStoreProvider: "qdrant",
			qdrantUrl: "http://localhost:6333",
			qdrantApiKey: "secret",
		})

		factory.createVectorStore()

		expect(QdrantVectorStore).toHaveBeenCalledWith(
			"/workspace",
			"http://localhost:6333",
			3072,
			"secret",
			expect.any(String),
		)
	})

	it("rejects an unknown model without a dimension override", () => {
		vi.mocked(getModelDimension).mockReturnValue(undefined)
		configManager.getConfig.mockReturnValue({
			isConfigured: true,
			embedderProvider: "vertex",
			modelId: "custom-model",
			vertexOptions: { apiProvider: "vertex", projectId: "project", location: "global" },
			vectorStoreProvider: "lancedb",
			localIndexPath: ".alpha/code-index/lancedb",
		})

		expect(() => factory.createVectorStore()).toThrow("vectorDimensionNotDetermined")
	})
})
