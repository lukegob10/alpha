const mocks = vi.hoisted(() => {
	const outputChannel = {
		appendLine: vi.fn(),
		dispose: vi.fn(),
	}
	const provider = {
		contextProxy: {
			extensionUri: {},
		},
		providerSettingsManager: {},
		customModesManager: {},
		setScheduledTaskService: vi.fn(),
		setGoalSeekService: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	}

	return {
		outputChannel,
		provider,
		shutdownGlobalStores: vi.fn().mockResolvedValue(undefined),
		cleanupMcp: vi.fn().mockResolvedValue(undefined),
		shutdownTelemetry: vi.fn(),
		cleanupTerminal: vi.fn(),
		getContextProxy: vi.fn().mockResolvedValue(provider.contextProxy),
	}
})

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => mocks.outputChannel),
		registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
		registerUriHandler: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => []) })),
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	env: { language: "en" },
}))

vi.mock("fs", () => ({ existsSync: vi.fn(() => false) }))
vi.mock("@dotenvx/dotenvx", () => ({ config: vi.fn() }))
vi.mock("@alpha-code/core", () => ({ customToolRegistry: { setExtensionPath: vi.fn() } }))
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		createInstance: vi.fn(),
		instance: {
			setProvider: vi.fn(),
			shutdown: mocks.shutdownTelemetry,
		},
	},
}))
vi.mock("../../utils/networkProxy", () => ({ initializeNetworkProxy: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../shared/package", () => ({ Package: { name: "alpha", outputChannel: "Alpha" } }))
vi.mock("../../shared/language", () => ({ formatLanguage: vi.fn((language) => language) }))
vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: { getInstance: mocks.getContextProxy },
}))
vi.mock("../../core/agent/AgentControlStore", () => ({
	AgentControlStore: { shutdownGlobalStores: mocks.shutdownGlobalStores },
}))
vi.mock("../../core/webview/ClineProvider", () => {
	const ClineProvider = vi.fn(() => mocks.provider)
	Object.assign(ClineProvider, { sideBarId: "alpha.SidebarProvider" })
	return { ClineProvider }
})
vi.mock("../../integrations/editor/DiffViewProvider", () => ({ DIFF_VIEW_URI_SCHEME: "alpha-diff" }))
vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { initialize: vi.fn(), cleanup: mocks.cleanupTerminal },
}))
vi.mock("../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { initialize: vi.fn() },
}))
vi.mock("../../services/mcp/McpServerManager", () => ({
	McpServerManager: { cleanup: mocks.cleanupMcp },
}))
vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: vi.fn() },
}))
vi.mock("../../services/scheduled-tasks", () => ({
	ScheduledTaskService: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined) })),
}))
vi.mock("../../services/goal-seek", () => ({
	GoalSeekService: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined) })),
}))
vi.mock("../../utils/migrateSettings", () => ({ migrateSettings: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../utils/autoImportSettings", () => ({ autoImportSettings: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../api", () => ({ API: vi.fn() }))
vi.mock("../../activate", () => {
	const CodeActionProvider = vi.fn()
	Object.assign(CodeActionProvider, { providedCodeActionKinds: [] })
	return {
		handleUri: vi.fn(),
		registerCommands: vi.fn(),
		registerCodeActions: vi.fn(),
		registerTerminalActions: vi.fn(),
		CodeActionProvider,
	}
})
vi.mock("../../i18n", () => ({ initializeI18n: vi.fn() }))
vi.mock("../../api/providers/fetchers/modelCache", () => ({
	initializeModelCacheRefresh: vi.fn().mockResolvedValue(undefined),
}))

import type * as vscode from "vscode"
import { activate, deactivate } from "../../extension"

describe("extension lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("persists the default command policy before initializing provider state", async () => {
		let finishGlobalStateUpdate!: () => void
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			globalState: {
				get: vi.fn(),
				update: vi.fn(() => new Promise<void>((resolve) => (finishGlobalStateUpdate = resolve))),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		const activating = activate(context)
		await vi.waitFor(() => expect(context.globalState.update).toHaveBeenCalledWith("allowedCommands", []))
		expect(mocks.getContextProxy).not.toHaveBeenCalled()

		finishGlobalStateUpdate()
		await activating
		expect(mocks.getContextProxy).toHaveBeenCalledWith(context)
		await deactivate()
	})

	it("awaits sidebar provider disposal before shutting down global services", async () => {
		let finishProviderDisposal!: () => void
		mocks.provider.dispose.mockImplementationOnce(
			() => new Promise<void>((resolve) => (finishProviderDisposal = resolve)),
		)
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			globalState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		await activate(context)
		const deactivating = deactivate()

		await vi.waitFor(() => expect(mocks.provider.dispose).toHaveBeenCalledOnce())
		expect(mocks.shutdownGlobalStores).not.toHaveBeenCalled()

		finishProviderDisposal()
		await deactivating

		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledWith(context)
		expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce()
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})
})
