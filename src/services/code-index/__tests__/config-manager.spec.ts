import { beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { SECRET_STATE_KEYS } from "@alpha-code/types"
import type * as vscode from "vscode"

type StoredState = Record<string, unknown> | undefined

function createContextProxy(
	initial: StoredState,
	providerSettings?: Record<string, unknown>,
	secrets: Record<string, string> = {},
) {
	let state = initial
	return {
		getGlobalState: vi.fn(() => state),
		getProviderSettings: vi.fn(() => providerSettings),
		getSecret: vi.fn((key: string) => secrets[key] ?? ""),
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
	it.each([
		{ roots: 1, refreshSecrets: true },
		{ roots: 4, refreshSecrets: true },
		{ roots: 1, refreshSecrets: false },
		{ roots: 4, refreshSecrets: false },
	])("bounds startup reads ($roots roots, refresh=$refreshSecrets)", async ({ roots, refreshSecrets }) => {
		const persisted = new Map<string, unknown>([
			["codebaseIndexConfig", vertexConfig({ codebaseIndexEnabled: false })],
		])
		const secrets = new Map<string, string>([["codebaseIndexGeminiApiKey", "initial-index-secret"]])
		const getSecret = vi.fn(async (key: string) => secrets.get(key))
		const contextProxy = new ContextProxy({
			globalState: {
				get: (key: string) => persisted.get(key),
				update: async (key: string, value: unknown) => {
					if (value === undefined) persisted.delete(key)
					else persisted.set(key, value)
				},
			},
			secrets: {
				get: getSecret,
				store: async (key: string, value: string) => {
					secrets.set(key, value)
				},
			},
		} as unknown as vscode.ExtensionContext)
		await contextProxy.initialize()
		const hydrationReads = getSecret.mock.calls.length
		const refreshSecretsSpy = vi.spyOn(contextProxy, "refreshSecrets")
		const managers = Array.from({ length: roots }, () => new CodeIndexConfigManager(contextProxy))
		await Promise.all(managers.map((manager) => manager.loadConfiguration({ refreshSecrets })))
		const expectedHydrationReads = SECRET_STATE_KEYS.length + 1 // Custom headers retain their public setting shape.
		const expectedRefreshes = refreshSecrets ? roots : 0
		const expectedStartupReads = expectedHydrationReads * (expectedRefreshes + 1)
		expect(new Set(getSecret.mock.calls.map(([key]) => key))).toEqual(
			new Set([...SECRET_STATE_KEYS, "openAiHeaders"]),
		)

		expect({
			roots,
			hydrationReads,
			startupReads: getSecret.mock.calls.length,
			refreshes: refreshSecretsSpy.mock.calls.length,
		}).toEqual({
			roots,
			hydrationReads: expectedHydrationReads,
			startupReads: expectedStartupReads,
			refreshes: expectedRefreshes,
		})
		for (const manager of managers) expect(manager.isFeatureEnabled).toBe(false)

		secrets.set("codebaseIndexGeminiApiKey", "rotated-index-secret")
		persisted.set("vertexJsonCredentials", "legacy-chat-secret")
		await managers[0].loadConfiguration()
		expect(refreshSecretsSpy).toHaveBeenCalledTimes(expectedRefreshes + 1)
		expect(getSecret).toHaveBeenCalledTimes(expectedStartupReads + expectedHydrationReads)
		expect(contextProxy.getSecret("codebaseIndexGeminiApiKey")).toBe("rotated-index-secret")
		expect(managers[0].getConfig().geminiApiKey).toBe("rotated-index-secret")
		expect(secrets.get("vertexJsonCredentials")).toBe("legacy-chat-secret")
		expect(persisted.has("vertexJsonCredentials")).toBe(false)
	})

	it("refreshes an uninitialized proxy even when snapshot reuse was requested", async () => {
		const context = createContextProxy(vertexConfig())
		const manager = new CodeIndexConfigManager(context as unknown as ContextProxy)

		await manager.loadConfiguration({ refreshSecrets: false })

		expect(context.refreshSecrets).toHaveBeenCalledOnce()
	})

	it("normalizes old result limits and applies search-only changes without restarting the index", async () => {
		const context = createContextProxy(vertexConfig({ codebaseIndexSearchMaxResults: 200 }))
		const manager = new CodeIndexConfigManager(context as any)
		expect(manager.currentSearchMaxResults).toBe(100)
		context.setState(vertexConfig({ codebaseIndexSearchMaxResults: 20, codebaseIndexSearchMinScore: 0.7 }))
		const loaded = await manager.loadConfiguration()
		expect(loaded.requiresRestart).toBe(false)
		expect(manager.currentSearchMaxResults).toBe(20)
		expect(manager.currentSearchMinScore).toBe(0.7)
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

	it("loads Gemini only with its dedicated indexing secret", () => {
		const config = vertexConfig({ codebaseIndexEmbedderProvider: "gemini" })
		const chat = { apiProvider: "gemini", geminiApiKey: "chat-secret" }
		const missing = new CodeIndexConfigManager(createContextProxy(config, chat) as any)
		expect(missing.isFeatureConfigured).toBe(false)
		expect(missing.configurationError).toBeTruthy()
		const context = createContextProxy(config, chat, { codebaseIndexGeminiApiKey: "index-secret" })
		const configured = new CodeIndexConfigManager(context as any)
		expect(configured.isFeatureConfigured).toBe(true)
		expect(configured.legacyProvider).toBeUndefined()
		expect(configured.currentEmbedderProvider).toBe("gemini")
		expect(configured.currentModelDimension).toBe(3072)
		expect(configured.getConfig().geminiApiKey).toBe("index-secret")
	})

	it("restarts on Gemini provider, model, and secret changes, but ignores Vertex edits", async () => {
		const secrets = { codebaseIndexGeminiApiKey: "first" }
		const context = createContextProxy(vertexConfig(), undefined, secrets)
		const manager = new CodeIndexConfigManager(context as any)
		const gemini = vertexConfig({ codebaseIndexEmbedderProvider: "gemini" })
		context.setState(gemini)
		expect((await manager.loadConfiguration()).requiresRestart).toBe(true)
		context.setState({ ...gemini, codebaseIndexVertexProjectId: "unrelated-project" })
		expect((await manager.loadConfiguration()).requiresRestart).toBe(false)
		context.setState({ ...gemini, codebaseIndexEmbedderModelId: "gemini-embedding-2" })
		expect((await manager.loadConfiguration()).requiresRestart).toBe(true)
		secrets.codebaseIndexGeminiApiKey = "rotated"
		expect((await manager.loadConfiguration()).requiresRestart).toBe(true)
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
