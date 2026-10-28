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
		createTask: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
	}

	return {
		outputChannel,
		provider,
		disposeProviders: vi.fn(async () => provider.dispose()),
		shutdownGlobalStores: vi.fn().mockResolvedValue(undefined),
		cleanupMcp: vi.fn().mockResolvedValue(undefined),
		shutdownTelemetry: vi.fn(),
		cleanupTerminal: vi.fn(),
		getContextProxy: vi.fn().mockResolvedValue(provider.contextProxy),
		loadEnvironment: vi.fn().mockResolvedValue(undefined),
		initializeNetworkProxy: vi.fn().mockResolvedValue(undefined),
		autoImportSettings: vi.fn().mockResolvedValue(undefined),
		providerConstructed: vi.fn(),
		startMemory: vi.fn(),
		constructApi: vi.fn(),
		initializeScheduledTasks: vi.fn().mockResolvedValue(undefined),
		getCodeIndexManager: vi.fn(),
		registerCommands: vi.fn(),
		workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string } }>,
		registerUriHandler: vi.fn((_handler: { handleUri: (uri: unknown) => unknown }) => ({
			dispose: vi.fn(),
		})),
	}
})

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => mocks.outputChannel),
		registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
		registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
		registerUriHandler: mocks.registerUriHandler,
	},
	workspace: {
		get workspaceFolders() {
			return mocks.workspaceFolders
		},
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => []) })),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
		registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: { language: "en" },
}))

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
vi.mock("../../utils/networkProxy", () => ({ initializeNetworkProxy: mocks.initializeNetworkProxy }))
vi.mock("../../utils/loadEnvironment", () => ({ loadExtensionEnvironment: mocks.loadEnvironment }))
vi.mock("../../shared/package", () => ({ Package: { name: "alpha", outputChannel: "Alpha" } }))
vi.mock("../../shared/language", () => ({ formatLanguage: vi.fn((language) => language) }))
vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: { getInstance: mocks.getContextProxy },
}))
vi.mock("../../core/agent/AgentControlStore", () => ({
	AgentControlStore: { shutdownGlobalStores: mocks.shutdownGlobalStores },
}))
vi.mock("../../core/webview/AlphaProvider", () => {
	const AlphaProvider = vi.fn(function (...args: unknown[]) {
		mocks.providerConstructed(args[4])
		return mocks.provider
	})
	Object.assign(AlphaProvider, { sideBarId: "alpha.SidebarProvider", disposeAll: mocks.disposeProviders })
	return { AlphaProvider }
})
vi.mock("../../integrations/editor/DiffViewProvider", () => ({ DIFF_VIEW_URI_SCHEME: "alpha-diff" }))
vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { initialize: vi.fn(), cleanup: mocks.cleanupTerminal },
}))
vi.mock("../../services/mcp/McpServerManager", () => ({
	McpServerManager: { cleanup: mocks.cleanupMcp },
}))
vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: mocks.getCodeIndexManager },
}))
vi.mock("../../services/scheduled-tasks", () => ({
	ScheduledTaskService: vi.fn(function () {
		return { initialize: mocks.initializeScheduledTasks }
	}),
}))
vi.mock("../../services/tickets/TicketPanel", () => ({
	TicketPanel: vi.fn(function () {
		return { dispose: vi.fn() }
	}),
}))
vi.mock("../../utils/migrateSettings", () => ({ migrateSettings: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../utils/autoImportSettings", () => ({ autoImportSettings: mocks.autoImportSettings }))
vi.mock("../api", () => ({
	API: vi.fn(function () {
		mocks.constructApi()
	}),
}))
vi.mock("../../activate", () => {
	const CodeActionProvider = vi.fn()
	Object.assign(CodeActionProvider, { providedCodeActionKinds: [] })
	return {
		registerCommands: mocks.registerCommands,
		registerEditorChatSerializer: vi.fn(),
		registerCodeActions: vi.fn(),
		registerTerminalActions: vi.fn(),
		CodeActionProvider,
	}
})
vi.mock("../../i18n", () => ({ initializeI18n: vi.fn() }))

import type * as vscode from "vscode"
import { commands, window } from "vscode"
import { activate, deactivate } from "../../extension"
import { ChatGptAuthService } from "../../services/chatgpt/ChatGptAuthService"

function createSecretStorage() {
	const values = new Map<string, string>()
	const listeners = new Set<(event: vscode.SecretStorageChangeEvent) => unknown>()
	const emit = (key: string) => {
		for (const listener of listeners) listener({ key })
	}
	return {
		keys: vi.fn(async () => [...values.keys()]),
		get: vi.fn(async (key: string) => values.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			if (values.get(key) === value) return
			values.set(key, value)
			emit(key)
		}),
		delete: vi.fn(async (key: string) => {
			if (values.delete(key)) emit(key)
		}),
		onDidChange: vi.fn(
			(
				listener: (event: vscode.SecretStorageChangeEvent) => unknown,
				thisArgs?: unknown,
				disposables?: vscode.Disposable[],
			) => {
				const boundListener = listener.bind(thisArgs)
				listeners.add(boundListener)
				const subscription = { dispose: vi.fn(() => listeners.delete(boundListener)) }
				disposables?.push(subscription)
				return subscription
			},
		),
	} satisfies vscode.SecretStorage
}

describe("extension lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.workspaceFolders = undefined
	})

	afterEach(async () => {
		await ChatGptAuthService.tryGetInstance()?.dispose()
		vi.useRealTimers()
	})

	it("owns the ChatGPT secret listener and releases the auth singleton on deactivation", async () => {
		const secrets = createSecretStorage()
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets,
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		await activate(context)
		const auth = ChatGptAuthService.tryGetInstance()
		expect(auth).toBeDefined()
		expect(context.subscriptions).toContain(auth)
		expect(secrets.onDidChange).toHaveBeenCalledOnce()
		const secretListener = secrets.onDidChange.mock.results[0].value
		expect(secretListener.dispose).not.toHaveBeenCalled()
		await expect(auth?.getStatus()).resolves.toMatchObject({ connected: false, connecting: false, accounts: [] })
		await deactivate()
		expect(secretListener.dispose).toHaveBeenCalledOnce()
		expect(ChatGptAuthService.tryGetInstance()).toBeUndefined()
	})

	it.each(["success", "failure"])(
		"settles startup configuration before task surfaces and schedules are admitted (%s)",
		async (outcome) => {
			let settleImport!: () => void
			let startImport!: () => void
			const importStarted = new Promise<void>((resolve) => (startImport = resolve))
			mocks.autoImportSettings.mockImplementationOnce(() => {
				startImport()
				return new Promise<void>((resolve, reject) => {
					settleImport = () => {
						if (outcome === "failure") reject(new Error("Import unavailable"))
						else resolve()
					}
				})
			})
			mocks.providerConstructed.mockImplementationOnce((ready: Promise<void> = Promise.resolve()) => {
				void ready.then(() => mocks.startMemory()).catch(() => undefined)
			})
			mocks.initializeScheduledTasks.mockImplementationOnce(async () => {
				await mocks.provider.createTask("scheduled task")
			})
			vi.mocked(window.registerWebviewViewProvider).mockImplementationOnce(() => {
				void mocks.provider.createTask("restored sidebar task")
				return { dispose: vi.fn() }
			})
			const initializeIndex = vi.fn().mockResolvedValue({ requiresRestart: false })
			mocks.getCodeIndexManager.mockReturnValueOnce({ initialize: initializeIndex, dispose: vi.fn() })
			mocks.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]
			const context = {
				extensionPath: "/extension",
				extensionUri: {},
				globalStorageUri: { fsPath: "/storage" },
				secrets: createSecretStorage(),
				globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
				subscriptions: [],
			} as unknown as vscode.ExtensionContext
			const activating = activate(context)
			try {
				await importStarted
				expect(mocks.startMemory).not.toHaveBeenCalled()
				expect(mocks.provider.createTask).not.toHaveBeenCalled()
				expect(mocks.initializeScheduledTasks).not.toHaveBeenCalled()
				expect(window.registerWebviewViewProvider).not.toHaveBeenCalled()
				expect(mocks.registerCommands).not.toHaveBeenCalled()
				expect(initializeIndex).not.toHaveBeenCalled()

				settleImport()
				await activating
				expect(mocks.startMemory).toHaveBeenCalledOnce()
				expect(mocks.initializeScheduledTasks).toHaveBeenCalledOnce()
				expect(window.registerWebviewViewProvider).toHaveBeenCalledOnce()
				expect(mocks.registerCommands).toHaveBeenCalledOnce()
				expect(mocks.provider.createTask).toHaveBeenCalledWith("scheduled task")
				expect(mocks.provider.createTask).toHaveBeenCalledWith("restored sidebar task")
				expect(initializeIndex).toHaveBeenCalledWith(mocks.provider.contextProxy, { refreshSecrets: false })
			} finally {
				settleImport()
				await activating
				await deactivate()
			}
		},
	)

	it("does not start constructor memory work when activation fails after the import", async () => {
		mocks.providerConstructed.mockImplementationOnce((ready: Promise<void> = Promise.resolve()) => {
			void ready.then(() => mocks.startMemory()).catch(() => undefined)
		})
		mocks.constructApi.mockImplementationOnce(() => {
			throw new Error("API initialization failed")
		})
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		try {
			await expect(activate(context)).rejects.toThrow("API initialization failed")
			expect(mocks.startMemory).not.toHaveBeenCalled()
		} finally {
			await deactivate()
		}
	})

	it("waits for command registration before auto-opening a switched worktree", async () => {
		vi.useFakeTimers()
		let finishImport!: () => void
		let startImport!: () => void
		const importStarted = new Promise<void>((resolve) => (startImport = resolve))
		mocks.autoImportSettings.mockImplementationOnce(() => {
			startImport()
			return new Promise<void>((resolve) => (finishImport = resolve))
		})
		mocks.workspaceFolders = [{ uri: { fsPath: "/worktree" } }]
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: {
				get: vi.fn((key: string) => (key === "worktreeAutoOpenPath" ? "/worktree" : undefined)),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		const activating = activate(context)
		try {
			await importStarted
			await vi.advanceTimersByTimeAsync(500)
			expect(commands.executeCommand).not.toHaveBeenCalledWith("alpha.plusButtonClicked")
			finishImport()
			await activating
			expect(mocks.registerCommands).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(500)
			expect(commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked")
		} finally {
			finishImport()
			await activating
			await deactivate()
			vi.useRealTimers()
		}
	})

	it("cancels delayed worktree auto-open when the extension subscriptions are disposed", async () => {
		vi.useFakeTimers()
		mocks.workspaceFolders = [{ uri: { fsPath: "/worktree" } }]
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: {
				get: vi.fn((key: string) => (key === "worktreeAutoOpenPath" ? "/worktree" : undefined)),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		try {
			await activate(context)
			for (const subscription of context.subscriptions) {
				if (typeof subscription.dispose === "function") subscription.dispose()
			}
			await vi.advanceTimersByTimeAsync(500)
			expect(commands.executeCommand).not.toHaveBeenCalledWith("alpha.plusButtonClicked")
		} finally {
			await deactivate()
			vi.useRealTimers()
		}
	})

	it("loads the optional environment before network and provider initialization", async () => {
		let finishEnvironment!: () => void
		mocks.loadEnvironment.mockImplementationOnce(
			() => new Promise<void>((resolve) => (finishEnvironment = resolve)),
		)
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		const activating = activate(context)
		expect(mocks.loadEnvironment).toHaveBeenCalledOnce()
		expect(mocks.initializeNetworkProxy).not.toHaveBeenCalled()
		expect(mocks.getContextProxy).not.toHaveBeenCalled()

		finishEnvironment()
		await activating
		expect(mocks.initializeNetworkProxy).toHaveBeenCalledWith(context, expect.anything())
		expect(mocks.getContextProxy).toHaveBeenCalledWith(context)
		await deactivate()
	})

	it("persists the default command policy before initializing provider state", async () => {
		let finishGlobalStateUpdate!: () => void
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
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

	it("does not register retired provider OAuth callbacks", async () => {
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: {
				get: vi.fn((key: string) => (key === "allowedCommands" ? [] : undefined)),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		await activate(context)
		expect(mocks.registerUriHandler).not.toHaveBeenCalled()
		await deactivate()
	})

	it("awaits every task provider's disposal before shutting down global services", async () => {
		let finishProviderDisposal!: () => void
		mocks.provider.dispose.mockImplementationOnce(
			() => new Promise<void>((resolve) => (finishProviderDisposal = resolve)),
		)
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		await activate(context)
		const deactivating = deactivate()

		await vi.waitFor(() => expect(mocks.provider.dispose).toHaveBeenCalledOnce())
		expect(mocks.disposeProviders).toHaveBeenCalledOnce()
		expect(mocks.shutdownGlobalStores).not.toHaveBeenCalled()

		finishProviderDisposal()
		await deactivating

		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledWith(context)
		expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce()
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})

	it("keeps shared services running until an editor provider finishes cleanup", async () => {
		let finishEditor!: () => void
		const editorCleanup = new Promise<void>((resolve) => (finishEditor = resolve))
		mocks.disposeProviders.mockImplementationOnce(async () => {
			await Promise.all([mocks.provider.dispose(), editorCleanup])
		})
		const deactivating = deactivate()
		try {
			await Promise.resolve()
			expect(mocks.disposeProviders).toHaveBeenCalledOnce()
			expect(mocks.shutdownGlobalStores).not.toHaveBeenCalled()
			expect(mocks.cleanupMcp).not.toHaveBeenCalled()
		} finally {
			finishEditor()
			await deactivating
		}
		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledOnce()
	})

	it("finishes cleanup when the host has already closed its output channel", async () => {
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		await activate(context)
		mocks.outputChannel.appendLine.mockImplementationOnce(() => {
			throw new Error("Channel has been closed")
		})
		await expect(deactivate()).resolves.toBeUndefined()
		expect(mocks.provider.dispose).toHaveBeenCalledOnce()
		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledWith(context)
		expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce()
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})
	it("awaits telemetry shutdown before completing deactivation", async () => {
		let finish!: () => void
		let started!: () => void
		const shutdownStarted = new Promise<void>((resolve) => (started = resolve))
		mocks.shutdownTelemetry.mockImplementationOnce(() => {
			started()
			return new Promise<void>((resolve) => (finish = resolve))
		})
		let settled = false
		const deactivating = deactivate().then(() => {
			settled = true
		})
		try {
			await shutdownStarted
			expect(settled).toBe(false)
			expect(mocks.cleanupTerminal).not.toHaveBeenCalled()
		} finally {
			finish()
			await deactivating
		}
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})
	it.each(["telemetry", "mcp"])(
		"finishes other cleanup after %s shutdown rejects without logging raw errors",
		async (client) => {
			const shutdown = client === "telemetry" ? mocks.shutdownTelemetry : mocks.cleanupMcp
			shutdown.mockRejectedValueOnce(new Error("SECRET-shutdown-error"))
			await expect(deactivate()).resolves.toBeUndefined()
			expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce()
			expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
			expect(JSON.stringify(mocks.outputChannel.appendLine.mock.calls)).not.toContain("SECRET")
		},
	)
})
