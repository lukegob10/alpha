// Source-only prepared public fixture. Reuses the existing Task.spec bootstrap under a distinct filename.
import * as os from "os"
import * as path from "path"
import * as fsSync from "fs"
import { EventEmitter } from "events"
import * as vscode from "vscode"
import type { GlobalState, ProviderSettings } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import { Task } from "../Task"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { ContextProxy } from "../../config/ContextProxy"
import type { AgentMessage } from "../../task-persistence/AgentMessageInbox"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { executeCommandTool } from "../../tools/ExecuteCommandTool"
import i18n from "../../../i18n"
import enCommon from "../../../i18n/locales/en/common.json"

const { hookProcess, physicalLifecycleFiles } = vi.hoisted(() => ({
	physicalLifecycleFiles: new Set<string>(),
	hookProcess: {
		spawn: vi.fn(),
		calls: [] as Array<Record<string, unknown>>,
		respond: (_request: Record<string, unknown>): Record<string, unknown> => ({}),
	},
}))
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: hookProcess.spawn,
}))

// Task tests isolate filesystem durability; AgentMessageInbox.spec exercises the real durable store.
vi.mock("../../task-persistence/TaskMessageQueuePersistence", () => ({
	TaskMessageQueuePersistence: class {
		async load() {
			return []
		}
		async save() {}
	},
}))
vi.mock("../../task-persistence/AgentMessageInbox", () => ({
	AgentMessageInbox: class {
		messages: AgentMessage[] = []
		hasPending() {
			return this.messages.length > 0
		}
		async receive(message: AgentMessage) {
			this.messages.push(message)
		}
		async deliver(persist: (message: AgentMessage) => Promise<void>) {
			while (this.messages.length) {
				await persist(this.messages[0])
				this.messages.shift()
			}
		}
	},
}))

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

function isVirtualTaskStoragePath(filePath: string): boolean {
	const virtualStorageRoots = [
		path.resolve(os.tmpdir(), "test-storage"),
		path.resolve("/test/storage"),
		path.resolve("/mock/storage/path"),
	]
	const candidate = path.resolve(filePath)
	return virtualStorageRoots.some((root) => {
		const relativePath = path.relative(root, candidate)
		return (
			relativePath === "" ||
			(!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`))
		)
	})
}

function createStorageLstatMock(actualLstat: typeof import("node:fs/promises").lstat) {
	return vi.fn().mockImplementation((filePath, options) => {
		if (typeof filePath === "string" && isVirtualTaskStoragePath(filePath)) {
			return Promise.reject(
				Object.assign(new Error("Virtual storage path does not exist"), {
					code: "ENOENT",
					path: filePath,
					syscall: "lstat",
				}),
			)
		}
		return actualLstat(filePath, options)
	})
}

// Constructor goal-owner writes share the virtual filesystem boundary and must not leave real lock retries behind.
// Physical task-loop and goal fixtures retain the actual durable store.
vi.mock("../../agent/goals/GoalAccountingBindingStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../agent/goals/GoalAccountingBindingStore")>()
	return {
		...actual,
		GoalAccountingBindingStore: class extends actual.GoalAccountingBindingStore {
			constructor(
				private readonly fixtureStoragePath: string,
				taskId: string,
			) {
				super(fixtureStoragePath, taskId)
			}

			override async save(
				...args: Parameters<typeof actual.GoalAccountingBindingStore.prototype.save>
			): Promise<void> {
				if (isVirtualTaskStoragePath(this.fixtureStoragePath)) return
				await super.save(...args)
			}
		},
	}
})

// Only virtual history indexes share this fixture's mocked write boundary; physical writes stay durable.
vi.mock("../../../utils/safeWriteJson", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/safeWriteJson")>()
	return {
		...actual,
		safeWriteJson: vi.fn(async (...args: Parameters<typeof actual.safeWriteJson>) => {
			if (path.basename(args[0]) === "_index.json" && isVirtualTaskStoragePath(args[0])) return
			await actual.safeWriteJson(...args)
		}),
	}
})

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const isPhysicalLifecycleFile = (filePath: unknown): boolean =>
		typeof filePath === "string" && physicalLifecycleFiles.has(filePath.replaceAll("\\", "/"))
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		// Virtual storage stays absent regardless of host leftovers; isolated physical fixtures use real metadata.
		lstat: createStorageLstatMock(actual.lstat),
		readFile: vi.fn().mockImplementation((filePath, ...args: unknown[]) => {
			if (isPhysicalLifecycleFile(filePath)) return actual.readFile(filePath, ...args)
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify(mockMessages))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve(
					JSON.stringify([
						{
							role: "user",
							content: [{ type: "text", text: "historical task" }],
							ts: Date.now(),
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "I'll help you with that task." }],
							ts: Date.now(),
						},
					]),
				)
			}
			return Promise.resolve("[]")
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi
			.fn()
			.mockImplementation((filePath: unknown, ...args: unknown[]) =>
				isPhysicalLifecycleFile(filePath) ? actual.stat(filePath, ...args) : Promise.reject({ code: "ENOENT" }),
			),
		readdir: vi.fn().mockResolvedValue([]),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
	captureEnvironmentDetails: vi
		.fn()
		.mockImplementation(async () => ({ details: "", commit: vi.fn(), release: vi.fn() })),
}))

vi.mock("../../ignore/AlphaIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})
// Keep task/settings creation virtual while retaining real base-path and read-only storage validation.
vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		getStorageBasePath: actual.getStorageBasePath,
		resolveExistingTaskDirectoryPathReadOnly: actual.resolveExistingTaskDirectoryPathReadOnly,
		getTaskDirectoryPath: vi
			.fn()
			.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
		getSettingsDirectoryPath: vi
			.fn()
			.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
	}
})

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
}))

const mockMessages = [
	{
		ts: Date.now(),
		type: "say",
		say: "text",
		text: "historical task",
	},
]

const markTestHandlerAsLegacyEOF = (task: Task) => {
	Object.defineProperty(task.api, "streamCapabilities", {
		configurable: true,
		value: { cancellation: true },
	})
}

const beforeReadCommand = "git --no-pager diff --no-ext-diff --no-textconv -- before.ts"
const afterReadCommand = "git --no-pager diff --no-ext-diff --no-textconv -- after.ts"

function assertNativeCommandSurface(task: Task) {
	const surface = task["currentTaskToolSurface"]
	expect(surface?.schemas.some((tool) => tool.type === "function" && tool.function.name === "exec_command")).toBe(
		true,
	)
	expect(surface?.allowedFunctionNames).toContain("exec_command")
	expect(surface?.registry.resolve("exec_command")).toBeDefined()
	expect(surface?.registry.resolve("read_file")).toBeUndefined()
}

describe("Alpha", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Setup mock extension context
		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => {
					if (key === "taskHistory") {
						return [
							{
								id: "123",
								number: 0,
								ts: Date.now(),
								task: "historical task",
								tokensIn: 100,
								tokensOut: 200,
								cacheWrites: 0,
								cacheReads: 0,
								totalCost: 0.001,
							},
						]
					}

					return undefined
				}),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		// Setup mock provider with output channel
		mockProvider = new AlphaProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		// Setup mock API configuration
		mockApiConfig = {
			apiProvider: "openai",
			openAiModelId: "claude-3-5-sonnet-20241022",
			openAiApiKey: "test-api-key", // Add API key to mock config
		}

		// Mock provider methods
		mockProvider.hasPendingAgentMessages = vi.fn(() => false)
		mockProvider.deliverAgentMessages = vi.fn(async () => undefined)
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue([])
		mockProvider.prepareTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
		mockProvider.rollbackTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
		mockProvider.settleIndependentTaskWaitReceiptsForParent = vi.fn().mockResolvedValue(undefined)
		mockProvider.publishAgentLifecycleEvent = vi.fn().mockResolvedValue({ accepted: true })
		mockProvider.replayAgentLifecycle = vi.fn().mockResolvedValue(undefined)
		mockProvider.getAgentLifecycleSnapshot = vi.fn().mockReturnValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockImplementation(async (id) => ({
			historyItem: {
				id,
				ts: Date.now(),
				task: "historical task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
			},
			taskDirPath: "/mock/storage/path/tasks/123",
			apiConversationHistoryFilePath: "/mock/storage/path/tasks/123/api_conversation_history.json",
			uiMessagesFilePath: "/mock/storage/path/tasks/123/ui_messages.json",
			apiConversationHistory: [
				{
					role: "user",
					content: [{ type: "text", text: "historical task" }],
					ts: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "I'll help you with that task." }],
					ts: Date.now(),
				},
			],
		}))
		// Provider bootstrap owns lock timers; settle it before tests take control of the clock.
		await Promise.allSettled([
			mockProvider.agentControlStoreReady,
			mockProvider.taskHistoryStoreReady,
			mockProvider.mcpHubInitialization,
		])
		mockProvider.postMessageToWebview.mockClear()
	})

	afterEach(async () => {
		await mockProvider.dispose()
	})

	describe("WS07 public normal configuration", () => {
		const tasks = new Set<Task>()
		const journals = new Map<string, AgentLifecycleJournal>()
		let fixtureDirectory: string
		let installedHooks: Record<string, unknown>
		let workspaceHooks: Record<string, unknown>
		const hookCommand = { command: process.execPath, args: ["--ws07-mocked-hook"] }

		beforeEach(() => {
			fixtureDirectory = fsSync.mkdtempSync(path.join(os.tmpdir(), "alpha-ws07-public-"))
			Object.assign(mockExtensionContext, { globalStorageUri: { fsPath: fixtureDirectory } })
			i18n.addResourceBundle("en", "common", enCommon, true, true)
			installedHooks = {}
			workspaceHooks = {}
			hookProcess.calls.length = 0
			hookProcess.respond = () => ({})
			hookProcess.spawn.mockReset().mockImplementation(() => {
				const child = Object.assign(new EventEmitter(), {
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
					stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
					kill: vi.fn(),
				})
				child.stdin.end.mockImplementation((input: string) => {
					const request = JSON.parse(input) as Record<string, unknown>
					hookProcess.calls.push(request)
					queueMicrotask(() => {
						child.stdout.emit("data", Buffer.from(JSON.stringify(hookProcess.respond(request))))
						child.emit("close", 0)
					})
				})
				return child
			})
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
				() =>
					({
						get: (key: string, fallback: unknown) =>
							key === "completionHooks" ? workspaceHooks : fallback,
						inspect: (key: string) =>
							key === "completionHooks"
								? {
										defaultValue: { stop: [], subagentStop: [] },
										globalValue: installedHooks,
										workspaceValue: workspaceHooks,
										workspaceFolderValue: workspaceHooks,
									}
								: undefined,
					}) as unknown as vscode.WorkspaceConfiguration,
			)
			const state = { autoApprovalEnabled: false, mode: "code", mcpEnabled: false }
			mockProvider.getState = vi.fn(async () => state)
			mockProvider.getValues = vi.fn(() => state)
			mockProvider.getParentCompletionDecision = vi.fn(async () => ({ allowed: true }))
		})

		afterEach(async () => {
			const settled = await Promise.allSettled(
				[...tasks].map(async (task) => {
					try {
						await task.abortTask(true)
					} finally {
						await task.waitForTermination()
					}
				}),
			)
			tasks.clear()
			const journalResults = await Promise.allSettled([...journals.values()].map((journal) => journal.close()))
			journals.clear()
			physicalLifecycleFiles.clear()
			const target = path.resolve(fixtureDirectory)
			if (
				path.dirname(target) !== path.resolve(os.tmpdir()) ||
				!path.basename(target).startsWith("alpha-ws07-public-")
			) {
				throw new Error("WS07 fixture cleanup escaped its owned temporary directory")
			}
			fsSync.rmSync(target, { recursive: true, force: true })
			const failures = [...settled, ...journalResults].flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			)
			if (failures.length) throw new AggregateError(failures, "WS07 public Task cleanup failed")
		})

		function lifecycleJournal(taskId: string): AgentLifecycleJournal {
			const journal = journals.get(taskId)
			if (!journal) throw new Error("WS07 task has no owned lifecycle journal")
			return journal
		}

		async function createPublicTask() {
			const workspacePath = path.join(fixtureDirectory, "workspace")
			fsSync.mkdirSync(workspacePath, { recursive: true })
			fsSync.writeFileSync(path.join(workspacePath, "before.ts"), "before")
			fsSync.writeFileSync(path.join(workspacePath, "after.ts"), "after")
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "WS07 public contract",
				workspacePath,
				startTask: false,
				enableCheckpoints: false,
			})
			tasks.add(task)
			task.setTaskApprovalMode("ask")
			const journalDirectory = path.join(fixtureDirectory, "tasks", task.taskId)
			fsSync.mkdirSync(journalDirectory, { recursive: true })
			for (const fileName of [GlobalFileNames.agentLifecycleEvents, GlobalFileNames.agentLifecycleSnapshot]) {
				physicalLifecycleFiles.add(path.join(journalDirectory, fileName).replaceAll("\\", "/"))
			}
			markTestHandlerAsLegacyEOF(task)
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			// The existing virtual transcript adapter cannot supply a physical saved assistant boundary.
			// Native persistence/fence tests remain separate; keep this fixture focused on installed-hook wiring.
			vi.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects").mockResolvedValue(undefined)
			vi.spyOn(task as any, "enqueueAlphaMessagesSave").mockImplementation(async (...args: unknown[]) => {
				const [snapshot, persisted] = args as [() => unknown, (() => void) | undefined]
				snapshot()
				persisted?.()
				return true
			})
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			// Prompt assembly has separate public tests; leave request sequencing, tool surface and scheduler real.
			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("WS07 fixture instructions")
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			await task["messageQueueService"].ready
			await task["taskApiConfigReady"]
			await task["taskApprovalModePersistence"]
			await task["alphaMessagesSaveQueue"]
			journals.set(task.taskId, await AgentLifecycleJournal.open(task.taskId, fixtureDirectory))
			mockProvider.getAgentLifecycleSnapshot = (taskId: string) => journals.get(taskId)?.getSnapshot()
			mockProvider.replayAgentLifecycle = (taskId: string) => lifecycleJournal(taskId).replay()
			mockProvider.publishAgentLifecycleEvent = async (
				event: AgentLifecycleEventInput,
				eventOptions?: { durable?: boolean },
			) => ({ accepted: true, ...(await lifecycleJournal(event.taskId).append(event, eventOptions)) })
			await task["beginCanonicalLifecycleTurn"]()
			return task
		}

		function textProvider(task: Task) {
			return vi.spyOn(task.api, "createMessage").mockImplementation(async function* () {
				yield { type: "text", text: "The public request completed." } as const
			})
		}

		it("keeps the ordinary no-hook request control completed", async () => {
			const task = await createPublicTask()
			const provider = textProvider(task)
			await expect(
				task.runAgentRequests([{ type: "text", text: "Inspect the request." }], false, undefined, {
					inputOrigin: "human",
				}),
			).resolves.toMatchObject({ status: "completed" })
			expect(provider).toHaveBeenCalledOnce()
			expect(hookProcess.spawn).not.toHaveBeenCalled()
		})

		it("ignores workspace executable hooks through the normal request configuration", async () => {
			workspaceHooks = { sessionStart: [hookCommand], userPromptSubmit: [hookCommand] }
			const task = await createPublicTask()
			const provider = textProvider(task)
			await expect(
				task.runAgentRequests([{ type: "text", text: "Inspect safely." }], false, undefined, {
					inputOrigin: "human",
				}),
			).resolves.toMatchObject({ status: "completed" })
			expect(provider).toHaveBeenCalledOnce()
			expect(hookProcess.spawn).not.toHaveBeenCalled()
		})

		it("dispatches installed start and fresh-human submit before provider input without treating agent continuation as human", async () => {
			installedHooks = { sessionStart: [hookCommand], userPromptSubmit: [hookCommand] }
			hookProcess.respond = (request) => ({
				hookSpecificOutput: {
					hookEventName: request.hook_event_name,
					additionalContext: `HOOK_CONTEXT_${request.hook_event_name}`,
				},
			})
			const task = await createPublicTask()
			const requests: string[] = []
			const provider = vi
				.spyOn(task.api, "createMessage")
				.mockImplementation(async function* (_prompt, messages) {
					requests.push(JSON.stringify(messages))
					yield { type: "text", text: "The public request completed." } as const
				})
			await expect(
				task.runAgentRequests([{ type: "text", text: "Fresh human request." }], false, undefined, {
					inputOrigin: "human",
				}),
			).resolves.toMatchObject({ status: "completed" })
			expect(provider).toHaveBeenCalledOnce()
			expect(hookProcess.calls.map((request) => request.hook_event_name)).toEqual([
				"SessionStart",
				"UserPromptSubmit",
			])
			expect(requests[0]).toContain("HOOK_CONTEXT_SessionStart")
			expect(requests[0]).toContain("HOOK_CONTEXT_UserPromptSubmit")
			await task.runAgentRequests([{ type: "text", text: "Agent continuation." }], false, undefined, {
				inputOrigin: "agent",
			})
			expect(provider).toHaveBeenCalledTimes(2)
			expect(hookProcess.calls.map((request) => request.hook_event_name)).toEqual([
				"SessionStart",
				"UserPromptSubmit",
			])
			expect(
				task.apiConversationHistory.some((message) => message.hook_prompt && message.input_origin === "agent"),
			).toBe(true)
		})

		it("stops installed submit rejection before provider admission and saves an attributed agent receipt", async () => {
			installedHooks = { userPromptSubmit: [hookCommand] }
			hookProcess.respond = () => ({ decision: "block", reason: "WS07_PUBLIC_REJECTION" })
			const task = await createPublicTask()
			const provider = textProvider(task)
			await expect(
				task.runAgentRequests([{ type: "text", text: "WS07_REJECTED_HUMAN_BODY" }], false, undefined, {
					inputOrigin: "human",
				}),
			).resolves.toMatchObject({ status: "awaiting-user" })
			expect(provider).not.toHaveBeenCalled()
			expect(hookProcess.calls.map((request) => request.hook_event_name)).toEqual(["UserPromptSubmit"])
			expect(JSON.stringify(task.apiConversationHistory)).not.toContain("WS07_REJECTED_HUMAN_BODY")
			expect(task.apiConversationHistory).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						input_origin: "agent",
						hook_prompt: expect.objectContaining({ event: "UserPromptSubmit" }),
					}),
				]),
			)
		})

		it("routes installed pre permission and post hooks through the Task-built scheduler and ordinary approval", async () => {
			installedHooks = { preToolUse: [hookCommand], permissionRequest: [hookCommand], postToolUse: [hookCommand] }
			hookProcess.respond = (request) =>
				request.hook_event_name === "PreToolUse"
					? {
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision: "allow",
								updatedInput: { cmd: afterReadCommand },
							},
						}
					: request.hook_event_name === "PostToolUse"
						? { decision: "block", reason: "WS07_POST_COMPLETED_EFFECT" }
						: {
								hookSpecificOutput: {
									hookEventName: "PermissionRequest",
									decision: { behavior: "allow" },
								},
							}
			const task = await createPublicTask()
			const effects: string[] = []
			const nativeApproval = vi.spyOn(task, "requestToolApproval")
			vi.spyOn(executeCommandTool, "execute").mockImplementation(async (params, _task, callbacks) => {
				const askCommandApproval = callbacks.askCommandApproval
				if (!askCommandApproval) throw new Error("Task scheduler did not supply native command approval")
				if (!(await askCommandApproval("command", params.command)).approved) return
				const admitted = await lifecycleJournal(task.taskId).replay()
				expect(admitted?.effectStartedToolCallIds).toContain("ws07-public-read")
				effects.push(params.command)
				callbacks.pushToolResult("WS07_READ_SUCCEEDED")
			})
			let requests = 0
			vi.spyOn(task.api, "createMessage").mockImplementation(async function* () {
				if (requests++ === 0) {
					assertNativeCommandSurface(task)
					yield {
						type: "tool_call",
						id: "ws07-public-read",
						name: "exec_command",
						arguments: JSON.stringify({ cmd: beforeReadCommand }),
					} as const
				} else yield { type: "text", text: "The tool result was handled." } as const
			})
			await task.runAgentRequests([{ type: "text", text: "Read the approved file." }], false, undefined, {
				inputOrigin: "human",
			})
			expect(effects).toEqual([afterReadCommand])
			expect(hookProcess.calls.map((request) => request.hook_event_name)).toEqual([
				"PreToolUse",
				"PermissionRequest",
				"PostToolUse",
			])
			expect(hookProcess.calls.map((request) => request.tool_name)).toEqual([
				"exec_command",
				"exec_command",
				"exec_command",
			])
			expect(hookProcess.calls[0].tool_input).toMatchObject({
				cmd: beforeReadCommand,
				command: beforeReadCommand,
			})
			expect(hookProcess.calls[1].tool_input).toMatchObject({ cmd: afterReadCommand, command: afterReadCommand })
			expect(nativeApproval).toHaveBeenCalledOnce()
			expect(nativeApproval.mock.calls[0][1]).toBe(afterReadCommand)
			expect(JSON.stringify([...task.apiConversationHistory, task.userMessageContent])).toContain(
				"WS07_POST_COMPLETED_EFFECT",
			)
			expect(effects).toHaveLength(1)
		})

		it("lets installed permission denial narrow the native approval path before the read effect", async () => {
			installedHooks = { permissionRequest: [hookCommand] }
			hookProcess.respond = () => ({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", message: "WS07_PERMISSION_DENIED" },
				},
			})
			const task = await createPublicTask()
			const effects: string[] = []
			const nativeApproval = vi.spyOn(task, "requestToolApproval")
			vi.spyOn(executeCommandTool, "execute").mockImplementation(async (params, _task, callbacks) => {
				const askCommandApproval = callbacks.askCommandApproval
				if (!askCommandApproval) throw new Error("Task scheduler did not supply native command approval")
				if (!(await askCommandApproval("command", params.command)).approved) return
				effects.push("read")
				callbacks.pushToolResult("WS07_READ_SUCCEEDED")
			})
			let requests = 0
			vi.spyOn(task.api, "createMessage").mockImplementation(async function* () {
				if (requests++ === 0) {
					assertNativeCommandSurface(task)
					yield {
						type: "tool_call",
						id: "ws07-public-denied",
						name: "exec_command",
						arguments: JSON.stringify({ cmd: beforeReadCommand }),
					} as const
				} else yield { type: "text", text: "The denied result was handled." } as const
			})
			await task.runAgentRequests([{ type: "text", text: "Read only after approval." }], false, undefined, {
				inputOrigin: "human",
			})
			expect(hookProcess.calls.map((request) => request.hook_event_name)).toEqual(["PermissionRequest"])
			expect(hookProcess.calls[0]).toMatchObject({
				tool_name: "exec_command",
				tool_input: { cmd: beforeReadCommand, command: beforeReadCommand },
			})
			expect(effects).toEqual([])
			expect(nativeApproval).not.toHaveBeenCalled()
			expect((await lifecycleJournal(task.taskId).replay())?.effectStartedToolCallIds).toEqual([])
			expect(JSON.stringify([...task.apiConversationHistory, task.userMessageContent])).toContain(
				"WS07_PERMISSION_DENIED",
			)
		})
	})
})
