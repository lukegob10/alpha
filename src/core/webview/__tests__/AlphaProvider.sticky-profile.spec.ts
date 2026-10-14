// npx vitest run core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts

import * as vscode from "vscode"
import { TelemetryService } from "@alpha-code/telemetry"
import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { ContextProxy } from "../../config/ContextProxy"
import { Task } from "../../task/Task"
import type { HistoryItem, WebviewMessage } from "@alpha-code/types"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({
			dispose: vi.fn(),
		})),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

// Create a counter for unique task IDs.
let taskIdCounter = 0

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options) {
		return {
			taskId: options.taskId || `test-task-id-${++taskIdCounter}`,
			apiConfiguration: options.apiConfiguration,
			saveAlphaMessages: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteAlphaMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			emit: vi.fn(),
			parentTask: options.parentTask,
			updateApiConfiguration: vi.fn(function (this: any, providerSettings: any) {
				this.apiConfiguration = providerSettings
			}),
			setTaskApiConfigName: vi.fn(function (this: any, name: string | undefined) {
				this._taskApiConfigName = name
				this.taskApiConfigName = name
			}),
			getTaskApiConfigName: vi.fn(async function (this: any) {
				return this._taskApiConfigName
			}),
			_taskApiConfigName: options.historyItem?.apiConfigName,
			taskApiConfigName: options.historyItem?.apiConfigName,
		}
	}),
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{
			slug: "code",
			name: "Code Mode",
			roleDefinition: "You are a code assistant",
			groups: ["read", "edit"],
		},
		{
			slug: "architect",
			name: "Architect Mode",
			roleDefinition: "You are an architect",
			groups: ["read", "edit"],
		},
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", () => {
	const transactionFiles = new Map<string, string>()
	const transactionDirectories = new Set<string>()
	return {
		mkdir: vi.fn().mockImplementation(async (filePath: string) => {
			if (filePath.includes(".transaction.lock")) transactionDirectories.add(filePath)
		}),
		writeFile: vi.fn().mockImplementation(async (filePath: string, data: unknown) => {
			if (filePath.includes(".transaction.lock")) transactionFiles.set(filePath, String(data))
		}),
		readFile: vi.fn().mockImplementation((filePath: string) => {
			if (transactionFiles.has(filePath)) return Promise.resolve(transactionFiles.get(filePath))
			if (filePath.includes(".transaction.lock")) {
				return Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" }))
			}
			return filePath.endsWith("agent_control.json")
				? Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" }))
				: Promise.resolve("")
		}),
		readdir: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockImplementation(async (filePath: string) => {
			if (!transactionDirectories.has(filePath)) {
				throw Object.assign(new Error("not found"), { code: "ENOENT" })
			}
			return { isDirectory: () => true }
		}),
		rename: vi.fn().mockImplementation(async (sourcePath: string, destinationPath: string) => {
			if (transactionDirectories.has(destinationPath)) {
				throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" })
			}
			if (!transactionDirectories.delete(sourcePath)) {
				throw Object.assign(new Error("not found"), { code: "ENOENT" })
			}
			transactionDirectories.add(destinationPath)
			for (const [filePath, data] of [...transactionFiles]) {
				if (!filePath.startsWith(sourcePath)) continue
				transactionFiles.delete(filePath)
				transactionFiles.set(`${destinationPath}${filePath.slice(sourcePath.length)}`, data)
			}
		}),
		unlink: vi.fn().mockImplementation(async (filePath: string) => {
			transactionFiles.delete(filePath)
		}),
		rmdir: vi.fn().mockImplementation(async (filePath: string) => {
			transactionDirectories.delete(filePath)
		}),
		access: vi.fn().mockResolvedValue(undefined),
		rm: vi.fn().mockResolvedValue(undefined),
	}
})

vi.mock("proper-lockfile", () => ({
	lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
	check: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
			}
		},
	},
}))

let storageFixtureCounter = 0

describe("AlphaProvider - Sticky Provider Profile", () => {
	let provider: AlphaProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: any
	let originalRooCliRuntimeEnv: string | undefined

	beforeEach(async () => {
		vi.clearAllMocks()
		// Provider-profile tests mock storage; the OS mutex requires a real host
		// filesystem, exercised separately by persistence and extension tests.
		vi.spyOn(AgentControlStore, "forGlobalStorage").mockImplementation(
			() => new AgentControlStore(new InMemoryAgentControlPersistence()),
		)
		taskIdCounter = 0
		originalRooCliRuntimeEnv = process.env.ROO_CLI_RUNTIME
		delete process.env.ROO_CLI_RUNTIME

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "default-profile",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: {} as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: `/test/sticky-profile/storage-${++storageFixtureCounter}`,
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
			onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		} as unknown as vscode.WebviewView

		provider = new AlphaProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		await (provider as any).taskHistoryStoreReady

		// Mock getMcpHub method
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	afterEach(() => {
		vi.mocked(AgentControlStore.forGlobalStorage).mockRestore()
		if (originalRooCliRuntimeEnv === undefined) {
			delete process.env.ROO_CLI_RUNTIME
		} else {
			process.env.ROO_CLI_RUNTIME = originalRooCliRuntimeEnv
		}
	})

	describe("renameProviderProfile", () => {
		const savedSettings = {
			apiProvider: "openai" as const,
			openAiBaseUrl: "https://saved.example/v1",
			openAiApiKey: "saved-test-key",
			openAiModelId: "saved-model",
		}
		const history = (id: string, apiConfigName = "saved"): HistoryItem => ({
			id,
			number: 1,
			ts: 1,
			task: "Keep task profile identity",
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0,
			apiConfigName,
		})
		const taskFixture = (taskId: string, initialName = "saved") => {
			let name: string | undefined = initialName
			return {
				taskId,
				apiConfiguration: savedSettings,
				api: { identity: taskId },
				get taskApiConfigName() {
					return name
				},
				getTaskApiConfigName: vi.fn(async () => name),
				setTaskApiConfigName: vi.fn((value: string | undefined) => {
					name = value
				}),
				updateApiConfiguration: vi.fn(),
				abortTask: vi.fn().mockResolvedValue(undefined),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
			}
		}
		const patchStoredNames = async (owner: AlphaProvider, oldName: string, newName: string) => {
			const changed: HistoryItem[] = []
			if (oldName === newName) return changed
			for (const item of owner.taskHistoryStore.getAll()) {
				if (item.apiConfigName !== oldName) continue
				const updated = { ...item, apiConfigName: newName }
				await owner.taskHistoryStore.upsert(updated)
				changed.push(updated)
			}
			return changed
		}
		const createSibling = async () => {
			const peerProxy = new ContextProxy(mockContext)
			await peerProxy.initialize()
			const peer = new AlphaProvider(mockContext, mockOutputChannel, "editor", peerProxy)
			await (peer as any).taskHistoryStoreReady
			vi.spyOn(peer, "postStateToWebview").mockResolvedValue(undefined)
			vi.spyOn(peer.taskHistoryStore, "renameProviderProfile").mockImplementation((oldName, newName) =>
				patchStoredNames(peer, oldName, newName),
			)
			return peer
		}
		let patchHistory: (oldName: string, newName: string) => Promise<HistoryItem[]>

		beforeEach(async () => {
			await provider.providerSettingsManager.initialize()
			await provider.providerSettingsManager.saveConfig("saved", { id: "saved-id", ...savedSettings })
			await provider.providerSettingsManager.saveConfig("other", {
				id: "other-id",
				apiProvider: "vscode-lm",
			})
			await provider.providerSettingsManager.activateProfile({ id: "saved-id" })
			await provider.providerSettingsManager.setModeConfig("code", "saved-id")
			await provider.contextProxy.setProviderSettings(savedSettings)
			await provider.contextProxy.setValues({
				currentApiConfigName: "saved",
				listApiConfigMeta: await provider.providerSettingsManager.listConfig(),
				subagentDefaultApiConfigId: "saved-id",
				subagentApiConfigByRole: { explore: "saved-id", review: "other-id", worker: "saved-id" },
			})
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// This file's filesystem is mocked. The real history API is covered with durable files and
			// commit races in TaskHistoryStore.spec.ts; retain name-only cache writes at this adapter boundary.
			patchHistory = (oldName, newName) => patchStoredNames(provider, oldName, newName)
			vi.spyOn(provider.taskHistoryStore, "renameProviderProfile").mockImplementation(patchHistory)
		})

		it("renames foreground, background and saved task identity without changing handlers, settings, secrets or child routes", async () => {
			const foreground = taskFixture("foreground")
			const background = taskFixture("background")
			const unrelated = taskFixture("unrelated", "other")
			await provider.addTaskToStack(background as unknown as Task, { focus: false })
			await provider.addTaskToStack(unrelated as unknown as Task, { focus: false })
			await provider.addTaskToStack(foreground as unknown as Task)
			await provider.taskHistoryStore.upsert(history(foreground.taskId))
			await provider.taskHistoryStore.upsert(history(background.taskId))
			await provider.taskHistoryStore.upsert(history("saved-only"))
			await provider.taskHistoryStore.upsert(history(unrelated.taskId, "other"))
			const before = provider.contextProxy.getValues()
			const setSettings = vi.spyOn(provider.contextProxy, "setProviderSettings")
			const activate = vi.spyOn(provider.providerSettingsManager, "activateProfile")
			vi.mocked(mockContext.globalState.update).mockClear()

			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).resolves.toMatchObject({
				id: "saved-id",
				oldName: "saved",
				newName: "renamed",
			})
			expect(provider.contextProxy.getValues()).toEqual({
				...before,
				currentApiConfigName: "renamed",
				listApiConfigMeta: await provider.providerSettingsManager.listConfig(),
			})
			expect(await provider.providerSettingsManager.getModeConfigId("code")).toBe("saved-id")
			expect(setSettings).not.toHaveBeenCalled()
			expect(activate).not.toHaveBeenCalled()
			for (const task of [foreground, background]) {
				expect(task.taskApiConfigName).toBe("renamed")
				expect(task.apiConfiguration).toBe(savedSettings)
				expect(task.api).toEqual({ identity: task.taskId })
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
			}
			expect(unrelated.taskApiConfigName).toBe("other")
			expect(unrelated.setTaskApiConfigName).not.toHaveBeenCalled()
			for (const id of ["foreground", "background", "saved-only"]) {
				expect(provider.taskHistoryStore.get(id)?.apiConfigName).toBe("renamed")
			}
			expect(provider.taskHistoryStore.get("unrelated")?.apiConfigName).toBe("other")
			expect(JSON.stringify(vi.mocked(mockContext.globalState.update).mock.calls)).not.toContain("saved-test-key")
		})

		it("renames an inactive profile without selecting it or rebuilding any current or background task", async () => {
			await provider.providerSettingsManager.activateProfile({ id: "other-id" })
			await provider.contextProxy.setValue("currentApiConfigName", "other")
			const current = taskFixture("current", "other")
			const background = taskFixture("background")
			await provider.addTaskToStack(background as unknown as Task, { focus: false })
			await provider.addTaskToStack(current as unknown as Task)
			await provider.renameProviderProfile({ id: "saved-id" }, "renamed")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("other")
			expect(current.taskApiConfigName).toBe("other")
			expect(background.taskApiConfigName).toBe("renamed")
			expect(current.updateApiConfiguration).not.toHaveBeenCalled()
			expect(background.updateApiConfiguration).not.toHaveBeenCalled()
		})

		it("updates a sibling view's owned background task through the shared session registry", async () => {
			const peer = await createSibling()
			try {
				const task = taskFixture("peer-owned-background")
				await peer.addTaskToStack(task as unknown as Task, { focus: false })
				await peer.taskHistoryStore.upsert(history(task.taskId))
				const setSettings = vi.spyOn(peer.contextProxy, "setProviderSettings")
				expect(provider.getLiveTask(task.taskId)).toBe(task)
				expect(provider.getTaskOwner(task.taskId)).toBe(peer)
				await provider.renameProviderProfile({ id: "saved-id" }, "renamed")
				expect(task.taskApiConfigName).toBe("renamed")
				expect(task.apiConfiguration).toBe(savedSettings)
				expect(task.api).toEqual({ identity: task.taskId })
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
				expect(setSettings).not.toHaveBeenCalled()
				expect(peer.contextProxy.getValue("currentApiConfigName")).toBe("renamed")
				expect(peer.contextProxy.getValue("listApiConfigMeta")).toEqual(
					await peer.providerSettingsManager.listConfig(),
				)
				expect(peer.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("renamed")
				expect(peer.postStateToWebview).toHaveBeenCalledOnce()
			} finally {
				await peer.dispose()
			}
		})

		it("serializes a sibling rename through the first rename's held identity projection", async () => {
			const peer = await createSibling()
			try {
				const task = taskFixture("peer-owned-background")
				await peer.addTaskToStack(task as unknown as Task, { focus: false })
				await peer.taskHistoryStore.upsert(history(task.taskId))
				let release!: () => void
				let enter!: () => void
				const held = new Promise<void>((resolve) => (release = resolve))
				const started = new Promise<void>((resolve) => (enter = resolve))
				const setValue = provider.contextProxy.setValue.bind(provider.contextProxy)
				vi.spyOn(provider.contextProxy, "setValue").mockImplementationOnce(async (key, value) => {
					enter()
					await held
					return setValue(key, value)
				})
				const first = provider.renameProviderProfile({ id: "saved-id" }, "renamed")
				await started
				const rename = vi.spyOn(peer.providerSettingsManager, "renameProfile")
				const second = peer.renameProviderProfile({ id: "saved-id" }, "newer")
				let startedWhileHeld: number
				try {
					// One scheduler checkpoint drains runnable work while the first projection is held.
					await new Promise<void>((resolve) => setImmediate(resolve))
					startedWhileHeld = rename.mock.calls.length
				} finally {
					release()
				}
				await first
				await second
				expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("newer")
				expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("newer")
				expect(peer.contextProxy.getValue("currentApiConfigName")).toBe("newer")
				expect(task.taskApiConfigName).toBe("newer")
				expect(peer.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("newer")
				expect(task.apiConfiguration).toBe(savedSettings)
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
				expect(startedWhileHeld).toBe(0)
			} finally {
				await peer.dispose()
			}
		})

		it("saves a stale sibling draft by stable ID after the rename's held projection without recreating the old name", async () => {
			const peer = await createSibling()
			try {
				const task = taskFixture("peer-current")
				await peer.addTaskToStack(task as unknown as Task)
				await peer.taskHistoryStore.upsert(history(task.taskId))
				const before = await provider.providerSettingsManager.listConfig()
				let release!: () => void
				let enter!: () => void
				const held = new Promise<void>((resolve) => (release = resolve))
				const started = new Promise<void>((resolve) => (enter = resolve))
				const setValue = provider.contextProxy.setValue.bind(provider.contextProxy)
				vi.spyOn(provider.contextProxy, "setValue").mockImplementationOnce(async (key, value) => {
					enter()
					await held
					return setValue(key, value)
				})
				const rename = provider.renameProviderProfile({ id: "saved-id" }, "renamed")
				await started
				const saveConfig = vi.spyOn(peer.providerSettingsManager, "saveConfig")
				const acknowledgement = vi.spyOn(peer, "postMessageToWebview").mockResolvedValue(undefined)
				const draft = {
					...savedSettings,
					id: "other-id",
					openAiBaseUrl: "https://explicit-save.example/v1",
					openAiApiKey: "explicit-save-test-key",
					openAiModelId: "explicit-save-model",
				}
				const save = webviewMessageHandler(peer, {
					type: "upsertApiConfiguration",
					requestId: "stale-save",
					text: "saved",
					apiConfigurationId: "saved-id",
					apiConfiguration: draft,
				})
				try {
					await new Promise<void>((resolve) => setImmediate(resolve))
					expect(saveConfig).not.toHaveBeenCalled()
				} finally {
					release()
				}
				await rename
				await save
				const after = await peer.providerSettingsManager.listConfig()
				expect(after).toHaveLength(before.length)
				expect(after.filter(({ id }) => id === "saved-id").map(({ name }) => name)).toEqual(["renamed"])
				expect(after.some(({ name }) => name === "saved")).toBe(false)
				expect(await peer.providerSettingsManager.getProfile({ id: "saved-id" })).toMatchObject({
					...draft,
					id: "saved-id",
					name: "renamed",
				})
				expect(saveConfig).toHaveBeenCalledExactlyOnceWith({ id: "saved-id" }, draft)
				expect(acknowledgement).toHaveBeenCalledExactlyOnceWith({
					type: "apiConfigurationSaved",
					apiConfigurationSaveResult: {
						requestId: "stale-save",
						status: "success",
						id: "saved-id",
						name: "renamed",
					},
				})
				expect(peer.contextProxy.getValue("currentApiConfigName")).toBe("renamed")
				expect(task.taskApiConfigName).toBe("renamed")
				expect(peer.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("renamed")
				expect(task.updateApiConfiguration).toHaveBeenCalledExactlyOnceWith(draft)
				expect(await peer.providerSettingsManager.getModeConfigId("code")).toBe("saved-id")
			} finally {
				await peer.dispose()
			}
		})

		it.each(["unknown", "deleted"])(
			"rejects a modern Save targeting an %s ID without provider, history or activation projections",
			async (state) => {
				const task = taskFixture("foreground")
				await provider.addTaskToStack(task as unknown as Task)
				await provider.taskHistoryStore.upsert(history(task.taskId))
				if (state === "deleted") {
					await provider.providerSettingsManager.deleteConfig("saved")
					await provider.providerSettingsManager.saveConfig("saved", {
						id: "replacement-id",
						apiProvider: "vscode-lm",
					})
				}
				const before = await provider.providerSettingsManager.listConfig()
				const contextBefore = provider.contextProxy.getValues()
				const historyBefore = provider.taskHistoryStore.getAll()
				const setSettings = vi.spyOn(provider.contextProxy, "setProviderSettings")
				const setMode = vi.spyOn(provider.providerSettingsManager, "setModeConfig")
				const activate = vi.spyOn(provider.providerSettingsManager, "activateProfile")
				const historyWrite = vi.spyOn(provider.taskHistoryStore, "upsert")
				const acknowledgement = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
				vi.mocked(mockContext.secrets.store).mockClear()
				vi.mocked(mockContext.globalState.update).mockClear()
				await webviewMessageHandler(provider, {
					type: "upsertApiConfiguration",
					requestId: `missing-save-${state}`,
					apiConfigurationId: state === "unknown" ? "missing-id" : "saved-id",
					text: "saved",
					apiConfiguration: { ...savedSettings, openAiModelId: "must-not-save" },
				})
				expect(await provider.providerSettingsManager.listConfig()).toEqual(before)
				expect(provider.contextProxy.getValues()).toEqual(contextBefore)
				expect(provider.taskHistoryStore.getAll()).toEqual(historyBefore)
				expect(mockContext.secrets.store).not.toHaveBeenCalled()
				expect(mockContext.globalState.update).not.toHaveBeenCalled()
				expect(setSettings).not.toHaveBeenCalled()
				expect(setMode).not.toHaveBeenCalled()
				expect(activate).not.toHaveBeenCalled()
				expect(historyWrite).not.toHaveBeenCalled()
				expect(task.setTaskApiConfigName).not.toHaveBeenCalled()
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
				expect(provider.postStateToWebview).not.toHaveBeenCalled()
				expect(acknowledgement).toHaveBeenCalledExactlyOnceWith({
					type: "apiConfigurationSaved",
					apiConfigurationSaveResult: {
						requestId: `missing-save-${state}`,
						status: "error",
						error: "notFound",
					},
				})
			},
		)

		it.each([
			["string", "malformed-draft"],
			["array", []],
			["number", 42],
			["date", new Date("2026-10-11T00:00:00Z")],
		])(
			"acknowledges a malformed %s draft container as invalid without saving or activating",
			async (kind, draft) => {
				const task = taskFixture("foreground")
				await provider.addTaskToStack(task as unknown as Task)
				await provider.taskHistoryStore.upsert(history(task.taskId))
				const before = await provider.providerSettingsManager.getProfile({ id: "saved-id" })
				const contextBefore = provider.contextProxy.getValues()
				const setSettings = vi.spyOn(provider.contextProxy, "setProviderSettings")
				const setMode = vi.spyOn(provider.providerSettingsManager, "setModeConfig")
				const historyWrite = vi.spyOn(provider.taskHistoryStore, "upsert")
				const acknowledgement = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
				vi.mocked(mockContext.secrets.store).mockClear()
				vi.mocked(mockContext.globalState.update).mockClear()

				await webviewMessageHandler(provider, {
					type: "upsertApiConfiguration",
					requestId: `malformed-container-${kind}`,
					apiConfigurationId: "saved-id",
					text: "stale-name",
					apiConfiguration: draft,
				} as unknown as WebviewMessage)

				expect(await provider.providerSettingsManager.getProfile({ id: "saved-id" })).toEqual(before)
				expect(provider.contextProxy.getValues()).toEqual(contextBefore)
				expect(mockContext.secrets.store).not.toHaveBeenCalled()
				expect(mockContext.globalState.update).not.toHaveBeenCalled()
				expect(setSettings).not.toHaveBeenCalled()
				expect(setMode).not.toHaveBeenCalled()
				expect(historyWrite).not.toHaveBeenCalled()
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
				expect(task.setTaskApiConfigName).not.toHaveBeenCalled()
				expect(provider.postStateToWebview).not.toHaveBeenCalled()
				expect(acknowledgement).toHaveBeenCalledExactlyOnceWith({
					type: "apiConfigurationSaved",
					apiConfigurationSaveResult: {
						requestId: `malformed-container-${kind}`,
						status: "error",
						error: "invalid",
					},
				})
			},
		)

		it("acknowledges a rejected primary Save without changing the task and allows a stable-ID retry", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			const before = await provider.providerSettingsManager.getProfile({ id: "saved-id" })
			const contextBefore = provider.contextProxy.getValues()
			const acknowledgement = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
			const draft = { ...savedSettings, openAiModelId: "retry-model" }
			vi.mocked(mockContext.secrets.store).mockRejectedValueOnce(new Error("private storage failure"))

			await webviewMessageHandler(provider, {
				type: "upsertApiConfiguration",
				requestId: "failed-primary-save",
				apiConfigurationId: "saved-id",
				text: "saved",
				apiConfiguration: draft,
			})

			expect(await provider.providerSettingsManager.getProfile({ id: "saved-id" })).toEqual(before)
			expect(provider.contextProxy.getValues()).toEqual(contextBefore)
			expect(task.updateApiConfiguration).not.toHaveBeenCalled()
			expect(task.setTaskApiConfigName).not.toHaveBeenCalled()
			expect(provider.postStateToWebview).not.toHaveBeenCalled()
			expect(acknowledgement).toHaveBeenLastCalledWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "failed-primary-save", status: "error", error: "saveFailed" },
			})

			await webviewMessageHandler(provider, {
				type: "upsertApiConfiguration",
				requestId: "primary-save-retry",
				apiConfigurationId: "saved-id",
				apiConfiguration: draft,
			})
			expect(await provider.providerSettingsManager.getProfile({ id: "saved-id" })).toMatchObject(draft)
			expect(task.updateApiConfiguration).toHaveBeenCalledExactlyOnceWith(draft)
			expect(acknowledgement).toHaveBeenLastCalledWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: {
					requestId: "primary-save-retry",
					status: "success",
					id: "saved-id",
					name: "saved",
				},
			})
		})

		it("reports failed Save completion after a committed write and retries the same renamed ID without creating another profile", async () => {
			await provider.renameProviderProfile({ id: "saved-id" }, "renamed")
			const before = await provider.providerSettingsManager.listConfig()
			const draft = { ...savedSettings, openAiModelId: "committed-model" }
			const acknowledgement = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
			vi.mocked(provider.postStateToWebview).mockRejectedValueOnce(new Error("private projection failure"))

			await webviewMessageHandler(provider, {
				type: "upsertApiConfiguration",
				requestId: "failed-save-completion",
				apiConfigurationId: "saved-id",
				text: "saved",
				apiConfiguration: draft,
			})
			expect(await provider.providerSettingsManager.getProfile({ id: "saved-id" })).toMatchObject({
				...draft,
				name: "renamed",
			})
			expect(acknowledgement).toHaveBeenLastCalledWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: {
					requestId: "failed-save-completion",
					status: "error",
					error: "saveFailed",
				},
			})

			await webviewMessageHandler(provider, {
				type: "upsertApiConfiguration",
				requestId: "save-completion-retry",
				apiConfigurationId: "saved-id",
				text: "saved",
				apiConfiguration: draft,
			})
			const after = await provider.providerSettingsManager.listConfig()
			expect(after).toHaveLength(before.length)
			expect(after.filter(({ id }) => id === "saved-id")).toEqual([expect.objectContaining({ name: "renamed" })])
			expect(after.some(({ name }) => name === "saved")).toBe(false)
			expect(acknowledgement).toHaveBeenLastCalledWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: {
					requestId: "save-completion-retry",
					status: "success",
					id: "saved-id",
					name: "renamed",
				},
			})
		})

		it.each(["metadata", "provider-setting"])(
			"settles all started Save writes after a rejected %s write before acknowledging or renaming",
			async (stage) => {
				const task = taskFixture("foreground")
				await provider.addTaskToStack(task as unknown as Task)
				await provider.taskHistoryStore.upsert(history(task.taskId))
				let release!: () => void
				let enter!: () => void
				const held = new Promise<void>((resolve) => (release = resolve))
				const started = new Promise<void>((resolve) => (enter = resolve))
				const update = vi.mocked(mockContext.globalState.update).getMockImplementation()!
				const failedKey = stage === "metadata" ? "listApiConfigMeta" : "openAiBaseUrl"
				let rejectOnce = true
				vi.mocked(mockContext.globalState.update).mockImplementation(async (key, value) => {
					if (key === failedKey && rejectOnce) {
						rejectOnce = false
						throw new Error("private projection failure")
					}
					if (key === "openAiModelId") {
						enter()
						await held
					}
					return update(key, value)
				})
				const acknowledgement = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
				const renameProfile = vi.spyOn(provider.providerSettingsManager, "renameProfile")
				const save = webviewMessageHandler(provider, {
					type: "upsertApiConfiguration",
					requestId: `held-save-${stage}`,
					apiConfigurationId: "saved-id",
					apiConfiguration: { ...savedSettings, openAiModelId: "held-save-model" },
				})
				await started
				const rename = provider.renameProviderProfile({ id: "saved-id" }, "renamed")
				let acknowledgementsWhileHeld: number
				let renamesWhileHeld: number
				try {
					await new Promise<void>((resolve) => setImmediate(resolve))
					acknowledgementsWhileHeld = acknowledgement.mock.calls.length
					renamesWhileHeld = renameProfile.mock.calls.length
				} finally {
					release()
				}
				await save
				await rename
				expect(acknowledgementsWhileHeld).toBe(0)
				expect(renamesWhileHeld).toBe(0)
				expect(acknowledgement).toHaveBeenCalledExactlyOnceWith({
					type: "apiConfigurationSaved",
					apiConfigurationSaveResult: {
						requestId: `held-save-${stage}`,
						status: "error",
						error: "saveFailed",
					},
				})
				expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("renamed")
				expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("renamed")
				expect(task.taskApiConfigName).toBe("renamed")
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
			},
		)

		it("settles all started activation writes after rejection before the next queued rename", async () => {
			let release!: () => void
			let enter!: () => void
			const held = new Promise<void>((resolve) => (release = resolve))
			const started = new Promise<void>((resolve) => (enter = resolve))
			const update = vi.mocked(mockContext.globalState.update).getMockImplementation()!
			let rejectOnce = true
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key, value) => {
				if (key === "listApiConfigMeta" && rejectOnce) {
					rejectOnce = false
					throw new Error("private projection failure")
				}
				if (key === "apiProvider") {
					enter()
					await held
				}
				return update(key, value)
			})
			const renameProfile = vi.spyOn(provider.providerSettingsManager, "renameProfile")
			let activationSettled = false
			const activation = provider.activateProviderProfile({ id: "other-id" }).then(
				() => {
					activationSettled = true
					return undefined
				},
				(error: unknown) => {
					activationSettled = true
					return error
				},
			)
			await started
			const rename = provider.renameProviderProfile({ id: "other-id" }, "activated-renamed")
			let settledWhileHeld: boolean
			let renamesWhileHeld: number
			try {
				await new Promise<void>((resolve) => setImmediate(resolve))
				settledWhileHeld = activationSettled
				renamesWhileHeld = renameProfile.mock.calls.length
			} finally {
				release()
			}
			expect(await activation).toBeInstanceOf(Error)
			await rename
			expect(settledWhileHeld).toBe(false)
			expect(renamesWhileHeld).toBe(0)
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("activated-renamed")
		})

		it("finishes the name-only rename before a queued activation applies its selected provider", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			let release!: () => void
			let enter!: () => void
			const held = new Promise<void>((resolve) => (release = resolve))
			const started = new Promise<void>((resolve) => (enter = resolve))
			const store = vi.mocked(mockContext.secrets.store).getMockImplementation()!
			vi.mocked(mockContext.secrets.store).mockImplementationOnce(async (key, value) => {
				enter()
				await held
				return store(key, value)
			})
			const activate = vi.spyOn(provider.providerSettingsManager, "activateProfile")
			const setSettings = vi.spyOn(provider.contextProxy, "setProviderSettings")
			const rename = provider.renameProviderProfile({ id: "saved-id" }, "renamed")
			await started
			const activation = provider.activateProviderProfile({ id: "other-id" })
			try {
				await Promise.resolve()
				await Promise.resolve()
				expect(activate).not.toHaveBeenCalled()
				expect(setSettings).not.toHaveBeenCalled()
				expect(task.updateApiConfiguration).not.toHaveBeenCalled()
			} finally {
				release()
			}
			await rename
			await activation
			expect(task.setTaskApiConfigName.mock.calls.map(([name]) => name)).toEqual(["renamed", "other"])
			expect(task.updateApiConfiguration).toHaveBeenCalledOnce()
			expect(setSettings).toHaveBeenCalledOnce()
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("other")
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("renamed")
			expect((await provider.providerSettingsManager.getProfile({ id: "other-id" })).name).toBe("other")
		})

		it.each([
			[{ id: "missing" }, "renamed", "notFound"],
			[{ id: "saved-id" }, "OTHER", "nameInUse"],
		] as const)("rejects %j -> %s as %s before projecting state", async (target, newName, code) => {
			await expect(provider.renameProviderProfile(target, newName)).rejects.toMatchObject({ code })
			expect(provider.postStateToWebview).not.toHaveBeenCalled()
			expect(provider.taskHistoryStore.renameProviderProfile).not.toHaveBeenCalled()
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("saved")
		})

		it("leaves identity unchanged after primary storage rejection and allows a later rename retry", async () => {
			vi.mocked(mockContext.secrets.store).mockRejectedValueOnce(new Error("private secret storage path"))
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).rejects.toMatchObject({
				code: "saveFailed",
			})
			expect(provider.postStateToWebview).not.toHaveBeenCalled()
			expect(provider.taskHistoryStore.renameProviderProfile).not.toHaveBeenCalled()
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("saved")
			await provider.renameProviderProfile({ id: "saved-id" }, "renamed")
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("renamed")
		})

		it("compensates a metadata write failure by ID and restores names before a successful retry", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			vi.mocked(mockContext.globalState.update).mockRejectedValueOnce(new Error("private memento storage path"))
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).rejects.toMatchObject({
				code: "saveFailed",
			})
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("saved")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("saved")
			expect(task.taskApiConfigName).toBe("saved")
			expect(provider.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("saved")
			expect(task.updateApiConfiguration).not.toHaveBeenCalled()
			await provider.renameProviderProfile({ id: "saved-id" }, "renamed")
			expect(task.taskApiConfigName).toBe("renamed")
		})

		it("repairs name references after repeated projection failures while retaining task settings and later history fields", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			vi.mocked(provider.taskHistoryStore.renameProviderProfile).mockImplementationOnce(
				async (oldName, newName) => {
					const changed = await patchHistory(oldName, newName)
					await provider.taskHistoryStore.upsert({
						...provider.taskHistoryStore.get(task.taskId)!,
						tokensIn: 777,
					})
					throw new Error(`private history storage failure ${changed.length}`)
				},
			)
			const update = vi.mocked(mockContext.globalState.update).getMockImplementation()!
			vi.mocked(mockContext.globalState.update).mockImplementationOnce(update).mockImplementationOnce(update)
			vi.mocked(mockContext.globalState.update).mockRejectedValueOnce(new Error("inverse metadata rejected"))
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).rejects.toMatchObject({
				code: "saveFailed",
			})
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("saved")
			expect(task.taskApiConfigName).toBe("saved")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("saved")
			expect(provider.taskHistoryStore.get(task.taskId)).toMatchObject({ apiConfigName: "saved", tokensIn: 777 })
			expect(provider.postStateToWebview).toHaveBeenCalledTimes(2)
			expect(task.apiConfiguration).toBe(savedSettings)
		})

		it("returns committed metadata identity despite a legacy name field when the inverse secret write rejects", async () => {
			const profilesKey = "roo_cline_config_api_config"
			const persisted = JSON.parse((await mockContext.secrets.get(profilesKey))!)
			persisted.apiConfigs.saved.name = "legacy-profile-field"
			await mockContext.secrets.store(profilesKey, JSON.stringify(persisted))
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			const store = vi.mocked(mockContext.secrets.store)
			store
				.mockImplementationOnce(store.getMockImplementation()!)
				.mockRejectedValueOnce(new Error("inverse write rejected"))
			vi.mocked(mockContext.globalState.update).mockRejectedValueOnce(new Error("first metadata write rejected"))
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).resolves.toMatchObject({
				oldName: "saved",
				newName: "renamed",
			})
			expect(
				(await provider.providerSettingsManager.listConfig()).find(({ id }) => id === "saved-id")?.name,
			).toBe("renamed")
			expect(JSON.parse((await mockContext.secrets.get(profilesKey))!).apiConfigs.renamed.name).toBe(
				"legacy-profile-field",
			)
			expect(task.taskApiConfigName).toBe("renamed")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("renamed")
			expect(provider.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("renamed")
			expect(task.updateApiConfiguration).not.toHaveBeenCalled()
		})

		it("exposes the authoritative reverted name after the forward state was published and inverse state delivery fails", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			const observed: string[] = []
			vi.mocked(provider.postStateToWebview)
				.mockImplementationOnce(async () => {
					observed.push(provider.contextProxy.getValue("currentApiConfigName") ?? "")
				})
				.mockRejectedValueOnce(new Error("inverse state delivery rejected"))
			vi.mocked(provider.taskHistoryStore.renameProviderProfile).mockImplementationOnce(
				async (oldName, newName) => {
					await patchHistory(oldName, newName)
					throw new Error("history compatibility projection rejected")
				},
			)
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).rejects.toMatchObject({
				code: "saveFailed",
				profile: { id: "saved-id", name: "saved" },
			})
			expect(observed).toEqual(["renamed"])
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("saved")
			expect(task.taskApiConfigName).toBe("saved")
			expect(provider.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("saved")
		})

		it("does not compensate over a newer persisted rename and reports its latest committed identity", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			vi.mocked(mockContext.globalState.update).mockImplementationOnce(async () => {
				await provider.providerSettingsManager.renameProfile({ id: "saved-id" }, "external")
				throw new Error("external metadata update rejected")
			})
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).resolves.toMatchObject({
				id: "saved-id",
				newName: "external",
			})
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("external")
			expect(task.taskApiConfigName).toBe("external")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("external")
			expect(provider.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("external")
		})

		it("repairs the intermediate name after a newer rename even when every metadata and state projection rejects", async () => {
			const task = taskFixture("foreground")
			await provider.addTaskToStack(task as unknown as Task)
			await provider.taskHistoryStore.upsert(history(task.taskId))
			const update = vi.mocked(mockContext.globalState.update).getMockImplementation()!
			vi.mocked(mockContext.globalState.update).mockImplementationOnce(async () => {
				await provider.providerSettingsManager.renameProfile({ id: "saved-id" }, "external")
				throw new Error("metadata rejection after external rename")
			})
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key, value) => {
				if (key === "listApiConfigMeta") throw new Error("metadata unavailable")
				return update(key, value)
			})
			vi.mocked(provider.postStateToWebview).mockRejectedValue(new Error("state projection unavailable"))
			await expect(provider.renameProviderProfile({ id: "saved-id" }, "renamed")).resolves.toMatchObject({
				newName: "external",
			})
			expect((await provider.providerSettingsManager.getProfile({ id: "saved-id" })).name).toBe("external")
			expect(task.taskApiConfigName).toBe("external")
			expect(provider.taskHistoryStore.get(task.taskId)?.apiConfigName).toBe("external")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("external")
		})
	})

	describe("activateProviderProfile", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		it("should save provider profile to task metadata when switching profiles", async () => {
			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addTaskToStack(mockTask as any)

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to track calls
			const updateTaskHistorySpy = vi
				.spyOn(provider, "updateTaskHistory")
				.mockImplementation(() => Promise.resolve([]))

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "vertex",
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: "vertex" },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task history was updated with new provider profile
			expect(updateTaskHistorySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					id: mockTask.taskId,
					apiConfigName: "new-profile",
				}),
			)

			// Verify task's setTaskApiConfigName was called
			expect(mockTask.setTaskApiConfigName).toHaveBeenCalledWith("new-profile")
		})

		it("should update task's taskApiConfigName property when switching profiles", async () => {
			// Create a mock task with initial profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addTaskToStack(mockTask as any)

			// Mock getGlobalState to return task history
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([
				{
					id: mockTask.taskId,
					ts: Date.now(),
					task: "Test task",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
				},
			])

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => Promise.resolve([]))

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "openai",
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: "openai" },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task's _taskApiConfigName property was updated
			expect(mockTask._taskApiConfigName).toBe("new-profile")
		})

		it("should update in-memory task profile even if task history item does not exist yet", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			await provider.addTaskToStack(mockTask as any)

			// No history item exists yet
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([])

			const updateTaskHistorySpy = vi
				.spyOn(provider, "updateTaskHistory")
				.mockImplementation(() => Promise.resolve([]))

			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "openai",
			})

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: "openai" },
			])

			await provider.activateProviderProfile({ name: "new-profile" })

			// In-memory should still update, even without a history item.
			expect(mockTask._taskApiConfigName).toBe("new-profile")
			// No history item => no updateTaskHistory call.
			expect(updateTaskHistorySpy).not.toHaveBeenCalled()
		})
	})

	describe("createTaskWithHistoryItem", () => {
		it("restores a retired task into Plan while preserving its provider profile", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "ask",
				apiConfigName: "saved-profile", // Saved provider profile
			}

			// Mock activateProviderProfile to ensure task restoration stays lane-local.
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: "vertex" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "saved-profile",
				id: "saved-profile-id",
				apiProvider: "vertex",
				vertexJsonCredentials: "saved-key",
			} as any)

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())
			expect(vi.mocked(Task)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					historyItem: expect.objectContaining({ mode: "architect" }),
					taskApiConfigName: "saved-profile",
					apiConfiguration: expect.objectContaining({
						apiProvider: "vertex",
						vertexJsonCredentials: "saved-key",
					}),
				}),
			)
		})

		it("restores the saved task profile even with the retired CLI environment flag", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "saved-profile",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: "vertex" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "saved-profile",
				id: "saved-profile-id",
				apiProvider: "vertex",
				vertexJsonCredentials: "saved-key",
			})

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())
			expect(vi.mocked(Task)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					taskApiConfigName: "saved-profile",
					apiConfiguration: expect.objectContaining({
						apiProvider: "vertex",
						vertexJsonCredentials: "saved-key",
					}),
				}),
			)
		})

		it("restores the saved mode profile even with the retired CLI environment flag", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-profile", id: "mode-config-id", apiProvider: "vertex" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "mode-profile",
				id: "mode-config-id",
				apiProvider: "vertex",
				vertexJsonCredentials: "mode-key",
			})

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "mode-profile" },
				{ persistTaskHistory: false, notifyWebview: false },
			)
		})

		it("should use current profile if history item has no saved apiConfigName", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item without saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				// No apiConfigName field
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify activateProviderProfile was NOT called for apiConfigName restoration
			// (it might be called for mode-based config, but not for direct apiConfigName)
			const callsForApiConfigName = activateProviderProfileSpy.mock.calls.filter(
				(call) => call[0] && "name" in call[0] && call[0].name === historyItem.apiConfigName,
			)
			expect(callsForApiConfigName.length).toBe(0)
		})

		it("should prioritize task's apiConfigName over mode-based config", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with both mode and apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "architect", // Mode has a different preferred profile
				apiConfigName: "task-specific-profile", // Task's actual profile
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Mock providerSettingsManager methods
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-preferred-profile", id: "mode-config-id", apiProvider: "vertex" },
				{ name: "task-specific-profile", id: "task-profile-id", apiProvider: "openai" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "task-specific-profile",
				id: "task-profile-id",
				apiProvider: "openai",
				openAiApiKey: "task-profile-key",
			} as any)

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()
			expect(provider.providerSettingsManager.getModeConfigId).not.toHaveBeenCalled()
			expect(vi.mocked(Task)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					taskApiConfigName: "task-specific-profile",
					apiConfiguration: expect.objectContaining({
						apiProvider: "openai",
						openAiApiKey: "task-profile-key",
					}),
				}),
			)
		})

		it("should handle missing provider profile gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with a provider profile that no longer exists
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "deleted-profile", // Profile that doesn't exist
			}

			// Mock providerSettingsManager.listConfig to return empty (profile doesn't exist)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])

			// Mock log to verify warning is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify a warning was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Provider profile 'deleted-profile' from history no longer exists"),
			)
		})
	})

	describe("Task metadata persistence", () => {
		it("should include apiConfigName in task metadata when saving", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task with provider profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "test-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to capture the updated history item
			let updatedHistoryItem: any
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				updatedHistoryItem = item
				return Promise.resolve([item])
			})

			// Add task to provider stack
			await provider.addTaskToStack(mockTask as any)

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "vertex",
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: "vertex" },
			])

			// Trigger a profile switch
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify apiConfigName was included in the updated history item
			expect(updatedHistoryItem).toBeDefined()
			expect(updatedHistoryItem.apiConfigName).toBe("new-profile")
		})
	})

	describe("Multiple workspaces isolation", () => {
		it("should preserve task profile when switching profiles in another workspace", async () => {
			// This test verifies that each task retains its designated provider profile
			// so that switching profiles in one workspace doesn't alter other tasks

			await provider.resolveWebviewView(mockWebviewView)

			// Create task 1 with profile A
			const task1 = {
				taskId: "task-1",
				_taskApiConfigName: "profile-a",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Create task 2 with profile B
			const task2 = {
				taskId: "task-2",
				_taskApiConfigName: "profile-b",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task 1 to stack
			await provider.addTaskToStack(task1 as any)

			// Mock getGlobalState to return task history for both tasks
			const taskHistory = [
				{
					id: "task-1",
					ts: Date.now(),
					task: "Task 1",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-a",
				},
				{
					id: "task-2",
					ts: Date.now(),
					task: "Task 2",
					number: 2,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-b",
				},
			]

			// Populate the store
			for (const item of taskHistory) {
				await provider.taskHistoryStore.upsert(item as any)
			}

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				const index = taskHistory.findIndex((h) => h.id === item.id)
				if (index >= 0) {
					taskHistory[index] = { ...taskHistory[index], ...item }
				}
				return Promise.resolve(taskHistory)
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-c",
				id: "profile-c-id",
				apiProvider: "vertex",
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "profile-a", id: "profile-a-id", apiProvider: "vertex" },
				{ name: "profile-b", id: "profile-b-id", apiProvider: "openai" },
				{ name: "profile-c", id: "profile-c-id", apiProvider: "vertex" },
			])

			// Switch task 1's profile to profile C
			await provider.activateProviderProfile({ name: "profile-c" })

			// Verify task 1's profile was updated
			expect(task1._taskApiConfigName).toBe("profile-c")
			expect(taskHistory[0].apiConfigName).toBe("profile-c")

			// Verify task 2's profile remains unchanged
			expect(taskHistory[1].apiConfigName).toBe("profile-b")
		})
	})

	describe("Error handling", () => {
		it("should handle errors gracefully when saving profile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveAlphaMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addTaskToStack(mockTask as any)

			// Populate the store
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to throw error
			vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("Save failed"))

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "vertex",
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: "vertex" },
			])

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Switch provider profile - should not throw
			await expect(provider.activateProviderProfile({ name: "new-profile" })).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist provider profile switch"))
		})

		it("should handle null/undefined apiConfigName gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with null apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: null as any, // Invalid apiConfigName
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify activateProviderProfile was not called with null
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: null })
		})
	})

	describe("Profile restoration with activateProfile failure", () => {
		it("should continue task restoration even if activateProviderProfile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "failing-profile",
			}

			// Mock providerSettingsManager.listConfig to return the profile
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "failing-profile", id: "failing-profile-id", apiProvider: "vertex" },
			])

			// Mock activateProviderProfile to throw error
			vi.spyOn(provider, "activateProviderProfile").mockRejectedValue(new Error("Activation failed"))

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw even though activation fails
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to restore API configuration 'failing-profile' for task"),
			)
		})
	})
})
