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
		cleanupTerminal: vi.fn(),
		getContextProxy: vi.fn().mockResolvedValue(provider.contextProxy),
		loadEnvironment: vi.fn().mockResolvedValue(undefined),
		initializeNetworkProxy: vi.fn().mockResolvedValue(undefined),
		autoImportSettings: vi.fn().mockResolvedValue(undefined),
		providerConstructed: vi.fn(),
		startMemory: vi.fn(),
		constructApi: vi.fn(),
		initializeScheduledTasks: vi.fn().mockResolvedValue(undefined),
		disposeScheduledTasks: vi.fn().mockResolvedValue(undefined),
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
		return { initialize: mocks.initializeScheduledTasks, dispose: mocks.disposeScheduledTasks }
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
	return {
		registerCommands: mocks.registerCommands,
		registerEditorChatSerializer: vi.fn(),
	}
})
vi.mock("../../i18n", () => ({ initializeI18n: vi.fn() }))

import type * as vscode from "vscode"
import { commands, window, workspace } from "vscode"
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
		expect(secrets.onDidChange).toHaveBeenCalledOnce()
		const secretListener = secrets.onDidChange.mock.results[0].value
		expect(secretListener.dispose).not.toHaveBeenCalled()
		await expect(auth?.getStatus()).resolves.toMatchObject({ connected: false, connecting: false, accounts: [] })
		const deactivating = deactivate()
		// VS Code disposes the subscriptions while asynchronous deactivation is still in flight.
		await Promise.all(context.subscriptions.map((subscription) => subscription.dispose()))
		await deactivating
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

	it("rolls back services and registrations when activation fails after the import", async () => {
		mocks.workspaceFolders = [{ uri: { fsPath: "/worktree" } }]
		const initializationError = new Error("API initialization failed")
		const existing = { dispose: vi.fn() }
		const command = { dispose: vi.fn() }
		const failingRegistration = { dispose: vi.fn().mockRejectedValue(new Error("SECRET disposal error")) }
		const secrets = createSecretStorage()
		mocks.registerCommands.mockImplementationOnce((options: { context: vscode.ExtensionContext }) => {
			options.context.subscriptions.push(command, failingRegistration)
		})
		mocks.providerConstructed.mockImplementationOnce((ready: Promise<void> = Promise.resolve()) => {
			void ready.then(() => mocks.startMemory()).catch(() => undefined)
		})
		mocks.constructApi.mockImplementationOnce(() => {
			throw initializationError
		})
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets,
			globalState: {
				get: vi.fn((key: string) => (key === "worktreeAutoOpenPath" ? "/worktree" : undefined)),
				update: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [existing],
		} as unknown as vscode.ExtensionContext
		await expect(activate(context)).rejects.toBe(initializationError)
		expect(mocks.startMemory).not.toHaveBeenCalled()
		expect(command.dispose).toHaveBeenCalledOnce()
		expect(failingRegistration.dispose).toHaveBeenCalledOnce()
		expect(mocks.disposeScheduledTasks).toHaveBeenCalledOnce()
		expect(secrets.onDidChange.mock.results[0].value.dispose).toHaveBeenCalledOnce()
		expect(ChatGptAuthService.tryGetInstance()).toBeUndefined()
		expect(mocks.disposeProviders).toHaveBeenCalledOnce()
		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledWith(context)
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
		expect(mocks.outputChannel.dispose).toHaveBeenCalledOnce()
		expect(mocks.disposeScheduledTasks.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.disposeProviders.mock.invocationCallOrder[0],
		)
		expect(mocks.cleanupTerminal.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.outputChannel.dispose.mock.invocationCallOrder[0],
		)
		expect(context.subscriptions).toEqual([existing])
		expect(existing.dispose).not.toHaveBeenCalled()
		expect(JSON.stringify(mocks.outputChannel.appendLine.mock.calls)).not.toContain("SECRET")
		expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
		expect(commands.executeCommand).not.toHaveBeenCalled()
	})

	it("releases listeners when provider configuration fails before a task provider exists", async () => {
		const error = new Error("Context initialization failed")
		mocks.getContextProxy.mockRejectedValueOnce(error)
		const secrets = createSecretStorage()
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets,
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		await expect(activate(context)).rejects.toBe(error)
		expect(mocks.providerConstructed).not.toHaveBeenCalled()
		expect(secrets.onDidChange.mock.results[0].value.dispose).toHaveBeenCalledOnce()
		expect(ChatGptAuthService.tryGetInstance()).toBeUndefined()
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
		expect(context.subscriptions).toEqual([])
	})

	it.each([false, true])(
		"opens the worktree sidebar outside the activation join (superseded: %s)",
		async (superseded) => {
			vi.useFakeTimers()
			let finishImport!: () => void
			let startImport!: () => void
			const importStarted = new Promise<void>((resolve) => (startImport = resolve))
			mocks.autoImportSettings.mockImplementationOnce(() => {
				startImport()
				return new Promise<void>((resolve) => (finishImport = resolve))
			})
			mocks.workspaceFolders = [{ uri: { fsPath: "/worktree" } }]
			let worktreeAutoOpenPath = "/worktree"
			const context = {
				extensionPath: "/extension",
				extensionUri: {},
				globalStorageUri: { fsPath: "/storage" },
				secrets: createSecretStorage(),
				globalState: {
					get: vi.fn((key: string) => (key === "worktreeAutoOpenPath" ? worktreeAutoOpenPath : undefined)),
					update: vi.fn().mockResolvedValue(undefined),
				},
				subscriptions: [],
			} as unknown as vscode.ExtensionContext
			let finishDispatch!: () => void
			const dispatch = new Promise<void>((resolve) => (finishDispatch = resolve))
			await vi.mocked(commands.executeCommand).withImplementation(
				async (command) => {
					if (command === "alpha.plusButtonClicked") {
						expect(mocks.registerCommands).toHaveBeenCalledOnce()
						expect(mocks.constructApi).toHaveBeenCalledOnce()
						await dispatch
					}
				},
				async () => {
					const activating = activate(context)
					try {
						await importStarted
						expect(commands.executeCommand).not.toHaveBeenCalled()
						finishImport()
						await activating
						expect(commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked", "sidebar")
						expect(context.globalState.update).not.toHaveBeenCalled()
						if (superseded) worktreeAutoOpenPath = "/next-worktree"
						finishDispatch()
						await dispatch
						await Promise.resolve()
						if (superseded) expect(context.globalState.update).not.toHaveBeenCalled()
						else expect(context.globalState.update).toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
					} finally {
						finishImport()
						finishDispatch()
						await activating
						await deactivate()
					}
				},
			)
		},
	)

	it("retains the worktree marker when the sidebar command rejects", async () => {
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
		await vi.mocked(commands.executeCommand).withImplementation(
			async (command) => {
				if (command === "alpha.plusButtonClicked") throw new Error("Sidebar unavailable")
			},
			async () => {
				try {
					await activate(context)
					expect(commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked", "sidebar")
					expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
				} finally {
					await deactivate()
				}
			},
		)
	})

	it("uses native case and separator rules to match the pending worktree", async () => {
		const isWindows = process.platform === "win32"
		const currentPath = isWindows ? "C:\\Worktrees\\Feature\\" : "/worktrees/Feature"
		const pendingPath = isWindows ? "c:/worktrees/feature" : "/worktrees/feature"
		mocks.workspaceFolders = [{ uri: { fsPath: currentPath } }]
		const update = vi.fn().mockResolvedValue(undefined)
		const context = {
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: {
				get: vi.fn((key: string) => (key === "worktreeAutoOpenPath" ? pendingPath : undefined)),
				update,
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		try {
			await activate(context)
			await Promise.resolve()
			if (isWindows) {
				expect(update).toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
				expect(commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked", "sidebar")
			} else {
				expect(update).not.toHaveBeenCalled()
				expect(commands.executeCommand).not.toHaveBeenCalledWith("alpha.plusButtonClicked", "sidebar")
			}
		} finally {
			await deactivate()
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

	it("does not copy inherited command rules into extension-global storage on activation", async () => {
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

		await vi.mocked(workspace.getConfiguration).withImplementation(
			() =>
				({
					get: vi.fn((key: string) => (key === "allowedCommands" ? ["git status"] : undefined)),
				}) as unknown as vscode.WorkspaceConfiguration,
			async () => {
				try {
					await activate(context)
					expect(mocks.getContextProxy).toHaveBeenCalledWith(context)
					expect(context.globalState.update).not.toHaveBeenCalledWith("allowedCommands", expect.anything())
				} finally {
					await deactivate()
				}
			},
		)
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
		expect(deactivate()).toBe(deactivating)

		await vi.waitFor(() => expect(mocks.provider.dispose).toHaveBeenCalledOnce())
		expect(mocks.disposeProviders).toHaveBeenCalledOnce()
		expect(mocks.shutdownGlobalStores).not.toHaveBeenCalled()

		finishProviderDisposal()
		await deactivating

		expect(mocks.shutdownGlobalStores).toHaveBeenCalledOnce()
		expect(mocks.cleanupMcp).toHaveBeenCalledWith(context)
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})

	it("keeps shared services running until an editor provider finishes cleanup", async () => {
		let finishEditor!: () => void
		const editorCleanup = new Promise<void>((resolve) => (finishEditor = resolve))
		mocks.disposeProviders.mockImplementationOnce(async () => {
			await Promise.all([mocks.provider.dispose(), editorCleanup])
		})
		await activate({
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext)
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
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
	})
	it("finishes other cleanup after MCP shutdown rejects without logging raw errors", async () => {
		mocks.cleanupMcp.mockRejectedValueOnce(new Error("SECRET-shutdown-error"))
		await activate({
			extensionPath: "/extension",
			extensionUri: {},
			globalStorageUri: { fsPath: "/storage" },
			secrets: createSecretStorage(),
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext)
		await expect(deactivate()).resolves.toBeUndefined()
		expect(mocks.cleanupTerminal).toHaveBeenCalledOnce()
		expect(JSON.stringify(mocks.outputChannel.appendLine.mock.calls)).not.toContain("SECRET")
	})
})
