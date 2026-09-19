import { beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"

type StoredState = Record<string, unknown> | undefined

function createContextProxy(initial: StoredState, providerSettings?: Record<string, unknown>) {
	let state = initial
	return {
		getGlobalState: vi.fn(() => state),
		getProviderSettings: vi.fn(() => providerSettings),
		getSecret: vi.fn((key: string) => {
			if (key === "codeIndexQdrantApiKey") return ""
			if (key === "codebaseIndexVertexJsonCredentials") return ""
			return ""
		}),
		refreshSecrets: vi.fn(async () => undefined),
		setState(next: StoredState) {
			state = next
		},
	}
}

function vertexConfig(overrides: Record<string, unknown> = {}) {
	return {
		codebaseIndexEnabled: true,
		codebaseIndexVectorStoreProvider: "lancedb",
		codebaseIndexLocalIndexPath: ".alpha/code-index/lancedb",
		codebaseIndexEmbedderProvider: "vertex",
		codebaseIndexEmbedderModelId: "gemini-embedding-001",
		codebaseIndexVertexProjectId: "project",
		codebaseIndexVertexRegion: "global",
		...overrides,
	}
}

describe("CodeIndexConfigManager", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("loads a configured Vertex AI embedder", async () => {
		const context = createContextProxy(vertexConfig())
		const manager = new CodeIndexConfigManager(context as any)

		expect(manager.isFeatureEnabled).toBe(true)
		expect(manager.isFeatureConfigured).toBe(true)
		expect(manager.currentEmbedderProvider).toBe("vertex")
		expect(manager.currentModelId).toBe("gemini-embedding-001")
		expect(manager.currentModelDimension).toBe(3072)
		expect(manager.currentSearchMinScore).toBe(0.4)
		expect(manager.configurationError).toBeUndefined()

		const loaded = await manager.loadConfiguration()
		expect(loaded.currentConfig.embedderProvider).toBe("vertex")
		expect(loaded.currentConfig.vertexOptions).toMatchObject({
			apiProvider: "vertex",
			projectId: "project",
			location: "global",
		})
	})

	it("keeps a legacy provider readable but deterministically disables indexing", () => {
		const context = createContextProxy(vertexConfig({ codebaseIndexEmbedderProvider: "openai" }))
		const manager = new CodeIndexConfigManager(context as any)

		expect(manager.legacyProvider).toBe("openai")
		expect(manager.currentEmbedderProvider).toBe("vertex")
		expect(manager.isFeatureConfigured).toBe(false)
		expect(manager.configurationError).toBeTruthy()
	})

	it("does not treat a missing provider in a persisted config as Vertex", () => {
		const context = createContextProxy(vertexConfig({ codebaseIndexEmbedderProvider: undefined }))
		const manager = new CodeIndexConfigManager(context as any)

		expect(manager.legacyProvider).toBe("<missing>")
		expect(manager.isFeatureConfigured).toBe(false)
		expect(manager.configurationError).toBeTruthy()
	})

	it("uses active Vertex chat settings when code-index fields are empty", () => {
		const context = createContextProxy(
			vertexConfig({
				codebaseIndexVertexProjectId: "",
				codebaseIndexVertexRegion: "",
			}),
			{
				apiProvider: "vertex",
				projectId: "chat-project",
				location: "us-central1",
			},
		)
		const manager = new CodeIndexConfigManager(context as any)

		expect(manager.isFeatureConfigured).toBe(true)
		expect(manager.getConfig().vertexOptions).toMatchObject({
			projectId: "chat-project",
			location: "us-central1",
		})
	})

	it("requires a restart when the Vertex model changes even if dimensions match", async () => {
		const context = createContextProxy(vertexConfig())
		const manager = new CodeIndexConfigManager(context as any)
		const first = await manager.loadConfiguration()
		expect(first.requiresRestart).toBe(false)

		context.setState(vertexConfig({ codebaseIndexEmbedderModelId: "gemini-embedding-2" }))
		const second = await manager.loadConfiguration()
		expect(second.requiresRestart).toBe(true)
	})

	it("requires a restart when a legacy provider is replaced by Vertex", async () => {
		const context = createContextProxy(vertexConfig({ codebaseIndexEmbedderProvider: "openai" }))
		const manager = new CodeIndexConfigManager(context as any)
		const first = await manager.loadConfiguration()
		expect(first.requiresRestart).toBe(false)

		context.setState(vertexConfig())
		const second = await manager.loadConfiguration()
		expect(second.requiresRestart).toBe(true)
		expect(manager.isFeatureConfigured).toBe(true)
	})

	it("uses a manual dimension for an unknown Vertex model", () => {
		const context = createContextProxy(
			vertexConfig({
				codebaseIndexEmbedderModelId: "custom-vertex-model",
				codebaseIndexEmbedderModelDimension: 1024,
			}),
		)
		const manager = new CodeIndexConfigManager(context as any)

		expect(manager.currentModelDimension).toBe(1024)
	})
})
