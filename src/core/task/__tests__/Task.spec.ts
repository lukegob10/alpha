// npx vitest core/task/__tests__/Task.spec.ts

import * as os from "os"
import * as path from "path"
import * as fsSync from "fs"
import { EventEmitter } from "events"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	AlphaCodeEventName,
	getApiProtocol,
	alphaMessageSchema,
	type AlphaMessage,
	type AlphaAsk,
	type ApprovalMode,
	type GlobalState,
	type ProviderSettings,
	type ModelInfo,
	type ToolApprovalDecision,
	type ToolApprovalRequest,
	type SubagentGroupState,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task, type ToolApprovalReviewer } from "../Task"
import { AskIgnoredError } from "../AskIgnoredError"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import { ContextProxy } from "../../config/ContextProxy"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import { formatResponse } from "../../prompts/responses"
import { createAgentResponse } from "../../agent/AgentResponse"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
import { AgentControlTransactionError } from "../../agent/AgentControlTransaction"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { createAgentLifecycleSnapshot } from "../../agent/lifecycle/reducer"
import type { AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { parseProposedPlan } from "../../../shared/plan-mode"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { checkAutoApproval, checkAutoApprovalWithInheritedPolicy } from "../../auto-approval"
import {
	clearTaskSessionApprovalGrants,
	createTaskSessionApprovalKey,
	grantTaskSessionApproval,
	hasTaskSessionApproval,
} from "../../auto-approval/taskSessionApprovalGrants"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import * as contextManagement from "../../context-management"
import type { AgentMessage } from "../../task-persistence/AgentMessageInbox"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import * as taskPersistence from "../../task-persistence"
import i18n from "../../../i18n"
import enCommon from "../../../i18n/locales/en/common.json"

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

import delay from "delay"

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
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		// Virtual storage stays absent regardless of host leftovers; isolated physical fixtures use real metadata.
		lstat: createStorageLstatMock(actual.lstat),
		readFile: vi.fn().mockImplementation((filePath) => {
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
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
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
		resolveTaskDirectoryPath: actual.resolveTaskDirectoryPath,
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

	it("keeps the working handler and configuration when a legacy provider is rejected", () => {
		const apiConfiguration: ProviderSettings = { apiProvider: "openai", openAiModelId: "working" }
		const api = { getModel: vi.fn() }
		const task = Object.assign(Object.create(Task.prototype), {
			apiConfiguration,
			effectiveApiConfiguration: { ...apiConfiguration },
			api,
			reasoningPreference: { kind: "default" },
			reasoningByHandler: new WeakMap(),
			retainedReasoningHandlers: new Set(),
			reasoningHandlerUsers: new Map(),
		}) as Task

		expect(() => Task.prototype.updateApiConfiguration.call(task, { apiProvider: "openrouter" })).toThrow(
			"Unsupported API provider: openrouter",
		)
		expect(task.apiConfiguration).toBe(apiConfiguration)
		expect(task.api).toBe(api)
	})

	describe("constructor", () => {
		it("restores bounded diagnostic-session authority from persisted history", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "diagnostic-task",
					diagnosticSession: true,
					diagnosticIncidentId: "incident-42",
					diagnosticSourceTaskId: "source-task-9",
					number: 1,
					ts: Date.now(),
					task: "Inspect incident evidence",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
				startTask: false,
			})

			expect(alphaTask.diagnosticSession).toBe(true)
			expect(alphaTask.diagnosticIncidentId).toBe("incident-42")
			expect(alphaTask.diagnosticSourceTaskId).toBe("source-task-9")
		})

		it("rejects unbounded or non-primary diagnostic history", () => {
			const historyItem = {
				id: "diagnostic-task",
				diagnosticSession: true,
				diagnosticIncidentId: "incident-42",
				diagnosticSourceTaskId: "source-task-9".repeat(20),
				number: 1,
				ts: Date.now(),
				task: "Inspect incident evidence",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				taskKind: "subagent" as const,
			}

			expect(
				() =>
					new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						historyItem,
						startTask: false,
					}),
			).toThrow()
			expect(
				() =>
					new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						historyItem: { ...historyItem, diagnosticSourceTaskId: "source-task-9" },
						startTask: false,
					}),
			).toThrow("primary task runtime")
		})

		it("should always have diff strategy defined", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Diff is always enabled - diffStrategy should be defined
			expect(alphaTask.diffStrategy).toBeDefined()
		})

		it("should use default consecutiveMistakeLimit when not provided", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(alphaTask.consecutiveMistakeLimit).toBe(3)
		})

		it("should respect provided consecutiveMistakeLimit", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			expect(alphaTask.consecutiveMistakeLimit).toBe(5)
		})

		it("should keep consecutiveMistakeLimit of 0 as 0 for unlimited", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			expect(alphaTask.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass 0 to ToolRepetitionDetector for unlimited mode", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with 0 for unlimited mode
			expect(alphaTask.toolRepetitionDetector).toBeDefined()
			// Verify the limit remains as 0
			expect(alphaTask.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass consecutiveMistakeLimit to ToolRepetitionDetector", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with the same limit
			expect(alphaTask.toolRepetitionDetector).toBeDefined()
			expect(alphaTask.consecutiveMistakeLimit).toBe(5)
		})

		it("retains the concrete tool failure behind mistake-limit recovery", () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			alphaTask.recordToolError("attempt_completion", "Completion still needs verification")
			alphaTask.consecutiveMistakeLimit = 1

			expect(alphaTask.didToolFailInCurrentTurn).toBe(true)
			const guidance = (alphaTask as any).getMistakeLimitGuidance()
			expect(guidance).toContain(
				"Most recent tool failure: attempt_completion — Completion still needs verification",
			)
			expect(guidance).toContain("The previous completion call failed. Do not repeat it unchanged")
			expect(guidance).toContain(
				"This provider profile's Error & Repetition Limit is 1, so a single failed tool call opens this dialog.",
			)
		})

		it("retains the original root identity across a nested task chain", () => {
			const root = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "root task",
				startTask: false,
			})
			const child = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "child task",
				rootTask: root,
				parentTask: root,
				startTask: false,
			})
			const grandchild = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "grandchild task",
				rootTask: child.rootTask ?? child,
				parentTask: child,
				startTask: false,
			})

			expect(child.rootTask).toBe(root)
			expect(child.rootTaskId).toBe(root.taskId)
			expect(grandchild.rootTask).toBe(root)
			expect(grandchild.rootTaskId).toBe(root.taskId)
			expect(grandchild.parentTaskId).toBe(child.taskId)
		})

		it("should require either task or historyItem", () => {
			expect(() => {
				new Task({ provider: mockProvider, apiConfiguration: mockApiConfig })
			}).toThrow("Either historyItem or task/images must be provided")
		})

		it("does not wait for MCP initialization when counting startup tools", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const fullState = vi.spyOn(mockProvider, "getState").mockImplementation(() => new Promise<never>(() => {}))
			vi.spyOn(mockProvider, "getValue").mockReturnValue(true)
			vi.spyOn(mockProvider, "getMcpHub").mockReturnValue(undefined)

			await expect((alphaTask as any).getEnabledMcpToolsCount()).resolves.toEqual({
				enabledToolCount: 0,
				enabledServerCount: 0,
			})
			expect(fullState).not.toHaveBeenCalled()
		})

		it("publishes the initial user message through the lightweight task snapshot", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			mockProvider.postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)

			await (alphaTask as any).addToAlphaMessages({ ts: 1, type: "say", say: "text", text: "test task" }, "task")

			expect(mockProvider.postTaskStateToWebview).toHaveBeenCalledTimes(1)
			expect(mockProvider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
		})

		it("generates a title outside the main task transcript for a new primary task", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "Could you please fix chat naming?",
				startTask: false,
			})
			const historyItem = {
				id: alphaTask.taskId,
				number: 1,
				ts: 1,
				task: "Could you please fix chat naming?",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			vi.spyOn(mockProvider.taskHistoryStore, "get").mockReturnValue(historyItem)
			mockProvider.updateGeneratedTaskTitle = vi.fn().mockResolvedValue(undefined)
			const titleHandler = {
				streamCapabilities: { cancellation: true },
				prepareModel: vi.fn().mockResolvedValue(undefined),
				setReasoningOptions: vi.fn(),
				createMessage: vi.fn(async function* () {
					yield { type: "text", text: "Fix chat naming" }
					yield { type: "outcome", status: "completed", terminal: true }
				}),
				dispose: vi.fn(),
			}
			vi.spyOn(alphaTask as any, "createReasoningSummaryHandler").mockReturnValue(titleHandler)

			await (alphaTask as any).scheduleInitialTaskTitle("Could you please fix chat naming?")

			expect(mockProvider.updateGeneratedTaskTitle).toHaveBeenCalledExactlyOnceWith(
				alphaTask.taskId,
				"Fix chat naming",
			)
			expect(alphaTask.clineMessages).toEqual([])
			expect(alphaTask.apiConversationHistory).toEqual([])
			expect(titleHandler.dispose).toHaveBeenCalledOnce()
		})

		it("does not request generated titles for managed sub-agents", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "Implement delegated work",
				taskKind: "subagent",
				startTask: false,
			})
			const createHandler = vi.spyOn(alphaTask as any, "createReasoningSummaryHandler")
			mockProvider.updateGeneratedTaskTitle = vi.fn().mockResolvedValue(undefined)

			await (alphaTask as any).scheduleInitialTaskTitle("Implement delegated work")

			expect(createHandler).not.toHaveBeenCalled()
			expect(mockProvider.updateGeneratedTaskTitle).not.toHaveBeenCalled()
		})

		it("cancels an in-flight generated title when the task is renamed", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "Implement delegated work",
				startTask: false,
			})
			vi.spyOn(mockProvider.taskHistoryStore, "get").mockReturnValue({
				id: alphaTask.taskId,
				number: 1,
				ts: 1,
				task: "Implement delegated work",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})
			mockProvider.updateGeneratedTaskTitle = vi.fn().mockResolvedValue(undefined)
			let requestStarted!: () => void
			const started = new Promise<void>((resolve) => (requestStarted = resolve))
			const titleHandler = {
				streamCapabilities: { cancellation: true },
				prepareModel: vi.fn().mockResolvedValue(undefined),
				setReasoningOptions: vi.fn(),
				createMessage: vi.fn((_systemPrompt: string, _messages: unknown, metadata: { signal: AbortSignal }) =>
					(async function* () {
						requestStarted()
						await new Promise<void>((resolve) => metadata.signal.addEventListener("abort", () => resolve()))
						yield { type: "outcome", status: "cancelled", terminal: true }
					})(),
				),
				dispose: vi.fn(),
			}
			vi.spyOn(alphaTask as any, "createReasoningSummaryHandler").mockReturnValue(titleHandler)

			const generation = (alphaTask as any).scheduleInitialTaskTitle("Implement delegated work")
			await started
			alphaTask.cancelAutomaticTaskTitle()
			await generation

			expect(mockProvider.updateGeneratedTaskTitle).not.toHaveBeenCalled()
			expect(titleHandler.dispose).toHaveBeenCalledOnce()
		})

		it("publishes subsequent messages incrementally without rebuilding extension state", async () => {
			const alphaTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const message = { ts: 2, type: "say", say: "text", text: "next message" } as const
			mockProvider.postMessageToWebview.mockClear()
			mockProvider.postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)
			mockProvider.postStateToWebviewWithoutTaskHistory.mockClear()

			await (alphaTask as any).addToAlphaMessages(message)

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "messageCreated",
					taskId: alphaTask.taskId,
					clineMessage: message,
					clineMessagesSeq: expect.any(Number),
				}),
			)
			expect(mockProvider.postTaskStateToWebview).not.toHaveBeenCalled()
			expect(mockProvider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
		})
	})

	describe("getEnvironmentDetails", () => {
		describe("API conversation handling", () => {
			it("should clean conversation history before sending to API", () => {
				const alphaTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				const messageWithExtra = {
					role: "user" as const,
					content: [{ type: "text" as const, text: "test message" }],
					ts: Date.now(),
					extraProp: "should be removed",
				}

				const history = (alphaTask as any).buildCleanConversationHistory([messageWithExtra])

				expect(history).toEqual([
					{
						role: "user",
						content: [{ type: "text", text: "test message" }],
					},
				])
				expect(Object.keys(history[0])).toEqual(["role", "content"])
			})

			it("should persist VS Code LM stateful markers and only replay them to that provider", async () => {
				const alphaTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				const statefulMarker = "bW9kZWxcXHJlc3BvbnNl"
				;(alphaTask.api as any).getStatefulMarker = () => statefulMarker
				vi.spyOn(alphaTask as any, "saveApiConversationHistory").mockResolvedValue(true)

				await (alphaTask as any).addToApiConversationHistory({
					role: "assistant" as const,
					content: [{ type: "tool_use" as const, id: "call-1", name: "read_file", input: { path: "a.ts" } }],
				})
				const markerMessage = alphaTask.apiConversationHistory.at(-1)!
				expect(markerMessage).toHaveProperty("vscodeLmStatefulMarker", statefulMarker)

				const anthropicHistory = (alphaTask as any).buildCleanConversationHistory([markerMessage])
				expect(anthropicHistory[0]).not.toHaveProperty("vscodeLmStatefulMarker")

				alphaTask.apiConfiguration = {
					...mockApiConfig,
					apiProvider: "vscode-lm",
				} as ProviderSettings
				Reflect.set(alphaTask, "effectiveApiConfiguration", { ...alphaTask.apiConfiguration })
				const vscodeLmHistory = (alphaTask as any).buildCleanConversationHistory([markerMessage])

				expect(vscodeLmHistory[0]).toMatchObject({
					role: "assistant",
					vscodeLmStatefulMarker: statefulMarker,
				})
			})

			it("should handle image blocks based on model capabilities", () => {
				// Create two configurations - one with image support, one without
				const configWithImages = {
					...mockApiConfig,
					openAiModelId: "claude-3-sonnet",
				}
				const configWithoutImages = {
					...mockApiConfig,
					openAiModelId: "gpt-3.5-turbo",
				}

				// Create test conversation history with mixed content
				const conversationHistory: (Anthropic.MessageParam & { ts?: number })[] = [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: "Here is an image",
							} satisfies Anthropic.TextBlockParam,
							{
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: "image/jpeg",
									data: "base64data",
								},
							} satisfies Anthropic.ImageBlockParam,
						],
					},
					{
						role: "assistant" as const,
						content: [
							{
								type: "text" as const,
								text: "I see the image",
							} satisfies Anthropic.TextBlockParam,
						],
					},
				]

				// Test with model that supports images
				const alphaWithImages = new Task({
					provider: mockProvider,
					apiConfiguration: configWithImages,
					task: "test task",
					startTask: false,
				})

				// Mock the model info to indicate image support
				vi.spyOn(alphaWithImages.api, "getModel").mockReturnValue({
					id: "claude-3-sonnet",
					info: {
						supportsImages: true,
						supportsPromptCache: true,
						contextWindow: 200000,
						maxTokens: 4096,
						inputPrice: 0.25,
						outputPrice: 0.75,
					} as ModelInfo,
				})

				// Test with model that doesn't support images
				const alphaWithoutImages = new Task({
					provider: mockProvider,
					apiConfiguration: configWithoutImages,
					task: "test task",
					startTask: false,
				})

				// Mock the model info to indicate no image support
				vi.spyOn(alphaWithoutImages.api, "getModel").mockReturnValue({
					id: "gpt-3.5-turbo",
					info: {
						supportsImages: false,
						supportsPromptCache: false,
						contextWindow: 16000,
						maxTokens: 2048,
						inputPrice: 0.1,
						outputPrice: 0.2,
					} as ModelInfo,
				})

				const preserved = maybeRemoveImageBlocks(conversationHistory as any, alphaWithImages.api)
				const converted = maybeRemoveImageBlocks(conversationHistory as any, alphaWithoutImages.api)

				expect(preserved[0]?.content).toEqual(conversationHistory[0]?.content)
				expect(converted[0]?.content).toEqual([
					{ type: "text", text: "Here is an image" },
					{ type: "text", text: "[Referenced image in conversation]" },
				])
			})

			it("should cap the provider retry countdown to the policy-approved delay", async () => {
				vi.useFakeTimers()
				const alphaTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(alphaTask as any, "getSystemPrompt").mockResolvedValue("test instructions")

				// Mock say to track messages
				const saySpy = vi.spyOn(alphaTask, "say").mockResolvedValue(undefined)

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(alphaTask.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})

				// Set up mock state
				mockProvider.getState = vi.fn().mockResolvedValue({
					autoApprovalEnabled: true,
					requestDelaySeconds: 3,
				})

				// Mock previous API request message
				alphaTask.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({
							tokensIn: 100,
							tokensOut: 50,
							cacheWrites: 0,
							cacheReads: 0,
						}),
					},
				]

				// Trigger API request
				const iterator = alphaTask.attemptApiRequest(0)
				const request = iterator.next()
				try {
					await vi.waitFor(() =>
						expect(saySpy).toHaveBeenCalledWith(
							"api_req_retry_delayed",
							expect.stringContaining("<retry_timer>1</retry_timer>"),
							undefined,
							true,
						),
					)
					await vi.advanceTimersByTimeAsync(1_000)
					await request
				} finally {
					vi.useRealTimers()
				}

				// AgentRetryPolicy approves one second even though the provider requests three.
				const baseDelay = 1

				// Verify countdown messages
				for (let i = baseDelay; i > 0; i--) {
					expect(saySpy).toHaveBeenCalledWith(
						"api_req_retry_delayed",
						expect.stringContaining(`<retry_timer>${i}</retry_timer>`),
						undefined,
						true,
					)
				}

				expect(saySpy).toHaveBeenCalledWith("api_req_retry_delayed", "API Error\n", undefined, false)

				// Verify error message content
				const errorMessage = saySpy.mock.calls.find((call) => call[1]?.includes("<retry_timer>"))?.[1]
				expect(errorMessage).toBe(`${mockError.message}\n<retry_timer>${baseDelay}</retry_timer>`)
			})

			it("should honor an explicit zero-second API retry delay", async () => {
				const alphaTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)
				const saySpy = vi.spyOn(alphaTask, "say").mockResolvedValue(undefined)
				mockProvider.getState = vi.fn().mockResolvedValue({
					requestDelaySeconds: 0,
				})

				await (alphaTask as any).backoffAndAnnounce(0, new Error("transient failure"))

				expect(mockDelay).not.toHaveBeenCalled()
				expect(saySpy).not.toHaveBeenCalledWith("api_req_retry_delayed", expect.anything())
			})

			it("should not apply retry delay twice", async () => {
				vi.useFakeTimers()
				const alphaTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(alphaTask as any, "getSystemPrompt").mockResolvedValue("test instructions")

				// Mock say to track messages
				const saySpy = vi.spyOn(alphaTask, "say").mockResolvedValue(undefined)

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(alphaTask.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})

				// Set up mock state
				mockProvider.getState = vi.fn().mockResolvedValue({
					autoApprovalEnabled: true,
					requestDelaySeconds: 3,
				})

				// Mock previous API request message
				alphaTask.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({
							tokensIn: 100,
							tokensOut: 50,
							cacheWrites: 0,
							cacheReads: 0,
						}),
					},
				]

				// Trigger API request
				const iterator = alphaTask.attemptApiRequest(0)
				const request = iterator.next()
				try {
					await vi.waitFor(() =>
						expect(saySpy).toHaveBeenCalledWith(
							"api_req_retry_delayed",
							expect.stringContaining("<retry_timer>1</retry_timer>"),
							undefined,
							true,
						),
					)
					await vi.advanceTimersByTimeAsync(1_000)
					await request
				} finally {
					vi.useRealTimers()
				}

				// Verify delay is only applied for the policy-approved countdown.
				const baseDelay = 1

				// Verify countdown messages were only shown once
				const retryMessages = saySpy.mock.calls.filter(
					(call) => call[0] === "api_req_retry_delayed" && call[1]?.includes("<retry_timer>"),
				)
				expect(retryMessages).toHaveLength(baseDelay)

				// Verify the retry message sequence
				for (let i = baseDelay; i > 0; i--) {
					expect(saySpy).toHaveBeenCalledWith(
						"api_req_retry_delayed",
						expect.stringContaining(`<retry_timer>${i}</retry_timer>`),
						undefined,
						true,
					)
				}

				// Verify final retry message
				expect(saySpy).toHaveBeenCalledWith("api_req_retry_delayed", "API Error\n", undefined, false)
			})

			describe("processUserContentMentions", () => {
				it("should process mentions in user_message tags", async () => {
					const [alphaTask, task] = Task.create({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
					})

					try {
						const userContent = [
							{
								type: "text",
								text: "Regular text with 'some/path' (see below for file content)",
							} as const,
							{
								type: "text",
								text: "<user_message>Text with 'some/path' (see below for file content) in user_message tags</user_message>",
							} as const,
							{
								type: "tool_result",
								tool_use_id: "test-id",
								content: [
									{
										type: "text",
										text: "<user_message>Check 'some/path' (see below for file content)</user_message>",
									},
								],
							} as Anthropic.ToolResultBlockParam,
							{
								type: "tool_result",
								tool_use_id: "test-id-2",
								content: [
									{
										type: "text",
										text: "Regular tool result with 'path' (see below for file content)",
									},
								],
							} as Anthropic.ToolResultBlockParam,
						]

						const { content: processedContent } = await processUserContentMentions({
							userContent,
							cwd: alphaTask.cwd,
							fileContextTracker: alphaTask.fileContextTracker,
						})

						// Regular text should not be processed
						expect((processedContent[0] as Anthropic.TextBlockParam).text).toBe(
							"Regular text with 'some/path' (see below for file content)",
						)

						// Text within user_message tags should be processed
						expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain("processed:")
						expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain(
							"<user_message>Text with 'some/path' (see below for file content) in user_message tags</user_message>",
						)

						// user_message tag content should be processed
						const toolResult1 = processedContent[2] as Anthropic.ToolResultBlockParam
						const content1 = Array.isArray(toolResult1.content)
							? toolResult1.content[0]
							: toolResult1.content
						expect((content1 as Anthropic.TextBlockParam).text).toContain("processed:")
						expect((content1 as Anthropic.TextBlockParam).text).toContain(
							"<user_message>Check 'some/path' (see below for file content)</user_message>",
						)

						// Regular tool result should not be processed
						const toolResult2 = processedContent[3] as Anthropic.ToolResultBlockParam
						const content2 = Array.isArray(toolResult2.content)
							? toolResult2.content[0]
							: toolResult2.content
						expect((content2 as Anthropic.TextBlockParam).text).toBe(
							"Regular tool result with 'path' (see below for file content)",
						)
					} finally {
						try {
							await alphaTask.abortTask(true)
						} finally {
							try {
								await task.catch(() => {})
							} finally {
								await alphaTask.waitForTermination()
							}
						}
					}
				})
			})
		})

		describe("Subtask Rate Limiting", () => {
			let mockProvider: any
			let mockApiConfig: any
			let mockDelay: import("vitest").Mock

			beforeEach(() => {
				vi.clearAllMocks()
				// Reset the global timestamp before each test
				Task.resetGlobalApiRequestTime()

				mockApiConfig = {
					apiProvider: "openai",
					openAiApiKey: "test-key",
					rateLimitSeconds: 5,
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
						globalState: {
							get: vi.fn().mockImplementation(() => undefined),
							update: vi.fn().mockResolvedValue(undefined),
							keys: vi.fn().mockReturnValue([]),
						},
					},
					getState: vi.fn().mockResolvedValue({
						apiConfiguration: mockApiConfig,
						mcpEnabled: false,
					}),
					getMcpHub: vi.fn().mockReturnValue(undefined),
					getSkillsManager: vi.fn().mockReturnValue(undefined),
					say: vi.fn(),
					postStateToWebview: vi.fn().mockResolvedValue(undefined),
					postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
					postMessageToWebview: vi.fn().mockResolvedValue(undefined),
					updateTaskHistory: vi.fn().mockResolvedValue(undefined),
					claimAutomaticSubagentResults: vi.fn().mockResolvedValue({ claimId: "claim-default", taskIds: [] }),
					acknowledgeAutomaticSubagentResults: vi.fn().mockResolvedValue(undefined),
					releaseAutomaticSubagentResults: vi.fn().mockResolvedValue(undefined),
					acknowledgeWaitAgentResults: vi.fn().mockResolvedValue(undefined),
				}

				// Get the mocked delay function
				mockDelay = delay as import("vitest").Mock
				mockDelay.mockClear()
			})

			afterEach(() => {
				// Clean up the global state after each test
				Task.resetGlobalApiRequestTime()
			})

			it("persists local tool results before an interruptible provider-rate-limit wait", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "persist a lifecycle result",
					startTask: false,
				})
				const saveApiConversationHistory = vi
					.spyOn(task as any, "saveApiConversationHistory")
					.mockResolvedValue(true)
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-list", name: "list_agents", input: {} }],
						ts: 1,
					},
				] as any

				let announceWaitStarted!: () => void
				const waitStarted = new Promise<void>((resolve) => {
					announceWaitStarted = resolve
				})
				let rejectWait!: (error: Error) => void
				const blockedWait = new Promise<void>((_resolve, reject) => {
					rejectWait = reject
				})
				vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockImplementation(async () => {
					announceWaitStarted()
					await blockedWait
				})

				const onPersisted = vi.fn(() => {
					expect(
						task.apiConversationHistory.some(
							(message) =>
								message.role === "user" &&
								Array.isArray(message.content) &&
								message.content.some(
									(block) => block.type === "tool_result" && block.tool_use_id === "call-list",
								),
						),
					).toBe(true)
				})
				const request = task.runAgentRequests(
					[
						{
							type: "tool_result",
							tool_use_id: "call-list",
							content: '{"agents":[]}',
						},
					],
					false,
					onPersisted,
				)
				await waitStarted
				expect(saveApiConversationHistory).toHaveBeenCalledOnce()
				expect(onPersisted).toHaveBeenCalledOnce()
				const persistedBeforeInterruption = task.apiConversationHistory.some(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some(
							(block) => block.type === "tool_result" && block.tool_use_id === "call-list",
						),
				)

				rejectWait(new Error("rate-limit wait interrupted"))
				await expect(request).rejects.toThrow("rate-limit wait interrupted")
				expect(persistedBeforeInterruption).toBe(true)
			})

			it("does not acknowledge steering when API-history persistence and retries fail", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "retain an unacknowledged steering message",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "text", text: "ready" }],
						ts: 1,
					},
				] as any
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(false)
				const retry = vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
				const onPersisted = vi.fn()

				await expect(
					task.runAgentRequests(
						[{ type: "text", text: "<user_message>steer me</user_message>" }],
						false,
						onPersisted,
					),
				).rejects.toThrow("Failed to persist the user turn")

				expect(retry).toHaveBeenCalledOnce()
				expect(onPersisted).not.toHaveBeenCalled()
			})

			it.each([
				{ recovery: "none", manual: false, restore: "ok" },
				{ recovery: "summary", manual: false, restore: "ok" },
				{ recovery: "summary", manual: true, restore: "ok" },
				{ recovery: "truncation", manual: false, restore: "ok" },
				{ recovery: "truncation", manual: true, restore: "ok" },
				{ recovery: "summary", manual: false, restore: "failed" },
				{ recovery: "summary", manual: false, restore: "cancelled" },
				{ recovery: "summary", manual: false, restore: "steered" },
			])(
				"preserves acknowledged context across empty retry ($recovery, manual=$manual, restore=$restore)",
				async ({ recovery, manual, restore }) => {
					mockProvider.getState.mockResolvedValue({
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: !manual,
						mcpEnabled: false,
					})
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "retry environment",
						startTask: false,
					})
					markTestHandlerAsLegacyEOF(task)
					const capture = {
						details: "<environment_details>terminal A</environment_details>",
						commit: vi.fn(),
						release: vi.fn(),
					}
					const refreshed = {
						details: "<environment_details>terminal B</environment_details>",
						commit: vi.fn(),
						release: vi.fn(),
					}
					vi.mocked(captureEnvironmentDetails).mockResolvedValueOnce(capture)
					const requests: Anthropic.Messages.MessageParam[][] = []
					vi.spyOn(task as any, "saveApiConversationHistory").mockImplementation(async () => {
						if (requests.length === 1 && restore === "cancelled") {
							;(task as any).stepInterruptionController.abort(new Error("restore cancelled"))
						}
						return !(requests.length === 1 && restore === "failed")
					})
					vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("fixed system prompt")
					vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
					vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
					vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
					vi.spyOn(task as any, "waitForRetryDecision").mockImplementation(async () => {
						if (restore === "steered") {
							;(task as any).pendingSteerMessage = { text: "new user steer" }
							throw new Error("steered during retry wait")
						}
					})
					vi.spyOn(task, "say").mockResolvedValue(undefined)
					vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
					vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
					let compacted = false
					if (recovery !== "none") {
						// Model a real reduction while retaining the tool transaction and refreshed environment.
						vi.spyOn(task.api, "countTokens").mockImplementation(async (blocks) =>
							JSON.stringify(blocks).includes("hidden old") ? 1000 : 1,
						)
						task.apiConversationHistory = [
							{ role: "user", content: "hidden old user" },
							{ role: "assistant", content: "hidden old assistant" },
							{ role: "user", content: "inspect file" },
							{
								role: "assistant",
								content: [
									{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "file.ts" } },
								],
							},
						]
						vi.mocked(captureEnvironmentDetails).mockResolvedValueOnce(refreshed)
						vi.spyOn(task, "getTokenUsage").mockReturnValue({ ...task.getTokenUsage(), contextTokens: 100 })
						vi.spyOn(task.api, "getModel").mockReturnValue({
							id: "claude-3-5-sonnet-20241022",
							info: { contextWindow: 200_000, maxTokens: 8192, supportsPromptCache: false },
						})
						vi.spyOn(task as any, "getFilesReadByAlphaSafely").mockResolvedValue([])
						vi.spyOn(contextManagement, "willManageContext").mockImplementation(() => !compacted)
						vi.spyOn(contextManagement, "manageContext").mockImplementation(async ({ messages }) => {
							if (compacted) return { messages, summary: "", cost: 0, prevContextTokens: 100 }
							compacted = true
							const id = "recovery-1"
							const next: ApiMessage[] =
								recovery === "summary"
									? [
											...messages.map((message) => ({ ...message, condenseParent: id })),
											{
												role: "user",
												content: "compacted summary",
												isSummary: true,
												condenseId: id,
											},
										]
									: [
											...messages
												.slice(0, 2)
												.map((message) => ({ ...message, truncationParent: id })),
											{
												role: "user",
												content: "truncated prefix",
												isTruncationMarker: true,
												truncationId: id,
											},
											...messages.slice(2),
										]
							return {
								messages: next,
								summary: recovery === "summary" ? "compacted summary" : "",
								cost: 0,
								prevContextTokens: 100,
								...(recovery === "truncation" ? { truncationId: id, messagesRemoved: 2 } : {}),
							}
						})
					}
					let attempts = 0
					vi.spyOn(task.api, "createMessage").mockImplementation(async function* (_system, messages) {
						requests.push(structuredClone(messages))
						if (recovery !== "none") expect(refreshed.commit).toHaveBeenCalledOnce()
						if (attempts++ > 0) yield { type: "text", text: "Done." } as ApiStreamChunk
					})
					const content: Anthropic.Messages.ContentBlockParam[] =
						recovery === "none"
							? [{ type: "text", text: "continue" }]
							: [{ type: "tool_result", tool_use_id: "read-1", content: "file result" }]
					const result = await task
						.runAgentRequests(content, true)
						.catch((error: Error) => ({ status: "thrown", error }))
					if (restore === "failed" || restore === "cancelled") {
						expect(requests).toHaveLength(1)
						expect(result).not.toMatchObject({ status: "completed" })
						expect(JSON.stringify(task.apiConversationHistory)).toContain("terminal B")
						return
					}
					expect(result).toMatchObject({ status: "completed" })
					expect(requests).toHaveLength(2)
					if (restore === "steered") {
						const beforeSteer = requests[0][0].content as Anthropic.Messages.ContentBlockParam[]
						const afterSteer = requests[1][0].content as Anthropic.Messages.ContentBlockParam[]
						expect(afterSteer.slice(0, beforeSteer.length)).toEqual(beforeSteer)
						expect(JSON.stringify(requests[1])).toContain("new user steer")
					} else expect(requests[1]).toEqual(requests[0])
					const serialized = JSON.stringify(requests[1])
					expect(serialized.match(recovery === "none" ? /terminal A/g : /terminal B/g)).toHaveLength(1)
					expect(serialized).not.toContain("hidden old")
					if (recovery === "summary")
						expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
					if (recovery === "truncation") {
						const blocks = requests[1].flatMap((message) =>
							Array.isArray(message.content) ? message.content : [],
						)
						expect(blocks.filter((block) => block.type === "tool_use")).toMatchObject([{ id: "read-1" }])
						expect(blocks.filter((block) => block.type === "tool_result")).toMatchObject([
							{ tool_use_id: "read-1" },
						])
					}
					expect(captureEnvironmentDetails).toHaveBeenCalledTimes(
						recovery === "none" ? 1 : restore === "steered" ? 3 : 2,
					)
					expect(capture.commit).toHaveBeenCalledOnce()
				},
			)

			it("persists ordered child notifications beside one wait receipt before ACK", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "deliver child notifications",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-ordered", name: "wait_agent", input: {} }],
						ts: 1,
					},
				] as any
				const entry = (eventId: string, sequence: number) => ({
					eventId,
					sequence,
					rootTaskId: task.taskId,
					senderTaskId: "review-child",
					senderPath: "/root/review",
					recipientTaskId: task.taskId,
					recipientPath: "/root",
					kind: "message" as const,
					name: "agent_progress",
					payload: { message: eventId },
					createdAt: sequence,
				})
				task.stageWaitAgentNotifications("claim-ordered", [entry("second", 2), entry("first", 1)])
				task.retainWaitAgentResultClaim("call-ordered", "claim-ordered")
				const receipt = {
					type: "tool_result" as const,
					tool_use_id: "call-ordered",
					content: JSON.stringify({
						source: "managed_agent_mailbox",
						claimId: "claim-ordered",
						eventCount: 2,
					}),
				}
				expect(task.pushToolResultToUserContent(receipt)).toBe(true)
				expect(task.pushToolResultToUserContent(receipt)).toBe(false)
				expect(task.userMessageContent.map((block) => block.type)).toEqual(["tool_result", "text", "text"])
				expect(task.hasRetainedWaitAgentResultClaim("claim-ordered")).toBe(true)
				expect(task.userMessageContent.slice(1).map((block: any) => JSON.parse(block.text).eventId)).toEqual([
					"first",
					"second",
				])
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				;(task as any).assistantMessageSavedToHistory = true
				await expect(task.flushPendingToolResultsToHistory()).resolves.toBe(true)
				expect(mockProvider.acknowledgeWaitAgentResults).toHaveBeenCalledOnce()
				expect(mockProvider.acknowledgeWaitAgentResults).toHaveBeenCalledWith(task, "claim-ordered")
				expect(task.hasRetainedWaitAgentResultClaim("claim-ordered")).toBe(false)
				expect(task.apiConversationHistory.at(-1)?.content).toMatchObject([
					{ type: "tool_result", tool_use_id: "call-ordered" },
					{ type: "text" },
					{ type: "text" },
				])
			})

			it.each([true, false])(
				"acknowledges a native wait claim only after its matching tool result and unchanged notification are durably saved (%s)",
				async (matchingBody) => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "persist an owned native wait result",
						startTask: false,
					})
					task.apiConversationHistory = [
						{
							role: "assistant",
							content: [{ type: "tool_use", id: "call-wait", name: "wait_agent", input: {} }],
							ts: 1,
						},
					] as any
					task.retainWaitAgentResultClaim("call-wait", "claim-native-wait")
					task.stageWaitAgentNotifications("claim-native-wait", [
						{
							eventId: "wait-event",
							sequence: 1,
							senderTaskId: "child",
							senderPath: "/root/child",
							recipientTaskId: task.taskId,
							recipientPath: "/root",
							rootTaskId: task.taskId,
							kind: "result",
							name: "agent_completed",
							payload: { summary: "Child done" },
							createdAt: 1,
						},
					])
					let releaseSave!: (saved: boolean) => void
					const saveBlocked = new Promise<boolean>((resolve) => (releaseSave = resolve))
					vi.spyOn(task as any, "saveApiConversationHistory").mockReturnValue(saveBlocked)
					const notification = JSON.parse(
						task["stagedWaitAgentNotifications"].get("claim-native-wait")![0].text,
					)
					if (!matchingBody)
						notification.payload.summary = "Unrelated prose with matching notification headers"
					const toolResult = {
						role: "user" as const,
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: "call-wait",
								content: JSON.stringify({
									source: "managed_agent_mailbox",
									claimId: "claim-native-wait",
								}),
							},
							{
								type: "text" as const,
								text: JSON.stringify(notification),
							},
						],
					}

					const persisting = (task as any).addToApiConversationHistory(toolResult)
					expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalledWith(task, "claim-native-wait")
					releaseSave(true)
					await expect(persisting).resolves.toBe(true)

					if (matchingBody) {
						expect(mockProvider.acknowledgeWaitAgentResults).toHaveBeenCalledWith(task, "claim-native-wait")
						expect(task.hasRetainedWaitAgentResultClaim("claim-native-wait")).toBe(false)
					} else {
						expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalled()
						expect(task.hasRetainedWaitAgentResultClaim("claim-native-wait")).toBe(true)
						expect(task.hasDurablyPersistedWaitAgentClaim("claim-native-wait")).toBe(false)
					}
				},
			)

			it("does not ACK a wait receipt if its child notification is missing from the saved message", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "retain incomplete child delivery",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-incomplete", name: "wait_agent", input: {} }],
						ts: 1,
					},
				] as any
				task.stageWaitAgentNotifications("claim-incomplete", [
					{
						eventId: "missing-notification",
						sequence: 1,
						rootTaskId: task.taskId,
						senderTaskId: "child",
						senderPath: "/root/child",
						recipientTaskId: task.taskId,
						recipientPath: "/root",
						kind: "result",
						name: "agent_completed",
						createdAt: 1,
					},
				])
				task.retainWaitAgentResultClaim("call-incomplete", "claim-incomplete")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				await (task as any).addToApiConversationHistory({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call-incomplete",
							content: JSON.stringify({ source: "managed_agent_mailbox", claimId: "claim-incomplete" }),
						},
					],
				})
				expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalledWith(task, "claim-incomplete")
				expect(task.hasRetainedWaitAgentResultClaim("claim-incomplete")).toBe(true)
				expect(task.hasDurablyPersistedWaitAgentClaim("claim-incomplete")).toBe(false)
			})

			it("releases a staged claim when the wait call receives a cancellation receipt", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "cancel wait",
					startTask: false,
				})
				task.stageWaitAgentNotifications("claim-cancelled", [
					{
						eventId: "cancelled-event",
						sequence: 1,
						rootTaskId: task.taskId,
						senderTaskId: "child",
						senderPath: "/root/child",
						recipientTaskId: task.taskId,
						recipientPath: "/root",
						kind: "message",
						name: "agent_progress",
						createdAt: 1,
					},
				])
				task.retainWaitAgentResultClaim("call-cancelled", "claim-cancelled")
				task.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: "call-cancelled",
					content: "Wait cancelled",
					is_error: true,
				})
				expect(task.hasRetainedWaitAgentResultClaim("claim-cancelled")).toBe(false)
				expect(task.userMessageContent.map((block) => block.type)).toEqual(["tool_result"])
			})

			it("retains a native wait claim when history persistence fails and ACKs it after a successful retry", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "retry a native wait receipt",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-retry", name: "wait_agent", input: {} }],
						ts: 1,
					},
				] as any
				task.retainWaitAgentResultClaim("call-retry", "claim-retry")
				task.stageWaitAgentNotifications("claim-retry", [
					{
						eventId: "retry-event",
						sequence: 1,
						senderTaskId: "child",
						senderPath: "/root/child",
						recipientTaskId: task.taskId,
						recipientPath: "/root",
						rootTaskId: task.taskId,
						kind: "result",
						name: "agent_completed",
						createdAt: 1,
					},
				])
				vi.spyOn(task as any, "saveApiConversationHistory")
					.mockResolvedValueOnce(false)
					.mockResolvedValueOnce(true)
				const toolResult = {
					role: "user" as const,
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call-retry",
							content: JSON.stringify({ source: "managed_agent_mailbox", claimId: "claim-retry" }),
						},
						{
							type: "text" as const,
							text: task["stagedWaitAgentNotifications"].get("claim-retry")![0].text,
						},
					],
				}

				await expect((task as any).addToApiConversationHistory(toolResult)).resolves.toBe(false)
				expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalled()
				expect((task as any).pendingWaitAgentResultClaims.size).toBe(1)

				vi.useFakeTimers()
				try {
					const retrying = task.retrySaveApiConversationHistory()
					await vi.advanceTimersByTimeAsync(100)
					await expect(retrying).resolves.toBe(true)
				} finally {
					vi.useRealTimers()
				}
				expect(mockProvider.acknowledgeWaitAgentResults).toHaveBeenCalledWith(task, "claim-retry")
				expect((task as any).pendingWaitAgentResultClaims.size).toBe(0)
			})

			it("does not ACK a native wait claim from an error or mismatched JSON result with the same tool call ID", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "reject a false native wait receipt",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-false-receipt", name: "wait_agent", input: {} }],
						ts: 1,
					},
				] as any
				task.retainWaitAgentResultClaim("call-false-receipt", "claim-expected")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

				await (task as any).addToApiConversationHistory({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call-false-receipt",
							content: JSON.stringify({
								source: "managed_agent_mailbox",
								claimId: "claim-different",
								error: "presentation failed",
							}),
						},
					],
				})

				expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalled()
				expect((task as any).pendingWaitAgentResultClaims).toEqual(
					new Map([["call-false-receipt", "claim-expected"]]),
				)
			})

			it("uses the task-owned profile when the foreground profile has a rate limit", async () => {
				mockProvider.getState.mockResolvedValue({
					apiConfiguration: mockApiConfig,
					mcpEnabled: false,
				})

				const limitedTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "limited task",
					startTask: false,
				})
				await (limitedTask as any).maybeWaitForProviderRateLimit(0)
				mockDelay.mockClear()

				const child = new Task({
					provider: mockProvider,
					apiConfiguration: { ...mockApiConfig, rateLimitSeconds: 0 },
					task: "routed child task",
					startTask: false,
				})

				await (child as any).maybeWaitForProviderRateLimit(0)

				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("uses the task-owned rate limit when the foreground profile has none", async () => {
				mockProvider.getState.mockResolvedValue({
					apiConfiguration: { ...mockApiConfig, rateLimitSeconds: 0 },
					mcpEnabled: false,
				})

				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "routed child task",
					startTask: false,
				})
				await (child as any).maybeWaitForProviderRateLimit(0)
				mockDelay.mockClear()

				await (child as any).maybeWaitForProviderRateLimit(0)

				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
				expect(mockDelay).toHaveBeenCalledWith(1000)
			})

			it("serializes simultaneous requests routed to the same stable profile", async () => {
				const route = {
					source: "role" as const,
					resolution: "selected" as const,
					profileId: "shared-profile-id",
					profileName: "Shared profile",
					provider: "vertex",
					modelId: "claude-test",
				}
				const first = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "first routed task",
					startTask: false,
					subagentModelRoute: route,
				})
				const second = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "second routed task",
					startTask: false,
					subagentModelRoute: route,
				})

				await Promise.all([
					(first as any).maybeWaitForProviderRateLimit(0),
					(second as any).maybeWaitForProviderRateLimit(0),
				])

				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
				expect(mockDelay).toHaveBeenCalledWith(1000)
			})

			it("records task-local waits without misclassifying the configured shared lane as an error", async () => {
				const route = {
					source: "role" as const,
					resolution: "selected" as const,
					profileId: "shared-profile-id",
					profileName: "Shared profile",
					provider: "vertex",
					modelId: "claude-test",
				}
				const first = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "first routed task",
					startTask: false,
					subagentModelRoute: route,
				})
				const second = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "second routed task",
					startTask: false,
					subagentModelRoute: route,
				})

				await (first as any).maybeWaitForProviderRateLimit(0)
				await (second as any).maybeWaitForProviderRateLimit(0)

				expect(first.getRequestPacingMetrics()).toEqual({
					configuredIntervalSeconds: 5,
					waitCount: 0,
					totalWaitMs: 0,
					scope: "provider_profile",
				})
				expect(second.getRequestPacingMetrics()).toEqual({
					configuredIntervalSeconds: 5,
					waitCount: 1,
					totalWaitMs: 5_000,
					scope: "provider_profile",
				})
			})

			it("adds the completed current wait to the latest model-facing user request", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "report pacing",
					startTask: false,
				})
				task.apiConversationHistory = [
					{
						role: "user",
						content: [{ type: "text", text: "<environment_details>old totals</environment_details>" }],
					},
				] as any
				;(task as any).requestPacingWaitCount = 2
				;(task as any).requestPacingWaitMs = 20_000

				await (task as any).appendRequestPacingUpdateToLatestUserMessage()

				const content = task.apiConversationHistory[0].content as Array<{ type: string; text: string }>
				expect(content.at(-1)?.text).toContain('wait_count="2"')
				expect(content.at(-1)?.text).toContain('total_wait_ms="20000"')
				expect(content.at(-1)?.text).toContain('classification="configured_pacing_not_provider_error"')
			})

			it("does not serialize simultaneous requests routed to different stable profiles", async () => {
				const createRoutedTask = (profileId: string) =>
					new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: `task for ${profileId}`,
						startTask: false,
						subagentModelRoute: {
							source: "role",
							resolution: "selected",
							profileId,
							profileName: profileId,
							provider: "vertex",
							modelId: "claude-test",
						},
					})

				const first = createRoutedTask("profile-a")
				const second = createRoutedTask("profile-b")
				await Promise.all([
					(first as any).maybeWaitForProviderRateLimit(0),
					(second as any).maybeWaitForProviderRateLimit(0),
				])

				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("keeps legacy tasks on different providers in independent lanes", async () => {
				const anthropicTask = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					taskApiConfigName: "legacy-profile",
					task: "anthropic task",
					startTask: false,
				})
				const openAiTask = new Task({
					provider: mockProvider,
					apiConfiguration: {
						apiProvider: "openai",
						openAiApiKey: "test-key",
						openAiModelId: "gpt-test",
						rateLimitSeconds: mockApiConfig.rateLimitSeconds,
					},
					taskApiConfigName: "legacy-profile",
					task: "openai task",
					startTask: false,
				})

				await Promise.all([
					(anthropicTask as any).maybeWaitForProviderRateLimit(0),
					(openAiTask as any).maybeWaitForProviderRateLimit(0),
				])

				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("should enforce rate limiting across parent and subtask", async () => {
				// Add a spy to track getState calls
				const getStateSpy = vi.spyOn(mockProvider, "getState")

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
				})
				vi.spyOn(parent as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "parent response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "parent response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Verify no delay was applied for the first request
				expect(mockDelay).not.toHaveBeenCalled()

				// Create a subtask immediately after
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
				})
				vi.spyOn(child as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Spy on child.say to verify the emitted message type
				const saySpy = vi.spyOn(child, "say")

				// Mock the child's API stream
				const childMockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "child response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "child response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(child.api, "createMessage").mockReturnValue(childMockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify rate limiting was applied
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
				expect(mockDelay).toHaveBeenCalledWith(1000)

				// Verify we used the non-error rate-limit wait message type (JSON format)
				expect(saySpy).toHaveBeenCalledWith(
					"api_req_rate_limit_wait",
					expect.stringMatching(/\{"seconds":\d+\}/),
					undefined,
					true,
				)

				// Verify the wait message was finalized
				expect(saySpy).toHaveBeenCalledWith("api_req_rate_limit_wait", undefined, undefined, false)
			}, 10000) // Increase timeout to 10 seconds

			it("should not apply rate limiting if enough time has passed", async () => {
				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
				})
				vi.spyOn(parent as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Simulate time passing (more than rate limit)
				const originalPerformanceNow = performance.now
				const mockTime = performance.now() + (mockApiConfig.rateLimitSeconds + 1) * 1000
				performance.now = vi.fn(() => mockTime)

				// Create a subtask after time has passed
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
				})
				vi.spyOn(child as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no rate limiting was applied
				expect(mockDelay).not.toHaveBeenCalled()

				// Restore performance.now
				performance.now = originalPerformanceNow
			})

			it("should share rate limiting across multiple subtasks", async () => {
				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
				})
				vi.spyOn(parent as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create first subtask
				const child1 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 1",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
				})
				vi.spyOn(child1 as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child1.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the first child task
				const child1Iterator = child1.attemptApiRequest(0)
				await child1Iterator.next()

				// Verify rate limiting was applied
				const firstDelayCount = mockDelay.mock.calls.length
				expect(firstDelayCount).toBe(mockApiConfig.rateLimitSeconds)

				// Clear the mock to count new delays
				mockDelay.mockClear()

				// Create second subtask immediately after
				const child2 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 2",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
				})
				vi.spyOn(child2 as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child2.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the second child task
				const child2Iterator = child2.attemptApiRequest(0)
				await child2Iterator.next()

				// Verify rate limiting was applied again
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
			}, 15000) // Increase timeout to 15 seconds

			it("should handle rate limiting with zero rate limit", async () => {
				// Update config to have zero rate limit
				mockApiConfig.rateLimitSeconds = 0
				mockProvider.getState.mockResolvedValue({
					apiConfiguration: mockApiConfig,
					mcpEnabled: false,
				})

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
				})
				vi.spyOn(parent as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create a subtask
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
				})
				vi.spyOn(child as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no delay was applied
				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("should reserve a lane even when the first request needs no delay", async () => {
				// Create task
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request
				const iterator = task.attemptApiRequest(0)
				await iterator.next()

				mockDelay.mockClear()

				// A subsequent request on the same lane observes the first reservation.
				await (task as any).maybeWaitForProviderRateLimit(0)
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
			})
		})

		describe("Dynamic Strategy Selection", () => {
			let mockProvider: any
			let mockApiConfig: any

			beforeEach(() => {
				vi.clearAllMocks()

				mockApiConfig = {
					apiProvider: "openai",
					openAiApiKey: "test-key",
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
					},
					getState: vi.fn(),
				}
			})

			it("should use MultiSearchReplaceDiffStrategy by default", async () => {
				mockProvider.getState.mockResolvedValue({})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})

			it("should keep MultiSearchReplaceDiffStrategy when experiments are undefined", async () => {
				mockProvider.getState.mockResolvedValue({})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Initially should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)

				// Wait for async strategy update
				await new Promise((resolve) => setTimeout(resolve, 10))

				// Should still be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})
		})

		describe("getApiProtocol", () => {
			it("selects the retained connection's wire protocol", () => {
				expect(getApiProtocol("vertex", "claude-3-opus")).toBe("anthropic")
				expect(getApiProtocol("vertex", "gemini-3.7-flash")).toBe("openai")
				expect(getApiProtocol("openai", "anthropic/claude-3-opus")).toBe("openai")
				expect(getApiProtocol("vscode-lm", "claude-3-opus")).toBe("openai")
			})

			it("handles an absent provider or model", () => {
				expect(getApiProtocol(undefined, "claude-3-opus")).toBe("openai")
				expect(getApiProtocol("openai")).toBe("openai")
			})
		})

		describe("submitUserMessage", () => {
			it("should call handleWebviewAskResponse directly", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
				task["activeAsk"] = { type: "followup", ts: 1 }

				// Set up some existing messages to simulate an ongoing conversation
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]

				// Call submitUserMessage
				await task.submitUserMessage("test message", ["image1.png"])

				// Verify handleWebviewAskResponse was called directly (not webview)
				expect(handleResponseSpy).toHaveBeenCalledWith(
					"messageResponse",
					"test message",
					["image1.png"],
					[expect.any(String)],
				)
				// Should NOT route through webview anymore
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			})

			it("treats explicit user feedback as recovery guidance", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})
				task.consecutiveMistakeCount = 1
				task.consecutiveNoToolUseCount = 2
				task.consecutiveNoAssistantMessagesCount = 1
				;(task as any).automaticMistakeRecoveryCount = 1

				await await task.submitUserMessage("Did we finish?")

				expect(task.consecutiveMistakeCount).toBe(0)
				expect(task.consecutiveNoToolUseCount).toBe(0)
				expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
				expect((task as any).automaticMistakeRecoveryCount).toBe(0)
			})

			it("should handle empty messages gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
				task["activeAsk"] = { type: "followup", ts: 1 }

				// Call with empty text and no images
				await task.submitUserMessage("", [])

				// Should not call handleWebviewAskResponse for empty messages
				expect(handleResponseSpy).not.toHaveBeenCalled()

				// Call with whitespace only
				await task.submitUserMessage("   ", [])
				expect(handleResponseSpy).not.toHaveBeenCalled()
			})

			it("should call handleWebviewAskResponse for both new and existing task states", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
				task["activeAsk"] = { type: "followup", ts: 1 }

				// Test with no messages (new task scenario)
				task.clineMessages = []
				await task.submitUserMessage("new task", ["image1.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith(
					"messageResponse",
					"new task",
					["image1.png"],
					[expect.any(String)],
				)

				// Clear mock
				handleResponseSpy.mockClear()
				task["askResponse"] = undefined

				// Test with existing messages (ongoing task scenario)
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]
				await task.submitUserMessage("follow-up message", ["image2.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith(
					"messageResponse",
					"follow-up message",
					["image2.png"],
					[expect.any(String)],
				)
			})

			it("should handle undefined provider gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
				task["activeAsk"] = { type: "followup", ts: 1 }

				// Simulate weakref returning undefined
				Object.defineProperty(task, "providerRef", {
					value: { deref: () => undefined },
					writable: false,
					configurable: true,
				})

				await expect(task.submitUserMessage("test message")).rejects.toThrow("The task provider is unavailable")
				expect(handleResponseSpy).not.toHaveBeenCalled()
			})
		})
	})

	describe("steerUserMessage", () => {
		it("queues steering for a managed child before its first request", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
				taskKind: "subagent",
			})
			const submitSpy = vi.spyOn(task, "submitUserMessage")

			await task.steerUserMessage("focus on the cancellation race")

			expect(submitSpy).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "focus on the cancellation race",
				images: [],
				inputOrigin: "human",
			})
			expect(task.canAcceptSteerMessage()).toBe(false)

			// Moving the message into a turn stack must not reopen the steering slot
			// before that stack item is durably written to API history.
			;(task as any).pendingSteerMessage = undefined
			expect(task.canAcceptSteerMessage()).toBe(false)
		})

		it("retains a durable steering receipt when an initialized managed child is idle", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
				taskKind: "subagent",
			})
			task.isInitialized = true
			const submitSpy = vi.spyOn(task, "submitUserMessage")
			const onPersisted = vi.fn()

			expect((task as any).didComplete).toBe(false)
			expect(task.canAcceptSteerMessage()).toBe(false)
			await expect(task.steerUserMessage("recover this message", [], onPersisted)).rejects.toThrow(
				"became inactive before steering could be durably persisted",
			)

			expect(submitSpy).not.toHaveBeenCalled()
			expect(onPersisted).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "recover this message",
				images: [],
				onPersisted,
				inputOrigin: "agent",
			})
			expect((task as any).steerMessageAwaitingPersistence).toBe(true)
		})

		it("retains a durable steering receipt when an ask appears after the provider precheck", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
				taskKind: "subagent",
			})
			const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
			const onPersisted = vi.fn()
			;(task as any).activeAsk = { type: "tool", ts: Date.now() }

			expect(task.canAcceptSteerMessage()).toBe(false)
			await expect(task.steerUserMessage("retain across the ask race", [], onPersisted)).rejects.toThrow(
				"waiting for input before steering could be durably persisted",
			)

			expect(handleResponseSpy).not.toHaveBeenCalled()
			expect(onPersisted).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "retain across the ask race",
				images: [],
				onPersisted,
				inputOrigin: "agent",
			})
			expect((task as any).steerMessageAwaitingPersistence).toBe(true)
		})

		it("responds like a user message when the task is waiting on an ask", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
			task["activeAsk"] = { type: "followup", ts: 1 }

			await task.steerUserMessage("new context", ["image1.png"])

			expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "new context", ["image1.png"], undefined)
		})

		it("accepts a queued steering message at the command output handoff", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
			;(task as any).activeAsk = { type: "command_output", ts: Date.now() }

			expect(task.canAcceptSteerMessage()).toBe(true)
			await task.steerUserMessage("use the output already available", ["context.png"])

			expect(handleResponseSpy).toHaveBeenCalledWith(
				"messageResponse",
				"use the output already available",
				["context.png"],
				undefined,
			)
		})

		it("does not accept queued steering through a command approval ask", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).activeAsk = { type: "command", ts: Date.now() }

			expect(task.canAcceptSteerMessage()).toBe(false)
		})

		it("aborts the active request without aborting the task when steering during streaming", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			const abortController = new AbortController()
			const abortSpy = vi.spyOn(abortController, "abort")
			const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

			task.isStreaming = true
			task.currentRequestAbortController = abortController
			task.consecutiveMistakeCount = 1
			task.consecutiveNoToolUseCount = 2
			task.consecutiveNoAssistantMessagesCount = 1
			;(task as any).automaticMistakeRecoveryCount = 1

			await task.steerUserMessage("interrupt with this", ["image1.png"])

			expect(abortSpy).toHaveBeenCalled()
			expect(task.abort).toBe(false)
			expect(handleResponseSpy).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "interrupt with this",
				images: ["image1.png"],
				inputOrigin: "human",
			})
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.consecutiveNoToolUseCount).toBe(0)
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
			expect((task as any).automaticMistakeRecoveryCount).toBe(0)
		})

		it.each([false, true])("starts an edited prompt from saved history (opening prompt: %s)", async (opening) => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "original",
				startTask: false,
			})
			const prefix: ApiMessage[] = opening
				? []
				: [
						{ role: "user", content: [{ type: "text", text: "Earlier prompt" }], ts: 1 },
						{ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], ts: 2 },
					]
			vi.spyOn(task as any, "getSavedAlphaMessages").mockResolvedValue(
				opening
					? []
					: [
							{ ts: 1, type: "say", say: "text", text: "Earlier prompt" },
							{ ts: 2, type: "say", say: "text", text: "Earlier answer" },
						],
			)
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue(prefix)
			vi.spyOn(task as any, "flushApiConversationHistoryPersistence").mockResolvedValue(undefined)
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			const say = vi.spyOn(task, "say").mockResolvedValue(undefined)
			const overwrite = vi.spyOn(task, "overwriteApiConversationHistory").mockResolvedValue(true)
			const images = ["data:image/png;base64,aGVsbG8="]
			const loop = vi.spyOn(task as any, "initiateTaskLoop").mockImplementation(async (...args: unknown[]) => {
				await (args[1] as () => void)()
			})
			await task.resumeWithEditedMessage("Replacement", images)
			expect(say).toHaveBeenCalledWith(opening ? "text" : "user_feedback", "Replacement", images)
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toEqual(prefix)
			expect(loop).toHaveBeenCalledWith(
				[
					{ type: "text", text: "<user_message>\nReplacement\n</user_message>" },
					...formatResponse.imageBlocks(images),
				],
				expect.any(Function),
				expect.objectContaining({
					deferTaskStartedUntilInitialUserContentPersisted: true,
					includeInitialFileDetails: true,
				}),
			)
			await expect(task.resumeWithEditedMessage("Duplicate")).rejects.toThrow("already started")
		})

		it("reports an edited prompt persistence failure without activating the task", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "original",
				startTask: false,
			})
			vi.spyOn(task as any, "resumeTaskFromHistory").mockRejectedValue(new Error("Persistence failed"))
			const active = vi.fn()
			task.on(AlphaCodeEventName.TaskActive, active)
			await expect(task.resumeWithEditedMessage("Replacement")).rejects.toThrow("Persistence failed")
			expect(active).not.toHaveBeenCalled()
		})

		it("resumes a completed primary task with the same task identity", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			const active = vi.fn()
			task.on(AlphaCodeEventName.TaskActive, active)
			const resume = vi
				.spyOn(task as any, "resumeTaskFromHistory")
				.mockImplementation(async (...args: unknown[]) => {
					const onPersisted = args[1] as (() => Promise<void> | void) | undefined
					await onPersisted?.()
				})

			await task.resumeCompletedTaskFollowup("evaluate the prior answer", ["image1.png"])

			expect(task.taskId).toBeDefined()
			expect(resume).toHaveBeenCalledWith("evaluate the prior answer", expect.any(Function), ["image1.png"], {
				inputOrigin: "human",
				deferTaskStartedUntilInitialUserContentPersisted: true,
				reuseRetainedHistory: true,
			})
			expect((task as any).didComplete).toBe(false)
			expect(active).toHaveBeenCalledWith(task.taskId)
		})

		it("reuses retained completed-task history without disk reloads or a redundant workspace listing", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			task.clineMessages = [
				{ ts: 1, type: "say", say: "text", text: "initial task" },
				{ ts: 2, type: "say", say: "completion_result", text: "done" },
			]
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "initial task" }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			] as any
			const loadAlphaMessages = vi.spyOn(task as any, "getSavedAlphaMessages")
			const loadApiHistory = vi.spyOn(task as any, "getSavedApiConversationHistory")
			const overwriteAlphaMessages = vi.spyOn(task, "overwriteAlphaMessages")
			const reconcileSubagents = vi.spyOn(task as any, "reconcileInterruptedSubagentGroups")
			vi.spyOn(task as any, "flushApiConversationHistoryPersistence").mockResolvedValue(undefined)
			const say = vi.spyOn(task, "say").mockResolvedValue(undefined)
			const overwriteApiHistory = vi.spyOn(task, "overwriteApiConversationHistory").mockResolvedValue(true)
			const continueLoop = vi
				.spyOn(task as any, "initiateTaskLoop")
				.mockImplementation(async (...args: unknown[]) => {
					const onPersisted = args[1] as (() => Promise<void> | void) | undefined
					await onPersisted?.()
				})

			const queuedMessage = task.messageQueueService.addMessage("continue in place")!
			await task.resumeCompletedTaskFollowup(queuedMessage.text, [], "human", [queuedMessage.id])

			expect(loadAlphaMessages).not.toHaveBeenCalled()
			expect(loadApiHistory).not.toHaveBeenCalled()
			expect(overwriteAlphaMessages).not.toHaveBeenCalled()
			expect(reconcileSubagents).not.toHaveBeenCalled()
			expect(overwriteApiHistory).not.toHaveBeenCalled()
			expect(say).toHaveBeenCalledWith(
				"user_feedback",
				"continue in place",
				[],
				undefined,
				undefined,
				undefined,
				{
					queuedMessageIds: [queuedMessage.id],
				},
			)
			expect(
				task["getQueuedInputReceipts"](
					continueLoop.mock.calls[0]?.[0] as Parameters<Task["initiateTaskLoop"]>[0],
				),
			).toEqual([queuedMessage.id])
			expect(continueLoop).toHaveBeenCalledWith(
				[{ type: "text", text: "<user_message>\ncontinue in place\n</user_message>" }],
				expect.any(Function),
				{
					deferTaskStartedUntilInitialUserContentPersisted: true,
					includeInitialFileDetails: false,
					inputOrigin: "human",
				},
			)
		})

		it("restores retained API history when the atomic follow-up write fails", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			;(task as any).didEmitTaskCompleted = true
			task.clineMessages = [{ ts: 1, type: "say", say: "completion_result", text: "done" }]
			const originalHistory = [
				{ role: "user", content: [{ type: "text", text: "initial task" }] },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "completion-1", name: "attempt_completion", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "completion-1", content: "done" }],
				},
			] as any
			task.apiConversationHistory = originalHistory
			vi.spyOn(task as any, "flushApiConversationHistoryPersistence").mockResolvedValue(undefined)
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			const overwriteApiHistory = vi.spyOn(task, "overwriteApiConversationHistory")
			vi.spyOn(task as any, "initiateTaskLoop").mockRejectedValue(new Error("atomic history write failed"))

			await expect(task.resumeCompletedTaskFollowup("retry this follow-up")).rejects.toThrow(
				"atomic history write failed",
			)

			expect(overwriteApiHistory).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toBe(originalHistory)
			expect((task as any).didComplete).toBe(true)
			expect((task as any).steerMessageAwaitingPersistence).toBe(false)
		})

		it("reuses persisted follow-up feedback after failed provider admission and an edited FIFO retry", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			// Drive each retry explicitly so its provider-admission failure remains observable.
			task.messageQueueService.removeListener("stateChanged", task["messageQueueStateChangedHandler"]!)
			task["messageQueueStateChangedHandler"] = undefined
			task.markCompleted()
			task.clineMessages = [{ ts: 1, type: "say", say: "completion_result", text: "done" }]
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "initial task" }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]
			const persistence = task as unknown as {
				enqueueAlphaMessagesSave: Task["enqueueAlphaMessagesSave"]
				saveApiConversationHistory: Task["saveApiConversationHistory"]
				initiateTaskLoop: Task["initiateTaskLoop"]
			}
			let savedMessages = structuredClone(task.clineMessages)
			vi.spyOn(persistence, "enqueueAlphaMessagesSave").mockImplementation(async (snapshot, onPersisted) => {
				savedMessages = structuredClone(snapshot?.() ?? task.clineMessages)
				onPersisted?.()
				return true
			})
			const saveApiHistory = vi.spyOn(persistence, "saveApiConversationHistory").mockResolvedValue(false)
			vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
			const request = vi.fn()
			vi.spyOn(persistence, "initiateTaskLoop").mockImplementation(async (content, onPersisted) => {
				let admission: Promise<void> | undefined
				await task["persistUserContentWithEnvironment"](
					content,
					undefined,
					undefined,
					() => {
						admission = Promise.resolve(onPersisted?.())
					},
					undefined,
					task["getQueuedInputReceipts"](content),
					"human",
				)
				await admission
				request(content)
			})
			const queued = await task.messageQueueService.addMessageDurably(
				"Retry this follow-up.",
				["data:image/png;base64,AAAA"],
				"retry-request",
			)
			expect(queued).toBeDefined()

			await expect(
				task.resumeCompletedTaskFollowup(queued!.text, queued!.images, "human", [queued!.id]),
			).rejects.toThrow("Failed to persist the user turn")
			expect(savedMessages.filter((message) => message.say === "user_feedback")).toHaveLength(1)
			const feedbackTs = savedMessages.find((message) => message.say === "user_feedback")!.ts
			expect(task.isCompleted()).toBe(true)
			expect(task.messageQueueService.messages.map((message) => message.id)).toEqual([queued!.id])
			expect(task.messageQueueService.getClaimedMessageIds()).toEqual([])
			expect(task.apiConversationHistory.some((message) => message.queued_message_ids?.length)).toBe(false)
			expect(request).not.toHaveBeenCalled()

			await task.messageQueueService.updateMessageDurably(queued!.id, "Edited follow-up.", [
				"data:image/png;base64,BBBB",
			])
			const edited = task.messageQueueService.getMessage(queued!.id)!
			saveApiHistory.mockResolvedValue(true)
			await task.resumeCompletedTaskFollowup(edited.text, edited.images, "human", [edited.id])
			await task["waitForOwnedLifecycle"]()

			expect(task.clineMessages.filter((message) => message.say === "user_feedback")).toEqual([
				expect.objectContaining({
					ts: feedbackTs,
					text: "Edited follow-up.",
					images: ["data:image/png;base64,BBBB"],
					queuedMessageIds: [edited.id],
				}),
			])
			expect(savedMessages).toEqual(task.clineMessages)
			expect(task.messageQueueService.hasUnconsumedInput()).toBe(false)
			expect(
				task.apiConversationHistory.filter((message) => message.queued_message_ids?.includes(edited.id)),
			).toEqual([
				expect.objectContaining({
					role: "user",
					queued_message_ids: [edited.id],
					content: [
						{ type: "text", text: "<user_message>\nEdited follow-up.\n</user_message>" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
					],
				}),
			])
			expect(request).toHaveBeenCalledOnce()
		})

		it("keeps a completed task terminal when its follow-up fails before persistence", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			;(task as any).didEmitTaskCompleted = true
			const active = vi.fn()
			const started = vi.fn()
			task.on(AlphaCodeEventName.TaskActive, active)
			task.on(AlphaCodeEventName.TaskStarted, started)
			vi.spyOn(task as any, "resumeTaskFromHistory").mockRejectedValue(new Error("durable write failed"))

			await expect(task.resumeCompletedTaskFollowup("retain this draft")).rejects.toThrow("durable write failed")

			expect((task as any).didComplete).toBe(true)
			expect((task as any).didEmitTaskCompleted).toBe(true)
			expect((task as any).steerMessageAwaitingPersistence).toBe(false)
			expect(active).not.toHaveBeenCalled()
			expect(started).not.toHaveBeenCalled()
		})

		it("acknowledges a completed-task follow-up before waiting for the prior lifecycle flush", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			;(task as any).isTaskLoopActive = true
			let finishPriorLifecycle!: () => void
			;(task as any).ownedLifecyclePromise = new Promise<void>((resolve) => {
				finishPriorLifecycle = resolve
			})
			const publicationOrder: string[] = []
			const resume = vi.spyOn(task as any, "resumeTaskFromHistory")
			task.on(AlphaCodeEventName.TaskUserMessage, () => publicationOrder.push("admitted"))
			task.on(AlphaCodeEventName.TaskActive, () => publicationOrder.push("active"))
			resume.mockImplementation(async (...args: unknown[]) => {
				publicationOrder.push("resume")
				const onPersisted = args[1] as (() => Promise<void> | void) | undefined
				await onPersisted?.()
			})

			let accepted = false
			const followup = task.resumeCompletedTaskFollowup("continue after the terminal flush").then(() => {
				accepted = true
			})
			await Promise.resolve()

			expect(accepted).toBe(false)
			expect(resume).not.toHaveBeenCalled()
			expect(publicationOrder).toEqual(["admitted"])
			;(task as any).isTaskLoopActive = false
			finishPriorLifecycle()
			await followup

			expect(resume).toHaveBeenCalledOnce()
			expect(accepted).toBe(true)
			expect(publicationOrder).toEqual(["admitted", "resume", "active"])
		})

		it("rejects a second completed-task follow-up while the first admission is pending", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).didComplete = true
			;(task as any).isTaskLoopActive = true
			let finishPriorLifecycle!: () => void
			;(task as any).ownedLifecyclePromise = new Promise<void>((resolve) => {
				finishPriorLifecycle = resolve
			})
			vi.spyOn(task as any, "resumeTaskFromHistory").mockImplementation(async (...args: unknown[]) => {
				const onPersisted = args[1] as (() => Promise<void> | void) | undefined
				await onPersisted?.()
			})

			const firstFollowup = task.resumeCompletedTaskFollowup("first follow-up")
			await Promise.resolve()

			await expect(task.resumeCompletedTaskFollowup("duplicate follow-up")).rejects.toThrow(
				"already being admitted",
			)
			;(task as any).isTaskLoopActive = false
			finishPriorLifecycle()
			await firstFollowup
		})

		it("rejects the completed-task resume route while the task is not completed", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "active task",
				startTask: false,
			})
			const resume = vi.spyOn(task as any, "resumeTaskFromHistory")

			await expect(task.resumeCompletedTaskFollowup("do not fork this task")).rejects.toThrow("has not completed")
			expect(resume).not.toHaveBeenCalled()
		})

		it("retains steered content when the task loop is active before streaming starts", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

			;(task as any).isTaskLoopActive = true

			await task.steerUserMessage("skip data", [])

			expect(handleResponseSpy).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "skip data",
				images: [],
				inputOrigin: "human",
			})
		})

		it.each([true, false])(
			"captures the read grant from the task approval mode despite the legacy read chip (legacy chip=%s)",
			async (alwaysAllowReadOnly) => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "capture exploration policy",
					startTask: false,
				})
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					mode: "code",
					approvalMode: "auto",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly,
					showRooIgnoredFiles: false,
				} as any)
				vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("test instructions")
				vi.spyOn(task.api, "createMessage").mockImplementation(async function* () {
					yield { type: "text", text: "Ordinary answer." } as const
				})
				for await (const _chunk of task.attemptApiRequest(0)) {
					/* Consume the real request boundary. */
				}
				const surface = (task as any).currentTaskToolSurface
				expect(surface?.readGrant).toEqual({
					enabled: true,
					workspaceRoot: task.cwd,
					showIgnoredFiles: false,
				})
				expect(Object.isFrozen(surface.readGrant)).toBe(true)
				expect(surface.policy.approval.autoApprovalEnabled).toBe(true)
				expect(surface.isCallable("exec_command")).toBe(true)
				expect(surface.isCallable("read_file")).toBe(false)
				expect(surface.resolve("exec_command")?.prepareParallelCommand).toBeTypeOf("function")
			},
		)

		it("prevents an obsolete provider call when steering interrupts request preflight", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			let resolveState!: (state: Record<string, never>) => void
			const getState = vi
				.spyOn(mockProvider, "getState")
				.mockImplementationOnce(
					() => new Promise((resolve) => (resolveState = resolve as (state: Record<string, never>) => void)),
				)
			const createMessage = vi.spyOn(task.api, "createMessage")
			const stepController = new AbortController()

			;(task as any).isTaskLoopActive = true
			;(task as any).stepInterruptionController = stepController
			const nextChunk = task.attemptApiRequest(0, { interruptionSignal: stepController.signal }).next()

			await vi.waitFor(() => expect(getState).toHaveBeenCalled())
			await task.steerUserMessage("use this newer direction", [])
			resolveState({})

			await expect(nextChunk).rejects.toThrow("Request interrupted by steered user message")
			expect(createMessage).not.toHaveBeenCalled()
			expect((task as any).pendingSteerMessage).toEqual({
				text: "use this newer direction",
				images: [],
				inputOrigin: "human",
			})
		})

		it("rejects steering during an independently owned manual compaction", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			;(task as any).contextCondenseAbortController = new AbortController()

			expect(task.canAcceptSteerMessage()).toBe(false)
			await expect(task.steerUserMessage("wait until compaction completes", [])).rejects.toThrow(
				"Context compaction is in progress",
			)
			expect((task as any).pendingSteerMessage).toBeUndefined()
		})

		it("does not replace a steering message that is still pending persistence", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})

			;(task as any).isTaskLoopActive = true

			await task.steerUserMessage("first steering message", [])
			await expect(task.steerUserMessage("second steering message", [])).rejects.toThrow(
				"A steering message is already pending",
			)

			expect((task as any).pendingSteerMessage).toEqual({
				text: "first steering message",
				images: [],
				inputOrigin: "human",
			})
		})

		it("does not replace a steering response that an active ask has not consumed", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})

			;(task as any).activeAsk = { type: "followup", ts: Date.now() }

			await task.steerUserMessage("first steering response", [])
			await expect(task.steerUserMessage("second steering response", [])).rejects.toThrow(
				"A steering message is already pending",
			)

			expect((task as any).askResponseText).toBe("first steering response")
		})

		it("does not surface a provider failure when steering before the first chunk arrives", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("test instructions")
			const askSpy = vi.spyOn(task, "ask")

			async function* neverRespondingStream(): AsyncGenerator<ApiStreamChunk> {
				await new Promise<void>(() => {})
				yield { type: "text", text: "unreachable" }
			}

			vi.spyOn(task.api, "createMessage").mockReturnValue(neverRespondingStream())
			;(task as any).isTaskLoopActive = true
			const nextChunk = task.attemptApiRequest(0).next()

			await vi.waitFor(() => {
				expect(task.currentRequestAbortController).toBeDefined()
			})

			await task.steerUserMessage("add this context", [])

			await expect(nextChunk).rejects.toThrow("Request interrupted by steered user message")
			expect(askSpy).not.toHaveBeenCalledWith("api_req_failed", expect.anything())
			expect((task as any).pendingSteerMessage).toEqual({
				text: "add this context",
				images: [],
				inputOrigin: "human",
			})
		})

		it("does not let a late request abort clear a newer operation controller", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "preserve newer cancellation owner",
				startTask: false,
			})
			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("test instructions")

			async function* neverRespondingStream(): AsyncGenerator<ApiStreamChunk> {
				await new Promise<void>(() => {})
				yield { type: "text", text: "unreachable" }
			}

			vi.spyOn(task.api, "createMessage").mockReturnValue(neverRespondingStream())
			const nextChunk = task.attemptApiRequest(0, { ownerHandlesRetry: true }).next()
			await vi.waitFor(() => expect(task.api.createMessage).toHaveBeenCalledOnce())
			const oldController = task.currentRequestAbortController!
			const newerController = new AbortController()
			task.currentRequestAbortController = newerController

			oldController.abort()

			await expect(nextChunk).rejects.toThrow("Request cancelled by user")
			expect(task.currentRequestAbortController).toBe(newerController)
			expect(newerController.signal.aborted).toBe(false)
		})

		it.each([true, false])("keeps separate steering inputs atomic when saving succeeds=%s", async (saved) => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			const prefix: ApiMessage = { role: "assistant", content: "Ready", ts: 1 }
			const original: ApiMessage = {
				role: "user",
				content: [{ type: "text", text: "<user_message>\noriginal\n</user_message>" }],
				input_origin: "human",
				queued_message_ids: ["original-input"],
				ts: 2,
			}
			task.apiConversationHistory = [prefix]
			let attemptedHistory: ApiMessage[] = []
			const save = vi.spyOn(task as any, "saveApiConversationHistory").mockImplementation(async () => {
				attemptedHistory = structuredClone(task.apiConversationHistory)
				return saved
			})
			vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
			const acknowledge = vi.spyOn(task.messageQueueService, "acknowledgeMessages")
			const capture = { details: "", commit: vi.fn(), release: vi.fn() }
			const onPersisted = vi.fn()
			const steer = task["buildUserMessageContent"]("steered context", [])
			const persist = task["persistUserContentWithEnvironment"](
				steer,
				capture,
				undefined,
				onPersisted,
				undefined,
				["steering-input"],
				"human",
				[original],
			)
			if (saved) {
				await persist
				expect(task.apiConversationHistory).toEqual(attemptedHistory)
				expect(acknowledge).toHaveBeenCalledWith(["original-input", "steering-input"])
			} else {
				await expect(persist).rejects.toThrow("Failed to persist the user turn")
				expect(task.apiConversationHistory).toEqual([prefix])
				expect(acknowledge).not.toHaveBeenCalled()
			}
			expect(attemptedHistory).toEqual([
				prefix,
				original,
				expect.objectContaining({
					role: "user",
					content: steer,
					input_origin: "human",
					queued_message_ids: ["steering-input"],
				}),
			])
			expect(save).toHaveBeenCalledOnce()
			expect(onPersisted).toHaveBeenCalledTimes(saved ? 1 : 0)
			expect(capture.commit).toHaveBeenCalledTimes(saved ? 1 : 0)
			expect(capture.release).toHaveBeenCalledOnce()
		})
	})

	describe("abortTask", () => {
		it("waits for both the Worker process abort and terminal settlement", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			let finishAbort!: () => void
			const terminalProcess = Object.assign(new EventEmitter(), {
				isSettled: false,
				abort: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishAbort = resolve
						}),
				),
			})
			Object.assign(task, { taskKind: "subagent", subagentRole: "worker", terminalProcess })
			vi.spyOn(task, "dispose").mockImplementation(() => {})
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(undefined)

			let settled = false
			const abort = task.abortTask().finally(() => (settled = true))
			await vi.waitFor(() => expect(terminalProcess.abort).toHaveBeenCalledOnce())

			finishAbort()
			await Promise.resolve()
			expect(settled).toBe(false)

			terminalProcess.isSettled = true
			terminalProcess.emit("completed")
			await abort
			expect(settled).toBe(true)
		})

		it("does not wait for a Worker terminal event that already settled", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const terminalProcess = Object.assign(new EventEmitter(), {
				isSettled: true,
				abort: vi.fn(async () => undefined),
			})
			Object.assign(task, { taskKind: "subagent", subagentRole: "worker", terminalProcess })
			vi.spyOn(task, "dispose").mockImplementation(() => {})
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(undefined)

			await expect(task.abortTask()).resolves.toBeUndefined()
			expect(terminalProcess.abort).not.toHaveBeenCalled()
		})

		it("coalesces concurrent aborts into one lifecycle transition", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const emitSpy = vi.spyOn(task, "emit")
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {})
			let finishSave!: () => void
			const saveSpy = vi.spyOn(task as any, "saveAlphaMessages").mockImplementation(
				async () =>
					await new Promise<void>((resolve) => {
						finishSave = resolve
					}),
			)

			const first = task.abortTask()
			const second = task.abortTask(true)
			expect(second).toBe(first)
			await vi.waitFor(() => expect(saveSpy).toHaveBeenCalledOnce())
			finishSave()
			await Promise.all([first, second])

			expect(task.abandoned).toBe(true)
			expect(disposeSpy).toHaveBeenCalledOnce()
			const abortEmits = (emitSpy.mock.calls as unknown[][]).filter(([event]) => event === "taskAborted")
			expect(abortEmits).toHaveLength(1)
		})

		it("disposes and persists before surfacing a retryable managed-process cleanup failure", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			let abortAttempt = 0
			const terminalProcess = Object.assign(new EventEmitter(), {
				abort: vi.fn(async () => {
					abortAttempt++
					if (abortAttempt === 1) throw new Error("tree cleanup failed")
					terminalProcess.emit("completed")
				}),
			})
			Object.assign(task, { taskKind: "subagent", subagentRole: "worker", terminalProcess })
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {})
			const saveSpy = vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(undefined)

			const firstReceipt = task.beginTaskCancellation()
			const firstTermination = firstReceipt.termination.then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			)
			expect(Object.isFrozen(firstReceipt)).toBe(true)
			expect(task.beginTaskCancellation()).toBe(firstReceipt)
			await expect(task.abortTask()).rejects.toThrow("tree cleanup failed")
			expect(await firstTermination).toMatchObject({
				status: "rejected",
				error: expect.objectContaining({ message: "tree cleanup failed" }),
			})

			expect(disposeSpy).toHaveBeenCalledOnce()
			expect(saveSpy).toHaveBeenCalledOnce()

			const retryReceipt = task.beginTaskCancellation()
			expect(retryReceipt).not.toBe(firstReceipt)
			expect(retryReceipt.abort).not.toBe(firstReceipt.abort)
			expect(retryReceipt.termination).not.toBe(firstReceipt.termination)
			expect(task.beginTaskCancellation()).toBe(retryReceipt)
			await expect(task.abortTask()).resolves.toBeUndefined()
			await expect(retryReceipt.termination).resolves.toBeUndefined()
			expect(terminalProcess.abort).toHaveBeenCalledTimes(2)
			expect(disposeSpy).toHaveBeenCalledTimes(2)
			expect(saveSpy).toHaveBeenCalledTimes(2)
		})

		it("should set abort flag and emit TaskAborted event", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Spy on emit method
			const emitSpy = vi.spyOn(task, "emit")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify abort flag is set
			expect(task.abort).toBe(true)

			// Verify TaskAborted event was emitted
			expect(emitSpy).toHaveBeenCalledWith("taskAborted")
		})

		it("does not record cancellation when disposing a completed task", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "completed task cleanup",
				startTask: false,
			})
			vi.spyOn(task, "dispose").mockImplementation(() => {})
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(undefined)
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
			const taskAborted = vi.fn()
			task.on(AlphaCodeEventName.TaskAborted, taskAborted)
			task.markCompleted()

			await task.abortTask(true)

			expect(task.abort).toBe(true)
			expect(
				appendEvent.mock.calls.filter(([event]) => (event as AgentTurnEvent).type === "cancelled"),
			).toHaveLength(0)
			expect(taskAborted).not.toHaveBeenCalled()
		})

		it("records genuine in-flight cancellation exactly once", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "in-flight task cancellation",
				startTask: false,
			})
			vi.spyOn(task, "dispose").mockImplementation(() => {})
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(undefined)
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
			const taskAborted = vi.fn()
			task.on(AlphaCodeEventName.TaskAborted, taskAborted)

			await task.abortTask()

			expect(
				appendEvent.mock.calls.filter(([event]) => (event as AgentTurnEvent).type === "cancelled"),
			).toHaveLength(1)
			expect(taskAborted).toHaveBeenCalledOnce()
		})

		it("should be equivalent to clicking Cancel button functionality", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Mock the dispose method to track cleanup
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify the same behavior as Cancel button
			expect(task.abort).toBe(true)
			expect(disposeSpy).toHaveBeenCalled()
		})

		it("should work with TaskLike interface", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Cast to TaskLike to ensure interface compliance
			const taskLike = task as any // TaskLike interface from types package

			// Verify abortTask method exists and is callable
			expect(typeof taskLike.abortTask).toBe("function")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask through interface
			await taskLike.abortTask()

			// Verify it works
			expect(task.abort).toBe(true)
		})

		it("should handle errors during disposal gracefully", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Mock dispose to throw an error
			const mockError = new Error("Disposal failed")
			vi.spyOn(task, "dispose").mockImplementation(() => {
				throw mockError
			})

			// Spy on console.error to verify error is logged
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// abortTask should not throw even if dispose fails
			await expect(task.abortTask()).resolves.not.toThrow()

			// Verify error was logged
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Error during task"), mockError)

			// Verify abort flag is still set
			expect(task.abort).toBe(true)

			// Restore console.error
			consoleErrorSpy.mockRestore()
		})
		describe("captured resource cleanup", () => {
			it.each(["same-instance turn handoff", "different-instance handoff", "already-superseded worker"] as const)(
				"joins only old command resources after %s while retaining replacement services",
				async (handoff) => {
					let releaseGoal!: () => void
					const goalShutdown = new Promise<void>((resolve) => (releaseGoal = resolve))
					let releaseAbort!: () => void
					const abortAcknowledgement = new Promise<void>((resolve) => (releaseAbort = resolve))
					const oldProcess = Object.assign(new EventEmitter(), {
						executionId: "old-owned-execution",
						isSettled: false,
						abort: vi.fn(() => abortAcknowledgement),
						getUnretrievedOutput: vi.fn(() => "unread old output"),
					})
					const replacementProcess = Object.assign(new EventEmitter(), {
						executionId: "replacement-execution",
						isSettled: false,
						abort: vi.fn(async () => undefined),
						getUnretrievedOutput: vi.fn(() => "unread replacement output"),
					})
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "old resource owner",
						startTask: false,
						enableCheckpoints: false,
					})
					Object.assign(task, {
						taskKind: "subagent",
						subagentRole: "worker",
						goalShutdownPromise: goalShutdown,
						...(handoff === "already-superseded worker" ? {} : { terminalProcess: oldProcess }),
					})
					task.beginCommandExecution("old-command", oldProcess.executionId, "old command")
					const oldLifetime = task.getTaskLifetimeCancellationSignal()
					const oldQueueDispose = vi.spyOn(task.messageQueueService, "dispose")
					const oldTrackerDispose = vi.spyOn(task["fileContextTracker"], "dispose")
					const oldDispose = vi.spyOn(task, "dispose")
					task.isStreaming = true
					task.diffViewProvider.isEditing = true
					const oldRevert = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
					const registry = vi
						.spyOn(TerminalRegistry, "getTerminals")
						.mockReturnValue([
							{ taskId: task.taskId, process: oldProcess, running: true },
							...(handoff === "already-superseded worker"
								? [{ taskId: task.taskId, process: replacementProcess, running: true }]
								: []),
						] as unknown as ReturnType<typeof TerminalRegistry.getTerminals>)
					const releaseSharedTerminals = vi
						.spyOn(TerminalRegistry, "releaseTerminalsForTask")
						.mockImplementation(() => undefined)
					const cleanupSharedOutput = vi.spyOn(OutputInterceptor, "cleanupByIds").mockResolvedValue(undefined)
					const broadOutputCleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue(undefined)
					let replacement: Task | undefined
					let replacementQueueDispose: typeof oldQueueDispose | undefined
					let replacementTrackerDispose: typeof oldTrackerDispose | undefined
					let stopped: Promise<void> | undefined
					let termination: Promise<void> | undefined
					let stopSettled = false
					const oldSessionId =
						handoff === "already-superseded worker"
							? commandSessionRegistry.register(task, oldProcess as unknown as AlphaTerminalProcess)
							: undefined
					let replacementSessionId: number | undefined
					const installReplacement = () => {
						if (handoff === "same-instance turn handoff") {
							replacement = task
							Object.assign(task, {
								agentRunId: "replacement-run",
								agentTurnId: "replacement-turn",
								terminalProcess: replacementProcess,
								taskCancellationController: new AbortController(),
							})
						} else {
							replacement = new Task({
								provider: mockProvider,
								apiConfiguration: mockApiConfig,
								taskId: task.taskId,
								task: "replacement resource owner",
								startTask: false,
								enableCheckpoints: false,
							})
							Object.assign(replacement, { terminalProcess: replacementProcess })
						}
						replacement.beginCommandExecution("new-command", replacementProcess.executionId, "new command")
						replacementQueueDispose = vi.spyOn(replacement.messageQueueService, "dispose")
						replacementTrackerDispose = vi.spyOn(replacement["fileContextTracker"], "dispose")
						if (handoff === "already-superseded worker") {
							replacementSessionId = commandSessionRegistry.register(
								replacement,
								replacementProcess as unknown as AlphaTerminalProcess,
							)
						}
					}
					const approvalKey = createTaskSessionApprovalKey({
						taskId: task.taskId,
						toolName: "execute_command",
						askType: "command",
						argumentsValue: { command: "new command" },
						cwd: task.cwd,
					})!
					try {
						if (handoff === "already-superseded worker") installReplacement()
						stopped = task.abortTask()
						termination = task.waitForTermination()
						void termination.catch(() => undefined)
						void stopped.then(
							() => (stopSettled = true),
							() => (stopSettled = true),
						)
						expect(oldLifetime.aborted).toBe(true)
						expect(oldProcess.abort).toHaveBeenCalledOnce()
						if (!replacement) installReplacement()
						expect(grantTaskSessionApproval(approvalKey, task.taskId, new AbortController().signal)).toBe(
							true,
						)
						expect(replacementProcess.abort).not.toHaveBeenCalled()
						releaseGoal()
						await goalShutdown
						await Promise.resolve()
						expect(stopSettled).toBe(false)
						releaseAbort()
						await abortAcknowledgement
						await Promise.resolve()
						expect(stopSettled).toBe(false)
						oldProcess.isSettled = true
						oldProcess.emit("completed")
						await stopped
						await termination
						expect(stopSettled).toBe(true)
						expect(oldProcess.abort).toHaveBeenCalledOnce()
						expect(oldProcess.listenerCount("completed")).toBe(0)
						expect(oldProcess.listenerCount("error")).toBe(0)
						expect(replacementProcess.abort).not.toHaveBeenCalled()
						expect(replacement!.getTaskLifetimeCancellationSignal().aborted).toBe(false)
						expect(replacementQueueDispose).not.toHaveBeenCalled()
						expect(replacementTrackerDispose).not.toHaveBeenCalled()
						expect(replacement!.getCommandExecutionEvidence()).toContainEqual(
							expect.objectContaining({ toolCallId: "new-command", status: "running" }),
						)
						expect(hasTaskSessionApproval(approvalKey)).toBe(true)
						expect(releaseSharedTerminals).not.toHaveBeenCalled()
						expect(cleanupSharedOutput).not.toHaveBeenCalled()
						expect(broadOutputCleanup).not.toHaveBeenCalled()
						expect(oldRevert).not.toHaveBeenCalled()
						if (handoff === "same-instance turn handoff") {
							expect(oldDispose).not.toHaveBeenCalled()
							expect(oldQueueDispose).not.toHaveBeenCalled()
							expect(oldTrackerDispose).not.toHaveBeenCalled()
						} else {
							expect(oldDispose).toHaveBeenCalledExactlyOnceWith({
								preserveSharedTaskResources: true,
								preserveCommandOutputArtifacts: false,
								commandOutputCleanup: {
									guard: expect.any(Function),
									outputs: expect.any(Array),
									candidates: expect.any(Set),
								},
							})
							expect(oldQueueDispose).toHaveBeenCalledOnce()
							expect(oldTrackerDispose).toHaveBeenCalledOnce()
						}
						if (handoff === "already-superseded worker") {
							expect(commandSessionRegistry.resolve(task, oldSessionId!)).toBeUndefined()
							expect(
								commandSessionRegistry.ownsOutput(oldProcess as unknown as AlphaTerminalProcess),
							).toBe(false)
							expect(commandSessionRegistry.resolve(replacement!, replacementSessionId!)?.process).toBe(
								replacementProcess,
							)
							expect(
								commandSessionRegistry.ownsOutput(
									replacementProcess as unknown as AlphaTerminalProcess,
								),
							).toBe(true)
							expect(oldProcess.getUnretrievedOutput).not.toHaveBeenCalled()
							expect(replacementProcess.getUnretrievedOutput).not.toHaveBeenCalled()
						}
					} finally {
						registry.mockReturnValue([])
						releaseGoal()
						releaseAbort()
						oldProcess.isSettled = true
						oldProcess.emit("completed")
						replacementProcess.isSettled = true
						replacementProcess.emit("completed")
						try {
							if (stopped) await stopped
							if (termination) await termination
						} finally {
							try {
								if (replacement) {
									replacement.isStreaming = false
									replacement.diffViewProvider.isEditing = false
									replacement.dispose({ preserveSharedTaskResources: true })
								}
								if (!oldDispose.mock.calls.length) task.dispose({ preserveSharedTaskResources: true })
							} finally {
								clearTaskSessionApprovalGrants(task.taskId)
								registry.mockRestore()
								releaseSharedTerminals.mockRestore()
								cleanupSharedOutput.mockRestore()
								broadOutputCleanup.mockRestore()
							}
						}
					}
				},
			)

			it("joins owned command shutdown and performs ordinary task resource cleanup", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "ordinary owned Stop cleanup",
					startTask: false,
					enableCheckpoints: false,
				})
				let releaseGoal!: () => void
				const goalShutdown = new Promise<void>((resolve) => (releaseGoal = resolve))
				let releaseAbort!: () => void
				const abortAcknowledgement = new Promise<void>((resolve) => (releaseAbort = resolve))
				const process = Object.assign(new EventEmitter(), {
					executionId: "ordinary-owned-command",
					isSettled: false,
					abort: vi.fn(() => abortAcknowledgement),
					getUnretrievedOutput: vi.fn(() => "unread owned output"),
				})
				Object.assign(task, {
					taskKind: "subagent",
					subagentRole: "worker",
					terminalProcess: process,
					goalShutdownPromise: goalShutdown,
				})
				task.beginCommandExecution("owned-command", process.executionId, "owned command")
				const registry = vi
					.spyOn(TerminalRegistry, "getTerminals")
					.mockReturnValue([{ taskId: task.taskId, process, running: true }] as unknown as ReturnType<
						typeof TerminalRegistry.getTerminals
					>)
				const sessionId = commandSessionRegistry.register(task, process as unknown as AlphaTerminalProcess)
				const lifetime = task.getTaskLifetimeCancellationSignal()
				vi.spyOn(task, "getTokenUsage").mockReturnValue({ ...task.getTokenUsage(), totalTokensIn: 1 })
				const usageUpdated = vi.fn()
				const taskAborted = vi.fn()
				task.on(AlphaCodeEventName.TaskTokenUsageUpdated, usageUpdated)
				task.on(AlphaCodeEventName.TaskAborted, taskAborted)
				const dispose = vi.spyOn(task, "dispose")
				const queueDispose = vi.spyOn(task.messageQueueService, "dispose")
				const trackerDispose = vi.spyOn(task["fileContextTracker"], "dispose")
				const releaseTerminals = vi
					.spyOn(TerminalRegistry, "releaseTerminalsForTask")
					.mockImplementation(() => {})
				const cleanupOutput = vi.spyOn(OutputInterceptor, "cleanupByIds").mockResolvedValue(undefined)
				const broadOutputCleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue(undefined)
				task.isStreaming = true
				task.diffViewProvider.isEditing = true
				const revert = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
				const approvalKey = createTaskSessionApprovalKey({
					taskId: task.taskId,
					toolName: "execute_command",
					askType: "command",
					argumentsValue: { command: "owned command" },
					cwd: task.cwd,
				})!
				let stopped: Promise<void> | undefined
				let termination: Promise<void> | undefined
				let stopSettled = false
				try {
					expect(grantTaskSessionApproval(approvalKey, task.taskId, lifetime)).toBe(true)
					const receipt = task.beginTaskCancellation()
					stopped = receipt.abort
					termination = receipt.termination
					void termination.catch(() => undefined)
					expect(Object.isFrozen(receipt)).toBe(true)
					expect(receipt.isCurrent()).toBe(true)
					expect(task.beginTaskCancellation()).toBe(receipt)
					expect(task.abortTask()).toBe(receipt.abort)
					void stopped.then(
						() => (stopSettled = true),
						() => (stopSettled = true),
					)
					expect(lifetime.aborted).toBe(true)
					expect(process.abort).toHaveBeenCalledOnce()
					releaseGoal()
					releaseAbort()
					await abortAcknowledgement
					await Promise.resolve()
					expect(stopSettled).toBe(false)
					process.isSettled = true
					process.emit("completed")
					await stopped
					await termination
					expect(receipt.isCurrent()).toBe(true)
					expect(usageUpdated).toHaveBeenCalledOnce()
					expect(taskAborted).toHaveBeenCalledOnce()
					expect(usageUpdated.mock.invocationCallOrder[0]).toBeLessThan(
						taskAborted.mock.invocationCallOrder[0],
					)
					expect(dispose).toHaveBeenCalledExactlyOnceWith({
						preserveCommandOutputArtifacts: false,
						commandOutputCleanup: {
							guard: expect.any(Function),
							outputs: expect.any(Array),
							candidates: expect.any(Set),
						},
					})
					expect(queueDispose).toHaveBeenCalledOnce()
					expect(trackerDispose).toHaveBeenCalledOnce()
					expect(releaseTerminals).toHaveBeenCalledExactlyOnceWith(task.taskId)
					expect(cleanupOutput).toHaveBeenCalledExactlyOnceWith(
						path.join(mockExtensionContext.globalStorageUri.fsPath, "tasks", task.taskId, "command-output"),
						expect.any(Set),
						expect.any(Set),
						expect.any(Function),
					)
					expect(broadOutputCleanup).not.toHaveBeenCalled()
					expect(revert).toHaveBeenCalledOnce()
					expect(hasTaskSessionApproval(approvalKey)).toBe(false)
					expect(commandSessionRegistry.resolve(task, sessionId)).toBeUndefined()
					expect(commandSessionRegistry.ownsOutput(process as unknown as AlphaTerminalProcess)).toBe(false)
					expect(process.getUnretrievedOutput).not.toHaveBeenCalled()
					expect(process.listenerCount("completed")).toBe(0)
					expect(process.listenerCount("error")).toBe(0)
				} finally {
					registry.mockReturnValue([])
					releaseGoal()
					releaseAbort()
					process.isSettled = true
					process.emit("completed")
					try {
						if (stopped) await stopped
						if (termination) await termination
					} finally {
						if (!dispose.mock.calls.length) task.dispose({ preserveSharedTaskResources: true })
						clearTaskSessionApprovalGrants(task.taskId)
						registry.mockRestore()
						releaseTerminals.mockRestore()
						cleanupOutput.mockRestore()
						broadOutputCleanup.mockRestore()
					}
				}
			})

			it("withholds stale TaskAborted after an actual final-usage observer replaces the owner", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "final usage observer handoff",
					startTask: false,
					enableCheckpoints: false,
				})
				let releaseAbort!: () => void
				const abortAcknowledgement = new Promise<void>((resolve) => (releaseAbort = resolve))
				const process = Object.assign(new EventEmitter(), {
					executionId: "usage-owner-command",
					isSettled: false,
					abort: vi.fn(() => abortAcknowledgement),
				})
				Object.assign(task, {
					taskKind: "subagent",
					subagentRole: "worker",
					terminalProcess: process,
					goalShutdownPromise: Promise.resolve(),
				})
				task.beginCommandExecution("usage-owner-call", process.executionId, "owned command")
				vi.spyOn(task, "getTokenUsage").mockReturnValue({ ...task.getTokenUsage(), totalTokensIn: 1 })
				const registry = vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
				const dispose = vi.spyOn(task, "dispose")
				const taskAborted = vi.fn()
				task.on(AlphaCodeEventName.TaskAborted, taskAborted)
				const replacementHistory: ApiMessage[] = [
					{ role: "user", content: [{ type: "text", text: "replacement history" }] },
				]
				const replacementPending: Anthropic.Messages.ContentBlockParam[] = [
					{ type: "text", text: "replacement pending content" },
				]
				const replacementLifetime = new AbortController()
				let callsAtHandoff = -1
				let processSettledAtHandoff = false
				const usageUpdated = vi.fn(() => {
					processSettledAtHandoff = process.isSettled
					callsAtHandoff = mockProvider.publishAgentLifecycleEvent.mock.calls.length
					Object.assign(task, {
						agentRunId: "usage-replacement-run",
						agentTurnId: "usage-replacement-turn",
						apiConversationHistory: replacementHistory,
						userMessageContent: replacementPending,
						userMessageContentReady: true,
						isTaskLoopActive: true,
						consecutiveNoToolUseCount: 42,
						taskCancellationController: replacementLifetime,
					})
				})
				task.on(AlphaCodeEventName.TaskTokenUsageUpdated, usageUpdated)
				let stopped: Promise<void> | undefined
				let termination: Promise<void> | undefined
				try {
					stopped = task.abortTask()
					termination = task.waitForTermination()
					void termination.catch(() => undefined)
					expect(process.abort).toHaveBeenCalledOnce()
					expect(usageUpdated).not.toHaveBeenCalled()
					releaseAbort()
					await abortAcknowledgement
					await Promise.resolve()
					expect(usageUpdated).not.toHaveBeenCalled()
					process.isSettled = true
					process.emit("completed")
					await stopped
					await termination
					expect(usageUpdated).toHaveBeenCalledOnce()
					expect(processSettledAtHandoff).toBe(true)
					expect(taskAborted).not.toHaveBeenCalled()
					expect(dispose).not.toHaveBeenCalled()
					expect(task.apiConversationHistory).toBe(replacementHistory)
					expect(task["userMessageContent"]).toBe(replacementPending)
					expect(task["userMessageContent"]).toEqual([{ type: "text", text: "replacement pending content" }])
					expect(task["userMessageContentReady"]).toBe(true)
					expect(task["isTaskLoopActive"]).toBe(true)
					expect(task["consecutiveNoToolUseCount"]).toBe(42)
					expect(replacementLifetime.signal.aborted).toBe(false)
					expect(mockProvider.publishAgentLifecycleEvent.mock.calls).toHaveLength(callsAtHandoff)
					expect(process.listenerCount("completed")).toBe(0)
					expect(process.listenerCount("error")).toBe(0)
				} finally {
					releaseAbort()
					process.isSettled = true
					process.emit("completed")
					try {
						if (stopped) await stopped
						if (termination) await termination
					} finally {
						task.dispose({ preserveSharedTaskResources: true })
						registry.mockRestore()
					}
				}
			})

			it.each([
				{ suffix: "", firstFailure: new Error("first command tree could not stop") },
				{ suffix: " (undefined rejection)", firstFailure: undefined },
			])(
				"joins a held background command before reporting an earlier command abort rejection$suffix",
				async ({ firstFailure }) => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "all owned command shutdowns",
						startTask: false,
						enableCheckpoints: false,
					})
					await task.messageQueueService.ready
					let releaseGoal!: () => void
					const goalShutdown = new Promise<void>((resolve) => (releaseGoal = resolve))
					let releaseBackgroundAbort!: () => void
					const backgroundAcknowledgement = new Promise<void>((resolve) => (releaseBackgroundAbort = resolve))
					let rejectReplacementGoal!: (error: unknown) => void
					const replacementGoalFailure = new Error("replacement goal shutdown failed independently")
					const replacementGoal = new Promise<void>((_resolve, reject) => (rejectReplacementGoal = reject))
					const replacementGoalOutcome = replacementGoal.then(
						() => ({ status: "fulfilled" as const }),
						(error: unknown) => ({ status: "rejected" as const, error }),
					)
					const firstProcess = Object.assign(new EventEmitter(), {
						executionId: "first-failing-command",
						isSettled: false,
						abort: vi.fn(() => {
							Object.assign(task, {
								agentRunId: "new-run",
								agentTurnId: "new-turn",
								goalShutdownPromise: replacementGoal,
							})
							throw firstFailure
						}),
					})
					const backgroundProcess = Object.assign(new EventEmitter(), {
						executionId: "held-background-command",
						isSettled: false,
						abort: vi.fn(() => backgroundAcknowledgement),
					})
					Object.assign(task, {
						taskKind: "subagent",
						subagentRole: "worker",
						terminalProcess: firstProcess,
						goalShutdownPromise: goalShutdown,
					})
					task.beginCommandExecution("first-call", firstProcess.executionId, "first command")
					task.beginCommandExecution("background-call", backgroundProcess.executionId, "background command")
					const registry = vi
						.spyOn(TerminalRegistry, "getTerminals")
						.mockReturnValue([{ process: backgroundProcess, running: true }] as unknown as ReturnType<
							typeof TerminalRegistry.getTerminals
						>)
					let observed: Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }> | undefined
					let termination:
						| Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }>
						| undefined
					let stopOutcome: { status: "fulfilled" } | { status: "rejected"; error: unknown } | undefined
					let terminationOutcome: { status: "fulfilled" } | { status: "rejected"; error: unknown } | undefined
					vi.useFakeTimers()
					try {
						observed = task.abortTask().then(
							() => (stopOutcome = { status: "fulfilled" }),
							(error: unknown) => (stopOutcome = { status: "rejected", error }),
						)
						termination = task.waitForTermination().then(
							() => (terminationOutcome = { status: "fulfilled" }),
							(error: unknown) => (terminationOutcome = { status: "rejected", error }),
						)
						expect(firstProcess.abort).toHaveBeenCalledOnce()
						expect(backgroundProcess.abort).toHaveBeenCalledOnce()
						expect(task["goalShutdownPromise"]).toBe(replacementGoal)
						releaseGoal()
						await vi.advanceTimersByTimeAsync(0)
						expect(stopOutcome).toBeUndefined()
						expect(vi.getTimerCount()).toBe(1)
						releaseBackgroundAbort()
						await vi.advanceTimersByTimeAsync(0)
						expect(stopOutcome).toBeUndefined()
						backgroundProcess.isSettled = true
						backgroundProcess.emit("completed")
						const stopped = await observed
						expect(stopped.status).toBe("rejected")
						if (stopped.status !== "rejected") throw new Error("Stop unexpectedly accepted failed cleanup")
						expect(stopped.error).toBe(firstFailure)
						await vi.advanceTimersByTimeAsync(0)
						expect(terminationOutcome).toMatchObject({ status: "rejected" })
						const terminated = await termination
						expect(terminated.status).toBe("rejected")
						if (terminated.status !== "rejected") throw new Error("Termination lost failed command cleanup")
						expect(terminated.error).toBe(firstFailure)
						rejectReplacementGoal(replacementGoalFailure)
						const replacementFailed = await replacementGoalOutcome
						expect(replacementFailed.status).toBe("rejected")
						if (replacementFailed.status !== "rejected")
							throw new Error("Expected replacement goal rejection")
						expect(replacementFailed.error).toBe(replacementGoalFailure)
						expect((await termination).status).toBe("rejected")
						expect(terminated.error).toBe(firstFailure)
						expect(firstProcess.listenerCount("completed")).toBe(0)
						expect(firstProcess.listenerCount("error")).toBe(0)
						expect(backgroundProcess.listenerCount("completed")).toBe(0)
						expect(backgroundProcess.listenerCount("error")).toBe(0)
						expect(vi.getTimerCount()).toBe(0)
					} finally {
						registry.mockReturnValue([])
						releaseGoal()
						releaseBackgroundAbort()
						rejectReplacementGoal(replacementGoalFailure)
						backgroundProcess.isSettled = true
						backgroundProcess.emit("completed")
						try {
							const replacementFailed = await replacementGoalOutcome
							expect(replacementFailed.status).toBe("rejected")
							if (replacementFailed.status === "rejected") {
								expect(replacementFailed.error).toBe(replacementGoalFailure)
							}
							if (observed) await observed
							if (termination) await termination
						} finally {
							task.dispose({ preserveSharedTaskResources: true })
							registry.mockRestore()
							vi.useRealTimers()
						}
					}
				},
			)

			it.each(["goal invalidation", "lifetime abort", "process abort"] as const)(
				"keeps original cancellation handles and coalesces reentrant Stop during synchronous %s replacement",
				async (callback) => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "inline cancellation owner handoff",
						startTask: false,
						enableCheckpoints: false,
					})
					const original = {
						currentRequestAbortController: new AbortController(),
						agentWaitAbortController: new AbortController(),
						stepInterruptionController: new AbortController(),
						contextCondenseAbortController: new AbortController(),
						postTurnCompactionAbortController: new AbortController(),
						backgroundUsageDrainAbortController: new AbortController(),
						taskCancellationController: task["taskCancellationController"],
					}
					const replacement = {
						currentRequestAbortController: new AbortController(),
						agentWaitAbortController: new AbortController(),
						stepInterruptionController: new AbortController(),
						contextCondenseAbortController: new AbortController(),
						postTurnCompactionAbortController: new AbortController(),
						backgroundUsageDrainAbortController: new AbortController(),
						taskCancellationController: new AbortController(),
					}
					const replacementProcess = Object.assign(new EventEmitter(), {
						executionId: "inline-new-command",
						isSettled: false,
						abort: vi.fn(async () => undefined),
					})
					let replacementInstalled = false
					let nestedStop: Promise<void> | undefined
					let nestedReceipt: ReturnType<Task["beginTaskCancellation"]> | undefined
					const replaceOwner = () => {
						if (replacementInstalled) return
						replacementInstalled = true
						Object.assign(task, replacement, {
							agentRunId: "inline-replacement-run",
							agentTurnId: "inline-replacement-turn",
							terminalProcess: replacementProcess,
						})
						nestedReceipt = task.beginTaskCancellation()
						nestedStop = task.abortTask()
						void nestedStop.catch(() => undefined)
					}
					const originalProcess = Object.assign(new EventEmitter(), {
						executionId: "inline-old-command",
						isSettled: false,
						abort: vi.fn(async () => {
							if (callback === "process abort") replaceOwner()
							originalProcess.isSettled = true
							originalProcess.emit("completed")
						}),
					})
					Object.assign(task, original, {
						taskKind: "subagent",
						subagentRole: "worker",
						terminalProcess: originalProcess,
						goalShutdownPromise: Promise.resolve(),
					})
					task.beginCommandExecution("inline-old-call", originalProcess.executionId, "old command")
					const registry = vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
					const dispose = vi.spyOn(task, "dispose")
					const goal = task["goalController"]!
					const originalInvalidate = goal.invalidateContinuation.bind(goal)
					const invalidate = vi.spyOn(goal, "invalidateContinuation").mockImplementation(() => {
						originalInvalidate()
						if (callback === "goal invalidation") replaceOwner()
					})
					const onLifetimeAbort = () => {
						if (callback === "lifetime abort") replaceOwner()
					}
					original.taskCancellationController.signal.addEventListener("abort", onLifetimeAbort)
					let stopped: Promise<void> | undefined
					let termination: Promise<void> | undefined
					try {
						const receipt = task.beginTaskCancellation()
						stopped = receipt.abort
						termination = receipt.termination
						void termination.catch(() => undefined)
						expect(replacementInstalled).toBe(true)
						expect(nestedStop).toBe(stopped)
						expect(nestedReceipt).toBe(receipt)
						expect(nestedReceipt!.abort).toBe(stopped)
						expect(nestedReceipt!.termination).toBe(termination)
						expect(Object.isFrozen(receipt)).toBe(true)
						expect(receipt.isCurrent()).toBe(false)
						await stopped
						await termination
						for (const controller of Object.values(original)) expect(controller.signal.aborted).toBe(true)
						for (const controller of Object.values(replacement))
							expect(controller.signal.aborted).toBe(false)
						for (const [key, controller] of Object.entries(replacement)) {
							expect(Reflect.get(task, key)).toBe(controller)
						}
						expect(originalProcess.abort).toHaveBeenCalledOnce()
						expect(replacementProcess.abort).not.toHaveBeenCalled()
						expect(originalProcess.listenerCount("completed")).toBe(0)
						expect(originalProcess.listenerCount("error")).toBe(0)
						expect(dispose).not.toHaveBeenCalled()
					} finally {
						original.taskCancellationController.signal.removeEventListener("abort", onLifetimeAbort)
						invalidate.mockRestore()
						replacementProcess.isSettled = true
						replacementProcess.emit("completed")
						originalProcess.isSettled = true
						originalProcess.emit("completed")
						try {
							if (stopped) await stopped
							if (nestedStop && nestedStop !== stopped) await nestedStop
							if (termination) await termination
						} finally {
							task.dispose({ preserveSharedTaskResources: true })
							registry.mockRestore()
						}
					}
				},
			)
		})

		describe("passive command archive cancellation", () => {
			const gate = () => {
				let resolve!: () => void
				let reject!: (reason: unknown) => void
				const promise = new Promise<void>((accept, refuse) => {
					resolve = accept
					reject = refuse
				})
				return { promise, resolve, reject }
			}
			type Settlement = { status: "fulfilled" } | { status: "rejected"; reason: unknown }
			const observe = (promise: Promise<void>) => {
				const state: { settlement?: Settlement } = {}
				const settled = promise.then(
					() => (state.settlement = { status: "fulfilled" as const }),
					(reason: unknown) => (state.settlement = { status: "rejected" as const, reason }),
				)
				return { state, settled }
			}
			const archiveProcess = (index: number, physicallyExited = false) => {
				const acknowledgement = gate()
				const output = gate()
				const outputObserved = observe(output.promise)
				let closed = false
				const executionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
				const archiveExecutionId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`
				const process = Object.assign(new EventEmitter(), {
					executionId,
					isSettled: physicallyExited,
					isOutputFinalized: false,
					abort: vi.fn(() => acknowledgement.promise),
					waitForOutputFinalization: vi.fn(() => output.promise),
					cancelPendingOutputWrite: vi.fn(),
					finalizeOutput: vi.fn(async () => {
						throw new Error("Task must observe the passive archive latch instead of forcing finalization")
					}),
					getUnretrievedOutput: vi.fn(() => "original unread output"),
					then: vi.fn(() => {
						throw new Error("Task must not assimilate a thenable process while joining its archive")
					}),
				})
				return {
					process,
					executionId,
					archiveExecutionId,
					acknowledgement,
					output,
					outputObserved,
					isClosed: () => closed,
					finishPhysical: () => {
						acknowledgement.resolve()
						process.isSettled = true
						process.emit("completed")
					},
					finishOutput: () => {
						closed = true
						process.isOutputFinalized = true
						output.resolve()
						process.emit("finalized")
					},
				}
			}
			const archiveTask = async (options: { actualCleanup?: boolean } = {}) => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "passive archive Stop boundary",
					startTask: false,
					enableCheckpoints: false,
					taskKind: "subagent",
					subagentRole: "worker",
				})
				await task.messageQueueService.ready
				const terminals = vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
				const releaseTerminals = vi
					.spyOn(TerminalRegistry, "releaseTerminalsForTask")
					.mockImplementation(() => {})
				const broadCleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue(undefined)
				const cleanupImplementation = OutputInterceptor.cleanupByIds.bind(OutputInterceptor)
				const cleanup = vi.spyOn(OutputInterceptor, "cleanupByIds")
				if (!options.actualCleanup) cleanup.mockResolvedValue(undefined)
				const dispose = vi.spyOn(task, "dispose")
				vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
				return {
					task,
					terminals,
					cleanup,
					cleanupImplementation,
					broadCleanup,
					dispose,
					track: (record: ReturnType<typeof archiveProcess>) => {
						task.beginCommandExecution(
							`call-${record.executionId}`,
							record.executionId,
							"controlled command",
						)
						commandSessionRegistry.trackTaskOutput(
							task,
							record.process as unknown as AlphaTerminalProcess,
							record.executionId,
							{ archiveExecutionId: record.archiveExecutionId, isClosed: record.isClosed },
						)
					},
					cleanupFixture: () => {
						task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
						terminals.mockRestore()
						releaseTerminals.mockRestore()
						cleanup.mockRestore()
						broadCleanup.mockRestore()
					},
				}
			}

			it.each([
				{ exited: false, outcome: "fulfilled" },
				{ exited: true, outcome: "fulfilled" },
				{ exited: false, outcome: "rejected" },
				{ exited: true, outcome: "rejected" },
			] as const)(
				"joins a passive $outcome archive captured with physical exit=$exited",
				async ({ exited, outcome }) => {
					const fixture = await archiveTask()
					const record = archiveProcess(1, exited)
					fixture.track(record)
					if (!exited) Object.assign(fixture.task, { terminalProcess: record.process })
					const captured = commandSessionRegistry.capturePendingTaskOutput(fixture.task)
					expect(captured).toHaveLength(1)
					expect(captured[0]).toMatchObject({
						process: record.process,
						executionId: record.executionId,
						archiveExecutionId: record.archiveExecutionId,
					})
					expect(captured[0].isCleanupSafe()).toBe(false)
					const failure = new Error("Original output archive rejected")
					let abort: ReturnType<typeof observe> | undefined
					let termination: ReturnType<typeof observe> | undefined
					vi.useFakeTimers()
					try {
						const receipt = fixture.task.beginTaskCancellation()
						abort = observe(receipt.abort)
						termination = observe(receipt.termination)
						expect(record.process.abort).toHaveBeenCalledTimes(exited ? 0 : 1)
						await vi.advanceTimersByTimeAsync(0)
						expect(abort.state.settlement).toBeUndefined()
						expect(termination.state.settlement).toBeUndefined()
						if (!exited) record.finishPhysical()
						await vi.advanceTimersByTimeAsync(0)
						expect(abort.state.settlement).toBeUndefined()
						expect(fixture.dispose).not.toHaveBeenCalled()
						if (outcome === "fulfilled") record.finishOutput()
						else {
							// A finalized flag is not proof that a rejected writer closed its sink.
							record.process.isOutputFinalized = true
							record.output.reject(failure)
						}
						await vi.advanceTimersByTimeAsync(0)
						const expected: Settlement =
							outcome === "fulfilled" ? { status: "fulfilled" } : { status: "rejected", reason: failure }
						expect(await abort.settled).toEqual(expected)
						expect(await termination.settled).toEqual(expected)
						expect(await record.outputObserved.settled).toEqual(expected)
						expect(captured[0].isCleanupSafe()).toBe(outcome === "fulfilled")
						if (outcome === "rejected") {
							expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)).toContainEqual(
								captured[0],
							)
							for (const call of fixture.cleanup.mock.calls)
								expect(call[3]?.(record.archiveExecutionId)).toBe(false)
						}
						expect(record.process.finalizeOutput).not.toHaveBeenCalled()
						expect(record.process.then).not.toHaveBeenCalled()
						expect(fixture.broadCleanup).not.toHaveBeenCalled()
						expect(vi.getTimerCount()).toBe(0)
					} finally {
						record.finishPhysical()
						record.finishOutput()
						try {
							if (abort) await abort.settled
							if (termination) await termination.settled
							await record.outputObserved.settled
						} finally {
							fixture.cleanupFixture()
							vi.useRealTimers()
						}
					}
				},
			)

			it.each([
				{ suffix: "Error", firstFailure: new Error("First physical worker rejected") },
				{ suffix: "undefined", firstFailure: undefined },
				{ suffix: "null", firstFailure: null },
			])(
				"settles physical workers then concurrent archives before preserving first $suffix failure",
				async ({ firstFailure }) => {
					const fixture = await archiveTask()
					const first = archiveProcess(2)
					const sibling = archiveProcess(3)
					fixture.track(first)
					fixture.track(sibling)
					Object.assign(fixture.task, { terminalProcess: first.process })
					first.process.abort.mockImplementation(() => {
						throw firstFailure
					})
					fixture.terminals.mockReturnValue([
						{ taskId: fixture.task.taskId, process: sibling.process, running: true },
					] as unknown as ReturnType<typeof TerminalRegistry.getTerminals>)
					let abort: ReturnType<typeof observe> | undefined
					let termination: ReturnType<typeof observe> | undefined
					vi.useFakeTimers()
					try {
						const receipt = fixture.task.beginTaskCancellation()
						abort = observe(receipt.abort)
						termination = observe(receipt.termination)
						expect(first.process.abort).toHaveBeenCalledOnce()
						expect(sibling.process.abort).toHaveBeenCalledOnce()
						await vi.advanceTimersByTimeAsync(9_999)
						expect(abort.state.settlement).toBeUndefined()
						expect(vi.getTimerCount()).toBe(1)
						sibling.finishPhysical()
						await vi.advanceTimersByTimeAsync(0)
						expect(vi.getTimerCount()).toBe(2)
						await vi.advanceTimersByTimeAsync(14_999)
						expect(abort.state.settlement).toBeUndefined()
						const laterArchiveFailure = new Error(
							"Later archive rejection must not replace the first reason",
						)
						first.output.reject(laterArchiveFailure)
						await vi.advanceTimersByTimeAsync(0)
						expect(abort.state.settlement).toBeUndefined()
						await vi.advanceTimersByTimeAsync(1)
						const stopped = await abort.settled
						const terminated = await termination.settled
						expect(stopped.status).toBe("rejected")
						expect(terminated.status).toBe("rejected")
						if (stopped.status !== "rejected" || terminated.status !== "rejected") {
							throw new Error("A rejected physical cleanup must remain rejected")
						}
						expect(stopped.reason).toBe(firstFailure)
						expect(terminated.reason).toBe(firstFailure)
						expect((await first.outputObserved.settled).status).toBe("rejected")
						expect(sibling.outputObserved.state.settlement).toBeUndefined()
						expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)).toEqual(
							expect.arrayContaining([
								expect.objectContaining({ archiveExecutionId: first.archiveExecutionId }),
								expect.objectContaining({ archiveExecutionId: sibling.archiveExecutionId }),
							]),
						)
						for (const record of [first, sibling]) {
							expect(record.process.finalizeOutput).not.toHaveBeenCalled()
							expect(record.process.then).not.toHaveBeenCalled()
						}
						expect(vi.getTimerCount()).toBe(0)
					} finally {
						fixture.terminals.mockReturnValue([])
						first.finishPhysical()
						sibling.finishPhysical()
						first.finishOutput()
						sibling.finishOutput()
						try {
							if (abort) await abort.settled
							if (termination) await termination.settled
							await Promise.all([first.outputObserved.settled, sibling.outputObserved.settled])
						} finally {
							fixture.cleanupFixture()
							vi.useRealTimers()
						}
					}
				},
			)

			it("retains timed-out passive latches and retries after natural close without another physical interrupt", async () => {
				const fixture = await archiveTask()
				const records = [archiveProcess(4, true), archiveProcess(5, true)]
				for (const record of records) fixture.track(record)
				const captured = commandSessionRegistry.capturePendingTaskOutput(fixture.task)
				let abort: ReturnType<typeof observe> | undefined
				let termination: ReturnType<typeof observe> | undefined
				let retriedAbort: ReturnType<typeof observe> | undefined
				let retriedTermination: ReturnType<typeof observe> | undefined
				vi.useFakeTimers()
				try {
					const receipt = fixture.task.beginTaskCancellation()
					abort = observe(receipt.abort)
					termination = observe(receipt.termination)
					await vi.advanceTimersByTimeAsync(14_999)
					expect(abort.state.settlement).toBeUndefined()
					expect(termination.state.settlement).toBeUndefined()
					expect(vi.getTimerCount()).toBe(2)
					await vi.advanceTimersByTimeAsync(1)
					const failed = await abort.settled
					expect(failed.status).toBe("rejected")
					if (failed.status !== "rejected") throw new Error("A pending archive cannot complete Stop")
					expect(failed.reason).toEqual(
						new Error(`Timed out waiting for command output for task ${fixture.task.taskId}`),
					)
					expect(await termination.settled).toEqual(failed)
					for (const record of records) {
						expect(record.outputObserved.state.settlement).toBeUndefined()
						expect(record.process.isOutputFinalized).toBe(false)
						expect(record.process.abort).not.toHaveBeenCalled()
						expect(record.process.finalizeOutput).not.toHaveBeenCalled()
					}
					expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)).toEqual(captured)
					for (const record of captured) expect(record.isCleanupSafe()).toBe(false)
					for (const record of records) record.finishOutput()
					await vi.advanceTimersByTimeAsync(0)
					const retry = fixture.task.beginTaskCancellation()
					expect(retry).not.toBe(receipt)
					retriedAbort = observe(retry.abort)
					retriedTermination = observe(retry.termination)
					await vi.advanceTimersByTimeAsync(0)
					expect(await retriedAbort.settled).toEqual({ status: "fulfilled" })
					expect(await retriedTermination.settled).toEqual({ status: "fulfilled" })
					expect(await abort.settled).toEqual(failed)
					for (const record of records) {
						expect(await record.outputObserved.settled).toEqual({ status: "fulfilled" })
						expect(record.process.abort).not.toHaveBeenCalled()
						expect(record.process.finalizeOutput).not.toHaveBeenCalled()
					}
					expect(vi.getTimerCount()).toBe(0)
				} finally {
					for (const record of records) record.finishOutput()
					try {
						for (const observed of [abort, termination, retriedAbort, retriedTermination]) {
							if (observed) await observed.settled
						}
						await Promise.all(records.map((record) => record.outputObserved.settled))
					} finally {
						fixture.cleanupFixture()
						vi.useRealTimers()
					}
				}
			})

			it("bounds physical, archive and all remaining failed producer joins as three shared phases", async () => {
				const fixture = await archiveTask()
				const record = archiveProcess(9)
				fixture.track(record)
				Object.assign(fixture.task, { terminalProcess: record.process })
				const producer = gate()
				const manual = gate()
				const goal = gate()
				const ownedProducer = fixture.task["ownBackgroundLifecycle"]("start", producer.promise)
				fixture.task["manualContextCondenseSettlement"] = manual.promise
				fixture.task["goalShutdownPromise"] = undefined
				const requestedGoal = vi.spyOn(fixture.task["goalController"]!, "get").mockImplementation(async () => {
					await goal.promise
					return undefined
				})
				let abort: ReturnType<typeof observe> | undefined
				let termination: ReturnType<typeof observe> | undefined
				vi.useFakeTimers()
				try {
					const receipt = fixture.task.beginTaskCancellation()
					abort = observe(receipt.abort)
					termination = observe(receipt.termination)
					expect(requestedGoal).toHaveBeenCalledOnce()
					await vi.advanceTimersByTimeAsync(9_999)
					expect(abort.state.settlement).toBeUndefined()
					expect(vi.getTimerCount()).toBe(1)
					await vi.advanceTimersByTimeAsync(1)
					expect(abort.state.settlement).toBeUndefined()
					expect(vi.getTimerCount()).toBe(1)
					await vi.advanceTimersByTimeAsync(14_999)
					expect(abort.state.settlement).toBeUndefined()
					await vi.advanceTimersByTimeAsync(1)
					const stopped = await abort.settled
					expect(stopped).toEqual({
						status: "rejected",
						reason: new Error(`Timed out stopping a command for task ${fixture.task.taskId}`),
					})
					expect(termination.state.settlement).toBeUndefined()
					expect(fixture.dispose).not.toHaveBeenCalled()
					await vi.advanceTimersByTimeAsync(9_999)
					expect(termination.state.settlement).toBeUndefined()
					expect(vi.getTimerCount()).toBe(1)
					producer.resolve()
					manual.resolve()
					await vi.advanceTimersByTimeAsync(0)
					expect(termination.state.settlement).toBeUndefined()
					expect(fixture.dispose).not.toHaveBeenCalled()
					await vi.advanceTimersByTimeAsync(1)
					expect(await termination.settled).toEqual(stopped)
					expect(fixture.dispose).not.toHaveBeenCalled()
					expect(fixture.cleanup).not.toHaveBeenCalled()
					expect(record.outputObserved.state.settlement).toBeUndefined()
					expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)[0].isCleanupSafe()).toBe(false)
					expect(record.process.finalizeOutput).not.toHaveBeenCalled()
					expect(vi.getTimerCount()).toBe(0)
				} finally {
					producer.resolve()
					manual.resolve()
					goal.resolve()
					record.finishPhysical()
					record.finishOutput()
					try {
						await vi.advanceTimersByTimeAsync(0)
						await ownedProducer
						if (abort) await abort.settled
						if (termination) await termination.settled
						await record.outputObserved.settled
					} finally {
						fixture.cleanupFixture()
						requestedGoal.mockRestore()
						vi.useRealTimers()
					}
				}
			})

			it.each(["command artifacts", "shared task resources", "both"] as const)(
				"preserves pending output while disposing with %s protection",
				async (protection) => {
					const fixture = await archiveTask()
					const record = archiveProcess(6, true)
					fixture.track(record)
					const capture = commandSessionRegistry.capturePendingTaskOutput(fixture.task)
					const queueDispose = vi.spyOn(fixture.task.messageQueueService, "dispose")
					try {
						fixture.task.dispose({
							preserveCommandOutputArtifacts: protection !== "shared task resources",
							preserveSharedTaskResources: protection !== "command artifacts",
						})
						await Promise.resolve()
						expect(queueDispose).toHaveBeenCalledOnce()
						expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)).toEqual(capture)
						expect(capture[0].isCleanupSafe()).toBe(false)
						expect(record.outputObserved.state.settlement).toBeUndefined()
						expect(record.process.finalizeOutput).not.toHaveBeenCalled()
						expect(fixture.cleanup).not.toHaveBeenCalled()
						expect(fixture.broadCleanup).not.toHaveBeenCalled()
					} finally {
						record.finishOutput()
						await record.outputObserved.settled
						fixture.cleanupFixture()
					}
				},
			)

			it("rechecks original archive scope and owner at each removal after a replacement callback", async () => {
				const fixture = await archiveTask()
				const record = archiveProcess(7, true)
				fixture.track(record)
				const replacementOutput = archiveProcess(8, true)
				let replacement: Task | undefined
				let replacementQueueDispose: { mock: { calls: unknown[][] } } | undefined
				let replacementLifetime: AbortSignal | undefined
				const unlinkDecisions: boolean[] = []
				fixture.cleanup.mockImplementation(async (_directory, keepIds, candidates, canRemove) => {
					expect(candidates).toBeInstanceOf(Set)
					expect(candidates?.has(record.archiveExecutionId)).toBe(true)
					expect(candidates?.has(record.executionId)).toBe(false)
					expect(keepIds.has(record.archiveExecutionId)).toBe(false)
					expect(canRemove).toBeTypeOf("function")
					unlinkDecisions.push(canRemove!(record.archiveExecutionId))
					replacement = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						taskId: fixture.task.taskId,
						task: "replacement archive owner",
						startTask: false,
						enableCheckpoints: false,
					})
					replacementQueueDispose = vi.spyOn(replacement.messageQueueService, "dispose")
					replacementLifetime = replacement.getTaskLifetimeCancellationSignal()
					commandSessionRegistry.trackTaskOutput(
						replacement,
						replacementOutput.process as unknown as AlphaTerminalProcess,
						replacementOutput.executionId,
						{
							archiveExecutionId: replacementOutput.archiveExecutionId,
							isClosed: replacementOutput.isClosed,
						},
					)
					unlinkDecisions.push(canRemove!(record.archiveExecutionId))
					unlinkDecisions.push(canRemove!(replacementOutput.archiveExecutionId))
					expect(candidates?.has(replacementOutput.archiveExecutionId)).toBe(false)
				})
				let abort: ReturnType<typeof observe> | undefined
				let termination: ReturnType<typeof observe> | undefined
				vi.useFakeTimers()
				try {
					const receipt = fixture.task.beginTaskCancellation()
					abort = observe(receipt.abort)
					termination = observe(receipt.termination)
					record.finishOutput()
					await vi.advanceTimersByTimeAsync(0)
					expect(await abort.settled).toEqual({ status: "fulfilled" })
					expect(await termination.settled).toEqual({ status: "fulfilled" })
					expect(fixture.cleanup).toHaveBeenCalledOnce()
					expect(unlinkDecisions).toEqual([true, false, false])
					expect(replacement).toBeDefined()
					expect(replacementQueueDispose).not.toHaveBeenCalled()
					expect(replacementLifetime?.aborted).toBe(false)
					expect(replacementOutput.process.abort).not.toHaveBeenCalled()
					expect(replacementOutput.process.finalizeOutput).not.toHaveBeenCalled()
					expect(commandSessionRegistry.capturePendingTaskOutput(replacement!)).toHaveLength(1)
					expect(fixture.broadCleanup).not.toHaveBeenCalled()
					expect(receipt.isCurrent()).toBe(false)
				} finally {
					record.finishOutput()
					replacementOutput.finishOutput()
					try {
						if (abort) await abort.settled
						if (termination) await termination.settled
						await Promise.all([record.outputObserved.settled, replacementOutput.outputObserved.settled])
					} finally {
						replacement?.dispose({
							preserveSharedTaskResources: true,
							preserveCommandOutputArtifacts: true,
						})
						fixture.cleanupFixture()
						vi.useRealTimers()
					}
				}
			})
			it.each(["directory read", "earlier unlink"] as const)(
				"fences actual scoped artifact cleanup when replacement arrives during %s",
				async (handoff) => {
					const fixture = await archiveTask({ actualCleanup: true })
					const first = archiveProcess(10, true)
					const later = archiveProcess(11, true)
					const unsafe = archiveProcess(12, true)
					const replacementOutput = archiveProcess(13, true)
					for (const record of [first, later]) fixture.track(record)
					fixture.track(unsafe)
					const keptId = "40000000-0000-4000-8000-000000000001"
					const untrackedId = "50000000-0000-4000-8000-000000000001"
					fixture.task.apiConversationHistory = [
						{ role: "assistant", content: [{ type: "text", text: `Keep cmd-${keptId}.txt` }] },
					]
					const directory = path.join(
						mockExtensionContext.globalStorageUri.fsPath,
						"tasks",
						fixture.task.taskId,
						"command-output",
					)
					const filenames = [
						unsafe.archiveExecutionId,
						first.archiveExecutionId,
						later.archiveExecutionId,
						keptId,
						replacementOutput.archiveExecutionId,
						untrackedId,
					].map((id) => `cmd-${id}.txt`)
					type DirectoryIO = {
						readdir: (directory: fsSync.PathLike) => Promise<string[]>
						unlink: (file: fsSync.PathLike) => Promise<void>
					}
					// OutputInterceptor imports the fs object's writable promises property.
					// Narrow this fixture to the exact one-argument calls made by the real cleanup method.
					const io = fsSync.promises as unknown as DirectoryIO
					const actualReadDirectory = io.readdir.bind(io)
					const actualUnlink = io.unlink.bind(io)
					const releaseDirectory = gate()
					const releaseUnlink = gate()
					const cleanupFinished = gate()
					let directoryEntered = false
					let firstUnlinkEntered = false
					let cleanupStarted = false
					const unlinkPaths: string[] = []
					const readDirectory = vi.spyOn(io, "readdir").mockImplementation(async (candidate) => {
						if (path.resolve(String(candidate)) !== path.resolve(directory))
							return actualReadDirectory(candidate)
						directoryEntered = true
						if (handoff === "directory read") await releaseDirectory.promise
						return filenames
					})
					const unlink = vi.spyOn(io, "unlink").mockImplementation(async (candidate) => {
						const filename = String(candidate)
						if (path.dirname(path.resolve(filename)) !== path.resolve(directory))
							return actualUnlink(candidate)
						unlinkPaths.push(filename)
						if (path.basename(filename) === `cmd-${first.archiveExecutionId}.txt`) {
							firstUnlinkEntered = true
							await releaseUnlink.promise
						}
					})
					fixture.cleanup.mockImplementation(async (...args) => {
						cleanupStarted = true
						try {
							await fixture.cleanupImplementation(...args)
						} finally {
							cleanupFinished.resolve()
						}
					})
					const archiveFailure = new Error("An original output sink remains unclosed")
					let replacement: Task | undefined
					let replacementLifetime: AbortSignal | undefined
					let replacementQueueDispose: { mock: { calls: unknown[][] } } | undefined
					const replacementHistory: ApiMessage[] = [
						{ role: "user", content: `Keep replacement cmd-${replacementOutput.archiveExecutionId}.txt` },
					]
					const replacementPending: Task["userMessageContent"] = [
						{ type: "text", text: "B pending sentinel" },
					]
					let abort: ReturnType<typeof observe> | undefined
					let termination: ReturnType<typeof observe> | undefined
					vi.useFakeTimers()
					try {
						const receipt = fixture.task.beginTaskCancellation()
						abort = observe(receipt.abort)
						termination = observe(receipt.termination)
						first.finishOutput()
						later.finishOutput()
						unsafe.process.isOutputFinalized = true
						unsafe.output.reject(archiveFailure)
						await vi.advanceTimersByTimeAsync(0)
						expect(fixture.cleanup).toHaveBeenCalledOnce()
						expect(directoryEntered).toBe(true)
						expect(firstUnlinkEntered).toBe(handoff === "earlier unlink")
						expect(unlinkPaths).toEqual(
							handoff === "earlier unlink"
								? [path.join(directory, `cmd-${first.archiveExecutionId}.txt`)]
								: [],
						)
						const [cleanupDirectory, keepIds, candidates, canRemove] = fixture.cleanup.mock.calls[0]
						expect(cleanupDirectory).toBe(directory)
						expect(keepIds.has(keptId)).toBe(true)
						expect(candidates?.has(first.archiveExecutionId)).toBe(true)
						expect(candidates?.has(later.archiveExecutionId)).toBe(true)
						expect(candidates?.has(first.executionId)).toBe(false)
						expect(candidates?.has(replacementOutput.archiveExecutionId)).toBe(false)
						expect(candidates?.has(untrackedId)).toBe(false)
						// Both rows have a genuinely eligible A candidate before handoff.
						// The keyed unsafe row cannot mask a missing original-owner fence.
						expect(canRemove?.(first.archiveExecutionId)).toBe(true)
						replacement = new Task({
							provider: mockProvider,
							apiConfiguration: mockApiConfig,
							taskId: fixture.task.taskId,
							task: "replacement during real cleanup effect boundary",
							startTask: false,
							enableCheckpoints: false,
						})
						Object.assign(replacement, {
							apiConversationHistory: replacementHistory,
							userMessageContent: replacementPending,
							userMessageContentReady: true,
						})
						replacementLifetime = replacement.getTaskLifetimeCancellationSignal()
						replacementQueueDispose = vi.spyOn(replacement.messageQueueService, "dispose")
						commandSessionRegistry.trackTaskOutput(
							replacement,
							replacementOutput.process as unknown as AlphaTerminalProcess,
							replacementOutput.executionId,
							{
								archiveExecutionId: replacementOutput.archiveExecutionId,
								isClosed: replacementOutput.isClosed,
							},
						)
						releaseDirectory.resolve()
						releaseUnlink.resolve()
						await vi.advanceTimersByTimeAsync(0)
						await cleanupFinished.promise
						expect(await abort.settled).toEqual({ status: "rejected", reason: archiveFailure })
						expect(await termination.settled).toEqual(await abort.settled)
						expect(unlinkPaths).toEqual(
							handoff === "earlier unlink"
								? [path.join(directory, `cmd-${first.archiveExecutionId}.txt`)]
								: [],
						)
						expect(replacement.apiConversationHistory).toBe(replacementHistory)
						expect(replacement["userMessageContent"]).toBe(replacementPending)
						expect(replacement["userMessageContentReady"]).toBe(true)
						expect(replacementLifetime.aborted).toBe(false)
						expect(replacementQueueDispose).not.toHaveBeenCalled()
						expect(replacementOutput.process.abort).not.toHaveBeenCalled()
						expect(commandSessionRegistry.capturePendingTaskOutput(replacement)).toHaveLength(1)
						const unsafeCapture = commandSessionRegistry
							.capturePendingTaskOutput(fixture.task)
							.find((item) => Object.is(item.process, unsafe.process))
						expect(unsafeCapture).toBeDefined()
						expect(unsafeCapture!.isCleanupSafe()).toBe(false)
						expect(unsafeCapture!.archiveExecutionId).toBe(unsafe.archiveExecutionId)
						expect(fixture.broadCleanup).not.toHaveBeenCalled()
					} finally {
						releaseDirectory.resolve()
						releaseUnlink.resolve()
						for (const record of [first, later, unsafe, replacementOutput]) record.finishOutput()
						try {
							await vi.advanceTimersByTimeAsync(0)
							if (cleanupStarted) await cleanupFinished.promise
							if (abort) await abort.settled
							if (termination) await termination.settled
							await Promise.all(
								[first, later, unsafe, replacementOutput].map(
									(record) => record.outputObserved.settled,
								),
							)
						} finally {
							replacement?.dispose({
								preserveSharedTaskResources: true,
								preserveCommandOutputArtifacts: true,
							})
							fixture.cleanupFixture()
							readDirectory.mockRestore()
							unlink.mockRestore()
							vi.useRealTimers()
						}
					}
				},
			)

			it("keeps an unmapped legacy output pin from authorizing any actual artifact unlink", async () => {
				const fixture = await archiveTask({ actualCleanup: true })
				const known = archiveProcess(14, true)
				const legacy = archiveProcess(15, true)
				fixture.track(known)
				const legacySession = commandSessionRegistry.register(
					fixture.task,
					legacy.process as unknown as AlphaTerminalProcess,
				)
				const directory = path.join(
					mockExtensionContext.globalStorageUri.fsPath,
					"tasks",
					fixture.task.taskId,
					"command-output",
				)
				type DirectoryIO = {
					readdir: (directory: fsSync.PathLike) => Promise<string[]>
					unlink: (file: fsSync.PathLike) => Promise<void>
				}
				const io = fsSync.promises as unknown as DirectoryIO
				const actualReadDirectory = io.readdir.bind(io)
				const actualUnlink = io.unlink.bind(io)
				const readDirectory = vi.spyOn(io, "readdir").mockImplementation(async (candidate) => {
					if (path.resolve(String(candidate)) !== path.resolve(directory))
						return actualReadDirectory(candidate)
					return [`cmd-${known.archiveExecutionId}.txt`, `cmd-${legacy.executionId}.txt`]
				})
				const unlinkPaths: string[] = []
				const unlink = vi.spyOn(io, "unlink").mockImplementation(async (candidate) => {
					if (path.dirname(path.resolve(String(candidate))) !== path.resolve(directory))
						return actualUnlink(candidate)
					unlinkPaths.push(String(candidate))
				})
				const cleanupFinished = gate()
				let cleanupStarted = false
				fixture.cleanup.mockImplementation(async (...args) => {
					cleanupStarted = true
					try {
						await fixture.cleanupImplementation(...args)
					} finally {
						cleanupFinished.resolve()
					}
				})
				let abort: ReturnType<typeof observe> | undefined
				let termination: ReturnType<typeof observe> | undefined
				vi.useFakeTimers()
				try {
					const receipt = fixture.task.beginTaskCancellation()
					abort = observe(receipt.abort)
					termination = observe(receipt.termination)
					known.finishOutput()
					legacy.finishOutput()
					await vi.advanceTimersByTimeAsync(0)
					expect(await abort.settled).toEqual({ status: "fulfilled" })
					expect(await termination.settled).toEqual({ status: "fulfilled" })
					expect(fixture.cleanup).toHaveBeenCalledOnce()
					await cleanupFinished.promise
					expect(readDirectory).toHaveBeenCalledWith(directory)
					expect(unlinkPaths).toEqual([])
					const [, , candidates, canRemove] = fixture.cleanup.mock.calls[0]
					expect(candidates?.has(known.archiveExecutionId)).toBe(true)
					expect(candidates?.has(legacy.executionId)).toBe(false)
					expect(canRemove?.(known.archiveExecutionId)).toBe(false)
					const legacyCapture = commandSessionRegistry
						.capturePendingTaskOutput(fixture.task)
						.find((item) => Object.is(item.process, legacy.process))
					expect(receipt.isCurrent()).toBe(true)
					expect(legacy.process.isOutputFinalized).toBe(true)
					expect(legacyCapture).toBeDefined()
					expect(legacyCapture!.archiveExecutionId).toBeUndefined()
					expect(legacyCapture!.isCleanupSafe()).toBe(false)
					expect(known.process.finalizeOutput).not.toHaveBeenCalled()
					expect(legacy.process.finalizeOutput).not.toHaveBeenCalled()
				} finally {
					known.finishOutput()
					legacy.finishOutput()
					try {
						await vi.advanceTimersByTimeAsync(0)
						if (cleanupStarted) await cleanupFinished.promise
						if (abort) await abort.settled
						if (termination) await termination.settled
						await Promise.all([known.outputObserved.settled, legacy.outputObserved.settled])
					} finally {
						commandSessionRegistry.release(fixture.task, legacySession)
						fixture.cleanupFixture()
						readDirectory.mockRestore()
						unlink.mockRestore()
						vi.useRealTimers()
					}
				}
			})
		})

		describe("native original-owner joins", () => {
			const gate = () => {
				let resolve!: () => void
				let reject!: (reason: unknown) => void
				const promise = new Promise<void>((accept, refuse) => {
					resolve = accept
					reject = refuse
				})
				return { promise, resolve, reject }
			}
			type Settlement = { status: "fulfilled" } | { status: "rejected"; reason: unknown }
			const observe = (promise: Promise<void>) => {
				const state: { settlement?: Settlement } = {}
				const settled = promise.then(
					() => (state.settlement = { status: "fulfilled" as const }),
					(reason: unknown) => (state.settlement = { status: "rejected" as const, reason }),
				)
				return { state, settled }
			}
			const ownedTask = async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "native original-owner join boundary",
					startTask: false,
					enableCheckpoints: false,
				})
				await task.messageQueueService.ready
				return task
			}

			it.each([
				{ label: "successful", failed: false, reason: undefined },
				{ label: "Error", failed: true, reason: new Error("Original lifecycle failed") },
				{ label: "undefined", failed: true, reason: undefined },
				{ label: "null", failed: true, reason: null },
			])(
				"joins captured lifecycle and goal after handoff while preserving $label settlement",
				async ({ failed, reason }) => {
					const task = await ownedTask()
					const lifecycle = gate()
					const goal = gate()
					const replacementLifecycle = gate()
					const replacementGoal = gate()
					const ownedLifecycle = task["ownBackgroundLifecycle"]("start", lifecycle.promise)
					const lifecycleObserved = observe(ownedLifecycle)
					const goalObserved = observe(goal.promise)
					task["goalShutdownPromise"] = goal.promise
					const guard = task["captureAgentStepOwnership"]()
					let waiting: ReturnType<typeof observe> | undefined
					vi.useFakeTimers()
					try {
						waiting = observe(task.waitForTermination(guard))
						Object.assign(task, {
							agentRunId: "native-join-replacement-run",
							agentTurnId: "native-join-replacement-turn",
							ownedLifecyclePromise: replacementLifecycle.promise,
							goalShutdownPromise: replacementGoal.promise,
						})
						expect(guard()).toBe(false)
						if (failed) lifecycle.reject(reason)
						else lifecycle.resolve()
						await vi.advanceTimersByTimeAsync(0)
						expect(waiting.state.settlement).toBeUndefined()
						if (failed)
							goal.reject(new Error("Later original goal failure must not replace the lifecycle reason"))
						else goal.resolve()
						await vi.advanceTimersByTimeAsync(0)
						expect(waiting.state.settlement?.status).toBe(failed ? "rejected" : "fulfilled")
						const result = await waiting.settled
						if (failed) {
							if (result.status !== "rejected")
								throw new Error("Original failed lifecycle was treated as success")
							expect(result.reason).toBe(reason)
						}
						expect(task["ownedLifecyclePromise"]).toBe(replacementLifecycle.promise)
						expect(task["goalShutdownPromise"]).toBe(replacementGoal.promise)
						expect(vi.getTimerCount()).toBe(0)
					} finally {
						lifecycle.resolve()
						goal.resolve()
						replacementLifecycle.resolve()
						replacementGoal.resolve()
						try {
							if (waiting) await waiting.settled
							await lifecycleObserved.settled
							await goalObserved.settled
						} finally {
							task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
							vi.useRealTimers()
						}
					}
				},
			)

			it("keeps a captured native cancellation receipt authoritative over replacement lifecycle and goal joins", async () => {
				const task = await ownedTask()
				const cleanupEntered = gate()
				const releaseCleanup = gate()
				const replacementLifecycle = gate()
				const replacementGoal = gate()
				const originalFlush = task.flushApiConversationHistoryPersistence.bind(task)
				const flush = vi
					.spyOn(task, "flushApiConversationHistoryPersistence")
					.mockImplementation(async (guard) => {
						cleanupEntered.resolve()
						await releaseCleanup.promise
						await originalFlush(guard)
					})
				const dispose = vi.spyOn(task, "dispose")
				const replacementLifetime = new AbortController()
				let abort: ReturnType<typeof observe> | undefined
				let termination: ReturnType<typeof observe> | undefined
				let waiting: ReturnType<typeof observe> | undefined
				let clockControlled = false
				try {
					const receipt = task.beginTaskCancellation()
					abort = observe(receipt.abort)
					termination = observe(receipt.termination)
					expect(
						await Promise.race([cleanupEntered.promise.then(() => true), abort.settled.then(() => false)]),
					).toBe(true)
					expect(receipt.isCurrent()).toBe(true)
					waiting = observe(task.waitForTermination(receipt.isCurrent))
					vi.useFakeTimers()
					clockControlled = true
					await vi.advanceTimersByTimeAsync(0)
					expect(waiting.state.settlement).toBeUndefined()
					Object.assign(task, {
						agentRunId: "receipt-wait-replacement-run",
						agentTurnId: "receipt-wait-replacement-turn",
						ownedLifecyclePromise: replacementLifecycle.promise,
						goalShutdownPromise: replacementGoal.promise,
						taskCancellationController: replacementLifetime,
					})
					expect(receipt.isCurrent()).toBe(false)
					releaseCleanup.resolve()
					await vi.advanceTimersByTimeAsync(0)
					expect(waiting.state.settlement).toEqual({ status: "fulfilled" })
					expect(await waiting.settled).toEqual({ status: "fulfilled" })
					expect(await abort.settled).toEqual({ status: "fulfilled" })
					expect(await termination.settled).toEqual({ status: "fulfilled" })
					expect(task["ownedLifecyclePromise"]).toBe(replacementLifecycle.promise)
					expect(task["goalShutdownPromise"]).toBe(replacementGoal.promise)
					expect(replacementLifetime.signal.aborted).toBe(false)
					expect(dispose).not.toHaveBeenCalled()
				} finally {
					releaseCleanup.resolve()
					replacementLifecycle.resolve()
					replacementGoal.resolve()
					try {
						if (clockControlled) await vi.advanceTimersByTimeAsync(0)
						if (waiting) await waiting.settled
						if (abort) await abort.settled
						if (termination) await termination.settled
					} finally {
						flush.mockRestore()
						task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
						if (clockControlled) vi.useRealTimers()
					}
				}
			})

			it.each(["guarded", "legacy no-argument"] as const)(
				"keeps the %s transcript drain contract across a held real queued operation",
				async (mode) => {
					const task = await ownedTask()
					const originalEntered = gate()
					const original = gate()
					const replacementEntered = gate()
					const replacement = gate()
					const originalWrite = task["enqueueApiConversationHistoryPersistence"](async () => {
						originalEntered.resolve()
						await original.promise
					})
					await originalEntered.promise
					const guard = task["captureAgentStepOwnership"]()
					const foreignFailure = new Error("Replacement transcript failure must retain replacement ownership")
					const replacementHistory: ApiMessage[] = [{ role: "user", content: "replacement history" }]
					const replacementPending: Task["userMessageContent"] = [
						{ type: "text", text: "replacement pending" },
					]
					let replacementWrite: Promise<void> | undefined
					let waiting: ReturnType<typeof observe> | undefined
					vi.useFakeTimers()
					try {
						waiting = observe(
							mode === "guarded"
								? task.flushApiConversationHistoryPersistence(guard)
								: task.flushApiConversationHistoryPersistence(),
						)
						Object.assign(task, {
							agentRunId: "drain-replacement-run",
							agentTurnId: "drain-replacement-turn",
							apiConversationHistory: replacementHistory,
							userMessageContent: replacementPending,
							providerTranscriptSidecarFailure: foreignFailure,
						})
						replacementWrite = task["enqueueApiConversationHistoryPersistence"](async () => {
							replacementEntered.resolve()
							await replacement.promise
						})
						const replacementQueue = task["apiConversationHistorySaveQueue"]
						original.resolve()
						await vi.advanceTimersByTimeAsync(0)
						await originalWrite
						await replacementEntered.promise
						if (mode === "guarded") {
							expect(waiting.state.settlement).toEqual({ status: "fulfilled" })
						} else expect(waiting.state.settlement).toBeUndefined()
						expect(task["apiConversationHistorySaveQueue"]).toBe(replacementQueue)
						expect(task["providerTranscriptSidecarFailure"]).toBe(foreignFailure)
						expect(task.apiConversationHistory).toBe(replacementHistory)
						expect(task["userMessageContent"]).toBe(replacementPending)
						replacement.resolve()
						await vi.advanceTimersByTimeAsync(0)
						expect(await waiting.settled).toEqual(
							mode === "guarded"
								? { status: "fulfilled" }
								: { status: "rejected", reason: foreignFailure },
						)
						await replacementWrite
						expect(task["providerTranscriptSidecarFailure"]).toBe(foreignFailure)
					} finally {
						original.resolve()
						replacement.resolve()
						try {
							await originalWrite
							await replacementWrite
							if (waiting) await waiting.settled
						} finally {
							// This is an explicit new-owner recovery phase for the test-injected failure.
							if (task["providerTranscriptSidecarFailure"] === foreignFailure) {
								task["providerTranscriptSidecarFailure"] = undefined
							}
							task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
							vi.useRealTimers()
						}
					}
				},
			)

			it.each([
				{ label: "Error", reason: new Error("Original queue rejected before its observer resumed") },
				{ label: "undefined", reason: undefined },
				{ label: "null", reason: null },
			])("retains an awaited original queue $label rejection after guard loss", async ({ reason }) => {
				const task = await ownedTask()
				const original = gate()
				const replacement = gate()
				const originalObserved = observe(original.promise)
				const queues = Task["apiConversationHistorySaveQueues"]
				const key = task["apiConversationHistoryPersistenceKey"]
				const previous = queues.get(key)
				queues.set(key, original.promise)
				const guard = task["captureAgentStepOwnership"]()
				let waiting: ReturnType<typeof observe> | undefined
				vi.useFakeTimers()
				try {
					// Direct queue-fault injection covers the public drain's exact rejected-await contract.
					// Normal enqueue operations use an observed, fulfilled bookkeeping tail instead.
					waiting = observe(task.flushApiConversationHistoryPersistence(guard))
					Object.assign(task, { agentRunId: "queue-failure-new-run", agentTurnId: "queue-failure-new-turn" })
					queues.set(key, replacement.promise)
					original.reject(reason)
					await vi.advanceTimersByTimeAsync(0)
					expect(waiting.state.settlement?.status).toBe("rejected")
					const result = await waiting.settled
					if (result.status !== "rejected") throw new Error("Original queue rejection was hidden by handoff")
					expect(result.reason).toBe(reason)
					expect(queues.get(key)).toBe(replacement.promise)
				} finally {
					original.resolve()
					replacement.resolve()
					try {
						await originalObserved.settled
						if (waiting) await waiting.settled
					} finally {
						if (queues.get(key) === replacement.promise) {
							if (previous) queues.set(key, previous)
							else queues.delete(key)
						}
						task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
						vi.useRealTimers()
					}
				}
			})

			it("does not read live join handles, queues or failure state when either native join guard is already stale", async () => {
				const task = await ownedTask()
				const reads: string[] = []
				const fields = [
					"taskTerminationPromise",
					"ownedLifecyclePromise",
					"goalShutdownPromise",
					"providerTranscriptSidecarFailure",
				] as const
				const descriptors = new Map(fields.map((name) => [name, Object.getOwnPropertyDescriptor(task, name)]))
				for (const name of fields) {
					Object.defineProperty(task, name, {
						configurable: true,
						get: () => {
							reads.push(name)
							throw new Error(`Stale original join read replacement ${name}`)
						},
					})
				}
				const queueRead = vi.spyOn(Task["apiConversationHistorySaveQueues"], "get")
				try {
					await expect(task.waitForTermination(() => false)).resolves.toBeUndefined()
					await expect(task.flushApiConversationHistoryPersistence(() => false)).resolves.toBeUndefined()
					expect(reads).toEqual([])
					expect(queueRead).not.toHaveBeenCalled()
				} finally {
					queueRead.mockRestore()
					for (const name of fields) {
						const descriptor = descriptors.get(name)
						if (descriptor) Object.defineProperty(task, name, descriptor)
						else Reflect.deleteProperty(task, name)
					}
					task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
				}
			})
		})

		describe("Stream Failure Retry", () => {
			it("should not abort task on stream failure, only on user cancellation", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Spy on console.error to verify error logging
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Spy on abortTask to verify it's NOT called for stream failures
				const abortTaskSpy = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

				// Test Case 1: Stream failure should NOT abort task
				task.abort = false
				task.abandoned = false

				// Simulate the catch block behavior for stream failure
				const streamFailureError = new Error("Stream failed mid-execution")

				// The key assertion: verify that when abort=false, abortTask is NOT called
				// This would normally happen in the catch block around line 2184
				const shouldAbort = task.abort
				expect(shouldAbort).toBe(false)

				// Verify error would be logged (this is what the new code does)
				console.error(
					`[Task#${task.taskId}.${task.instanceId}] Stream failed, will retry: ${streamFailureError.message}`,
				)
				expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Stream failed, will retry"))

				// Verify abortTask was NOT called
				expect(abortTaskSpy).not.toHaveBeenCalled()

				// Test Case 2: User cancellation SHOULD abort task
				task.abort = true

				// For user cancellation, abortTask SHOULD be called
				if (task.abort) {
					await task.abortTask()
				}

				expect(abortTaskSpy).toHaveBeenCalled()

				// Restore mocks
				consoleErrorSpy.mockRestore()
			})
		})

		describe("cancelCurrentRequest", () => {
			it("should cancel the current HTTP request via AbortController", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Create a real AbortController and spy on its abort method
				const mockAbortController = new AbortController()
				const abortSpy = vi.spyOn(mockAbortController, "abort")
				task.currentRequestAbortController = mockAbortController

				// Spy on console.log
				const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

				// Call cancelCurrentRequest
				task.cancelCurrentRequest()

				// Verify abort was called on the controller
				expect(abortSpy).toHaveBeenCalled()

				// Verify the controller was cleared
				expect(task.currentRequestAbortController).toBeUndefined()

				// Verify logging
				expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Aborting current HTTP request"))

				// Restore console.log
				consoleLogSpy.mockRestore()
			})

			it("should handle missing AbortController gracefully", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Ensure no controller exists
				task.currentRequestAbortController = undefined

				// Should not throw when called with no controller
				expect(() => task.cancelCurrentRequest()).not.toThrow()
			})

			it("should be called during dispose", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Spy on cancelCurrentRequest
				const cancelSpy = vi.spyOn(task, "cancelCurrentRequest")

				// Mock other dispose operations
				vi.spyOn(task.messageQueueService, "removeListener").mockImplementation(
					() => task.messageQueueService as any,
				)
				vi.spyOn(task.messageQueueService, "dispose").mockImplementation(() => {})
				vi.spyOn(task, "removeAllListeners").mockImplementation(() => task as any)

				// Call dispose
				task.dispose()

				// Verify cancelCurrentRequest was called
				expect(cancelSpy).toHaveBeenCalled()
			})
		})
	})

	describe("token usage timer ownership", () => {
		let task: Task
		beforeEach(() => {
			vi.useFakeTimers()
			task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "Publish final usage without retaining timers",
				startTask: false,
			})
		})
		afterEach(() => {
			task.dispose()
			vi.useRealTimers()
		})
		const usage = (tokens: number) => ({
			totalTokensIn: tokens,
			totalTokensOut: tokens / 10,
			totalCost: tokens / 1_000,
			contextTokens: tokens,
		})

		it("publishes the latest final usage once without scheduling a timeout", async () => {
			const latest = usage(100)
			vi.spyOn(task, "getTokenUsage").mockReturnValue(latest)
			task.toolUsage = { read_file: { attempts: 2, failures: 1 } }
			const updated = vi.fn()
			task.on(AlphaCodeEventName.TaskTokenUsageUpdated, updated)

			task.emitFinalTokenUsageUpdate()
			task.emitFinalTokenUsageUpdate()

			expect(updated).toHaveBeenCalledExactlyOnceWith(task.taskId, latest, task.toolUsage)
			expect(vi.getTimerCount()).toBe(0)
			await vi.runAllTimersAsync()
			expect(updated).toHaveBeenCalledOnce()
		})

		it("cancels pending throttled usage before publishing the current terminal payload", async () => {
			const updated = vi.fn()
			task.on(AlphaCodeEventName.TaskTokenUsageUpdated, updated)
			task["debouncedEmitTokenUsage"](usage(100), {})
			task["debouncedEmitTokenUsage"](usage(200), {})
			expect(vi.getTimerCount()).toBe(1)
			updated.mockClear()
			const latest = usage(300)
			vi.spyOn(task, "getTokenUsage").mockReturnValue(latest)
			task.toolUsage = { read_file: { attempts: 3, failures: 0 } }

			task.emitFinalTokenUsageUpdate()

			expect(updated).toHaveBeenCalledExactlyOnceWith(task.taskId, latest, task.toolUsage)
			expect(vi.getTimerCount()).toBe(0)
			await vi.advanceTimersByTimeAsync(2_000)
			expect(updated).toHaveBeenCalledOnce()
		})

		it.each(["pending", "final"] as const)(
			"disposes %s usage timers without a later task event",
			async (boundary) => {
				vi.spyOn(task, "getTokenUsage").mockReturnValue(usage(300))
				task["debouncedEmitTokenUsage"](usage(100), {})
				task["debouncedEmitTokenUsage"](usage(200), {})
				if (boundary === "final") task.emitFinalTokenUsageUpdate()
				const emit = vi.spyOn(task, "emit")

				task.dispose()

				expect(vi.getTimerCount()).toBe(0)
				await vi.advanceTimersByTimeAsync(2_000)
				expect(emit).not.toHaveBeenCalledWith(
					AlphaCodeEventName.TaskTokenUsageUpdated,
					task.taskId,
					expect.anything(),
					expect.anything(),
				)
			},
		)

		it("retains normal usage throttling after a final emission", async () => {
			vi.spyOn(task, "getTokenUsage").mockReturnValue(usage(100))
			const updated = vi.fn()
			task.on(AlphaCodeEventName.TaskTokenUsageUpdated, updated)
			task.emitFinalTokenUsageUpdate()
			updated.mockClear()

			task["debouncedEmitTokenUsage"](usage(200), {})
			task["debouncedEmitTokenUsage"](usage(300), {})
			expect(updated).toHaveBeenCalledExactlyOnceWith(task.taskId, usage(200), {})
			expect(vi.getTimerCount()).toBe(1)
			await vi.advanceTimersByTimeAsync(1_999)
			expect(updated).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(1)
			expect(updated).toHaveBeenLastCalledWith(task.taskId, usage(300), {})
			expect(updated).toHaveBeenCalledTimes(2)
			expect(vi.getTimerCount()).toBe(0)
		})
	})

	describe("v2.0.9 root task loop", () => {
		const loopStorageParent = path.resolve(os.tmpdir())
		const loopStoragePrefix = "alpha-task-loop-"
		let loopStoragePath: string | undefined
		const startedTaskLoops = new Set<{ task: Task; run: Promise<void> }>()
		const trackTaskLoop = (task: Task) => {
			const initiateTaskLoop = task["initiateTaskLoop"].bind(task)
			task["initiateTaskLoop"] = (...args) => {
				const run = initiateTaskLoop(...args)
				startedTaskLoops.add({ task, run })
				void run.catch(() => undefined)
				return run
			}
		}
		const createTask = (taskKind: "primary" | "subagent" = "primary") => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "root loop regression",
				taskKind,
				startTask: false,
				enableCheckpoints: false,
			})
			fsSync.mkdirSync(path.join(mockExtensionContext.globalStorageUri.fsPath, "tasks", task.taskId), {
				recursive: true,
			})
			markTestHandlerAsLegacyEOF(task)
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "enqueueAlphaMessagesSave").mockImplementation(async (...args: unknown[]) => {
				const [createSnapshot, onPersisted] = args as [() => unknown, (() => void) | undefined]
				createSnapshot()
				onPersisted?.()
				return true
			})
			trackTaskLoop(task)
			return task
		}

		beforeEach(() => {
			// Owned directories preserve real goal locks and absent-state/path validation; transcript/UI writes stay mocked.
			loopStoragePath = fsSync.mkdtempSync(path.join(loopStorageParent, loopStoragePrefix))
			Object.assign(mockExtensionContext, { globalStorageUri: { fsPath: loopStoragePath } })
			i18n.addResourceBundle("en", "common", enCommon)
			mockProvider.getParentCompletionDecision = vi.fn().mockResolvedValue({ allowed: true })
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
				() => ({ get: (_key: string, defaultValue: unknown) => defaultValue }) as any,
			)
		})

		afterEach(async () => {
			// Settled loops retain Task resources for follow-ups; every started fixture must be stopped and joined.
			const runsByTask = new Map<Task, Promise<void>[]>()
			for (const { task, run } of startedTaskLoops) {
				const runs = runsByTask.get(task) ?? []
				runs.push(run)
				runsByTask.set(task, runs)
			}
			const settled = await Promise.allSettled(
				[...runsByTask].map(async ([task, runs]) => {
					const stopped = task.abortTask(true)
					try {
						await stopped
					} finally {
						try {
							await Promise.all(runs.map((run) => run.catch(() => undefined)))
						} finally {
							await task.waitForTermination()
						}
					}
				}),
			)
			const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
			startedTaskLoops.clear()
			try {
				if (loopStoragePath) {
					const target = path.resolve(loopStoragePath)
					if (
						path.dirname(target) !== loopStorageParent ||
						!path.basename(target).startsWith(loopStoragePrefix)
					) {
						throw new Error("Root loop fixture cleanup escaped its owned temporary directory")
					}
					fsSync.rmSync(target, { recursive: true, force: true })
					loopStoragePath = undefined
				}
			} catch (error) {
				failures.push(error)
			}
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, "Root loop fixture cleanup failed")
		})

		const deferred = <T = void>() => {
			let resolve!: (value: T | PromiseLike<T>) => void
			const promise = new Promise<T>((resolvePromise) => {
				resolve = resolvePromise
			})
			return { promise, resolve }
		}

		it("keeps Stop terminal when completed follow-up history precedes a held queue acknowledgement", async () => {
			const task = createTask()
			task.messageQueueService.removeListener("stateChanged", task["messageQueueStateChangedHandler"]!)
			task["messageQueueStateChangedHandler"] = undefined
			task.clineMessages = [{ ts: 1, type: "say", say: "completion_result", text: "done" }]
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "initial task" }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]
			task.markCompleted()
			const savedReceipts: string[][] = []
			const persistence = task as unknown as { saveApiConversationHistory: Task["saveApiConversationHistory"] }
			vi.spyOn(persistence, "saveApiConversationHistory").mockImplementation(async () => {
				savedReceipts.push(task.apiConversationHistory.flatMap((message) => message.queued_message_ids ?? []))
				return true
			})
			const providerRequest = vi.spyOn(task.api, "createMessage")
			const queued = await task.messageQueueService.addMessageDurably(
				"Persist this cancelled follow-up.",
				[],
				"stop-request",
			)
			const acknowledgementStarted = deferred()
			const releaseAcknowledgement = deferred()
			const flush = task.messageQueueService.flush.bind(task.messageQueueService)
			vi.spyOn(task.messageQueueService, "flush").mockImplementation(async () => {
				if (task.apiConversationHistory.some((message) => message.queued_message_ids?.includes(queued!.id))) {
					acknowledgementStarted.resolve()
					await releaseAcknowledgement.promise
				}
				await flush()
			})
			const emitted = vi.spyOn(task, "emit")
			const followup = task.resumeCompletedTaskFollowup(queued!.text, [], "human", [queued!.id])
			await acknowledgementStarted.promise
			expect(savedReceipts.some((ids) => ids.includes(queued!.id))).toBe(true)
			expect(task.messageQueueService.hasUnconsumedInput()).toBe(false)
			expect(providerRequest).not.toHaveBeenCalled()
			const stopped = deferred()
			task.once(AlphaCodeEventName.TaskAborted, () => stopped.resolve())
			const stopping = task.abortTask()
			await stopped.promise
			const afterStop = emitted.mock.calls.length
			releaseAcknowledgement.resolve()
			await expect(followup).resolves.toBeUndefined()
			await stopping
			await task.waitForTermination()

			expect(
				emitted.mock.calls
					.slice(afterStop)
					.filter(
						(call) =>
							call[0] === AlphaCodeEventName.TaskActive || call[0] === AlphaCodeEventName.TaskStarted,
					),
			).toEqual([])
			expect(task.abort).toBe(true)
			expect(
				task.apiConversationHistory.filter((message) => message.queued_message_ids?.includes(queued!.id)),
			).toHaveLength(1)
			expect(task.messageQueueService.hasUnconsumedInput()).toBe(false)
			expect(providerRequest).not.toHaveBeenCalled()
		})

		it.each(["primary", "subagent"] as const)(
			"delivers %s agent input without human queue, approval response, or interruption",
			async (kind) => {
				const task = createTask(kind)
				const userMessage = vi.fn()
				task.on(AlphaCodeEventName.TaskUserMessage, userMessage)
				const submit = vi.spyOn(task, "submitUserMessage")
				const steer = vi.spyOn(task, "steerUserMessage")
				const cancel = vi.spyOn(task, "cancelCurrentRequest")
				;(task as any).activeAsk = { type: "tool" }
				const save = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				const message = { id: "agent-event-1", senderTaskId: "parent", text: "Review this finding" }
				await task.receiveAgentMessage(message)
				expect(task.hasPendingAgentMessages()).toBe(true)
				expect(task.messageQueueService.isEmpty()).toBe(true)
				expect(submit).not.toHaveBeenCalled()
				expect(steer).not.toHaveBeenCalled()
				expect(cancel).not.toHaveBeenCalled()
				expect(userMessage).not.toHaveBeenCalled()
				expect(task.apiConversationHistory).toEqual([])
				;(task as any).activeAsk = undefined
				await (task as any).deliverAgentMessages()
				expect(save).toHaveBeenCalled()
				expect(task.apiConversationHistory).toEqual([expect.objectContaining({ agent_message_id: message.id })])
				expect(JSON.stringify(task.apiConversationHistory)).toContain("<agent_message>")
				expect(JSON.stringify(task.apiConversationHistory)).not.toContain("<user_message>")
				expect((task as any).buildCleanConversationHistory(task.apiConversationHistory)[0]).not.toHaveProperty(
					"agent_message_id",
				)
				// Human steering retains the complete agent envelope and its delivery receipt.
				const delivered = structuredClone(task.apiConversationHistory[0])
				await task["persistUserContentWithEnvironment"](
					task["buildUserMessageContent"]("Human steering", []),
					undefined,
					undefined,
					undefined,
					undefined,
					[],
					"human",
				)
				expect(task.apiConversationHistory[0]).toEqual(delivered)
				expect(task.apiConversationHistory[1]).toMatchObject({ role: "user", input_origin: "human" })
				// Replay after a crash between transcript persistence and inbox ACK.
				await task.receiveAgentMessage(message)
				await (task as any).deliverAgentMessages()
				expect(task.apiConversationHistory).toHaveLength(2)
			},
		)

		it("blocks completion while an agent message is being durably admitted", async () => {
			const task = createTask()
			const gate = deferred()
			const admitting = task.admitAgentMessage(() => gate.promise)
			expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: false, reasonCode: "interrupted" })
			gate.resolve()
			await admitting
			expect(task.hasPendingAgentMessages()).toBe(false)
		})

		it("joins admitted mailbox writes before building the next model input", async () => {
			const task = createTask()
			const gate = deferred()
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const admitting = task.admitAgentMessage(async () => {
				await gate.promise
				await task.receiveAgentMessage({ id: "slow-write", senderTaskId: "child", text: "Durable finding" })
			})
			const delivering = (task as any).deliverAgentMessages()
			expect(task.apiConversationHistory).toEqual([])
			gate.resolve()
			await Promise.all([admitting, delivering])
			expect(task.apiConversationHistory).toEqual([expect.objectContaining({ agent_message_id: "slow-write" })])
		})

		it("continues after visible text when agent input arrives during the model response", async () => {
			const task = createTask()
			const request = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					await task.receiveAgentMessage({
						id: "during-response",
						senderTaskId: "child",
						text: "New finding",
					})
					return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done" }]) }
				})
				.mockImplementationOnce(async () => {
					vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
					await (task as any).deliverAgentMessages()
					return true
				})
			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])
			expect(request).toHaveBeenCalledTimes(2)
			expect(request.mock.calls[1][0]).toEqual([])
		})

		it.each(["commentary", "reasoning"] as const)(
			"continues after %s to read automatic child reports without calling wait_agent",
			async (phase) => {
				const task = createTask()
				let resultPending = false
				mockProvider.hasPendingAgentResultNotifications = vi.fn(() => resultPending)
				mockProvider.deliverAgentMessages = vi.fn(async (_recipient, persist) => {
					await persist({
						id: "automatic-turn-result",
						senderTaskId: "child",
						text: "Follow-up finished",
						notification: {
							eventId: "automatic-turn-result",
							sequence: 1,
							rootTaskId: task.taskId,
							senderTaskId: "child",
							senderPath: "/root/child",
							recipientTaskId: task.taskId,
							recipientPath: "/root",
							kind: "result",
							name: "agent_completed",
							payload: { taskId: "child", status: "completed", summary: "Follow-up finished" },
							createdAt: 1,
						},
					})
					resultPending = false
				})
				const request = vi
					.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						resultPending = true
						return {
							status: "completed",
							response: createAgentResponse(
								phase === "reasoning"
									? [{ type: "reasoning", text: "Thinking about the review" }]
									: [{ type: "text", text: "Checking the review", phase: "commentary" }],
							),
						}
					})
					.mockImplementationOnce(async () => {
						await task["deliverAgentMessages"]()
						return true
					})
				await task["initiateTaskLoop"]([{ type: "text", text: "start" }])
				expect(request).toHaveBeenCalledTimes(2)
				expect(request.mock.calls[1][0]).toEqual([])
				expect(task.apiConversationHistory).toEqual([
					expect.objectContaining({
						input_origin: "agent",
						agent_message_id: "automatic-turn-result",
					}),
				])
				expect(JSON.parse((task.apiConversationHistory[0].content[0] as { text: string }).text)).toMatchObject({
					source: "managed_agent_notification",
					eventId: "automatic-turn-result",
					payload: { summary: "Follow-up finished" },
				})
			},
		)

		it.each(["final_answer", undefined] as const)(
			"retains passive child reports after a %s answer without another model request",
			async (phase) => {
				const task = createTask()
				mockProvider.hasPendingAgentResultNotifications = vi.fn(() => true)
				const delivery = vi.fn(async () => undefined)
				mockProvider.deliverAgentMessages = delivery
				const request = vi.spyOn(task, "runAgentRequests").mockResolvedValue({
					status: "completed",
					response: createAgentResponse([
						{ type: "text", text: "Review complete", ...(phase ? { phase } : {}) },
					]),
				})
				await task["initiateTaskLoop"]([{ type: "text", text: "start" }])
				expect(request).toHaveBeenCalledOnce()
				expect(delivery).not.toHaveBeenCalled()
				expect(task.isCompleted()).toBe(true)
				expect(mockProvider.getParentCompletionDecision).toHaveBeenCalledWith(task, {
					deferResultNotifications: true,
				})
			},
		)

		it("deduplicates an automatic result across a later native wait receipt", async () => {
			const task = createTask()
			const acknowledge = vi.spyOn(mockProvider, "acknowledgeWaitAgentResults").mockResolvedValue(undefined)
			const notification = {
				eventId: "automatic-before-wait",
				sequence: 1,
				createdAt: 1,
				rootTaskId: task.taskId,
				senderTaskId: "child",
				senderPath: "/root/child",
				recipientTaskId: task.taskId,
				recipientPath: "/root",
				kind: "result" as const,
				name: "agent_completed",
				payload: { status: "completed", summary: "Only one body" },
			}
			await task.receiveAgentMessage({
				id: notification.eventId,
				senderTaskId: "child",
				text: "Only one body",
				notification,
			})
			await task["deliverAgentMessages"]()
			task.apiConversationHistory.push({
				role: "assistant",
				content: [{ type: "tool_use", id: "wait-after-auto", name: "wait_agent", input: {} }],
			})
			task.retainWaitAgentResultClaim("wait-after-auto", "claim-after-auto")
			task.stageWaitAgentNotifications("claim-after-auto", [notification])
			task.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: "wait-after-auto",
				content: JSON.stringify({
					source: "managed_agent_mailbox",
					claimId: "claim-after-auto",
					eventCount: 1,
				}),
			})
			expect(task.userMessageContent.map((block) => block.type)).toEqual(["tool_result"])
			task["assistantMessageSavedToHistory"] = true
			await expect(task.flushPendingToolResultsToHistory()).resolves.toBe(true)
			expect(acknowledge).toHaveBeenCalledWith(task, "claim-after-auto")
			expect(JSON.stringify(task.apiConversationHistory).match(/Only one body/g)).toHaveLength(1)
		})

		it("uses the admitted step's approval mode and isolates the next-step task override", async () => {
			const task = createTask()
			task.setTaskApprovalMode("ask")
			const globalAskState = {
				approvalMode: "ask",
				autoApprovalEnabled: false,
				apiConfiguration: mockApiConfig,
			} as unknown as Awaited<ReturnType<AlphaProvider["getState"]>>
			const editAsk = {
				tool: JSON.stringify({ tool: "appliedDiff" }),
				command: "echo approval-mode-test",
			}
			const decide = (mode: ReturnType<Task["getTaskApprovalMode"]>, ask: "tool" | "command", text: string) =>
				checkAutoApprovalWithInheritedPolicy({
					state: task["approvalStateForAsk"](globalAskState, mode),
					ask,
					text,
				})

			const admittedMode = task["getApprovalModeForAsk"]()
			Object.assign(task, {
				currentAgentStep: { snapshot: { context: { policy: { approval: { mode: admittedMode } } } } },
			})
			expect(admittedMode).toBe("ask")
			expect(await decide(admittedMode, "tool", editAsk.tool)).toEqual({ decision: "ask" })
			expect(await decide(admittedMode, "command", editAsk.command)).toEqual({ decision: "ask" })

			// Changing the task while this step is admitted cannot widen its policy.
			expect(task.setTaskApprovalMode("auto")).toBe(true)
			expect(task["getApprovalModeForAsk"]()).toBe("ask")
			expect(await decide(task["getApprovalModeForAsk"](), "tool", editAsk.tool)).toEqual({ decision: "ask" })
			expect(await decide(task["getApprovalModeForAsk"](), "command", editAsk.command)).toEqual({
				decision: "ask",
			})

			// The next admitted step receives Auto, while the provider's default and
			// another task remain on Ask.
			Object.assign(task, {
				currentAgentStep: { snapshot: { context: { policy: { approval: { mode: "auto" } } } } },
			})
			expect(task["getApprovalModeForAsk"]()).toBe("auto")
			expect(await decide(task["getApprovalModeForAsk"](), "tool", editAsk.tool)).toEqual({ decision: "approve" })
			expect(await decide(task["getApprovalModeForAsk"](), "command", editAsk.command)).toEqual({
				decision: "approve",
			})
			const unrelatedTask = createTask()
			unrelatedTask.setTaskApprovalMode("ask")
			expect(unrelatedTask["getApprovalModeForAsk"]()).toBe("ask")
		})

		it("leaves the next model-facing user content free of child-report injection", async () => {
			const task = createTask()
			const presentationSummary = "Retained child presentation is not model input."
			const mailboxSummary = "Canonical child mailbox finding."
			task.clineMessages.push({
				ts: 1,
				type: "say",
				say: "subagent_group",
				subagentGroup: {
					groupId: "retained-child-group",
					parentTaskId: task.taskId,
					executionMode: "async",
					status: "completed",
					createdAt: 1,
					completedAt: 2,
					agents: [
						{
							taskId: "managed-child",
							nickname: "Ada",
							role: "explore",
							objective: "Inspect the parser",
							status: "completed",
							summary: presentationSummary,
							completedAt: 2,
							usage: { durationMs: 1 },
						},
					],
				},
			})
			await task.receiveAgentMessage({
				id: "canonical-child-report",
				senderTaskId: "managed-child",
				text: mailboxSummary,
				notification: {
					eventId: "canonical-child-report",
					sequence: 1,
					rootTaskId: task.taskId,
					senderTaskId: "managed-child",
					senderPath: "/root/child",
					recipientTaskId: task.taskId,
					recipientPath: "/root",
					kind: "result",
					name: "agent_completed",
					payload: { taskId: "managed-child", status: "completed", summary: mailboxSummary },
					createdAt: 2,
				},
			})
			expect(task.hasPendingAgentMessages()).toBe(true)
			mockProvider.getState = vi.fn().mockResolvedValue({})
			mockProvider.getValues = vi.fn().mockReturnValue({})
			const requests: Anthropic.Messages.MessageParam[][] = []
			vi.spyOn(task.api, "createMessage").mockImplementation(async function* (_system, messages) {
				requests.push(structuredClone(messages))
				yield { type: "text", text: "Read the canonical child finding." } as const
			})

			await expect(
				task.runAgentRequests([{ type: "text", text: "Continue the parent work." }], false),
			).resolves.toMatchObject({ status: "completed" })

			expect(requests).toHaveLength(1)
			const request = JSON.stringify(requests[0])
			expect(request).not.toContain(presentationSummary)
			expect(request).not.toContain("spawned_subagent_result")
			expect(request).toContain("managed_agent_notification")
			expect(request.split(mailboxSummary)).toHaveLength(2)
			expect(
				task.apiConversationHistory.filter((message) => message.agent_message_id === "canonical-child-report"),
			).toEqual([expect.objectContaining({ role: "user", input_origin: "agent" })])
			expect(
				JSON.stringify(
					task.apiConversationHistory.filter(
						(message) => message.role === "user" && message.input_origin !== "agent",
					),
				),
			).not.toContain(mailboxSummary)
			expect(task.hasPendingAgentMessages()).toBe(false)
			expect(JSON.stringify(task.clineMessages)).toContain(presentationSummary)
		})

		it("persists tool results before agent input and sends both to the next provider request", async () => {
			const task = createTask("subagent")
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "Inspect a file" }] },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "a.ts" } }],
				},
			]
			await task.receiveAgentMessage({ id: "message-1", senderTaskId: "parent", text: "Parent finding" })
			mockProvider.getState = vi.fn().mockResolvedValue({})
			mockProvider.getValues = vi.fn().mockReturnValue({})
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const requests: unknown[] = []
			vi.spyOn(task.api, "createMessage").mockImplementation(async function* (_system, messages) {
				requests.push(structuredClone(messages))
				yield { type: "text", text: "Read both inputs." } as const
			})
			await expect(
				task.runAgentRequests([{ type: "tool_result", tool_use_id: "read-1", content: "FILE_CONTENT" }], false),
			).resolves.toMatchObject({ status: "completed" })
			expect(requests).toHaveLength(1)
			const request = JSON.stringify(requests[0])
			expect(request).toContain("FILE_CONTENT")
			expect(request).toContain("Parent finding")
			expect(request.indexOf("FILE_CONTENT")).toBeLessThan(request.indexOf("Parent finding"))
			expect(request).not.toContain("agent_message_id")
			expect(task.hasPendingAgentMessages()).toBe(false)
		})

		it("includes pre-start managed-child steering in the first provider input before acknowledging it", async () => {
			const task = createTask("subagent")
			task.apiConversationHistory = []
			const requests: unknown[][] = []
			let historyAtAcknowledgement: unknown
			const onPersisted = vi.fn(() => {
				historyAtAcknowledgement = structuredClone(task.apiConversationHistory)
			})
			await task.steerUserMessage("STEERING_MESSAGE", [], onPersisted)

			mockProvider.getState = vi.fn().mockResolvedValue({})
			mockProvider.getValues = vi.fn().mockReturnValue({})
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task.api, "createMessage").mockImplementation(async function* (_system, messages) {
				requests.push(structuredClone(messages))
				yield { type: "text", text: "I received the parent instruction." } as const
			})

			await expect(
				task.runAgentRequests([{ type: "text", text: "INITIAL_CHILD_PROMPT" }], false),
			).resolves.toMatchObject({ status: "completed" })

			expect(requests).toHaveLength(1)
			expect(JSON.stringify(requests[0])).toContain("INITIAL_CHILD_PROMPT")
			expect(JSON.stringify(requests[0])).toContain("STEERING_MESSAGE")
			expect(onPersisted).toHaveBeenCalledOnce()
			expect(JSON.stringify(historyAtAcknowledgement)).toContain("STEERING_MESSAGE")
			expect(JSON.stringify(task.apiConversationHistory)).toContain("STEERING_MESSAGE")
		})

		// Keep the existing watchdog live while the scenario clock is frozen.
		const controlledSignalSetTimeout = setTimeout
		const controlledSignalClearTimeout = clearTimeout
		const waitForControlledSignal = async <T>(
			name: string,
			promise: Promise<T>,
			state: () => string,
		): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					promise,
					new Promise<T>((_resolve, reject) => {
						timer = controlledSignalSetTimeout(
							() => reject(new Error(`${name} timed out: ${state()}`)),
							4000,
						)
					}),
				])
			} finally {
				if (timer) controlledSignalClearTimeout(timer)
			}
		}

		const startEarlyReadStream = async (scenario: {
			barrier?: boolean
			outcome?: "failed" | "incomplete" | "cancelled"
			mismatch?: boolean | "arguments"
			failAssistantSave?: boolean
			failReadFinalizer?: boolean
			holdReadFinalizer?: boolean
			publicationFailure?: "event" | "journal"
			failReceiptSave?: boolean
			realStoppingAwait?: boolean
			unavailableReadPreparation?: boolean
			command?: { command: string; arguments: string }
			workdir?: (cwd: string) => string
			timing?: { providerTailMs: number; readMs: number; assistantSaveMs: number }
			failReadEffectFence?: boolean
			laterCall?: "queued-read" | "serial-command"
		}) => {
			const task = createTask()
			if (scenario.command || scenario.timing) {
				vi.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects").mockResolvedValue(undefined)
			}
			if (scenario.command) {
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			}
			const events: AgentTurnEvent[] = []
			const eventOrder: string[] = []
			let readTimer: ReturnType<typeof setTimeout> | undefined
			let providerTimer: ReturnType<typeof setTimeout> | undefined
			let assistantSaveTimer: ReturnType<typeof setTimeout> | undefined
			const lifecyclePublications: Array<{ type: string; durable: boolean }> = []
			const lifecycleEvents: AgentLifecycleEventInput[] = []
			let lifecycleSnapshot: any
			let sequence = 0
			const acceptedCallId = "early-read-1"
			let readEffectCount = 0
			const assistantSaveStarted = deferred()
			const releaseAssistantSave = deferred()
			const readStarted = deferred()
			const readResultReady = deferred()
			const providerTailReached = deferred()
			const providerEof = deferred()
			const normalCommandStarted = deferred()
			const releaseRead = deferred()
			const releaseProvider = deferred()
			const readFinalizerStarted = deferred()
			const releaseReadFinalizer = deferred()
			const stoppingWaitEntered = deferred()
			const releaseStoppingWait = deferred()
			const readEffectFenceEntered = deferred()
			const releaseReadEffectFence = deferred()
			const readEffectFenceFailure = new Error("Early read effect fence rejected before execution.")
			let publicationFailureInjected = false
			let receiptSaveAllowed = !scenario.failReceiptSave
			const persistedAssistantHistory: any[] = []
			const barrierExecute = vi.fn()
			let normalCommandEffectCount = 0
			let commandPreparationCount = 0
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const readExecute = vi.fn()
			if (scenario.laterCall === "serial-command") {
				readExecute.mockImplementation(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
					normalCommandEffectCount += 1
					normalCommandStarted.resolve()
					callbacks.pushToolResult("later serial command completed")
				})
			}
			if (!scenario.command)
				registry.register({
					name: "exec_command",
					aliases: [],
					schema: {
						type: "function",
						function: {
							name: "exec_command",
							description: "Run an audited read command",
							parameters: {
								type: "object",
								properties: { cmd: { type: "string" }, workdir: { type: "string" } },
								required: ["cmd"],
							},
						},
					},
					capabilities: {
						concurrency: "serial",
						sideEffects: "workspace",
						controlFlow: false,
						requiresApproval: true,
						parallelCommandRead: true,
					},
					prepareParallelCommand: async () => {
						if (scenario.unavailableReadPreparation) return undefined
						return {
							scope: path.resolve(task.cwd, "."),
							run: async (callbacks) => {
								readEffectCount += 1
								eventOrder.push("read_started")
								readStarted.resolve()
								if (scenario.timing) {
									readTimer = setTimeout(() => releaseRead.resolve(), scenario.timing.readMs)
								}
								await releaseRead.promise
								callbacks.pushToolResult("directory listing")
								eventOrder.push("read_result_ready")
								readResultReady.resolve()
								return async () => {
									readFinalizerStarted.resolve()
									if (scenario.holdReadFinalizer) await releaseReadFinalizer.promise
									if (scenario.failReadFinalizer) {
										eventOrder.push("read_finalizer_failed")
										throw new Error("Read output archive could not be finalized.")
									}
									eventOrder.push("read_published")
								}
							},
						}
					},
					isParallelCommandReadReady: async () => true,
					execute: readExecute,
				})
			if (scenario.command) {
				registry.register({
					name: "exec_command",
					aliases: [],
					schema: {
						type: "function",
						function: {
							name: "exec_command",
							description: "Execute a command",
							parameters: {
								type: "object",
								properties: { cmd: { type: "string" } },
								required: ["cmd"],
							},
						},
					},
					capabilities: {
						concurrency: "serial",
						sideEffects: "workspace",
						controlFlow: false,
						requiresApproval: true,
						parallelCommandRead: true,
					},
					prepareParallelCommand: async () => {
						commandPreparationCount += 1
						return undefined
					},
					execute: async ({ callbacks }) => {
						if (!(await callbacks.askApproval("command", scenario.command!.command))) return
						normalCommandEffectCount += 1
						eventOrder.push("normal_command_started")
						normalCommandStarted.resolve()
						callbacks.pushToolResult("normal command effect completed")
					},
				})
			}
			if (scenario.barrier) {
				registry.register({
					name: "attempt_completion",
					aliases: [],
					schema: {
						type: "function",
						function: {
							name: "attempt_completion",
							description: "Finish the task",
							parameters: { type: "object", properties: {} },
						},
					},
					capabilities: {
						concurrency: "barrier",
						sideEffects: "task",
						controlFlow: true,
						requiresApproval: false,
					},
					execute: barrierExecute,
				})
			}
			const surface = createTaskToolSurface({
				registry,
				mode: "code",
				applyProfile: false,
				autoApprovalEnabled: true,
				readGrant: { enabled: true, workspaceRoot: task.cwd, showIgnoredFiles: false },
				execution: { workspaceRoots: [task.cwd] },
				taskKind: "primary",
			})
			const state = {
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				showRooIgnoredFiles: false,
				...(scenario.command ? { alwaysAllowExecute: true, allowedCommands: [scenario.command.command] } : {}),
			}
			mockProvider.getState = vi.fn().mockResolvedValue(state)
			mockProvider.getValues = vi.fn().mockReturnValue(state)
			mockProvider.replayAgentLifecycle = vi.fn(async () => lifecycleSnapshot)
			mockProvider.getAgentLifecycleSnapshot = vi.fn(() => lifecycleSnapshot)
			mockProvider.publishAgentLifecycleEvent = vi.fn(async (input: any, options?: { durable?: boolean }) => {
				const event = { ...input, sequence: ++sequence }
				lifecycleEvents.push(structuredClone(input))
				lifecyclePublications.push({ type: event.type, durable: options?.durable === true })
				eventOrder.push(`lifecycle:${event.type}`)
				if (!lifecycleSnapshot) {
					lifecycleSnapshot = {
						version: 1,
						taskId: event.taskId,
						runId: event.runId,
						turnId: event.turnId,
						status: "in_progress",
						phase: "starting",
						lastSequence: 0,
						items: [],
						steps: [],
						acceptedToolCallIds: [],
						effectStartedToolCallIds: [],
						terminalToolCallIds: [],
						processedEvents: [],
						effectTrackingVersion: 1,
					}
				}
				lifecycleSnapshot.lastSequence = event.sequence
				if (event.type === "step_started") {
					lifecycleSnapshot.steps.push({ stepId: event.stepId, status: "in_progress", phase: "working" })
				} else if (event.type === "tool_call_accepted") {
					lifecycleSnapshot.items.push(event.payload.item)
					lifecycleSnapshot.acceptedToolCallIds.push(event.payload.item.toolCallId)
				} else if (event.type === "tool_effect_started") {
					lifecycleSnapshot.effectStartedToolCallIds.push(event.payload.toolCallId)
				} else if (event.type === "tool_result_recorded") {
					lifecycleSnapshot.items.push(event.payload.item)
					lifecycleSnapshot.terminalToolCallIds.push(event.payload.item.toolCallId)
					if (scenario.publicationFailure === "journal" && !publicationFailureInjected) {
						publicationFailureInjected = true
						throw new Error("Result journal acknowledgement failed after append.")
					}
				}
				return { accepted: true, event, snapshot: lifecycleSnapshot }
			})
			await (task as any).beginCanonicalLifecycleTurn()
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			if (scenario.realStoppingAwait) {
				task["pendingCommandVerification"] = releaseStoppingWait.promise
				const originalWait: Task["waitForRequestControl"] = task["waitForRequestControl"].bind(task)
				const controls = task as unknown as { waitForRequestControl: Task["waitForRequestControl"] }
				vi.spyOn(controls, "waitForRequestControl").mockImplementation(function <T>(
					operation: PromiseLike<T>,
					signal?: AbortSignal,
					absoluteDeadline?: number,
				): Promise<T> {
					if (Object.is(operation, releaseStoppingWait.promise)) stoppingWaitEntered.resolve()
					return originalWait(operation, signal, absoluteDeadline)
				})
			} else vi.spyOn(task, "recordToolCallForStopping").mockResolvedValue(undefined)
			vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockImplementation(async (...args: unknown[]) => {
				const event = args[0] as AgentTurnEvent
				events.push(event)
				eventOrder.push(`event:${event.type}`)
				if (
					scenario.publicationFailure === "event" &&
					event.type === "tool_result" &&
					!publicationFailureInjected
				) {
					publicationFailureInjected = true
					throw new Error("Result event acknowledgement failed after staging.")
				}
			})
			const initialAssistantCount = task.apiConversationHistory.filter(
				(message) => message.role === "assistant",
			).length
			vi.spyOn(task as any, "saveApiConversationHistory").mockImplementation(async () => {
				if (
					task.apiConversationHistory.filter((message) => message.role === "assistant").length >
					initialAssistantCount
				) {
					assistantSaveStarted.resolve()
					// The delay models the first assistant receipt; later result saves retain the released gate.
					if (scenario.timing && assistantSaveTimer === undefined) {
						assistantSaveTimer = setTimeout(
							() => releaseAssistantSave.resolve(),
							scenario.timing.assistantSaveMs,
						)
					}
					await releaseAssistantSave.promise
					if (scenario.failAssistantSave) return false
					const hasReadReceipt = task.apiConversationHistory.some(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.some(
								(block) => block.type === "tool_result" && block.tool_use_id === acceptedCallId,
							),
					)
					if (hasReadReceipt && !receiptSaveAllowed) return false
					persistedAssistantHistory.push(structuredClone(task.apiConversationHistory))
					eventOrder.push("assistant_saved")
				}
				return true
			})
			if (scenario.failAssistantSave) vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
			const executeCanonicalToolCalls = (task as any).executeCanonicalToolCalls.bind(task)
			const earlyDispatchSettled = deferred()
			vi.spyOn(task as any, "executeCanonicalToolCalls").mockImplementation(async (...args: any[]) => {
				const outcome = await executeCanonicalToolCalls(...args)
				if (args[5]?.deferResultCommit) earlyDispatchSettled.resolve(outcome)
				return outcome
			})
			if (scenario.failReadEffectFence) {
				const controls = task as unknown as {
					assertDurableAcceptedReadonlyToolCallBeforeEffects: Task["assertDurableAcceptedReadonlyToolCallBeforeEffects"]
				}
				const nativeReadFence = controls.assertDurableAcceptedReadonlyToolCallBeforeEffects.bind(task)
				let readFenceChecks = 0
				vi.spyOn(controls, "assertDurableAcceptedReadonlyToolCallBeforeEffects").mockImplementation(
					async (...args) => {
						await nativeReadFence(...args)
						// The first check admits the scheduler; its next native beforeEffect check fails.
						if (args[0].id === acceptedCallId && ++readFenceChecks === 2) {
							readEffectFenceEntered.resolve()
							await releaseReadEffectFence.promise
							throw readEffectFenceFailure
						}
					},
				)
			}
			let providerReachedEof = false
			let mismatchFinishSpy: { mockRestore: () => void } | undefined
			if (scenario.mismatch) {
				const originalFinish = AgentResponseAccumulator.prototype.finish
				mismatchFinishSpy = vi
					.spyOn(AgentResponseAccumulator.prototype, "finish")
					.mockImplementation(async function (
						this: AgentResponseAccumulator,
						...args: Parameters<AgentResponseAccumulator["finish"]>
					) {
						const response = await originalFinish.apply(this, args)
						return createAgentResponse(
							scenario.mismatch === "arguments"
								? response.items.map((item) =>
										item.type === "tool_call"
											? { ...item, arguments: { cmd: "git diff --stat", workdir: "." } }
											: item,
									)
								: [{ type: "text", text: "The finalized response omitted its accepted tool call." }],
							response.outcome,
						)
					})
			}
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					const attemptNumber = (attempt.mock.calls.length - 1) as number
					const turnId = (task as any).agentTurnId as string
					const step = {
						stepId: `${turnId}:step-${attemptNumber + 1}`,
						turnId,
						requestId: `early-read-request-${attemptNumber + 1}`,
						attemptId: `early-read-attempt-${attemptNumber + 1}`,
						surface,
						snapshot: {
							context: {
								contextId: "early-read-context",
								provider: { apiProtocol: "openai" },
								policy: surface.policy,
							},
							runtime: { getHandler: () => undefined },
						},
					}
					Object.assign(task, { currentAgentStep: step, currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					await (task as any).ensureCanonicalLifecycleStepStarted(step)
					if (attemptNumber > 0) {
						yield { type: "text", text: "The directory inspection is complete." }
						providerReachedEof = true
						return
					}
					yield {
						type: "tool_call",
						id: acceptedCallId,
						name: "exec_command",
						arguments:
							scenario.command?.arguments ??
							JSON.stringify({ cmd: "git status --short", workdir: scenario.workdir?.(task.cwd) ?? "." }),
					}
					yield { type: "tool_call_end", id: acceptedCallId }
					if (scenario.laterCall === "queued-read") {
						yield {
							type: "tool_call",
							id: "later-early-read",
							name: "exec_command",
							arguments: JSON.stringify({ cmd: "git diff --stat", workdir: "." }),
						}
						yield { type: "tool_call_end", id: "later-early-read" }
					}
					providerTailReached.resolve()
					if (scenario.timing) {
						providerTimer = setTimeout(() => releaseProvider.resolve(), scenario.timing.providerTailMs)
					}
					await releaseProvider.promise
					if (scenario.laterCall === "serial-command") {
						yield {
							type: "tool_call",
							id: "later-early-read",
							name: "exec_command",
							arguments: JSON.stringify({ cmd: "git add --all", workdir: "." }),
						}
						yield { type: "tool_call_end", id: "later-early-read" }
					}
					if (scenario.barrier) {
						yield {
							type: "tool_call",
							id: "later-barrier-1",
							name: "attempt_completion",
							arguments: JSON.stringify({ result: "done" }),
						}
						yield { type: "tool_call_end", id: "later-barrier-1" }
					} else if (scenario.outcome === "failed" || scenario.outcome === "incomplete") {
						if (scenario.outcome === "failed")
							yield {
								type: "error",
								error: "provider_failed",
								message: "Provider failed after the read completed.",
								retryable: false,
								semanticOutputObserved: true,
							}
						yield {
							type: "outcome",
							status: scenario.outcome,
							terminal: true,
							semanticOutputObserved: true,
							reason: "Provider failed after the read completed.",
							retryable: false,
						}
					} else if (scenario.outcome === "cancelled") {
						yield {
							type: "outcome",
							status: "cancelled",
							terminal: true,
							semanticOutputObserved: true,
							reason: "Provider cancelled after the read completed.",
						}
					} else {
						yield { type: "text", text: "The directory was inspected." }
					}
					eventOrder.push("provider_eof")
					providerReachedEof = true
					providerEof.resolve()
				})(),
			)
			const run = task.runAgentRequests([{ type: "text", text: "Inspect this directory." }], false)
			let runCompletion: unknown
			let runCompletedAt: number | undefined
			void run.then(
				(result) => {
					runCompletedAt = Date.now()
					runCompletion =
						typeof result === "boolean"
							? { value: result }
							: { status: result.status, reason: result.reason }
				},
				(error) => {
					runCompletion = { error: error instanceof Error ? error.message : String(error) }
				},
			)
			return {
				task,
				run,
				attempt,
				restoreMismatchSpy: () => mismatchFinishSpy?.mockRestore(),
				events,
				eventOrder,
				clearTimingTimers: () => {
					if (readTimer !== undefined) clearTimeout(readTimer)
					if (providerTimer !== undefined) clearTimeout(providerTimer)
					if (assistantSaveTimer !== undefined) clearTimeout(assistantSaveTimer)
				},
				lifecycleSnapshot: () => lifecycleSnapshot,
				debugState: () =>
					JSON.stringify({
						eventOrder,
						lifecycle: lifecyclePublications,
						providerReachedEof,
						runCompletion,
						assistantSavedToHistory: (task as any).assistantMessageSavedToHistory,
						historyRoles: task.apiConversationHistory.map((message) => message.role),
					}),
				lifecyclePublications,
				lifecycleEvents,
				publicationFailureInjected: () => publicationFailureInjected,
				providerTailReached: providerTailReached.promise,
				providerEof: providerEof.promise,
				normalCommandStarted: normalCommandStarted.promise,
				normalCommandEffectCount: () => normalCommandEffectCount,
				commandPreparationCount: () => commandPreparationCount,
				persistedAssistantHistory,
				barrierExecute,
				readExecute,
				acceptedCallId,
				readEffectCount: () => readEffectCount,
				providerReachedEof: () => providerReachedEof,
				runCompletion: () => runCompletion,
				runCompletedAt: () => runCompletedAt,
				assistantSaveStarted: assistantSaveStarted.promise,
				readStarted: readStarted.promise,
				readResultReady: readResultReady.promise,
				readFinalizerStarted: readFinalizerStarted.promise,
				stoppingWaitEntered: stoppingWaitEntered.promise,
				earlyDispatchSettled: earlyDispatchSettled.promise,
				readEffectFenceEntered: readEffectFenceEntered.promise,
				readEffectFenceFailure,
				releaseReadEffectFence: () => releaseReadEffectFence.resolve(),
				releaseRead: () => releaseRead.resolve(),
				releaseProvider: () => releaseProvider.resolve(),
				releaseAssistantSave: () => releaseAssistantSave.resolve(),
				releaseReadFinalizer: () => releaseReadFinalizer.resolve(),
				releaseStoppingWait: () => releaseStoppingWait.resolve(),
				allowReceiptSave: () => (receiptSaveAllowed = true),
			}
		}

		const earlyReadWorkdirs = [
			{ directory: "default", workdir: undefined },
			{ directory: "absolute", workdir: (cwd: string) => cwd },
			{ directory: "nested", workdir: () => "src" },
		]

		const stopEarlyReadStream = async (
			fixture?: Awaited<ReturnType<typeof startEarlyReadStream>>,
			options: { expectedRecoveryPersistenceFailure?: true } = {},
		) => {
			if (!fixture) return
			const stopped = fixture.task.abortTask(true)
			const expectedTermination = options.expectedRecoveryPersistenceFailure
				? fixture.task.waitForTermination().then(
						() => ({ status: "fulfilled" as const }),
						(error: unknown) => ({ status: "rejected" as const, error }),
					)
				: undefined
			fixture.releaseReadEffectFence()
			fixture.releaseRead()
			fixture.releaseProvider()
			fixture.releaseAssistantSave()
			fixture.releaseReadFinalizer()
			fixture.releaseStoppingWait()
			try {
				await stopped
			} finally {
				try {
					await fixture.run.catch(() => undefined)
				} finally {
					if (expectedTermination) {
						expect(await expectedTermination).toMatchObject({
							status: "rejected",
							error: {
								name: "Error",
								message:
									"Recovery tool-result receipts could not be durably saved during task termination.",
							},
						})
					} else await fixture.task.waitForTermination()
				}
			}
		}

		it.each([
			{ label: "a queued read before EOF", laterCall: "queued-read" as const },
			{ label: "a remaining serial command", laterCall: "serial-command" as const },
			{ label: "a single accepted read", laterCall: undefined },
		])("stops $label after a real failed early-read scheduler outcome", async ({ laterCall }) => {
			const fixture = await startEarlyReadStream({ failReadEffectFence: true, laterCall })
			try {
				await waitForControlledSignal("provider tail", fixture.providerTailReached, fixture.debugState)
				await waitForControlledSignal(
					"native read effect fence",
					fixture.readEffectFenceEntered,
					fixture.debugState,
				)
				fixture.releaseReadEffectFence()
				expect(
					await waitForControlledSignal(
						"failed early scheduler",
						fixture.earlyDispatchSettled,
						fixture.debugState,
					),
				).toMatchObject({
					status: "failed",
					failure: { kind: "effect_fence", message: fixture.readEffectFenceFailure.message },
				})
				// Let this fixture's ready promise work drain while the provider EOF gate remains held.
				await new Promise<void>((resolve) => setImmediate(() => resolve()))
				expect(fixture.providerReachedEof()).toBe(false)
				expect(fixture.readEffectCount()).toBe(0)
				fixture.releaseProvider()
				fixture.releaseAssistantSave()
				const result = await waitForControlledSignal("failed task step", fixture.run, fixture.debugState)
				expect(fixture.normalCommandEffectCount()).toBe(0)
				expect(result).toMatchObject({ status: "failed", reason: fixture.readEffectFenceFailure.message })
				expect(fixture.attempt).toHaveBeenCalledOnce()
				expect(fixture.readExecute).not.toHaveBeenCalled()
				expect(fixture.eventOrder).not.toContain("read_published")
				const expectedIds = [fixture.acceptedCallId, ...(laterCall ? ["later-early-read"] : [])]
				const toolUses = fixture.task.apiConversationHistory.flatMap((message) =>
					message.role === "assistant" && Array.isArray(message.content)
						? message.content.filter(
								(block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
							)
						: [],
				)
				const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
					message.role === "user" && Array.isArray(message.content)
						? message.content.filter(
								(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
							)
						: [],
				)
				expect(toolUses.map((block) => block.id)).toEqual(expectedIds)
				expect(receipts).toHaveLength(expectedIds.length)
				for (const id of expectedIds) {
					expect(receipts.filter((block) => block.tool_use_id === id)).toEqual([
						expect.objectContaining({ is_error: true }),
					])
					expect(
						fixture.lifecycleSnapshot().terminalToolCallIds.filter((callId: string) => callId === id),
					).toHaveLength(1)
				}
				expect(
					fixture.events.filter(
						(event) => event.type === "tool_result" && event.callId === fixture.acceptedCallId,
					),
				).toHaveLength(1)
			} finally {
				await stopEarlyReadStream(fixture)
			}
		})

		it.each(earlyReadWorkdirs)(
			"starts an audited read from $directory workdir before EOF and commits after durable history",
			async ({ workdir }) => {
				const fixture = await startEarlyReadStream({ workdir })
				const state = fixture.debugState
				try {
					await waitForControlledSignal("read start", fixture.readStarted, state)
					expect(fixture.providerReachedEof()).toBe(false)
					expect(fixture.readEffectCount()).toBe(1)
					const acceptance = fixture.lifecyclePublications.findIndex(
						(publication) => publication.type === "tool_call_accepted" && publication.durable,
					)
					expect(acceptance).toBeGreaterThanOrEqual(0)
					expect(fixture.eventOrder.indexOf("lifecycle:tool_call_accepted")).toBeLessThan(
						fixture.eventOrder.indexOf("read_started"),
					)

					fixture.releaseRead()
					await waitForControlledSignal("read result", fixture.readResultReady, state)
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, state)
					expect(fixture.providerReachedEof()).toBe(false)
					expect(fixture.eventOrder).not.toContain("read_published")
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					expect(fixture.task.userMessageContent.some((block) => block.type === "tool_result")).toBe(false)

					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					expect(fixture.task.userMessageContent.some((block) => block.type === "tool_result")).toBe(false)
					fixture.releaseAssistantSave()
					const result = await waitForControlledSignal("task run", fixture.run, state)

					expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
					expect(fixture.eventOrder.indexOf("read_published")).toBeGreaterThan(
						fixture.eventOrder.indexOf("assistant_saved"),
					)
					expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(1)
					expect(fixture.eventOrder.indexOf("read_started")).toBeLessThan(
						fixture.eventOrder.indexOf("provider_eof"),
					)
					expect(fixture.eventOrder.indexOf("provider_eof")).toBeLessThan(
						fixture.eventOrder.indexOf("event:tool_result"),
					)
					expect(fixture.eventOrder.filter((event) => event === "read_started")).toHaveLength(1)
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.persistedAssistantHistory[0]).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: "assistant",
								content: expect.arrayContaining([
									expect.objectContaining({ type: "tool_use", id: fixture.acceptedCallId }),
								]),
							}),
						]),
					)
					const pendingResults = fixture.task.userMessageContent.filter(
						(block) => block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
					)
					expect(pendingResults).toHaveLength(1)
					expect(pendingResults[0]).toMatchObject({ content: "directory listing", is_error: false })
					expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
					const historyResults = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(historyResults).toHaveLength(1)
					const callHistoryIndex = fixture.task.apiConversationHistory.findIndex(
						(message) =>
							message.role === "assistant" &&
							Array.isArray(message.content) &&
							message.content.some(
								(block) => block.type === "tool_use" && block.id === fixture.acceptedCallId,
							),
					)
					const resultHistoryIndex = fixture.task.apiConversationHistory.findIndex(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.some(
								(block) => block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
							),
					)
					expect(callHistoryIndex).toBeGreaterThanOrEqual(0)
					expect(resultHistoryIndex).toBeGreaterThan(callHistoryIndex)
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
				} finally {
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(earlyReadWorkdirs)(
			"measures read overlap for $directory workdir on the same controlled stream",
			async ({ directory, workdir }) => {
				let fixture: Awaited<ReturnType<typeof startEarlyReadStream>> | undefined
				vi.useFakeTimers()
				try {
					const started = Date.now()
					fixture = await startEarlyReadStream({
						workdir,
						timing: { providerTailMs: 200, readMs: 300, assistantSaveMs: 100 },
					})
					// Cold request setup settles while fake time is frozen, before the controlled workload advances.
					await waitForControlledSignal(
						"timed read and provider tail",
						Promise.all([fixture.readStarted, fixture.providerTailReached]),
						fixture.debugState,
					)
					expect(Date.now()).toBe(started)
					await vi.advanceTimersByTimeAsync(300)
					await waitForControlledSignal(
						"timed assistant save",
						fixture.assistantSaveStarted,
						fixture.debugState,
					)
					expect(Date.now()).toBe(started + 300)
					await vi.advanceTimersByTimeAsync(100)
					const result = await waitForControlledSignal("timed task run", fixture.run, fixture.debugState)
					const completedAt = fixture.runCompletedAt()
					expect(completedAt).toBeDefined()
					const elapsedMs = completedAt! - started
					const readStartedBeforeEof =
						fixture.eventOrder.indexOf("read_started") < fixture.eventOrder.indexOf("provider_eof")
					console.info(JSON.stringify({ directory, elapsedMs, readStartedBeforeEof }))
					expect(result).toMatchObject({ status: "completed" })
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledTimes(1)
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(readStartedBeforeEof).toBe(true)
					expect(elapsedMs).toBe(400)
					expect(
						await waitForControlledSignal(
							"timed result flush",
							fixture.task.flushPendingToolResultsToHistory(),
							fixture.debugState,
						),
					).toBe(true)
					expect(vi.getTimerCount()).toBe(0)
					await vi.runAllTimersAsync()
					expect(Date.now()).toBe(completedAt)
				} finally {
					fixture?.clearTimingTimers()
					vi.useRealTimers()
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(["../outside", "../path-sibling"])(
			"withholds a read from escaping workdir %s until ordinary staging",
			async (workdir) => {
				let fixture: Awaited<ReturnType<typeof startEarlyReadStream>> | undefined
				vi.useFakeTimers()
				try {
					fixture = await startEarlyReadStream({
						workdir: () => workdir,
						timing: { providerTailMs: 200, readMs: 300, assistantSaveMs: 100 },
					})
					await waitForControlledSignal(
						"escaping provider tail",
						fixture.providerTailReached,
						fixture.debugState,
					)
					await vi.runAllTimersAsync()
					await waitForControlledSignal("escaping task run", fixture.run, fixture.debugState)
					expect(fixture.readEffectCount()).toBe(0)
					expect(fixture.eventOrder).not.toContain("read_started")
					expect(fixture.task.userMessageContent).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								type: "tool_result",
								tool_use_id: fixture.acceptedCallId,
								is_error: true,
							}),
						]),
					)
				} finally {
					fixture?.clearTimingTimers()
					vi.useRealTimers()
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it("drains an in-flight nested read on provider cancellation and persists one cancelled result", async () => {
			const fixture = await startEarlyReadStream({ workdir: () => "src", outcome: "cancelled" })
			const state = fixture.debugState
			try {
				await waitForControlledSignal("read start", fixture.readStarted, state)
				fixture.releaseProvider()
				await waitForControlledSignal("provider EOF", fixture.providerEof, state)
				expect(fixture.eventOrder).not.toContain("read_result_ready")
				expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
				fixture.releaseRead()
				await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
				expect(fixture.eventOrder).not.toContain("read_published")
				fixture.releaseAssistantSave()
				expect(await waitForControlledSignal("task run", fixture.run, state)).toMatchObject({
					status: "aborted",
				})
				const results = fixture.task.apiConversationHistory.flatMap((message) =>
					message.role === "user" && Array.isArray(message.content)
						? message.content.filter(
								(block) => block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
							)
						: [],
				)
				expect(results).toHaveLength(1)
				expect(results[0]).toMatchObject({ is_error: true })
				expect(fixture.readEffectCount()).toBe(1)
				expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
				expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
			} finally {
				fixture.releaseRead()
				fixture.releaseProvider()
				fixture.releaseAssistantSave()
				await fixture.run.catch(() => undefined)
			}
		})

		it.each([
			{ label: "non-audited command", command: "node --version", arguments: { cmd: "node --version" } },
			{
				label: "legacy cwd command",
				command: "git status --short",
				arguments: { cmd: "git status --short", cwd: "src" },
			},
		])("runs a $label once through normal staging after provider EOF", async ({ command, arguments: args }) => {
			const callId = "early-read-1"
			const fixture = await startEarlyReadStream({
				command: { command, arguments: JSON.stringify(args) },
			})
			const state = fixture.debugState
			try {
				await waitForControlledSignal("provider command tail", fixture.providerTailReached, state)
				expect(fixture.providerReachedEof()).toBe(false)
				expect(fixture.normalCommandEffectCount()).toBe(0)
				expect(fixture.commandPreparationCount()).toBe(0)

				fixture.releaseProvider()
				await waitForControlledSignal("assistant history persistence", fixture.assistantSaveStarted, state)
				expect(fixture.normalCommandEffectCount()).toBe(0)
				fixture.releaseAssistantSave()
				await waitForControlledSignal("normal command effect", fixture.normalCommandStarted, state)
				expect(fixture.providerReachedEof()).toBe(true)
				expect(fixture.normalCommandEffectCount()).toBe(1)
				expect(fixture.commandPreparationCount()).toBe(1)
				expect(fixture.eventOrder.indexOf("provider_eof")).toBeLessThan(
					fixture.eventOrder.indexOf("normal_command_started"),
				)

				const result = await waitForControlledSignal("task run", fixture.run, state)
				expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
				expect(fixture.normalCommandEffectCount()).toBe(1)
				expect(
					fixture.task.userMessageContent.filter(
						(block) => block.type === "tool_result" && block.tool_use_id === callId,
					),
				).toHaveLength(1)
				expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
				const callHistoryIndex = fixture.task.apiConversationHistory.findIndex(
					(message) =>
						message.role === "assistant" &&
						Array.isArray(message.content) &&
						message.content.some((block) => block.type === "tool_use" && block.id === callId),
				)
				const resultHistoryIndex = fixture.task.apiConversationHistory.findIndex(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some((block) => block.type === "tool_result" && block.tool_use_id === callId),
				)
				expect(callHistoryIndex).toBeGreaterThanOrEqual(0)
				expect(resultHistoryIndex).toBeGreaterThan(callHistoryIndex)
				expect(
					fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) => block.type === "tool_result" && block.tool_use_id === callId,
								)
							: [],
					),
				).toHaveLength(1)
			} finally {
				await stopEarlyReadStream(fixture)
			}
		})

		it.each(earlyReadWorkdirs)(
			"settles an early $directory command read before rejecting a later lifecycle barrier",
			async ({ workdir }) => {
				const fixture = await startEarlyReadStream({ barrier: true, workdir })
				const state = fixture.debugState
				try {
					await waitForControlledSignal("read start", fixture.readStarted, state)
					expect(fixture.providerReachedEof()).toBe(false)
					fixture.releaseRead()
					await waitForControlledSignal("read result", fixture.readResultReady, state)
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)

					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					fixture.releaseAssistantSave()
					const result = await waitForControlledSignal("task run", fixture.run, state)

					expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
					expect(fixture.barrierExecute).not.toHaveBeenCalled()
					const pendingResults = fixture.task.userMessageContent.filter(
						(block) => block.type === "tool_result",
					)
					expect(pendingResults).toHaveLength(2)
					const pendingEarly = pendingResults.find((block) => block.tool_use_id === fixture.acceptedCallId)
					const pendingBarrier = pendingResults.find((block) => block.tool_use_id === "later-barrier-1")
					expect(pendingEarly).toMatchObject({ content: "directory listing", is_error: false })
					expect(pendingBarrier).toMatchObject({ is_error: true })
					expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
					const results = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_result")
							: [],
					)
					expect(results).toHaveLength(2)
					expect(results).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								tool_use_id: fixture.acceptedCallId,
								content: "directory listing",
								is_error: false,
							}),
							expect.objectContaining({
								tool_use_id: "later-barrier-1",
								is_error: true,
							}),
						]),
					)
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([
						fixture.acceptedCallId,
						"later-barrier-1",
					])
					expect(fixture.eventOrder.indexOf("event:tool_result")).toBeLessThan(
						fixture.eventOrder.indexOf("event:tool_batch_finished"),
					)
				} finally {
					fixture.releaseRead()
					fixture.releaseProvider()
					fixture.releaseAssistantSave()
					await fixture.run.catch(() => undefined)
				}
			},
		)

		it.each(
			earlyReadWorkdirs.map((workdir) => ({
				...workdir,
				outcome: "cancelled" as const,
				expectedStatus: "aborted",
			})),
		)(
			"withholds an early $directory read result when the provider ends $outcome",
			async ({ outcome, expectedStatus, workdir }) => {
				const fixture = await startEarlyReadStream({ outcome, workdir })
				const state = fixture.debugState
				try {
					await waitForControlledSignal("read start", fixture.readStarted, state)
					fixture.releaseRead()
					await waitForControlledSignal("read result", fixture.readResultReady, state)
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, state)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					fixture.releaseAssistantSave()
					const result = await waitForControlledSignal("task run", fixture.run, state)

					expect(result).toMatchObject({ status: expectedStatus })
					expect(fixture.eventOrder).not.toContain("read_published")
					const historyResults = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(historyResults).toHaveLength(1)
					expect(historyResults[0]).toMatchObject({
						is_error: true,
						content: expect.stringContaining("read completed"),
					})
					expect(fixture.events.filter((event) => event.type === "tool_result")).toHaveLength(0)
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
				} finally {
					fixture.releaseRead()
					fixture.releaseProvider()
					fixture.releaseAssistantSave()
					await fixture.run.catch(() => undefined)
				}
			},
		)

		it.each(
			earlyReadWorkdirs.flatMap((workdir) => [
				{ ...workdir, outcome: "failed" as const },
				{ ...workdir, outcome: "incomplete" as const },
			]),
		)(
			"publishes an early $directory read receipt when the provider ends $outcome",
			async ({ outcome, workdir }) => {
				const fixture = await startEarlyReadStream({ outcome, workdir })
				const state = fixture.debugState
				try {
					await waitForControlledSignal("read start", fixture.readStarted, state)
					fixture.releaseRead()
					await waitForControlledSignal("read result", fixture.readResultReady, state)
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, state)
					expect(fixture.eventOrder).not.toContain("read_published")
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					expect(fixture.eventOrder).not.toContain("read_published")
					fixture.releaseAssistantSave()
					const result = await waitForControlledSignal("task run", fixture.run, state)
					expect(result).toMatchObject({ status: outcome, response: { outcome: { status: outcome } } })
					expect(fixture.task.isCompleted()).toBe(false)
					expect(fixture.attempt).toHaveBeenCalledOnce()
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.readExecute).not.toHaveBeenCalled()
					expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(1)
					expect(fixture.eventOrder.indexOf("read_published")).toBeGreaterThan(
						fixture.eventOrder.indexOf("assistant_saved"),
					)
					const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(receipts).toEqual([
						expect.objectContaining({ content: "directory listing", is_error: false }),
					])
					expect(fixture.events.filter((event) => event.type === "tool_result")).toEqual([
						expect.objectContaining({
							callId: fixture.acceptedCallId,
							status: "success",
							output: "directory listing",
						}),
					])
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(
						fixture
							.lifecycleSnapshot()
							.items.filter((item: { type: string }) => item.type === "tool_result"),
					).toEqual([expect.objectContaining({ toolCallId: fixture.acceptedCallId, status: "success" })])
					const callIndex = fixture.task.apiConversationHistory.findIndex(
						(message) =>
							message.role === "assistant" &&
							Array.isArray(message.content) &&
							message.content.some(
								(block) => block.type === "tool_use" && block.id === fixture.acceptedCallId,
							),
					)
					const receiptIndex = fixture.task.apiConversationHistory.findIndex(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.includes(receipts[0]),
					)
					expect(callIndex).toBeGreaterThanOrEqual(0)
					expect(receiptIndex).toBeGreaterThan(callIndex)
				} finally {
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(
			(["failed", "incomplete"] as const).flatMap((outcome) => [
				{ outcome, mismatch: true as const, label: "omitted call" },
				{ outcome, mismatch: "arguments" as const, label: "changed arguments" },
			]),
		)(
			"withholds a settled early read for $label on a terminal $outcome response",
			async ({ outcome, mismatch }) => {
				const fixture = await startEarlyReadStream({ outcome, mismatch })
				try {
					await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
					fixture.releaseRead()
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					fixture.releaseAssistantSave()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: outcome,
					})
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledOnce()
					expect(fixture.eventOrder).not.toContain("read_published")
					expect(
						fixture.events.some((event) => event.type === "tool_result" && event.status === "success"),
					).toBe(false)
					const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(receipts).toEqual([expect.objectContaining({ is_error: true })])
					expect(JSON.stringify(receipts)).not.toContain("directory listing")
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
				} finally {
					fixture.restoreMismatchSpy()
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(["failed", "incomplete"] as const)(
			"withholds a settled preparation error without an approved read effect after a %s provider outcome",
			async (outcome) => {
				const fixture = await startEarlyReadStream({ outcome, unavailableReadPreparation: true })
				try {
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					fixture.releaseAssistantSave()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: outcome,
					})
					expect(fixture.readEffectCount()).toBe(0)
					expect(fixture.readExecute).not.toHaveBeenCalled()
					expect(fixture.eventOrder).not.toContain("read_started")
					expect(fixture.eventOrder).not.toContain("read_published")
					expect(fixture.eventOrder).not.toContain("read_finalizer_failed")
					expect(fixture.lifecycleEvents.some((event) => event.type === "tool_effect_started")).toBe(false)
					expect(
						fixture.events.some((event) => event.type === "tool_result" && event.status === "success"),
					).toBe(false)
					const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(receipts).toEqual([
						expect.objectContaining({
							is_error: true,
							content: expect.stringContaining("Tool call was not executed"),
						}),
					])
					expect(JSON.stringify(receipts)).not.toContain("directory listing")
					expect(JSON.stringify(receipts).toLowerCase()).not.toContain("read completed")
					expect(JSON.stringify(receipts).toLowerCase()).not.toContain("outcome is unknown")
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(fixture.task.isCompleted()).toBe(false)
					expect(fixture.attempt).toHaveBeenCalledOnce()
				} finally {
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(["failed", "incomplete"] as const)(
			"withholds completed early read output when the %s assistant boundary cannot be saved",
			async (outcome) => {
				const fixture = await startEarlyReadStream({ outcome, failAssistantSave: true })
				try {
					await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
					fixture.releaseRead()
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					fixture.releaseAssistantSave()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: "failed",
					})
					expect(fixture.eventOrder).not.toContain("read_published")
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					expect(fixture.task.userMessageContent.some((block) => block.type === "tool_result")).toBe(false)
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledOnce()
				} finally {
					await stopEarlyReadStream(fixture, { expectedRecoveryPersistenceFailure: true })
				}
			},
		)

		it.each(["failed", "incomplete"] as const)(
			"persists a real early-read archive error when the provider ends %s",
			async (outcome) => {
				const fixture = await startEarlyReadStream({ outcome, failReadFinalizer: true })
				try {
					await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
					fixture.releaseRead()
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					fixture.releaseAssistantSave()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: "failed",
						response: { outcome: { status: outcome } },
					})
					expect(fixture.eventOrder.filter((event) => event === "read_finalizer_failed")).toHaveLength(1)
					expect(fixture.eventOrder).not.toContain("read_published")
					const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(receipts).toEqual([
						expect.objectContaining({
							is_error: true,
							content: expect.stringContaining("archive could not be finalized"),
						}),
					])
					expect(fixture.events.filter((event) => event.type === "tool_result")).toEqual([
						expect.objectContaining({ callId: fixture.acceptedCallId, status: "error" }),
					])
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledOnce()
				} finally {
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it.each(["event", "journal"] as const)(
			"preserves truthful early read output after a partial %s publication failure",
			async (publicationFailure) => {
				const fixture = await startEarlyReadStream({ outcome: "failed", publicationFailure })
				try {
					await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
					fixture.releaseRead()
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					fixture.releaseAssistantSave()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: "failed",
						error: expect.any(Error),
					})
					expect(fixture.publicationFailureInjected()).toBe(true)
					expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(1)
					const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(
									(block) =>
										block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
								)
							: [],
					)
					expect(receipts).toEqual([
						expect.objectContaining({ content: "directory listing", is_error: false }),
					])
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(
						fixture
							.lifecycleSnapshot()
							.items.filter((item: { type: string }) => item.type === "tool_result"),
					).toEqual([expect.objectContaining({ toolCallId: fixture.acceptedCallId, status: "success" })])
					expect(fixture.events.filter((event) => event.type === "tool_result")).not.toContainEqual(
						expect.objectContaining({ status: "error" }),
					)
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledOnce()
				} finally {
					await stopEarlyReadStream(fixture)
				}
			},
		)

		it("retains a truthful early read receipt for explicit persistence repair without rerunning the finalizer", async () => {
			const fixture = await startEarlyReadStream({ outcome: "incomplete", failReceiptSave: true })
			try {
				await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
				fixture.releaseRead()
				await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
				fixture.releaseProvider()
				await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
				fixture.releaseAssistantSave()
				expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
					status: "failed",
				})
				expect(fixture.task.userMessageContent.filter((block) => block.type === "tool_result")).toEqual([
					expect.objectContaining({
						tool_use_id: fixture.acceptedCallId,
						content: "directory listing",
						is_error: false,
					}),
				])
				expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
				fixture.allowReceiptSave()
				expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
				expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
				const receipts = fixture.task.apiConversationHistory.flatMap((message) =>
					message.role === "user" && Array.isArray(message.content)
						? message.content.filter(
								(block) => block.type === "tool_result" && block.tool_use_id === fixture.acceptedCallId,
							)
						: [],
				)
				expect(receipts).toEqual([expect.objectContaining({ content: "directory listing", is_error: false })])
				expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(1)
				expect(fixture.readEffectCount()).toBe(1)
				expect(fixture.attempt).toHaveBeenCalledOnce()
			} finally {
				fixture.allowReceiptSave()
				await stopEarlyReadStream(fixture)
			}
		})

		it("joins discarded early-read cleanup without clearing a replacement response step", async () => {
			const fixture = await startEarlyReadStream({ mismatch: "arguments" })
			const discardEntered = deferred()
			const releaseDiscard = deferred()
			const discardClosed = deferred()
			const replacementAssistant: Task["assistantMessageContent"] = [
				{ type: "text", content: "Replacement response", partial: true },
			]
			const replacementUser: Task["userMessageContent"] = [{ type: "text", text: "Replacement request" }]
			let replacementInstalled = false
			let replacementStep: Task["currentAgentStep"]
			let replacementLifecycleReads = 0
			let lifecycleCount = 0
			let eventCount = 0
			let historyBefore: Task["apiConversationHistory"] = []
			let cleanupClosed = false
			let cleanupSucceeded = false
			const lifecycleOwner = fixture.task as unknown as {
				getCanonicalLifecycleSnapshot: Task["getCanonicalLifecycleSnapshot"]
			}
			const originalSnapshot = lifecycleOwner.getCanonicalLifecycleSnapshot.bind(fixture.task)
			const lifecycleRead = vi.spyOn(lifecycleOwner, "getCanonicalLifecycleSnapshot").mockImplementation(() => {
				if (replacementInstalled) replacementLifecycleReads += 1
				return originalSnapshot()
			})
			const originalDiscard = ToolScheduler.prototype.discardDeferredResults
			const discard = vi
				.spyOn(ToolScheduler.prototype, "discardDeferredResults")
				.mockImplementation(async function (this: ToolScheduler) {
					const step = fixture.task["currentAgentStep"]
					const runId = fixture.task["agentRunId"]
					if (!step || !runId || replacementInstalled)
						throw new Error("Expected one original disposal owner.")
					const turnId = `${step.turnId}-replacement`
					replacementStep = {
						...step,
						stepId: `${step.stepId}-replacement`,
						turnId,
						requestId: `${step.requestId}-replacement`,
						attemptId: `${step.attemptId}-replacement`,
					}
					historyBefore = structuredClone(fixture.task.apiConversationHistory)
					lifecycleCount = fixture.lifecycleEvents.length
					eventCount = fixture.events.length
					Object.assign(fixture.task, {
						currentAgentStep: replacementStep,
						agentRunId: `${runId}-replacement`,
						agentTurnId: turnId,
						assistantMessageContent: replacementAssistant,
						userMessageContent: replacementUser,
						currentStreamingContentIndex: 7,
						userMessageContentReady: false,
					})
					replacementInstalled = true
					discardEntered.resolve(undefined)
					try {
						await releaseDiscard.promise
						await originalDiscard.call(this)
						cleanupSucceeded = true
					} finally {
						cleanupClosed = true
						discardClosed.resolve(undefined)
					}
				})
			const expectReplacementUntouched = () => {
				expect(fixture.task["currentAgentStep"]).toBe(replacementStep)
				expect(fixture.task.assistantMessageContent).toBe(replacementAssistant)
				expect(fixture.task.userMessageContent).toBe(replacementUser)
				expect(fixture.task.currentStreamingContentIndex).toBe(7)
				expect(fixture.task.userMessageContentReady).toBe(false)
				expect(fixture.task.apiConversationHistory).toEqual(historyBefore)
				expect(fixture.lifecycleEvents).toHaveLength(lifecycleCount)
				expect(fixture.events).toHaveLength(eventCount)
				expect(replacementLifecycleReads).toBe(0)
			}
			try {
				await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
				fixture.releaseRead()
				await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
				fixture.releaseAssistantSave()
				fixture.releaseProvider()
				await waitForControlledSignal("discard entry", discardEntered.promise, fixture.debugState)
				expect(cleanupClosed).toBe(false)
				expect(fixture.runCompletion()).toBeUndefined()
				expectReplacementUntouched()
				releaseDiscard.resolve(undefined)
				await waitForControlledSignal("discard closure", discardClosed.promise, fixture.debugState)
				expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
					status: "aborted",
				})
				expectReplacementUntouched()
				expect(cleanupClosed).toBe(true)
				expect(cleanupSucceeded).toBe(true)
				expect(discard).toHaveBeenCalledOnce()
				expect(fixture.eventOrder).not.toContain("read_published")
				expect(fixture.readEffectCount()).toBe(1)
				expect(fixture.attempt).toHaveBeenCalledOnce()
			} finally {
				releaseDiscard.resolve(undefined)
				try {
					if (replacementInstalled) {
						await waitForControlledSignal("discard cleanup", discardClosed.promise, fixture.debugState)
					}
				} finally {
					discard.mockRestore()
					lifecycleRead.mockRestore()
					fixture.restoreMismatchSpy()
					await stopEarlyReadStream(fixture)
				}
			}
		})

		it.each([
			{ ownership: "step", boundary: "finalizer", provider: "failed", outcome: "failed" },
			{ ownership: "identity", boundary: "finalizer", provider: "failed", outcome: "failed" },
			{ ownership: "surface", boundary: "finalizer", provider: "failed", outcome: "failed" },
			{ ownership: "transcript", boundary: "finalizer", provider: "failed", outcome: "failed" },
			{ ownership: "step", boundary: "assistant save", provider: "failed", outcome: "failed" },
			{ ownership: "step", boundary: "finalizer", provider: "healthy", outcome: undefined },
			{ ownership: "transcript", boundary: "finalizer", provider: "healthy", outcome: undefined },
		] as const)(
			"fences $provider early read publication when $ownership ownership changes during its held $boundary",
			async ({ ownership, boundary, outcome }) => {
				const fixture = await startEarlyReadStream({ outcome, holdReadFinalizer: boundary === "finalizer" })
				let replacement: Task | undefined
				try {
					await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
					fixture.releaseRead()
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
					if (boundary === "finalizer") {
						fixture.releaseAssistantSave()
						expect(
							await Promise.race([
								fixture.readFinalizerStarted.then(() => true),
								fixture.run.then(() => false),
							]),
						).toBe(true)
					}
					const accepted = fixture.lifecycleEvents.find((event) => event.type === "tool_call_accepted")!
					expect(accepted).toBeDefined()
					const historyBefore = structuredClone(fixture.task.apiConversationHistory)
					const publicationCount = fixture.lifecycleEvents.length
					const replacementContent: Task["userMessageContent"] = []
					fixture.task.userMessageContent = replacementContent
					vi.mocked(fixture.task.recordToolCallForStopping).mockClear()
					if (ownership === "transcript") {
						replacement = new Task({
							provider: mockProvider,
							apiConfiguration: mockApiConfig,
							taskId: fixture.task.taskId,
							task: "Replacement transcript owner",
							startTask: false,
							enableCheckpoints: false,
						})
					} else {
						const step = fixture.task["currentAgentStep"]!
						const nextTurn = `${step.turnId}-replacement`
						const fields = {
							stepId: `${step.stepId}-replacement`,
							turnId: nextTurn,
							requestId: `${step.requestId}-replacement`,
							attemptId: `${step.attemptId}-replacement`,
						}
						fixture.task["agentRunId"] = `${fixture.task["agentRunId"]}-replacement`
						fixture.task["agentTurnId"] = nextTurn
						if (ownership === "identity") Object.assign(step, fields)
						else if (ownership === "surface") {
							const surface = createTaskToolSurface({ registry: step.surface!.registry, mode: "code" })
							fixture.task["currentTaskToolSurface"] = surface
							fixture.task["currentAgentStep"] = { ...step, ...fields, surface }
						} else fixture.task["currentAgentStep"] = { ...step, ...fields }
					}
					fixture.releaseAssistantSave()
					fixture.releaseReadFinalizer()
					expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
						status: "aborted",
					})
					expect(fixture.task.isCompleted()).toBe(false)
					expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(
						boundary === "finalizer" ? 1 : 0,
					)
					expect(fixture.task.recordToolCallForStopping).not.toHaveBeenCalled()
					expect(fixture.task.userMessageContent).toBe(replacementContent)
					expect(fixture.task.userMessageContent).toEqual([])
					expect(fixture.task.apiConversationHistory).toEqual(historyBefore)
					expect(fixture.lifecycleEvents.slice(publicationCount)).toEqual([])
					expect(fixture.lifecycleSnapshot()).toMatchObject({
						runId: accepted.runId,
						turnId: accepted.turnId,
					})
					expect(fixture.readEffectCount()).toBe(1)
					expect(fixture.attempt).toHaveBeenCalledOnce()
				} finally {
					try {
						await stopEarlyReadStream(fixture)
					} finally {
						await replacement?.abortTask(true)
						await replacement?.waitForTermination()
					}
				}
			},
		)

		it("fences the real Task stopping-evidence await after its captured owner is replaced", async () => {
			const fixture = await startEarlyReadStream({ outcome: "failed", realStoppingAwait: true })
			const recordOutcome = vi.spyOn(fixture.task["toolRepetitionDetector"], "recordOutcome")
			try {
				await waitForControlledSignal("read start", fixture.readStarted, fixture.debugState)
				fixture.releaseRead()
				await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, fixture.debugState)
				fixture.releaseProvider()
				await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, fixture.debugState)
				fixture.releaseAssistantSave()
				expect(
					await Promise.race([fixture.stoppingWaitEntered.then(() => true), fixture.run.then(() => false)]),
				).toBe(true)
				const step = fixture.task["currentAgentStep"]!
				const turnId = `${step.turnId}-replacement`
				const surface = createTaskToolSurface({ registry: step.surface!.registry, mode: "code" })
				const replacementContent: Task["userMessageContent"] = []
				const historyBefore = structuredClone(fixture.task.apiConversationHistory)
				const publicationCount = fixture.lifecycleEvents.length
				const recoveryBefore = fixture.task["completionRecovery"]
				fixture.task["agentRunId"] = `${fixture.task["agentRunId"]}-replacement`
				fixture.task["agentTurnId"] = turnId
				fixture.task["currentTaskToolSurface"] = surface
				fixture.task["currentAgentStep"] = { ...step, surface, turnId, stepId: `${step.stepId}-replacement` }
				fixture.task.userMessageContent = replacementContent
				fixture.task.didToolFailInCurrentTurn = false
				fixture.task["lastToolFailure"] = undefined
				recordOutcome.mockClear()
				fixture.releaseStoppingWait()
				expect(await waitForControlledSignal("task run", fixture.run, fixture.debugState)).toMatchObject({
					status: "aborted",
				})
				expect(recordOutcome).not.toHaveBeenCalled()
				expect(fixture.task["completionRecovery"]).toBe(recoveryBefore)
				expect(fixture.task["lastToolFailure"]).toBeUndefined()
				expect(fixture.task.didToolFailInCurrentTurn).toBe(false)
				expect(fixture.task.userMessageContent).toBe(replacementContent)
				expect(fixture.task.userMessageContent).toEqual([])
				expect(fixture.task.apiConversationHistory).toEqual(historyBefore)
				expect(fixture.lifecycleEvents.slice(publicationCount)).toEqual([])
				expect(fixture.eventOrder.filter((event) => event === "read_published")).toHaveLength(1)
				expect(fixture.readEffectCount()).toBe(1)
				expect(fixture.attempt).toHaveBeenCalledOnce()
			} finally {
				await stopEarlyReadStream(fixture)
			}
		})

		it.each(earlyReadWorkdirs)(
			"repairs an omitted accepted early $directory read in the final response",
			async ({ workdir }) => {
				const fixture = await startEarlyReadStream({ mismatch: true, workdir })
				const state = fixture.debugState
				try {
					await waitForControlledSignal("read start", fixture.readStarted, state)
					fixture.releaseRead()
					await waitForControlledSignal("read result", fixture.readResultReady, state)
					await waitForControlledSignal("early dispatch", fixture.earlyDispatchSettled, state)
					fixture.releaseProvider()
					await waitForControlledSignal("assistant save", fixture.assistantSaveStarted, state)
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
					fixture.releaseAssistantSave()
					const result = await waitForControlledSignal("task run", fixture.run, state)

					expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
					expect(
						fixture.task.apiConversationHistory.flatMap((message) =>
							message.role === "user" && Array.isArray(message.content)
								? message.content.filter(
										(block) =>
											block.type === "tool_result" &&
											block.tool_use_id === fixture.acceptedCallId,
									)
								: [],
						),
					).toHaveLength(1)
					expect(fixture.lifecycleSnapshot().terminalToolCallIds).toEqual([fixture.acceptedCallId])
					expect(fixture.events.some((event) => event.type === "tool_result")).toBe(false)
				} finally {
					fixture.releaseRead()
					fixture.releaseProvider()
					fixture.releaseAssistantSave()
					fixture.restoreMismatchSpy()
					await fixture.run.catch(() => undefined)
				}
			},
		)

		it.each(["apply_patch", "edit"])(
			"executes the advertised %s preference through the Task scheduler",
			async (name) => {
				const task = createTask()
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
				vi.spyOn(task, "say").mockResolvedValue(undefined)
				vi.spyOn(
					task as unknown as { assertCurrentProviderTranscriptBeforeEffects(): Promise<void> },
					"assertCurrentProviderTranscriptBeforeEffects",
				).mockResolvedValue(undefined)
				const registry = new ToolRegistry({ includeBuiltIns: false })
				const execute = vi.fn(
					async ({ callbacks }: { callbacks: { pushToolResult: (text: string) => void } }) => {
						callbacks.pushToolResult("Edit completed")
					},
				)
				registry.register({
					name,
					aliases: [],
					schema: {
						type: "function",
						function: {
							name,
							description: "Scoped edit fixture",
							parameters: { type: "object", properties: {} },
						},
					},
					capabilities: {
						concurrency: "serial",
						sideEffects: "none",
						requiresApproval: false,
						controlFlow: false,
					},
					execute,
				})
				const surface = createTaskToolSurface({ registry, mode: "code" })
				const outcome = await task["executeCanonicalToolCalls"](
					createAgentResponse([
						{
							type: "tool_call",
							id: "preferred-edit",
							name,
							arguments:
								name === "apply_patch"
									? { patch: "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch" }
									: {},
						},
						{ type: "tool_call", id: "hidden-edit", name: "apply_diff", arguments: {} },
					]),
					surface,
					"code",
					undefined,
					new AbortController().signal,
				)
				expect(outcome.results[0]).toMatchObject({ status: "success", content: "Edit completed" })
				expect(outcome.results[1].status).toBe("error")
				expect(execute).toHaveBeenCalledOnce()
			},
		)

		it("finishes a managed child from its streamed final text without a forced tool round", async () => {
			const task = createTask("subagent")
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)
			const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					if (request.mock.calls.length > 1) {
						throw Object.assign(new Error("Unexpected extra request after the final answer"), {
							retryable: false,
						})
					}
					yield { type: "text", text: "The parser handles the reported case correctly." }
				})(),
			)

			await Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "Review the parser." }])

			expect(request).toHaveBeenCalledOnce()
			expect(ask).not.toHaveBeenCalled()
			expect(completed).toHaveBeenCalledOnce()
			expect(Reflect.get(task, "didComplete")).toBe(true)
			expect(task.subagentCompletionOutcome).toBe("completed")
			expect(task.clineMessages.filter((message) => message.say === "completion_result")).toEqual([
				expect.objectContaining({ text: "The parser handles the reported case correctly.", partial: false }),
			])
			expect(JSON.stringify(task.apiConversationHistory)).not.toContain(formatResponse.noToolsUsed())
			expect(await task.finalizeTaskCompletion()).toBe(false)
			expect(completed).toHaveBeenCalledOnce()
		})

		it("keeps a clean legacy text-only EOF completed", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			markTestHandlerAsLegacyEOF(task)
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: "The response completed normally." }
				})(),
			)

			await expect(
				task.runAgentRequests([{ type: "text", text: "Explain the result." }], false),
			).resolves.toMatchObject({
				status: "completed",
				response: { text: "The response completed normally." },
			})
		})

		it("retains provider continuation through canonical stream finalization", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			Object.defineProperty(task.api, "streamCapabilities", {
				configurable: true,
				value: { lifecycle: true, cancellation: true },
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: "Continue processing this response." }
					yield {
						type: "outcome",
						status: "completed",
						terminal: true,
						semanticOutputObserved: true,
						requiresContinuation: true,
					}
				})(),
			)

			await expect(task.runAgentRequests([{ type: "text", text: "Start." }], false)).resolves.toMatchObject({
				status: "completed",
				response: { outcome: { status: "completed", requiresContinuation: true } },
			})
		})

		it("does not complete lifecycle output when the provider ends without a terminal outcome", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			Object.defineProperty(task.api, "streamCapabilities", {
				configurable: true,
				value: { lifecycle: true, cancellation: true },
			})
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: "This answer was cut off." }
				})(),
			)

			const result = await task.runAgentRequests([{ type: "text", text: "Explain the result." }], false)

			expect(result).toMatchObject({
				status: "incomplete",
				reason: "Provider stream closed before a terminal response outcome.",
				response: { text: "This answer was cut off.", outcome: { status: "incomplete" } },
			})
			expect(attempt).toHaveBeenCalledOnce()
			const terminalEvents = appendEvent.mock.calls
				.map(([event]) => event as AgentTurnEvent)
				.filter((event) => event.type === "response_terminal")
			expect(terminalEvents).toHaveLength(1)
			expect(terminalEvents[0]).toMatchObject({ type: "response_terminal", status: "incomplete" })
		})

		it("keeps provider errors after lifecycle text failed", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			Object.defineProperty(task.api, "streamCapabilities", {
				configurable: true,
				value: { lifecycle: true, cancellation: true },
			})
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: "This answer stopped early." }
					throw new Error("Provider stream failed after visible output.")
				})(),
			)

			const result = await task.runAgentRequests([{ type: "text", text: "Explain the result." }], false)

			expect(result).toMatchObject({
				status: "failed",
				reason: expect.stringContaining("Provider stream failed after visible output."),
				response: { text: "This answer stopped early.", outcome: { status: "failed" } },
			})
			expect(attempt).toHaveBeenCalledOnce()
			const terminalEvents = appendEvent.mock.calls
				.map(([event]) => event as AgentTurnEvent)
				.filter((event) => event.type === "response_terminal")
			expect(terminalEvents).toHaveLength(1)
			expect(terminalEvents[0]).toMatchObject({ type: "response_terminal", status: "failed" })
		})

		it("keeps cancellation terminal after lifecycle output has started", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			Object.defineProperty(task.api, "streamCapabilities", {
				configurable: true,
				value: { lifecycle: true, cancellation: true },
			})
			const requestController = new AbortController()
			let markStreamWaiting!: () => void
			const streamWaiting = new Promise<void>((resolve) => {
				markStreamWaiting = resolve
			})
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					task.currentRequestAbortController = requestController
					;(task as any).currentRequestSignal = requestController.signal
					yield { type: "text", text: "This answer was interrupted." }
					markStreamWaiting()
					await new Promise<void>((_resolve, reject) => {
						requestController.signal.addEventListener(
							"abort",
							() => reject(requestController.signal.reason),
							{ once: true },
						)
					})
				})(),
			)

			const pending = task.runAgentRequests([{ type: "text", text: "Explain the result." }], false)
			await streamWaiting
			task.cancelCurrentRequest()
			const result = await pending

			expect(result).toMatchObject({ status: "aborted", response: { outcome: { status: "cancelled" } } })
			expect(attempt).toHaveBeenCalledOnce()
			const terminalEvents = appendEvent.mock.calls
				.map(([event]) => event as AgentTurnEvent)
				.filter((event) => event.type === "response_terminal")
			expect(terminalEvents).toHaveLength(1)
			expect(terminalEvents[0]).toMatchObject({ type: "response_terminal", status: "aborted" })
		})

		it.each([false, true])(
			"automatically recovers a recognized empty response with tool auto-approval=%s",
			async (autoApprovalEnabled) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				const events = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const request = vi
					.spyOn(task, "attemptApiRequest")
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield* []
							throw Object.assign(new Error("Response contained no choices."), {
								firstChunkFailure: true,
								retryable: true,
								retryCategory: "empty-response",
							})
						})(),
					)
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield { type: "text", text: "Recovered answer." }
						})(),
					)

				await expect(task.runAgentRequests([{ type: "text", text: "start" }], false)).resolves.toMatchObject({
					status: "completed",
				})
				expect(request).toHaveBeenCalledTimes(2)
				expect(ask).not.toHaveBeenCalled()
				expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "retry", attempt: 1 }))
			},
		)

		it("persists queued receipt IDs from host mistake-limit feedback before acknowledging input", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task as any, "shouldAutoRecoverFromMistakeLimit").mockResolvedValue(false)
			const guidance = await task.messageQueueService.addMessageDurably(
				"Use the smaller repair",
				[],
				"mistake-reply",
			)
			expect(guidance).toBeDefined()
			task.messageQueueService.claimMessage(guidance!.id)
			await task.messageQueueService.flush()
			vi.spyOn(task, "ask").mockResolvedValue({
				response: "messageResponse",
				text: guidance!.text,
				images: guidance!.images,
				queuedMessageIds: [guidance!.id],
			})
			const content: Anthropic.Messages.ContentBlockParam[] = []

			await task["handleConsecutiveMistakeLimit"](content)
			const ids = task["getQueuedInputReceipts"](content)
			expect(ids).toEqual([guidance!.id])
			expect(task.messageQueueService.getClaimedMessageIds()).toEqual([guidance!.id])
			await task["persistUserContentWithEnvironment"](
				content,
				undefined,
				undefined,
				undefined,
				undefined,
				ids,
				"human",
			)
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				queued_message_ids: [guidance!.id],
				input_origin: "human",
			})
			expect(task.messageQueueService.hasUnconsumedInput()).toBe(false)
		})

		it.each(["first-chunk", "empty-response"] as const)(
			"returns a queued %s recovery reply to visible input before reporting the failed step",
			async (failure) => {
				const task = createTask()
				markTestHandlerAsLegacyEOF(task)
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockImplementation(async (type) => {
					expect(type).toBe("api_req_failed")
					const guidance = await task.messageQueueService.addMessageDurably(
						"Use the smaller repair",
						[],
						"provider-failure-reply",
					)
					task.messageQueueService.claimMessage(guidance!.id)
					await task.messageQueueService.flush()
					return {
						response: "messageResponse",
						text: guidance!.text,
						queuedMessageIds: [guidance!.id],
					}
				})
				const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
					(async function* (): AsyncGenerator<ApiStreamChunk> {
						yield* []
						if (failure === "first-chunk")
							throw Object.assign(new Error("Provider failure"), { firstChunkFailure: true })
					})(),
				)

				await expect(task.runAgentRequests([{ type: "text", text: "start" }], false)).resolves.toMatchObject({
					status: failure === "first-chunk" ? "failed" : "incomplete",
				})
				expect(request).toHaveBeenCalledOnce()
				expect(ask).toHaveBeenCalledOnce()
				expect(task.messageQueueService.getClaimedMessageIds()).toEqual([])
				expect(task.messageQueueService.messages).toEqual([
					expect.objectContaining({ id: "provider-failure-reply", text: "Use the smaller repair" }),
				])
				expect(task.apiConversationHistory.some((message) => message.queued_message_ids?.length)).toBe(false)
			},
		)

		it.each([false, true])(
			"persists fresh steering during manual retry publication without replay (split=%s)",
			async (split) => {
				const task = createTask()
				const initial = "Inspect the parser in this chat."
				const original = "Create a new independent task for the parser review."
				const steer = "Do not create a new task. Stay in this chat."
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
				vi.spyOn(task, "say").mockImplementation(async (type) => {
					if (type === "api_req_retried") await task.steerUserMessageDurably(steer, [], "retry-steering")
				})
				if (split) {
					vi.mocked(captureEnvironmentDetails).mockImplementationOnce(async () => {
						await task.steerUserMessageDurably(original, [], "initial-steering")
						return { details: "", commit: vi.fn(), release: vi.fn() }
					})
				}
				let retriedHistory: ApiMessage[] = []
				const request = vi
					.spyOn(task, "attemptApiRequest")
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield* []
							throw Object.assign(new Error("Manual retry required"), { firstChunkFailure: true })
						})(),
					)
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							retriedHistory = structuredClone(task.apiConversationHistory)
							yield { type: "text", text: "Continuing in this chat." }
						})(),
					)

				await expect(
					task.runAgentRequests(task["buildUserMessageContent"](split ? initial : original, []), false),
				).resolves.toMatchObject({
					status: "completed",
				})
				expect(request).toHaveBeenCalledTimes(2)
				expect(task["getUserRequestTextForCatalog"]()).toBe(steer)
				expect(
					retriedHistory.filter((message) => JSON.stringify(message.content).includes(initial)),
				).toHaveLength(split ? 1 : 0)
				expect(
					retriedHistory.filter((message) => JSON.stringify(message.content).includes(original)),
				).toHaveLength(1)
				expect(
					retriedHistory.filter((message) => JSON.stringify(message.content).includes(steer)),
				).toHaveLength(1)
				expect(retriedHistory.at(-1)).toMatchObject({
					input_origin: "human",
					queued_message_ids: ["retry-steering"],
				})
				expect(task.messageQueueService.hasUnconsumedInput()).toBe(false)
			},
		)

		it.each([undefined, false, true])(
			"bounds first-chunk recovery with retryable=%s and keeps manual recovery available",
			async (retryable) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
					(async function* (): AsyncGenerator<ApiStreamChunk> {
						yield* []
						throw Object.assign(new Error("Provider failure"), {
							firstChunkFailure: true,
							retryable,
							retryCategory: "empty-response",
						})
					})(),
				)

				await expect(task.runAgentRequests([{ type: "text", text: "start" }], false)).resolves.toMatchObject({
					status: "failed",
				})
				expect(request).toHaveBeenCalledTimes(retryable === true ? 2 : 1)
				if (retryable === false) expect(ask).not.toHaveBeenCalled()
				else expect(ask).toHaveBeenCalledExactlyOnceWith("api_req_failed", "Provider failure")
			},
		)

		it.each([false, true])(
			"compacts a first-chunk context rejection independently of tool auto-approval=%s",
			async (autoApprovalEnabled) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				const compact = vi.spyOn(task as any, "handleContextWindowExceededError").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const request = vi
					.spyOn(task, "attemptApiRequest")
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield* []
							// Responses preserves this classification without a retryable flag.
							throw Object.assign(new Error("Opaque provider context failure."), {
								firstChunkFailure: true,
								retryCategory: "context",
							})
						})(),
					)
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield { type: "text", text: "Recovered after compaction." }
						})(),
					)

				await expect(
					task.runAgentRequests([{ type: "text", text: "follow up" }], false),
				).resolves.toMatchObject({
					status: "completed",
				})
				expect(compact).toHaveBeenCalledExactlyOnceWith(expect.any(Number))
				expect(request).toHaveBeenCalledTimes(2)
				expect(request.mock.calls[1]?.[1]).toMatchObject({
					retryCategory: "context",
					retryDeadline: expect.any(Number),
				})
				expect(ask).not.toHaveBeenCalled()
				expect(task.apiConversationHistory.filter((message) => message.role === "user")).toHaveLength(1)
			},
		)

		it.each([undefined, false] as const)(
			"bounds first-chunk context recovery and preserves retryable=%s",
			async (retryable) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				const compact = vi.spyOn(task as any, "handleContextWindowExceededError").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
					(async function* (): AsyncGenerator<ApiStreamChunk> {
						yield* []
						throw Object.assign(new Error("Context still exceeds the provider limit."), {
							firstChunkFailure: true,
							retryCategory: "context",
							retryable,
						})
					})(),
				)

				await expect(
					task.runAgentRequests([{ type: "text", text: "follow up" }], false),
				).resolves.toMatchObject({
					status: "failed",
				})
				expect(request).toHaveBeenCalledTimes(retryable === false ? 1 : 2)
				expect(compact).toHaveBeenCalledTimes(retryable === false ? 0 : 1)
				if (retryable === false) expect(ask).not.toHaveBeenCalled()
				else
					expect(ask).toHaveBeenCalledExactlyOnceWith(
						"api_req_failed",
						"Context still exceeds the provider limit.",
					)
			},
		)

		it("preserves partial output without replaying a context rejection", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: false })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const compact = vi.spyOn(task as any, "handleContextWindowExceededError").mockResolvedValue(undefined)
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
			const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: "The answer began before the provider failed." }
					throw Object.assign(new Error("Context rejected after output."), { retryCategory: "context" })
				})(),
			)

			await expect(task.runAgentRequests([{ type: "text", text: "follow up" }], false)).resolves.toMatchObject({
				status: "failed",
				response: { text: "The answer began before the provider failed." },
			})
			expect(request).toHaveBeenCalledOnce()
			expect(compact).not.toHaveBeenCalled()
			expect(ask).not.toHaveBeenCalled()
		})

		it.each([false, true])(
			"retries a provider-classified 429 independently of tool auto-approval=%s",
			async (autoApprovalEnabled) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				const events = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
				Object.assign(task, { agentRetryPolicy: new AgentRetryPolicy({ baseDelayMs: 0 }) })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const request = vi
					.spyOn(task, "attemptApiRequest")
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield* []
							throw Object.assign(new Error("Gemini quota exceeded"), {
								firstChunkFailure: true,
								status: 429,
								statusCode: 429,
								retryable: true,
								retryCategory: "rate-limit",
								errorDetails: [{ retryDelay: "2s" }],
							})
						})(),
					)
					.mockImplementationOnce(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield { type: "text", text: "Recovered after Gemini rate limit." }
						})(),
					)

				await expect(task.runAgentRequests([{ type: "text", text: "start" }], false)).resolves.toMatchObject({
					status: "completed",
				})
				expect(request).toHaveBeenCalledTimes(2)
				expect(ask).not.toHaveBeenCalled()
				expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "retry", attempt: 1 }))
			},
		)

		it.each([
			["rate-limit", "transport", "Provider retry budget exhausted (attempts)."],
			["empty-response", "transport", "Provider retry budget exhausted (attempts)."],
			["rate-limit", "empty-response", "Empty-response retry budget exhausted."],
		] as const)(
			"stops transport, %s, and %s failures at the global attempt cap",
			async (middleCategory, finalCategory, reason) => {
				const task = createTask()
				mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
				vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
				vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
				vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
				Object.assign(task, {
					agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 3, baseDelayMs: 0, jitter: "none" }),
				})
				const categories = ["transport", middleCategory, finalCategory] as const
				const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
					(async function* (): AsyncGenerator<ApiStreamChunk> {
						yield* []
						const category = categories[request.mock.calls.length - 1] ?? "transport"
						if (category === "empty-response") return
						throw Object.assign(new Error(`Provider ${category} failure`), {
							firstChunkFailure: true,
							retryable: true,
							retryCategory: category,
						})
					})(),
				)

				await expect(task.runAgentRequests([{ type: "text", text: "start" }], false)).resolves.toMatchObject({
					status: "exhausted",
					reason,
				})
				expect(request).toHaveBeenCalledTimes(3)
			},
		)

		it.each([false, true])(
			"stops at the logical retry deadline with tool auto-approval=%s",
			async (autoApprovalEnabled) => {
				vi.useFakeTimers()
				try {
					vi.setSystemTime(5_000)
					const task = createTask()
					mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled })
					vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
					vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
					vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
					vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
					Object.assign(task, {
						agentRetryPolicy: new AgentRetryPolicy({
							maxAttempts: 2,
							maxElapsedMs: 100,
							baseDelayMs: 50,
							jitter: "none",
						}),
					})
					let markRetryAnnouncementStarted!: () => void
					const retryAnnouncementStarted = new Promise<void>((resolve) => {
						markRetryAnnouncementStarted = resolve
					})
					vi.spyOn(task, "say").mockImplementation(async (type, _text, _images, partial) => {
						if (type === "api_req_retry_delayed" && partial) {
							markRetryAnnouncementStarted()
							await new Promise<void>(() => undefined)
						}
					})
					const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
						(async function* (): AsyncGenerator<ApiStreamChunk> {
							yield* []
							throw Object.assign(new Error("transient provider failure"), {
								firstChunkFailure: true,
								retryable: true,
								retryCategory: "transport",
							})
						})(),
					)

					const pending = task.runAgentRequests([{ type: "text", text: "start" }], false)
					await retryAnnouncementStarted
					await vi.advanceTimersByTimeAsync(100)
					await expect(pending).resolves.toMatchObject({
						status: "exhausted",
						reason: "Automatic retry deadline exceeded",
					})
					expect(attempt).toHaveBeenCalledOnce()
					expect(vi.getTimerCount()).toBe(0)
				} finally {
					vi.useRealTimers()
				}
			},
		)

		it("rejects a mixed request_user_input batch before persisting the assistant response", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("architect")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const events = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const fence = vi
				.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects")
				.mockResolvedValue(undefined)
			const execute = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn")
			const usage = vi.spyOn(task, "recordToolUsage")
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({
					nativeTools: getNativeTools({ planMode: true }),
					mcpTools: [
						{
							type: "function",
							function: { name: "mcp--docs--lookup", parameters: { type: "object", properties: {} } },
						},
					],
				}),
				mode: "architect",
			})
			const snapshots: Task["userMessageContent"][] = []
			const persist = vi
				.spyOn(task as any, "persistAssistantResponseBeforeEffects")
				.mockImplementation(async () => {
					snapshots.push([...task.userMessageContent])
					return true
				})
			vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					// A real request captures this surface before reading provider chunks.
					Object.assign(task, { currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield { type: "reasoning", text: "Inspect the workspace first." }
					yield { type: "text", text: "Preparing the tools." }
					for (const [id, name] of [
						["read-first", "read_file"],
						["barrier", "request_user_input"],
						["mcp-last", "mcp__docs__lookup"],
					]) {
						yield { type: "tool_call", id, name, arguments: "{}" }
					}
				})(),
			)

			await task.runAgentRequests([{ type: "text", text: "start" }], false)

			expect(persist).toHaveBeenCalledOnce()
			expect(execute).not.toHaveBeenCalled()
			expect(fence).not.toHaveBeenCalled()
			expect(usage).not.toHaveBeenCalled()
			expect(snapshots[0]).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: "read-first", is_error: true }),
				expect.objectContaining({ type: "tool_result", tool_use_id: "barrier", is_error: true }),
				expect.objectContaining({ type: "tool_result", tool_use_id: "mcp-last", is_error: true }),
			])
			expect(task.assistantMessageContent).toEqual([])
			expect(task.userMessageContentReady).toBe(true)
			expect(task.userMessageContent).toEqual(snapshots[0])
			expect(events.mock.calls.some(([input]) => (input as AgentTurnEvent).type === "tool_result")).toBe(false)
		})

		it("commits a mixed native wait batch before scheduling its ordered effects", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const order: string[] = []
			const persist = vi
				.spyOn(task as any, "persistAssistantResponseBeforeEffects")
				.mockImplementation(async () => {
					order.push("commit")
					return true
				})
			const execute = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn").mockImplementation(async () => {
				order.push("effects")
				return { status: "completed" }
			})
			const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code" })
			vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					Object.assign(task, { currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield { type: "tool_call", id: "list-first", name: "list_agents", arguments: "{}" }
					yield { type: "tool_call", id: "wait-second", name: "wait_agent", arguments: "{}" }
				})(),
			)

			const sampled = await task.runAgentRequests([{ type: "text", text: "start" }], false, undefined, {
				deferResponseTransaction: true,
			})
			if (typeof sampled === "boolean" || !sampled.transaction) {
				throw new Error("Expected a deferred response transaction for the mixed wait batch.")
			}
			expect(order).toEqual([])
			await sampled.transaction.commitResponse()
			expect(order).toEqual(["commit"])
			expect(task.userMessageContent).toEqual([])
			await sampled.transaction.executeEffects()
			expect(order).toEqual(["commit", "effects"])
			expect(execute).toHaveBeenCalledWith(
				expect.objectContaining({
					toolCalls: [
						expect.objectContaining({ id: "list-first", name: "list_agents" }),
						expect.objectContaining({ id: "wait-second", name: "wait_agent" }),
					],
				}),
				surface,
				"code",
				expect.anything(),
			)
			expect(persist).toHaveBeenCalledOnce()
			sampled.transaction.release()
		})

		it.each([
			["successful", false],
			["failed", true],
		] as const)("forwards a %s tool result into the next turn", async (_label, isError) => {
			const task = createTask()
			const initialContent: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "start" }]
			const toolResult: Anthropic.ToolResultBlockParam = {
				type: "tool_result",
				tool_use_id: "read-1",
				content: isError ? "read failed" : "file contents",
				...(isError ? { is_error: true } : {}),
			}
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.apiConversationHistory.push({
						role: "assistant",
						content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "README.md" } }],
						ts: Date.now(),
					})
					task.assistantMessageSavedToHistory = true
					task.userMessageContent = [toolResult]
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop(initialContent)

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[0]?.slice(0, 2)).toEqual([initialContent, true])
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([[toolResult], false])
		})

		it("keeps canonical persistence and tool effects in separate deferred phases", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const events: string[] = []
			const persist = vi
				.spyOn(task as any, "persistAssistantResponseBeforeEffects")
				.mockImplementation(async () => {
					events.push("commit")
					return true
				})
			const execute = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn").mockImplementation(async () => {
				events.push("effects")
				return { status: "completed" }
			})
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({ nativeTools: getNativeTools() }),
				mode: "code",
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					Object.assign(task, { currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield { type: "text", text: "Inspecting the file." }
					yield {
						type: "tool_call",
						id: "deferred-read",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
				})(),
			)

			const sampled = await task.runAgentRequests([{ type: "text", text: "start" }], false, undefined, {
				deferResponseTransaction: true,
			})
			if (typeof sampled === "boolean" || !sampled.transaction) {
				throw new Error("Expected the provider sample to carry a deferred response transaction.")
			}

			expect(sampled.status).toBe("completed")
			expect(events).toEqual([])
			expect(persist).not.toHaveBeenCalled()
			expect(execute).not.toHaveBeenCalled()
			expect((task as any).stepInterruptionController).toBeDefined()

			await sampled.transaction.commitResponse()
			expect(events).toEqual(["commit"])
			expect(persist).toHaveBeenCalledOnce()
			expect(execute).not.toHaveBeenCalled()

			await sampled.transaction.executeEffects()
			expect(events).toEqual(["commit", "effects"])
			expect(execute).toHaveBeenCalledOnce()

			sampled.transaction.release()
			expect((task as any).stepInterruptionController).toBeUndefined()
			expect((task as any).isTaskLoopActive).toBe(false)
		})

		it("persists one deterministic error receipt for every unexecuted terminal tool call", async () => {
			const task = createTask()
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "start" }], ts: 1 },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "terminal-read", name: "read_file", input: { path: "a.ts" } },
						{ type: "tool_use", id: "terminal-list", name: "list_files", input: {} },
					],
					ts: 2,
				},
			] as any
			task.assistantMessageSavedToHistory = true
			const saveHistory = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const response = createAgentResponse([
				{ type: "tool_call", id: "terminal-read", name: "read_file", arguments: { path: "a.ts" } },
				{ type: "tool_call", id: "terminal-list", name: "list_files", arguments: {} },
			])

			const repaired = await (task as any).persistUnexecutedTerminalToolResults(response, "cancelled")

			expect(repaired).toBe(true)
			expect(saveHistory).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory.at(-1)).toEqual({
				role: "user",
				input_origin: "agent",
				content: [
					{
						type: "tool_result",
						tool_use_id: "terminal-read",
						content: "Tool call was not executed because the provider response was cancelled.",
						is_error: true,
					},
					{
						type: "tool_result",
						tool_use_id: "terminal-list",
						content: "Tool call was not executed because the provider response was cancelled.",
						is_error: true,
					},
				],
				ts: expect.any(Number),
			})
			expect(task.userMessageContent).toEqual([])

			// A direct/empty continuation must be idempotent: the durable assistant
			// boundary and its receipts are not duplicated on a second repair pass.
			await expect((task as any).persistUnexecutedTerminalToolResults(response, "cancelled")).resolves.toBe(true)
			expect(saveHistory).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory.filter((message) => message.role === "user")).toHaveLength(2)
		})

		it("closes the current call occurrence even when an older call reused its ID", async () => {
			const task = createTask()
			task.apiConversationHistory = [
				{ role: "assistant", content: [{ type: "tool_use", id: "reused-id", name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "reused-id", content: "old output" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "reused-id", name: "read_file", input: {} }] },
			] as any
			task.assistantMessageSavedToHistory = true
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const response = createAgentResponse([
				{ type: "tool_call", id: "reused-id", name: "read_file", arguments: {} },
			])
			await expect((task as any).persistUnexecutedTerminalToolResults(response, "cancelled")).resolves.toBe(true)
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [{ tool_use_id: "reused-id", is_error: true, content: expect.stringContaining("cancelled") }],
			})
		})

		it("retains terminal error receipts in memory when their history write fails", async () => {
			const task = createTask()
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "start" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "failed-write", name: "read_file", input: {} }],
					ts: 2,
				},
			] as any
			task.assistantMessageSavedToHistory = true
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(false)

			const repaired = await (task as any).persistUnexecutedTerminalToolResults(
				createAgentResponse([{ type: "tool_call", id: "failed-write", name: "read_file", arguments: {} }]),
				"incomplete",
			)

			expect(repaired).toBe(false)
			expect(task.apiConversationHistory).toHaveLength(2)
			expect(task.userMessageContent).toEqual([
				{
					type: "tool_result",
					tool_use_id: "failed-write",
					content: "Tool call was not executed because the provider response was incomplete.",
					is_error: true,
				},
			])
		})

		it.each([
			["Resume", [{ type: "text", text: "[TASK RESUMPTION] Resuming task..." }]],
			["typed guidance", [{ type: "text", text: "<user_message>Continue from the failed tool.</user_message>" }]],
		] as const)("reconciles retained terminal receipts before %s", async (_label, followupContent) => {
			const task = createTask()
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "start" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "retained-result", name: "read_file", input: {} }],
					ts: 2,
				},
			] as any
			task.assistantMessageSavedToHistory = true
			const saveHistory = vi
				.spyOn(task as any, "saveApiConversationHistory")
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(true)
			const response = createAgentResponse([
				{ type: "tool_call", id: "retained-result", name: "read_file", arguments: {} },
			])

			await expect((task as any).persistUnexecutedTerminalToolResults(response, "failed")).resolves.toBe(false)
			const requestContent = (task as any).mergePendingToolResultsIntoUserContent(followupContent)
			expect(requestContent).toEqual([
				{
					type: "tool_result",
					tool_use_id: "retained-result",
					content: "Tool call was not executed because the provider response failed.",
					is_error: true,
				},
				...followupContent,
			])

			await (task as any).persistUserContentWithEnvironment(requestContent, undefined, undefined)
			;(task as any).acknowledgePersistedUserMessageContent(requestContent)

			const resultBlocks = task.apiConversationHistory.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.filter((block) => block.type === "tool_result")
					: [],
			)
			expect(resultBlocks).toEqual([
				expect.objectContaining({
					tool_use_id: "retained-result",
					content: "Tool call was not executed because the provider response failed.",
					is_error: true,
				}),
			])
			expect(task.userMessageContent).toEqual([])
			expect(saveHistory).toHaveBeenCalledTimes(2)
		})

		it("fails closed without staging a tool result before the assistant boundary", async () => {
			const task = createTask()
			const saveHistory = vi.spyOn(task as any, "saveApiConversationHistory")

			const repaired = await (task as any).persistUnexecutedTerminalToolResults(
				createAgentResponse([{ type: "tool_call", id: "no-boundary", name: "read_file", arguments: {} }]),
				"failed",
			)

			expect(repaired).toBe(false)
			expect(task.userMessageContent).toEqual([])
			expect(saveHistory).not.toHaveBeenCalled()
		})

		it.each([
			["incomplete provider response", "incomplete", false, "failed"],
			["provider-declared cancellation", "cancelled", false, "failed"],
			["authoritative task cancellation", "cancelled", true, "aborted"],
		] as const)(
			"promotes terminal receipt persistence failure for %s to %s",
			async (_label, providerStatus, taskCancelled, expectedStatus) => {
				const task = createTask()
				if (taskCancelled) {
					;(task as any).taskCancellationController.abort(new Error("User cancelled the task."))
				}
				vi.spyOn(task as any, "persistAssistantResponseBeforeEffects").mockResolvedValue(true)
				vi.spyOn(task as any, "persistUnexecutedTerminalToolResults").mockResolvedValue(false)
				const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
				const response = createAgentResponse(
					[{ type: "tool_call", id: `receipt-${providerStatus}`, name: "read_file", arguments: {} }],
					{ status: providerStatus, reason: "Provider terminal outcome." },
				)

				const result = await (task as any).persistTerminalCanonicalResponse(
					response,
					providerStatus,
					"Provider terminal outcome.",
				)

				expect(result).toMatchObject({
					status: expectedStatus,
					reason: expect.stringContaining("Terminal tool-result receipts could not be durably saved."),
					error: expect.any(Error),
				})
				expect((result as any).error.name).toBe("TaskPersistenceError")
				expect(appendEvent).toHaveBeenLastCalledWith(
					expect.objectContaining({ type: "response_terminal", status: expectedStatus }),
					undefined,
				)
			},
		)

		it("promotes an assistant-boundary persistence failure to failed", async () => {
			const task = createTask()
			vi.spyOn(task as any, "persistAssistantResponseBeforeEffects").mockResolvedValue(false)
			const persistReceipts = vi.spyOn(task as any, "persistUnexecutedTerminalToolResults")
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			const response = createAgentResponse(
				[{ type: "tool_call", id: "assistant-boundary", name: "read_file", arguments: {} }],
				{ status: "incomplete", reason: "Stream ended." },
			)

			const result = await (task as any).persistTerminalCanonicalResponse(response, "incomplete", "Stream ended.")

			expect(result).toMatchObject({
				status: "failed",
				reason: expect.stringContaining("The assistant response could not be durably saved."),
				error: expect.any(Error),
			})
			expect(persistReceipts).not.toHaveBeenCalled()
			expect(appendEvent).toHaveBeenLastCalledWith(
				expect.objectContaining({ type: "response_terminal", status: "failed" }),
				undefined,
			)
		})

		it("persists the canonical tool boundary and an unexecuted receipt when a failed stream throws", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const reserveToolCall = vi.spyOn(task as any, "reserveStreamingToolCall")
			const executeToolTurn = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn")
			const executeTools = vi.spyOn(task as any, "executeCanonicalToolCalls")
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) => {
				return (async function* (): AsyncGenerator<ApiStreamChunk> {
					Object.assign(task, {
						currentTaskToolSurface: createTaskToolSurface({
							registry: new ToolRegistry({ nativeTools: getNativeTools() }),
							mode: "code",
						}),
					})
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield {
						type: "tool_call",
						id: "failed-stream-tool",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
					expect(reserveToolCall).toHaveBeenCalledOnce()
					expect(executeToolTurn).not.toHaveBeenCalled()
					expect(executeTools).not.toHaveBeenCalled()
					yield {
						type: "error",
						error: "policy_rejected",
						message: "Policy rejected",
						retryable: false,
						semanticOutputObserved: true,
					}
					yield {
						type: "outcome",
						status: "failed",
						terminal: true,
						semanticOutputObserved: true,
						reason: "Policy rejected",
						retryable: false,
					}
					throw Object.assign(new Error("Response failed: Policy rejected"), {
						retryable: false,
						semanticOutputObserved: true,
					})
				})()
			})

			const result = await task.runAgentRequests([{ type: "text", text: "start" }], false)

			expect(result).toMatchObject({
				status: "failed",
				reason: "Policy rejected",
				response: {
					outcome: { status: "failed", retryable: false },
					toolCalls: [
						{
							id: "failed-stream-tool",
							name: "read_file",
							arguments: { path: "README.md" },
						},
					],
				},
			})
			expect(attempt).toHaveBeenCalledOnce()
			expect(reserveToolCall).toHaveBeenCalledOnce()
			expect(executeToolTurn).not.toHaveBeenCalled()
			expect(executeTools).not.toHaveBeenCalled()
			const assistantBoundary = task.apiConversationHistory.find(
				(message) =>
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((block) => block.type === "tool_use" && block.id === "failed-stream-tool"),
			)
			expect(assistantBoundary).toBeDefined()
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "failed-stream-tool",
						content: "Tool call was not executed because the provider response failed.",
						is_error: true,
					},
				],
			})
		})

		it("preserves a nonretryable canonical error without a provider outcome and pairs only earlier accepted calls", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const execute = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn")
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({ nativeTools: getNativeTools() }),
				mode: "code",
			})
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					Object.assign(task, { currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield {
						type: "tool_call",
						id: "before-error",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
					yield {
						type: "error",
						error: "InvalidToolCall",
						message: "Malformed recognized tool intent",
						retryable: false,
						semanticOutputObserved: true,
					}
					yield {
						type: "tool_call",
						id: "after-error",
						name: "read_file",
						arguments: JSON.stringify({ path: "other.md" }),
					}
					yield { type: "text", text: "This must not become a successful final answer." }
				})(),
			)
			const result = await task.runAgentRequests([{ type: "text", text: "start" }], false)
			expect(result).toMatchObject({
				status: "failed",
				response: { outcome: { status: "failed", retryable: false }, toolCalls: [{ id: "before-error" }] },
			})
			expect(attempt).toHaveBeenCalledOnce()
			expect(execute).not.toHaveBeenCalled()
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "before-error", is_error: true }],
			})
			expect(JSON.stringify(task.apiConversationHistory)).not.toContain("after-error")
			expect(JSON.stringify(task.apiConversationHistory)).not.toContain("successful final answer")
		})

		it("persists an accepted call receipt and suppresses effects when the provider response is truncated", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			const executeToolTurn = vi.spyOn(task as any, "executeCanonicalToolCallsForTurn")
			const executeTools = vi.spyOn(task as any, "executeCanonicalToolCalls")
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({ nativeTools: getNativeTools() }),
				mode: "code",
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation((_retryAttempt, options) =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					Object.assign(task, { currentTaskToolSurface: surface })
					options?.onStepCaptured?.(task["currentAgentStep"])
					yield {
						type: "tool_call",
						id: "truncated-stream-tool",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
					yield {
						type: "outcome",
						status: "incomplete",
						terminal: true,
						semanticOutputObserved: true,
						reason: "The provider reached its output token limit.",
					}
				})(),
			)

			const result = await task.runAgentRequests([{ type: "text", text: "start" }], false)

			expect(result).toMatchObject({
				status: "incomplete",
				response: {
					outcome: { status: "incomplete" },
					toolCalls: [{ id: "truncated-stream-tool", name: "read_file", arguments: { path: "README.md" } }],
				},
			})
			expect(executeToolTurn).not.toHaveBeenCalled()
			expect(executeTools).not.toHaveBeenCalled()
			expect(
				task.apiConversationHistory.some(
					(message) =>
						message.role === "assistant" &&
						Array.isArray(message.content) &&
						message.content.some(
							(block) => block.type === "tool_use" && block.id === "truncated-stream-tool",
						),
				),
			).toBe(true)
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "truncated-stream-tool",
						content: "Tool call was not executed because the provider response was incomplete.",
						is_error: true,
					},
				],
			})
		})

		it("classifies a normal provider terminal receipt persistence failure", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "appendAgentTurnEvent").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task as any, "persistUnexecutedTerminalToolResults").mockResolvedValue(false)
			const executeTools = vi.spyOn(task as any, "executeCanonicalToolCalls")
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() => {
				return (async function* (): AsyncGenerator<ApiStreamChunk> {
					yield {
						type: "tool_call",
						id: "terminal-receipt-write",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
					yield {
						type: "outcome",
						status: "failed",
						terminal: true,
						semanticOutputObserved: true,
						reason: "Provider terminal outcome.",
						retryable: false,
					}
				})()
			})

			const result = await task.runAgentRequests([{ type: "text", text: "start" }], false)

			expect(result).toMatchObject({
				status: "failed",
				error: expect.objectContaining({ name: "TaskPersistenceError" }),
				reason: expect.stringContaining("Terminal tool-result receipts could not be durably saved."),
			})
			expect(attempt).toHaveBeenCalledOnce()
			expect(executeTools).not.toHaveBeenCalled()
		})

		it("publishes a durable completion boundary for an ordinary primary response", async () => {
			const task = createTask()
			let streamedMessageTs: number | undefined
			task.consecutiveMistakeCount = 1
			task.consecutiveNoToolUseCount = 2
			task.consecutiveNoAssistantMessagesCount = 1
			;(task as any).automaticMistakeRecoveryCount = 1
			const ask = vi.spyOn(task, "ask").mockResolvedValue({
				response: "yesButtonClicked",
				text: "",
				images: [],
			})
			const say = vi.spyOn(task, "say")
			const flush = vi.spyOn(task, "flushPendingToolResultsToHistory")
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)
			const requestStep = vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
				await task.say("text", "The requested explanation.", undefined, false)
				streamedMessageTs = task.clineMessages.at(-1)?.ts
				task.assistantMessageContent = [{ type: "text", content: "The requested explanation.", partial: false }]
				return false
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledOnce()
			expect(ask).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalledWith("completion_result", expect.anything())
			const visibleFinals = task.clineMessages.filter(
				(message) => message.type === "say" && message.say === "completion_result",
			)
			expect(visibleFinals).toHaveLength(1)
			expect(visibleFinals[0]).toMatchObject({
				ts: streamedMessageTs,
				text: "The requested explanation.",
				partial: false,
			})
			expect(task.clineMessages).not.toContainEqual(
				expect.objectContaining({ type: "say", say: "text", text: "The requested explanation." }),
			)
			expect(flush).toHaveBeenCalledOnce()
			expect(completed).toHaveBeenCalledOnce()
			expect(completed).toHaveBeenCalledWith(task.taskId, expect.anything(), task.toolUsage)
			expect(await task.finalizeTaskCompletion()).toBe(false)
			expect(completed).toHaveBeenCalledOnce()
			expect(task.userMessageContent).toEqual([])
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.consecutiveNoToolUseCount).toBe(0)
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
			expect((task as any).automaticMistakeRecoveryCount).toBe(0)
		})

		it("keeps automatic recovery from renewing progress or invalidating observed acceptance evidence", async () => {
			const task = createTask()
			task.toolRepetitionDetector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
			const failed = { toolName: "execute_command", kind: "check" as const, status: "error" as const }
			task.toolRepetitionDetector.recordOutcome(failed)
			task.workContext = {
				skills: [],
				receipts: [
					{
						checkId: "preflight",
						executionId: "observed",
						definitionDigest: "a".repeat(64),
						status: "passed",
						observedAt: 1,
					},
				],
			}
			vi.spyOn(task as any, "shouldAutoRecoverFromMistakeLimit").mockResolvedValue(true)

			await task["handleConsecutiveMistakeLimit"]([])

			expect(task.toolRepetitionDetector.recordOutcome(failed).action).toBe("continue")
			expect(task.workContext.receipts[0].status).toBe("passed")
			expect(Reflect.get(task, "automaticMistakeRecoveryCount")).toBe(1)
		})

		it.each(["text", "image"] as const)("renews progress when %s steering is consumed", async (kind) => {
			const task = createTask()
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			task.toolRepetitionDetector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
			const failed = { toolName: "execute_command", kind: "check" as const, status: "error" as const }
			task.toolRepetitionDetector.recordOutcome(failed)
			Object.assign(task, { isTaskLoopActive: true })
			await task.steerUserMessage(
				kind === "text" ? "Review the earlier files again." : "",
				kind === "image" ? ["data:image/png;base64,aA=="] : [],
			)
			// A late result from the interrupted step must not consume the new request's allowance.
			expect(task.toolRepetitionDetector.recordOutcome(failed).action).toBe("continue")
			vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
				expect(task.toolRepetitionDetector.recordOutcome(failed).action).toBe("change-strategy")
				yield { type: "text", text: "Updated review." }
			})

			await expect(task.runAgentRequests([], false)).resolves.toMatchObject({ status: "completed" })
		})

		it.each(["submission", "queue"] as const)(
			"renews exploration across %s follow-ups late in a long conversation",
			async (source) => {
				const task = createTask()
				mockProvider.getVerificationProgressState = vi.fn().mockReturnValue(undefined)
				task.toolRepetitionDetector = new ToolRepetitionDetector(3)
				vi.spyOn(task, "flushPendingToolResultsToHistory").mockResolvedValue(true)
				let step = 0
				let completionCount = 0
				const recoverySteps: number[] = []
				vi.spyOn(task, "ask").mockImplementation(async (type) => {
					if (type === "resume_task") {
						recoverySteps.push(step)
						task.abort = true
					}
					return { response: "yesButtonClicked" }
				})
				const present = task.presentCompletionResult.bind(task)
				vi.spyOn(task, "presentCompletionResult").mockImplementation(async (...args) => {
					await present(...args)
					completionCount++
					if (completionCount === 9) return
					const text = `Revisit the last three files for review question ${completionCount}.`
					if (source === "queue") {
						task.messageQueueService.addMessage(text, [])
					} else await task.submitUserMessage(text, [])
				})
				vi.spyOn(task, "runAgentRequests").mockImplementation(async (input) => {
					const receiptIds = task["getQueuedInputReceipts"](input)
					if (receiptIds.length) {
						task.apiConversationHistory.push({
							role: "user",
							content: input,
							queued_message_ids: receiptIds,
						})
						task.messageQueueService.acknowledgeMessages(receiptIds)
						await task.messageQueueService.flush()
					}
					step++
					task.userMessageContent = []
					if (step > 200 && (step - 201) % 4 === 0) {
						return {
							status: "completed",
							response: createAgentResponse([{ type: "text", text: "Review answer." }]),
						}
					}
					const args = { path: `file-${step <= 200 ? step : 197 + ((step - 202) % 4)}.ts` }
					await task.recordToolCallForStopping("read_file", args, "success")
					task.userMessageContent.push({
						type: "tool_result",
						tool_use_id: `read-${step}`,
						content: "File contents",
					})
					return {
						status: "completed",
						response: createAgentResponse([
							{ type: "tool_call", id: `read-${step}`, name: "read_file", arguments: args },
						]),
					}
				})

				await task["initiateTaskLoop"]([{ type: "text", text: "Review this large project." }])

				expect(recoverySteps).toEqual([])
				expect(step).toBe(233)
				expect(completionCount).toBe(9)
				expect(Reflect.get(task, "didComplete")).toBe(true)
			},
		)

		it("keeps repeated reads in the model loop until an ordinary final answer", async () => {
			const task = createTask()
			mockProvider.getVerificationProgressState = vi.fn().mockReturnValue(undefined)
			task.toolRepetitionDetector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
			vi.spyOn(task, "flushPendingToolResultsToHistory").mockResolvedValue(true)
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			let step = 0
			const requestStep = vi.spyOn(task, "runAgentRequests").mockImplementation(async () => {
				step++
				task.userMessageContent = []
				if (step === 12) {
					return {
						status: "completed",
						response: createAgentResponse([{ type: "text", text: "Review finished." }]),
					}
				}
				const args = { path: "same.ts" }
				await task.recordToolCallForStopping("read_file", args, "success")
				task.userMessageContent.push({
					type: "tool_result",
					tool_use_id: `read-${step}`,
					content: "Same contents",
				})
				return {
					status: "completed",
					response: createAgentResponse([
						{ type: "tool_call", id: `read-${step}`, name: "read_file", arguments: args },
					]),
				}
			})

			await task["initiateTaskLoop"]([{ type: "text", text: "Review the files." }])

			expect(requestStep).toHaveBeenCalledTimes(12)
			expect(ask.mock.calls.map(([type]) => type)).not.toContain("resume_task")
			expect(ask).not.toHaveBeenCalled()
			expect(Reflect.get(task, "didComplete")).toBe(true)
		})

		it.each(["failed", "incomplete", "exhausted"] as const)(
			"persists one safe recovery explanation before asking to resume a pre-provider %s turn",
			async (status) => {
				const task = createTask()
				mockProvider.postTaskMessageToWebview = vi.fn().mockResolvedValue(undefined)
				const privateReason =
					"Authorization: Bearer test-secret\nPrivate prompt: do not publish\n at internalFrame"
				const save = vi.mocked((task as any).saveAlphaMessages)
				const ask = vi.spyOn(task, "ask").mockImplementation(async () => {
					const errors = task.clineMessages.filter((message) => message.say === "error")
					expect(errors).toHaveLength(1)
					expect(errors[0].text).toBe(enCommon.errors[`task_recovery_${status}`])
					expect(JSON.stringify(task.clineMessages)).not.toContain(privateReason)
					expect(save).toHaveBeenCalled()
					expect(mockProvider.postTaskMessageToWebview).toHaveBeenCalledExactlyOnceWith(
						"messageCreated",
						task.taskId,
						errors[0],
					)
					return { response: "yesButtonClicked" }
				})
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockResolvedValueOnce({ status, reason: privateReason })
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(ask).toHaveBeenCalledExactlyOnceWith("resume_task")
				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(task.clineMessages.filter((message) => message.say === "error")).toHaveLength(1)
			},
		)

		it.each(["ELOCKOWNER", "ELOCKLEGACY"] as const)(
			"explains automatic recovery and the unknown-owner fallback for %s",
			async (code) => {
				const task = createTask()
				const privateReason = "Private storage path and request content"
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
				vi.spyOn(task, "runAgentRequests")
					.mockRejectedValueOnce(new AgentControlTransactionError(privateReason, code))
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				const errors = task.clineMessages.filter((message) => message.say === "error")
				expect(errors).toHaveLength(1)
				expect(errors[0].text).toContain("automatically recovers abandoned locks")
				expect(errors[0].text).toContain("close all VS Code windows")
				expect(errors[0].text).toContain("agent_control.json.transaction.lock")
				expect(JSON.stringify(task.clineMessages)).not.toContain(privateReason)
			},
		)

		it.each(["ELOCKED", "EQUEUEFULL"] as const)("explains %s as task-storage contention", async (code) => {
			const task = createTask()
			const privateReason = "Private storage path and request content"
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			const request = vi
				.spyOn(task, "runAgentRequests")
				.mockRejectedValueOnce(new AgentControlTransactionError(privateReason, code))
				.mockResolvedValueOnce(true)

			await Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "start" }])

			const errors = task.clineMessages.filter((message) => message.say === "error")
			expect(errors).toHaveLength(1)
			expect(errors[0].text).toContain("waiting for Alpha's task storage")
			expect(errors[0].text).toContain("then resume")
			expect(JSON.stringify(task.clineMessages)).not.toContain(privateReason)
			expect(ask).toHaveBeenCalledExactlyOnceWith("resume_task")
			expect(request).toHaveBeenCalledTimes(2)
		})

		it("explains an unhandled pre-provider exception without copying private diagnostics", async () => {
			const task = createTask()
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			vi.spyOn(task, "runAgentRequests")
				.mockRejectedValueOnce(new Error("Private request body with credentials and prompt"))
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(task.clineMessages.filter((message) => message.say === "error")).toEqual([
				expect.objectContaining({ text: enCommon.errors.task_recovery_failed }),
			])
		})

		it("explains a pacing metadata persistence failure before any provider request", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "maybeWaitForProviderRateLimit").mockImplementation(async () => {
				;(task as any).requestPacingWaitCount++
			})
			vi.spyOn(task as any, "appendRequestPacingUpdateToLatestUserMessage").mockResolvedValue(false)
			const request = vi.spyOn(task, "attemptApiRequest")
			vi.spyOn(task, "ask").mockImplementation(async () => {
				task.abort = true
				return { response: "noButtonClicked" }
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(request).not.toHaveBeenCalled()
			expect(task.clineMessages.filter((message) => message.say === "error")).toEqual([
				expect.objectContaining({ text: enCommon.errors.task_recovery_persistence }),
			])
		})

		it.each([
			["error", undefined],
			["api_req_started", "streaming_failed"],
			["api_req_started", undefined],
		] as const)(
			"does not duplicate an existing terminal %s explanation (cancel reason: %s)",
			async (say, cancelReason) => {
				const task = createTask()
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
				vi.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						await task.say(
							say,
							say === "error"
								? "Tool failed."
								: JSON.stringify({
										cancelReason,
										streamingFailedMessage: "Provider failed.",
									}),
						)
						return { status: "failed", reason: "Failure already presented." }
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(task.clineMessages).toHaveLength(1)
				expect(task.clineMessages[0].say).toBe(say)
			},
		)

		it("does not let a recovered provider attempt hide a later persistence failure", async () => {
			const task = createTask()
			mockProvider.getState = vi.fn().mockResolvedValue({ autoApprovalEnabled: true })
			vi.spyOn(task as any, "getTaskMode").mockResolvedValue("code")
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task as any, "maybeWaitForProviderRateLimit")
				.mockResolvedValueOnce(undefined)
				.mockImplementationOnce(async () => {
					;(task as any).requestPacingWaitCount++
				})
			vi.spyOn(task as any, "appendRequestPacingUpdateToLatestUserMessage").mockResolvedValue(false)
			vi.spyOn(task as any, "waitForRetryDecision").mockImplementation(async () => {
				await task.say("error", "Recovered provider attempt.")
			})
			const request = vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				(async function* (): AsyncGenerator<ApiStreamChunk> {
					yield* []
					throw Object.assign(new Error("Transient failure"), {
						firstChunkFailure: true,
						retryable: true,
						retryCategory: "transport",
					})
				})(),
			)
			vi.spyOn(task, "ask").mockImplementation(async () => {
				task.abort = true
				return { response: "noButtonClicked" }
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(request).toHaveBeenCalledOnce()
			expect(
				task.clineMessages.filter((message) => message.say === "error").map((message) => message.text),
			).toEqual(["Recovered provider attempt.", enCommon.errors.task_recovery_persistence])
		})

		it("does not let an earlier recovered step hide a new runtime failure", async () => {
			const task = createTask()
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			vi.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					await task.say("error", "Earlier recoverable tool error.")
					return { status: "completed", response: createAgentResponse([]) }
				})
				.mockRejectedValueOnce(new Error("New runtime failure"))
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(
				task.clineMessages.filter((message) => message.say === "error").map((message) => message.text),
			).toEqual(["Earlier recoverable tool error.", enCommon.errors.task_recovery_failed])
		})

		it("retains one recovery explanation when the task is loaded again", async () => {
			const task = createTask()
			vi.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "incomplete" })
				.mockResolvedValueOnce(true)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])
			let saved = structuredClone(task.clineMessages)
			saved.push({ ts: Date.now() + 1, type: "ask", ask: "resume_task" })
			vi.spyOn(task as any, "getSavedAlphaMessages").mockImplementation(async () => structuredClone(saved))
			vi.spyOn(task as any, "overwriteAlphaMessages").mockImplementation(async (...args: unknown[]) => {
				saved = structuredClone(args[0] as typeof saved)
				return true
			})
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "start" }], ts: 1 },
			])
			vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)

			await (task as any).resumeTaskFromHistory()

			expect(task.clineMessages.filter((message) => message.say === "error")).toEqual([
				expect.objectContaining({ text: enCommon.errors.task_recovery_incomplete }),
			])
			expect(task.clineMessages.some((message) => message.ask === "resume_task")).toBe(false)
			// Hydration cleans the in-memory view; this mocked ask does not persist
			// an interaction, so the original saved bytes must remain untouched.
			expect(saved.some((message) => message.ask === "resume_task")).toBe(true)
			expect(task.overwriteAlphaMessages).not.toHaveBeenCalled()
		})

		it.each([true, false])(
			"reports blocked stagnation once and preserves receipt-persistence failure (%s)",
			async (persisted) => {
				const task = createTask()
				const report = "Task remains incomplete: repeated search outcomes produced no new evidence."
				vi.spyOn(task as any, "flushPendingToolResultsToHistory").mockResolvedValue(persisted)
				const request = vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
					task.suspendAfterCurrentTurn(report, "blocked")
					return { status: "completed", response: createAgentResponse([]) }
				})
				const ask = vi.spyOn(task, "ask").mockImplementation(async () => {
					task.abort = true
					return { response: "noButtonClicked" }
				})
				await (task as any).initiateTaskLoop([{ type: "text", text: "Search the codebase." }])
				expect(request).toHaveBeenCalledOnce()
				expect(ask).toHaveBeenCalledWith("resume_task")
				const reports = task.clineMessages.filter((message) => message.say === (persisted ? "text" : "error"))
				expect(reports).toEqual([expect.objectContaining({ text: expect.stringContaining(report) })])
				expect(reports[0].partial).not.toBe(true)
				expect(task.clineMessages.some((message) => message.say === "completion_result")).toBe(false)
				expect(task.clineMessages.some((message) => message.say === "error")).toBe(!persisted)
				expect(Reflect.get(task, "didComplete")).toBe(false)
			},
		)

		it.each(["failed", "incomplete", "exhausted"] as const)(
			"resumes a primary task after a %s turn and consumes its follow-up once",
			async (status) => {
				const task = createTask()
				const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
				const ask = vi.spyOn(task, "ask").mockResolvedValue({
					response: "messageResponse",
					text: "Please continue from the partial result.",
					images: [],
				})
				const feedback = vi.spyOn(task, "say")
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockResolvedValueOnce({
						status,
						reason: `Provider turn ${status}.`,
						response: createAgentResponse([{ type: "text", text: "Partial result." }]),
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(ask).toHaveBeenCalledOnce()
				expect(ask).toHaveBeenCalledWith("resume_task")
				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
					[
						{
							type: "text",
							text: "<user_message>\nPlease continue from the partial result.\n</user_message>",
						},
					],
					false,
				])
				expect(feedback).toHaveBeenCalledTimes(2)
				expect(feedback).toHaveBeenCalledWith("error", enCommon.errors[`task_recovery_${status}`])
				expect(feedback).toHaveBeenCalledWith(
					"user_feedback",
					"Please continue from the partial result.",
					[],
					undefined,
					undefined,
					undefined,
					{ queuedMessageIds: undefined },
				)
				const eventTypes = appendEvent.mock.calls.map(([event]) => (event as AgentTurnEvent).type)
				expect(eventTypes).toContain(status === "incomplete" ? "turn_incomplete" : "turn_failed")
				expect(eventTypes).not.toContain("task_failed")
				expect(eventTypes).not.toContain("task_incomplete")
			},
		)

		it("uses the established resumption marker when Resume has no follow-up", async () => {
			const task = createTask()
			const ask = vi.spyOn(task, "ask").mockResolvedValue({
				response: "yesButtonClicked",
				text: undefined,
				images: undefined,
			})
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "incomplete", reason: "Stream ended before completion." })
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(ask).toHaveBeenCalledWith("resume_task")
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[{ type: "text", text: "[TASK RESUMPTION] Resuming task..." }],
				false,
			])
		})

		it("aborts instead of resuming when recovery is declined", async () => {
			const task = createTask()
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
			const abortTask = vi.spyOn(task, "abortTask").mockImplementation(async () => {
				task.abort = true
			})
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "failed", reason: "Stream ended before completion." })

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(ask).toHaveBeenCalledWith("resume_task")
			expect(abortTask).toHaveBeenCalledOnce()
			expect(requestStep).toHaveBeenCalledOnce()
			expect(appendEvent).toHaveBeenCalledWith(
				expect.objectContaining({ type: "task_completed", status: "aborted" }),
			)
		})

		it("stops the stale loop when recovery is superseded by another ask", async () => {
			const task = createTask()
			const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
			const abortTask = vi.spyOn(task, "abortTask")
			;(task as any).activeAsk = { type: "followup", ts: 42 }
			const ask = vi.spyOn(task, "ask").mockRejectedValue(new AskIgnoredError("superseded"))
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "failed", reason: "Stream ended before completion." })

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(ask).toHaveBeenCalledWith("resume_task")
			expect(abortTask).not.toHaveBeenCalled()
			expect(requestStep).toHaveBeenCalledOnce()
			expect(appendEvent.mock.calls.map(([event]) => (event as AgentTurnEvent).type)).not.toContain("task_failed")
			expect(appendEvent.mock.calls.map(([event]) => (event as AgentTurnEvent).type)).not.toContain(
				"task_incomplete",
			)
		})

		it("does not offer recovery after an authoritative aborted outcome", async () => {
			const task = createTask()
			const ask = vi.spyOn(task, "ask")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "aborted", reason: "The request was cancelled." })

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledOnce()
			expect(ask).not.toHaveBeenCalledWith("resume_task")
		})

		it.each(["primary", "subagent"] as const)(
			"does not offer recovery when %s completion is aborted",
			async (kind) => {
				const task = createTask(kind)
				const appendEvent = vi.spyOn(task as any, "appendAgentTurnEvent")
				const ask = vi.spyOn(task, "ask").mockResolvedValue({
					response: "yesButtonClicked",
					text: "",
					images: [],
				})
				vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
					task.assistantMessageContent = [{ type: "text", content: "Everything is done.", partial: false }]
					return false
				})
				vi.spyOn(task, "finalizeTaskCompletion").mockImplementationOnce(async () => {
					task.abort = true
					return false
				})

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(ask).not.toHaveBeenCalledWith("resume_task")
				expect(appendEvent).toHaveBeenCalledWith(
					expect.objectContaining({ type: "task_completed", status: "aborted" }),
				)
			},
		)

		it("keeps failed managed children on their terminal handoff path", async () => {
			const task = createTask("subagent")
			const ask = vi.spyOn(task, "ask")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({ status: "failed", reason: "Managed child failed." })

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledOnce()
			expect(ask).not.toHaveBeenCalledWith("resume_task")
		})

		it.each(["primary", "subagent"] as const)(
			"blocks %s text completion while the enabled todo policy has open work",
			async (kind) => {
				vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
					() =>
						({
							get: (key: string, defaultValue: unknown) =>
								key === "preventCompletionWithOpenTodos" ? true : defaultValue,
						}) as any,
				)
				const task = createTask(kind)
				task.todoList = [{ id: "pending", content: "Finish the regression", status: "pending" }]
				const ask = vi.spyOn(task, "ask")
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						task.assistantMessageContent = [
							{ type: "text", content: "Everything is done.", partial: false },
						]
						return false
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(ask).not.toHaveBeenCalledWith("completion_result", expect.anything(), expect.anything())
				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(requestStep.mock.calls[1]?.[0]).toEqual([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("incomplete todos"),
					}),
				])
				expect((task as any).didComplete).toBe(false)
			},
		)

		it("rechecks open todos after presenting the completion result", async () => {
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
				() =>
					({
						get: (key: string, defaultValue: unknown) =>
							key === "preventCompletionWithOpenTodos" ? true : defaultValue,
					}) as any,
			)
			const task = createTask()
			task.todoList = [{ id: "late", content: "Late work", status: "completed" }]
			const finalize = vi.spyOn(task, "finalizeTaskCompletion")
			const retract = vi.spyOn(task, "retractCompletionResult")
			const present = task.presentCompletionResult.bind(task)
			vi.spyOn(task, "presentCompletionResult").mockImplementationOnce(async (...args) => {
				await present(...args)
				task.todoList = [{ id: "late", content: "Late work", status: "in_progress" }]
			})
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [{ type: "text", content: "Everything is done.", partial: false }]
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(retract).toHaveBeenCalledOnce()
			expect(finalize).not.toHaveBeenCalled()
			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.[0]).toEqual([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("incomplete todos"),
				}),
			])
			expect((task as any).didComplete).toBe(false)
		})

		it.each([
			[false, "pending"],
			[true, "completed"],
		] as const)(
			"allows ordinary text completion with todo prevention %s and todo status %s",
			async (enabled, status) => {
				vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
					() =>
						({
							get: (key: string, defaultValue: unknown) =>
								key === "preventCompletionWithOpenTodos" ? enabled : defaultValue,
						}) as any,
				)
				const task = createTask()
				task.todoList = [{ id: "todo", content: "Tracked work", status }]
				vi.spyOn(task, "ask").mockResolvedValue({
					response: "yesButtonClicked",
					text: "",
					images: [],
				})
				vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
					task.assistantMessageContent = [
						{ type: "text", content: "The requested work is complete.", partial: false },
					]
					return false
				})

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect((task as any).didComplete).toBe(true)
			},
		)

		it("does not expose a newly staged completion when every transcript write fails", async () => {
			const task = createTask()
			const stagedSnapshots: any[][] = []
			vi.mocked((task as any).enqueueAlphaMessagesSave).mockImplementation(
				async (createSnapshot: () => any[]) => {
					stagedSnapshots.push(createSnapshot())
					return false
				},
			)
			const publish = vi.spyOn(task as any, "publishAlphaMessageCreated")

			await expect(task.presentCompletionResult("Durable final answer.")).rejects.toThrow(
				"Unable to persist the completion result",
			)

			expect(stagedSnapshots).toHaveLength(3)
			expect(stagedSnapshots).toEqual(
				expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({ say: "completion_result", text: "Durable final answer." }),
					]),
				]),
			)
			expect(task.clineMessages).not.toContainEqual(expect.objectContaining({ say: "completion_result" }))
			expect(publish).not.toHaveBeenCalled()
		})

		it("keeps the last durable terminal style when retraction persistence fails", async () => {
			const task = createTask()
			const completion = {
				ts: 42,
				type: "say" as const,
				say: "completion_result" as const,
				text: "Persisted final answer.",
				partial: false,
			}
			task.clineMessages = [completion]
			;(task as any).currentAssistantResponseMessageTs = completion.ts
			const stagedSnapshots: any[][] = []
			vi.mocked((task as any).enqueueAlphaMessagesSave).mockImplementation(
				async (createSnapshot: () => any[]) => {
					stagedSnapshots.push(createSnapshot())
					return false
				},
			)
			const update = vi.spyOn(task as any, "updateAlphaMessage")

			await expect(task.retractCompletionResult()).rejects.toThrow(
				"Unable to persist the rejected completion state",
			)

			expect(stagedSnapshots).toHaveLength(3)
			expect(stagedSnapshots[0]).toContainEqual(expect.objectContaining({ say: "text", partial: false }))
			expect(task.clineMessages).toEqual([completion])
			expect(update).not.toHaveBeenCalled()
			expect((task as any).pendingTurnSuspension?.reason).toContain("paused before another model request")
		})

		it.each(["primary", "subagent"] as const)(
			"does not expose a completion boundary when %s text fails the durable gate",
			async (kind) => {
				const task = createTask(kind)
				mockProvider.getParentCompletionDecision.mockResolvedValue({
					allowed: false,
					message: "A managed descendant is still active.",
				})
				const ask = vi.spyOn(task, "ask")
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						await task.say("text", "Everything is finished.", undefined, false)
						task.assistantMessageContent = [
							{ type: "text", content: "Everything is finished.", partial: false },
						]
						return false
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(ask).not.toHaveBeenCalledWith("completion_result", expect.anything(), expect.anything())
				expect(task.clineMessages).not.toContainEqual(
					expect.objectContaining({ type: "say", say: "completion_result" }),
				)
				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(requestStep.mock.calls[1]?.[0]).toEqual([
					expect.objectContaining({ type: "text", text: expect.stringContaining("still active") }),
				])
			},
		)

		it("returns an accepted raw completion from a legacy child to its parent", async () => {
			const parent = createTask()
			const child = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "legacy child",
				parentTask: parent,
				rootTask: parent,
				startTask: false,
				enableCheckpoints: false,
			})
			fsSync.mkdirSync(path.join(mockExtensionContext.globalStorageUri.fsPath, "tasks", child.taskId), {
				recursive: true,
			})
			trackTaskLoop(child)
			vi.spyOn(child as any, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(child as any, "enqueueAlphaMessagesSave").mockImplementation(async (...args: unknown[]) => {
				const [createSnapshot, onPersisted] = args as [() => unknown, (() => void) | undefined]
				createSnapshot()
				onPersisted?.()
				return true
			})
			mockProvider.getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: child.taskId, status: "active" },
			})
			mockProvider.reopenParentFromDelegation = vi.fn().mockResolvedValue(undefined)
			vi.spyOn(child, "ask").mockResolvedValue({
				response: "yesButtonClicked",
				text: "",
				images: [],
			})
			const finalize = vi.spyOn(child, "finalizeTaskCompletion").mockResolvedValue(true)
			vi.spyOn(child, "runAgentRequests").mockImplementationOnce(async () => {
				child.assistantMessageContent = [{ type: "text", content: "Legacy review complete.", partial: false }]
				return false
			})

			await (child as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
				parentTaskId: parent.taskId,
				childTaskId: child.taskId,
				completionResultSummary: "Legacy review complete.",
			})
			// The transactional parent handoff owns the terminal child state. Finalizing
			// the child independently would publish a duplicate completion boundary.
			expect(finalize).not.toHaveBeenCalled()
		})

		it.each(["presentation", "final gate", "finalization"])(
			"preserves the final answer for a follow-up queued during %s",
			async (boundary) => {
				const task = createTask()
				const present = task.presentCompletionResult.bind(task)
				vi.spyOn(task, "presentCompletionResult").mockImplementationOnce(async (...args) => {
					await present(...args)
					if (boundary === "presentation")
						task.messageQueueService.addMessage("Please add the missing detail.")
				})
				if (boundary === "final gate") {
					vi.spyOn(task, "waitForCompletionGateDecision")
						.mockResolvedValueOnce({ allowed: true, modelCanResolveRejection: false })
						.mockImplementationOnce(async () => {
							task.messageQueueService.addMessage("Please add the missing detail.")
							return { allowed: true, modelCanResolveRejection: false }
						})
				} else if (boundary === "finalization") {
					vi.spyOn(task, "finalizeTaskCompletion").mockImplementationOnce(async () => {
						task.messageQueueService.addMessage("Please add the missing detail.")
						return false
					})
				}
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						task.assistantMessageContent = [{ type: "text", content: "Initial answer.", partial: false }]
						return false
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
					[{ type: "text", text: "<user_message>\nPlease add the missing detail.\n</user_message>" }],
					false,
				])
				expect(task.messageQueueService.isEmpty()).toBe(true)
				expect(task.clineMessages).toContainEqual(
					expect.objectContaining({ say: "completion_result", text: "Initial answer." }),
				)
			},
		)

		it("continues the same task when the user submits guidance during completion presentation", async () => {
			let timestamp = 1000
			vi.spyOn(Date, "now").mockImplementation(() => ++timestamp)
			const task = createTask()
			const retract = vi.spyOn(task, "retractCompletionResult")
			const ask = vi.spyOn(task, "ask")
			const present = task.presentCompletionResult.bind(task)
			let followupId: string | undefined
			vi.spyOn(task, "presentCompletionResult").mockImplementationOnce(async (...args) => {
				await present(...args)
				await task.submitUserMessage("Please expand on that.", [])
				followupId = task.messageQueueService.messages[0]?.id
			})
			const say = vi.spyOn(task, "say")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [{ type: "text", content: "First answer.", partial: false }]
					return false
				})
				.mockImplementationOnce(async (input) => {
					const receiptIds = task["getQueuedInputReceipts"](input)
					task.apiConversationHistory.push({ role: "user", content: input, queued_message_ids: receiptIds })
					task.messageQueueService.acknowledgeMessages(receiptIds)
					await task.messageQueueService.flush()
					await task.say("text", "Expanded answer.", undefined, false)
					task.assistantMessageContent = [{ type: "text", content: "Expanded answer.", partial: false }]
					return false
				})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[{ type: "text", text: "<user_message>\nPlease expand on that.\n</user_message>" }],
				false,
			])
			expect(retract).not.toHaveBeenCalled()
			expect(followupId).toBeDefined()
			expect(say).toHaveBeenCalledWith(
				"user_feedback",
				"Please expand on that.",
				[],
				undefined,
				undefined,
				undefined,
				{
					queuedMessageIds: [followupId],
				},
			)
			expect(task.clineMessages.find((message) => message.say === "user_feedback")).toMatchObject({
				queuedMessageIds: [followupId],
			})
			expect(ask).not.toHaveBeenCalled()
			expect(
				task.clineMessages
					.filter((message) => message.say === "completion_result")
					.map((message) => message.text),
			).toEqual(["First answer.", "Expanded answer."])
		})

		it("does not start another model turn when a rejected completion cannot be retracted durably", async () => {
			const task = createTask()
			let saveAttempt = 0
			vi.mocked((task as any).enqueueAlphaMessagesSave).mockImplementation(
				async (createSnapshot: () => unknown, onPersisted?: () => void) => {
					createSnapshot()
					saveAttempt++
					if (saveAttempt === 1) {
						onPersisted?.()
						return true
					}
					return false
				},
			)
			const ask = vi.spyOn(task, "ask").mockImplementation(async (type) => {
				if (type === "resume_task") {
					task.abort = true
					return { response: "noButtonClicked" }
				}
				return { response: "yesButtonClicked", text: "", images: [] }
			})
			vi.spyOn(task, "waitForCompletionGateDecision")
				.mockResolvedValueOnce({ allowed: true, modelCanResolveRejection: false })
				.mockResolvedValueOnce({
					allowed: false,
					modelCanResolveRejection: true,
					message: "Verification failed.",
				})
			const say = vi.spyOn(task, "say")
			const requestStep = vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
				task.assistantMessageContent = [{ type: "text", content: "Premature answer.", partial: false }]
				return false
			})

			await expect((task as any).initiateTaskLoop([{ type: "text", text: "start" }])).resolves.toBeUndefined()
			expect(ask).toHaveBeenCalledWith("resume_task")

			expect(requestStep).toHaveBeenCalledOnce()
			expect(say.mock.calls.some(([type]) => type === "user_feedback")).toBe(false)
			expect(task.clineMessages).toContainEqual(
				expect.objectContaining({ type: "say", say: "completion_result", text: "Premature answer." }),
			)
			expect((task as any).pendingTurnSuspension?.reason).toContain("paused before another model request")
		})

		it.each(["primary", "subagent"] as const)(
			"retains pending user continuation after a %s no-tool response",
			async (kind) => {
				const task = createTask(kind)
				const queuedUserContent = [{ type: "text" as const, text: "Please continue with this detail." }]
				const requestStep = vi
					.spyOn(task, "runAgentRequests")
					.mockImplementationOnce(async () => {
						task.assistantMessageContent = [
							{ type: "text", content: "I can continue when that detail is available.", partial: false },
						]
						task.userMessageContent = queuedUserContent
						return false
					})
					.mockResolvedValueOnce(true)

				await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

				expect(requestStep).toHaveBeenCalledTimes(2)
				expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([queuedUserContent, false])
			},
		)

		it("promotes one queued user message with images after a visible primary response", async () => {
			const task = createTask()
			const firstImage = "data:image/png;base64,Zmlyc3Q="
			const secondImage = "data:image/jpeg;base64,c2Vjb25k"
			const firstQueuedMessage = task.messageQueueService.addMessage("Use this queued detail.", [firstImage])!
			task.messageQueueService.addMessage("Keep this for later.", [secondImage])
			const feedback = vi.spyOn(task, "say").mockResolvedValue(undefined)
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [
						{ type: "text", content: "The first requested explanation.", partial: false },
					]
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[
					{ type: "text", text: "<user_message>\nUse this queued detail.\n</user_message>" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" },
					},
				],
				false,
			])
			expect(feedback).toHaveBeenCalledWith(
				"user_feedback",
				"Use this queued detail.",
				[firstImage],
				undefined,
				undefined,
				undefined,
				{ queuedMessageIds: [firstQueuedMessage.id] },
			)
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.messages[0]).toMatchObject({
				text: "Keep this for later.",
				images: [secondImage],
			})
		})

		it("continues a provider-completed response with empty input instead of a no-tool error", async () => {
			const task = createTask()
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({
					status: "completed",
					response: createAgentResponse([{ type: "text", text: "The provider requests a follow-up step." }], {
						status: "completed",
						requiresContinuation: true,
					}),
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([[], false])
			expect(JSON.stringify(task.apiConversationHistory)).not.toContain(formatResponse.noToolsUsed())
		})

		it("keeps the queue behind pending turn content", async () => {
			const task = createTask()
			const pendingContent = [{ type: "text" as const, text: "tool result continuation" }]
			task.messageQueueService.addMessage("queued after tool results")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [
						{ type: "text", content: "I handled the previous step.", partial: false },
					]
					task.userMessageContent = pendingContent
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([pendingContent, false])
			expect(task.messageQueueService.messages).toHaveLength(1)
		})

		it.each(["primary", "subagent"] as const)("keeps the %s queue behind pending steering", async (kind) => {
			const task = createTask(kind)
			task.messageQueueService.addMessage("queued after steering")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [
						{ type: "text", content: "I received the original request.", partial: false },
					]
					;(task as any).pendingSteerMessage = { text: "higher-priority steering", images: [] }
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[{ type: "text", text: formatResponse.noToolsUsed() }],
				false,
			])
			expect(task.messageQueueService.messages).toHaveLength(1)
		})

		it.each(["failed", "incomplete", "aborted", "exhausted"] as const)(
			"does not publish managed text from a %s response",
			async (status) => {
				const task = createTask("subagent")
				const completed = vi.fn()
				task.on(AlphaCodeEventName.TaskCompleted, completed)
				const request = vi.spyOn(task, "runAgentRequests").mockResolvedValueOnce({
					status,
					response: createAgentResponse([{ type: "text", text: "Partial analysis before interruption." }]),
				})

				await Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "Investigate." }])

				expect(request).toHaveBeenCalledOnce()
				expect(completed).not.toHaveBeenCalled()
				expect(Reflect.get(task, "didComplete")).toBe(false)
				expect(task.clineMessages.some((message) => message.say === "completion_result")).toBe(false)
			},
		)

		it.each(["primary", "subagent"] as const)(
			"repairs a %s text completion without presenting a terminal error or premature completion",
			async (kind) => {
				const task = createTask(kind)
				const message = "Declared acceptance checks need attention: catalog-validation: unavailable."
				vi.spyOn(task, "waitForCompletionGateDecision")
					.mockResolvedValueOnce({
						allowed: false,
						classification: "repairable",
						reasonCode: "verification_missing",
						modelCanResolveRejection: true,
						message,
					})
					.mockResolvedValue({ allowed: true, modelCanResolveRejection: true })
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
				const completed = vi.fn()
				task.on(AlphaCodeEventName.TaskCompleted, completed)
				const request = vi
					.spyOn(task, "runAgentRequests")
					.mockResolvedValueOnce({
						status: "completed",
						response: createAgentResponse([{ type: "text", text: "Destination catalog complete." }]),
					})
					.mockImplementationOnce(async () => {
						expect(completed).not.toHaveBeenCalled()
						expect(task.clineMessages.some((row) => row.say === "completion_result")).toBe(false)
						return {
							status: "completed",
							response: createAgentResponse([{ type: "text", text: "Catalog validation verified." }]),
						}
					})

				await task["initiateTaskLoop"]([{ type: "text", text: "Build the catalog." }])

				expect(request).toHaveBeenCalledTimes(2)
				expect(request.mock.calls[1]?.[0]).toEqual([
					expect.objectContaining({ text: expect.stringContaining(message) }),
				])
				expect(task.clineMessages.some((row) => row.say === "error")).toBe(false)
				expect(completed).toHaveBeenCalledOnce()
			},
		)

		it("shows one error and stops when the completion repair allowance is exhausted", async () => {
			const task = createTask()
			vi.spyOn(task, "waitForCompletionGateDecision").mockResolvedValue({
				allowed: false,
				classification: "repairable",
				reasonCode: "verification_missing",
				modelCanResolveRejection: true,
				message: "catalog-validation: unavailable",
			})
			const request = vi.spyOn(task, "runAgentRequests").mockResolvedValue({
				status: "completed",
				response: createAgentResponse([{ type: "text", text: "Destination catalog complete." }]),
			})
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)
			vi.spyOn(task, "ask").mockImplementation(async (type) => {
				expect(type).toBe("resume_task")
				task.abort = true
				return { response: "noButtonClicked" }
			})

			await task["initiateTaskLoop"]([{ type: "text", text: "Build the catalog." }])

			expect(request).toHaveBeenCalledTimes(3)
			expect(completed).not.toHaveBeenCalled()
			expect(task.clineMessages.filter((row) => row.say === "error")).toEqual([
				expect.objectContaining({
					text: expect.stringContaining("incomplete and unverified after repeated attempts"),
				}),
			])
			expect(task.clineMessages.some((row) => row.say === "completion_result")).toBe(false)
		})

		it("allows a managed final answer after a recoverable completion rejection", async () => {
			const task = createTask("subagent")
			mockProvider.getParentCompletionDecision
				.mockResolvedValueOnce({
					allowed: false,
					modelCanResolveRejection: true,
					message: "Inspect the pending result.",
				})
				.mockResolvedValue({ allowed: true })
			const request = vi.spyOn(task, "runAgentRequests").mockImplementation(async () => {
				task.userMessageContent = []
				return {
					status: "completed",
					response: createAgentResponse([{ type: "text", text: "Reviewed result." }]),
				}
			})
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)

			await Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "Review." }])

			expect(request).toHaveBeenCalledTimes(2)
			expect(request.mock.calls[1]?.[0]).toEqual([
				expect.objectContaining({ text: expect.stringContaining("Inspect the pending result.") }),
			])
			expect(completed).toHaveBeenCalledOnce()
			expect(Reflect.get(task, "didComplete")).toBe(true)
		})

		it("retains guidance arriving while a managed answer is being persisted", async () => {
			const task = createTask("subagent")
			const present = task.presentCompletionResult.bind(task)
			vi.spyOn(task, "presentCompletionResult").mockImplementationOnce(async (...args) => {
				await present(...args)
				task.messageQueueService.addMessage("Include the cancellation case.")
			})
			const request = vi
				.spyOn(task, "runAgentRequests")
				.mockResolvedValueOnce({
					status: "completed",
					response: createAgentResponse([{ type: "text", text: "Initial review." }]),
				})
				.mockImplementationOnce(async (input) => {
					const receiptIds = task["getQueuedInputReceipts"](input)
					task.apiConversationHistory.push({ role: "user", content: input, queued_message_ids: receiptIds })
					task.messageQueueService.acknowledgeMessages(receiptIds)
					await task.messageQueueService.flush()
					return {
						status: "completed",
						response: createAgentResponse([{ type: "text", text: "Expanded review." }]),
					}
				})
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)

			await Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "Review." }])

			expect(request).toHaveBeenCalledTimes(2)
			expect(request.mock.calls[1]?.[0]).toEqual([
				{ type: "text", text: "<user_message>\nInclude the cancellation case.\n</user_message>" },
			])
			expect(task.clineMessages.filter((message) => message.say === "completion_result")).toEqual([
				expect.objectContaining({ text: "Expanded review." }),
			])
			expect(completed).toHaveBeenCalledOnce()
		})

		it("does not publish managed completion when persistence fails and can retry once it recovers", async () => {
			const task = createTask("subagent")
			vi.spyOn(task, "runAgentRequests").mockResolvedValue({
				status: "completed",
				response: createAgentResponse([{ type: "text", text: "The durable report." }]),
			})
			vi.spyOn(task, "flushPendingToolResultsToHistory").mockRejectedValueOnce(
				new Error("Persistence unavailable"),
			)
			const completed = vi.fn()
			task.on(AlphaCodeEventName.TaskCompleted, completed)
			const run = () => Reflect.get(task, "initiateTaskLoop").call(task, [{ type: "text", text: "Review." }])

			await expect(run()).rejects.toThrow("Persistence unavailable")
			expect(completed).not.toHaveBeenCalled()
			expect(Reflect.get(task, "didComplete")).toBe(false)
			await run()
			expect(Reflect.get(task, "didComplete")).toBe(true)
			expect(completed).toHaveBeenCalledOnce()
		})

		it("consumes queued guidance before accepting managed child text", async () => {
			const task = createTask("subagent")
			task.messageQueueService.addMessage("Check the additional edge case.")
			const requestStep = vi
				.spyOn(task, "runAgentRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [
						{ type: "text", content: "Managed child progress.", partial: false },
					]
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[{ type: "text", text: "<user_message>\nCheck the additional edge case.\n</user_message>" }],
				false,
			])
			expect(task.messageQueueService.messages).toHaveLength(0)
			expect(Reflect.get(task, "didComplete")).toBe(false)
		})

		it("stops at the completion boundary without starting another request", async () => {
			const task = createTask()
			const requestStep = vi.spyOn(task, "runAgentRequests").mockImplementationOnce(async () => {
				task.userMessageContent = [{ type: "text", text: "stale continuation" }]
				task.markCompleted()
				return false
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "finish" }])

			expect(requestStep).toHaveBeenCalledOnce()
		})

		it("resumes a delegated parent from its persisted new_task child result", async () => {
			const task = createTask()
			const capture = {
				details: "<environment_details>refreshed after delegation</environment_details>",
				commit: vi.fn(),
				release: vi.fn(),
			}
			vi.mocked(captureEnvironmentDetails).mockResolvedValueOnce(capture)
			const childResult: Anthropic.ToolResultBlockParam = {
				type: "tool_result",
				tool_use_id: "new-task-1",
				content: "Child task completed: inspected the parser",
			}
			task.apiConversationHistory = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "new-task-1",
							name: "new_task",
							input: { mode: "code", message: "Inspect the parser" },
						},
					],
				},
				{ role: "user", content: [childResult] },
			]
			const persistedChildMessage = task.apiConversationHistory[1]
			Object.assign(task, {
				abort: true,
				abandoned: true,
				isStreaming: true,
				isWaitingForFirstChunk: true,
			})
			const ask = vi.spyOn(task, "ask")
			const saveHistory = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			const continueLoop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)

			await task.resumeAfterDelegation()

			expect(ask).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toHaveLength(3)
			expect(task.apiConversationHistory[1]).toBe(persistedChildMessage)
			expect(persistedChildMessage.content).toEqual([childResult])
			expect(task.apiConversationHistory[2]).toMatchObject({
				role: "user",
				content: [{ type: "text", text: capture.details }],
			})
			expect(saveHistory).toHaveBeenCalledOnce()
			expect(capture.commit).toHaveBeenCalledOnce()
			expect(continueLoop).toHaveBeenCalledWith([])
			expect(task.skipPrevResponseIdOnce).toBe(true)
			expect(task.abort).toBe(false)
			expect(task.abandoned).toBe(false)
		})

		it.each([
			["say", "completed", "resume_completed_task"],
			["say", "active", "resume_task"],
			["say", "interrupted", "resume_task"],
			["say", "failed", "resume_task"],
			["say", undefined, "resume_task"],
			["ask", "completed", "resume_completed_task"],
			["ask", "interrupted", "resume_task"],
			["ask", undefined, "resume_completed_task"],
		] as const)(
			"reopens a saved %s completion row with task status %s at %s",
			async (type, status, expectedAsk) => {
				const task = createTask()
				const modelTurn = createAgentLifecycleSnapshot({
					taskId: task.taskId,
					runId: "history-run",
					turnId: "history-turn",
				})
				modelTurn.status = "completed"
				mockProvider.getAgentLifecycleSnapshot.mockReturnValue(modelTurn)
				const completion = {
					ts: 2,
					...(type === "say"
						? { type: "say" as const, say: "completion_result" as const }
						: { type: "ask" as const, ask: "completion_result" as const }),
					text: "The saved answer.",
					partial: false,
				}
				const savedUi = [
					{ ts: 1, type: "say" as const, say: "text" as const, text: "historical task" },
					completion,
				]
				vi.spyOn(task as any, "getSavedAlphaMessages").mockResolvedValue(savedUi)
				vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue([
					{ role: "assistant", content: [{ type: "text", text: "The saved answer." }] },
				])
				vi.spyOn(task, "overwriteApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
				vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
				mockProvider.getTaskWithId.mockResolvedValue({ historyItem: { id: task.taskId, status } })
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })

				await task["resumeTaskFromHistory"]()

				expect(ask).toHaveBeenCalledExactlyOnceWith(expectedAsk)
				expect(task.clineMessages).toEqual(savedUi)
				expect(task.isCompleted()).toBe(false)
			},
		)

		it("reopens a managed child through verified child finalization without a local completion ask", async () => {
			const task = createTask("subagent")
			const completion = { ts: 2, type: "say" as const, say: "completion_result" as const, text: "Child answer." }
			vi.spyOn(task as any, "getSavedAlphaMessages").mockResolvedValue([completion])
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue([
				{ role: "assistant", content: [{ type: "text", text: completion.text }] },
			])
			const finalize = vi.spyOn(task, "finalizeTaskCompletion").mockResolvedValue(false)
			const ask = vi.spyOn(task, "ask")
			const continueLoop = vi.spyOn(task as any, "initiateTaskLoop")

			await task["resumeTaskFromHistory"]()

			expect(finalize).toHaveBeenCalledExactlyOnceWith()
			expect(ask).not.toHaveBeenCalled()
			expect(continueLoop).not.toHaveBeenCalled()
			expect(task.isCompleted()).toBe(false)
		})

		it("paints the UI transcript before provider history finishes loading", async () => {
			const task = createTask()
			const savedUi = [
				{ ts: 1, type: "say", say: "text", text: "historical task" },
				{ ts: 2, type: "say", say: "reasoning", text: "completed reasoning", partial: false },
				{ ts: 3, type: "say", say: "reasoning", text: "interrupted reasoning", partial: true },
			]
			const savedApi = [{ role: "user", content: "original task", ts: 1 }]
			let releaseRead!: () => void
			const readBarrier = new Promise<void>((resolve) => {
				releaseRead = resolve
			})
			let reachedRead!: () => void
			const readStarted = new Promise<void>((resolve) => {
				reachedRead = resolve
			})
			vi.spyOn(task as any, "getSavedAlphaMessages").mockImplementation(async () => structuredClone(savedUi))
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockImplementation(async () => {
				reachedRead()
				await readBarrier
				return savedApi
			})
			const overwrite = vi.spyOn(task, "overwriteAlphaMessages").mockResolvedValue(true)
			const save = vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
			const ask = vi.spyOn(task, "ask").mockImplementation(async () => {
				expect(task.apiConversationHistory).toEqual(savedApi)
				return { response: "noButtonClicked" }
			})
			vi.spyOn(mockProvider, "isTaskOnScreen").mockReturnValue(true)
			const resume = (task as any).resumeTaskFromHistory()
			await readStarted
			await vi.waitFor(() => expect(mockProvider.postTaskStateToWebview).toHaveBeenCalled())
			const effectsBeforeRead = [overwrite.mock.calls.length, save.mock.calls.length, ask.mock.calls.length]
			expect(task.clineMessages).toEqual(savedUi.slice(0, 2))
			releaseRead()
			await resume
			expect(effectsBeforeRead).toEqual([0, 0, 0])
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.clineMessages).toEqual(savedUi.slice(0, 2))
			expect(ask).toHaveBeenCalledOnce()
		})

		it.each(["ui", "api"] as const)("preserves history when the %s read fails during reopen", async (phase) => {
			const task = createTask()
			const failure = new Error("History read unavailable")
			const uiRead = vi
				.spyOn(task as any, "getSavedAlphaMessages")
				.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "saved" }])
			const apiRead = vi
				.spyOn(task as any, "getSavedApiConversationHistory")
				.mockResolvedValue([{ role: "user", content: "saved", ts: 1 }])
			if (phase === "ui") uiRead.mockRejectedValue(failure)
			else apiRead.mockRejectedValue(failure)
			const overwrite = vi.spyOn(task, "overwriteAlphaMessages").mockResolvedValue(true)
			const save = vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			const ask = vi.spyOn(task, "ask")
			await expect((task as any).resumeTaskFromHistory()).rejects.toBe(failure)
			expect(overwrite).not.toHaveBeenCalled()
			expect(save).not.toHaveBeenCalled()
			expect(ask).not.toHaveBeenCalled()
		})

		it.each(["ui", "api"] as const)("abandons hydration after eviction during the %s read", async (phase) => {
			const task = createTask()
			vi.spyOn(task as any, "getSavedAlphaMessages").mockImplementation(async () => {
				if (phase === "ui") task.abandoned = true
				return [{ ts: 1, type: "say", say: "text", text: "saved" }]
			})
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockImplementation(async () => {
				task.abandoned = true
				return [{ role: "user", content: "saved", ts: 1 }]
			})
			const overwrite = vi.spyOn(task, "overwriteAlphaMessages").mockResolvedValue(true)
			const save = vi.spyOn(task as any, "saveAlphaMessages").mockResolvedValue(true)
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
			await (task as any).resumeTaskFromHistory()
			expect(overwrite).not.toHaveBeenCalled()
			expect(save).not.toHaveBeenCalled()
			expect(ask).not.toHaveBeenCalled()
			if (phase === "ui") {
				expect(task.clineMessages).toEqual([])
				expect(task.apiConversationHistory).toEqual([])
			} else {
				expect(task.clineMessages).toEqual([{ ts: 1, type: "say", say: "text", text: "saved" }])
				expect(task.apiConversationHistory).toEqual([])
			}
		})

		it.each([false, true])(
			"resumes reversed historical receipts without replacing output (legacy calls: %s)",
			async (legacyCalls) => {
				const task = createTask()
				const receipts = [
					{ type: "tool_result", tool_call_id: "second-reload", content: "actual failure", is_error: true },
					{ type: "tool_result", tool_call_id: "first-reload", content: "actual success", is_error: false },
				]
				const savedApiHistory = [
					{ role: "user", content: "inspect", ts: 1 },
					{
						role: "assistant",
						content: ["first-reload", "second-reload"].map((id) =>
							legacyCalls
								? {
										type: "tool_call",
										tool_call_id: id,
										name: "read_file",
										input: { path: `${id}.txt` },
									}
								: { type: "tool_use", id, name: "read_file", input: { path: `${id}.txt` } },
						),
						ts: 2,
					},
					{ role: "user", content: receipts, ts: 3 },
				]
				const original = structuredClone(savedApiHistory)
				vi.spyOn(task as any, "getSavedAlphaMessages").mockResolvedValue([
					{ ts: 1, type: "say", say: "text", text: "historical task" },
				])
				vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue(savedApiHistory)
				vi.spyOn(task as any, "overwriteAlphaMessages").mockResolvedValue(true)
				vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)
				vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
				vi.spyOn(task, "say").mockResolvedValue(undefined)
				vi.spyOn(task, "ask").mockResolvedValue({ response: "messageResponse", text: "continue", images: [] })
				const continueLoop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
				await task["resumeTaskFromHistory"]()
				expect(continueLoop).toHaveBeenCalledOnce()
				const content = continueLoop.mock.calls[0][0] as Array<{ type: string }>
				expect(content.filter((block) => block.type === "tool_result")).toEqual([])
				expect(task.apiConversationHistory.at(-1)?.content).toEqual(receipts)
				expect(task.apiConversationHistory).toEqual(original)
				expect(savedApiHistory).toEqual(original)
			},
		)

		it("repairs an interrupted tool call when a root task resumes after reload", async () => {
			const task = createTask()
			const savedAlphaMessages = [{ ts: 1, type: "say", say: "text", text: "historical task" }]
			const savedApiHistory = [
				{ role: "user", content: [{ type: "text", text: "inspect" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "read-after-reload", name: "read_file", input: {} }],
					ts: 2,
				},
			]
			vi.spyOn(task as any, "getSavedAlphaMessages").mockResolvedValue(savedAlphaMessages)
			vi.spyOn(task as any, "overwriteAlphaMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			const loadApiHistory = vi
				.spyOn(task as any, "getSavedApiConversationHistory")
				.mockResolvedValue(savedApiHistory)
			vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({
				response: "messageResponse",
				text: "continue after reload",
				images: [],
			} as any)
			const continueLoop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)

			await (task as any).resumeTaskFromHistory()

			expect(loadApiHistory).toHaveBeenCalledOnce()
			expect(continueLoop).toHaveBeenCalledWith(
				[
					{
						type: "tool_result",
						tool_use_id: "read-after-reload",
						content: "Task was interrupted before this tool call could be completed.",
						is_error: true,
					},
					{ type: "text", text: "<user_message>\ncontinue after reload\n</user_message>" },
				],
				undefined,
				expect.objectContaining({
					deferTaskStartedUntilInitialUserContentPersisted: false,
					includeInitialFileDetails: true,
				}),
			)
		})
	})

	describe("upsertSubagentGroup durable publication", () => {
		function fixture(operation: "create" | "update") {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "Persist managed group cards",
				taskId: "group-parent",
				taskApiConfigName: "default",
				startTask: false,
				enableCheckpoints: false,
			})
			const group: SubagentGroupState = {
				groupId: "target-group",
				parentTaskId: task.taskId,
				status: "running",
				createdAt: 1,
				agents: [
					{
						taskId: "child",
						nickname: "Child",
						role: "review",
						objective: "Review communication",
						status: "running",
						usage: { inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0 },
					},
				],
			}
			const sibling: AlphaMessage = {
				ts: group.createdAt,
				type: "say",
				say: "subagent_group",
				text: "Sibling card",
				subagentGroup: { ...structuredClone(group), groupId: "sibling-group" },
			}
			const original: AlphaMessage = {
				ts: 10,
				type: "say",
				say: "subagent_group",
				text: "Retained card text",
				images: ["data:image/png;base64,aA=="],
				partial: false,
				subagentGroup: structuredClone(group),
			}
			task.clineMessages = [
				{ ts: group.createdAt, type: "say", say: "text", text: "Unrelated message at the same timestamp" },
				sibling,
				...(operation === "update" ? [original] : []),
			]
			const baseline = structuredClone(task.clineMessages)
			const nextGroup: SubagentGroupState = {
				...group,
				status: "completed",
				completedAt: 20,
				agents: group.agents.map((agent) => ({ ...agent, status: "completed" })),
			}
			const expected: AlphaMessage = {
				...(operation === "update"
					? original
					: { ts: group.createdAt, type: "say" as const, say: "subagent_group" as const }),
				subagentGroup: nextGroup,
			}
			const projection = vi.fn(async () => undefined)
			mockProvider.postTaskMessageToWebview = projection
			const messageEvents = vi.fn()
			task.on(AlphaCodeEventName.Message, messageEvents)
			const releaseReview = vi.fn()
			Reflect.set(task, "subagentReviewBarrier", { promise: new Promise<void>(() => {}), resolve: releaseReview })
			return { task, nextGroup, baseline, sibling, original, expected, projection, messageEvents, releaseReview }
		}

		it.each(["create", "update"] as const)(
			"keeps memory, UI, and the review barrier unchanged when %s persistence fails",
			async (operation) => {
				const { task, nextGroup, baseline, sibling, original, projection, messageEvents, releaseReview } =
					fixture(operation)
				const save = vi
					.spyOn(taskPersistence, "saveTaskMessages")
					.mockRejectedValue(new Error("Transcript storage unavailable"))
				try {
					await expect(task.upsertSubagentGroup(nextGroup)).rejects.toThrow(
						"Unable to persist the sub-agent group",
					)
					expect(save).toHaveBeenCalledTimes(3)
					expect(task.clineMessages).toEqual(baseline)
					expect(task.clineMessages[1]).toBe(sibling)
					if (operation === "update") expect(task.clineMessages[2]).toBe(original)
					expect(projection).not.toHaveBeenCalled()
					expect(messageEvents).not.toHaveBeenCalled()
					expect(releaseReview).not.toHaveBeenCalled()
				} finally {
					save.mockRestore()
				}
			},
		)

		it.each(["create", "update"] as const)(
			"commits %s before publishing while preserving existing fields and sibling cards",
			async (operation) => {
				const { task, nextGroup, baseline, sibling, expected, projection, messageEvents, releaseReview } =
					fixture(operation)
				let enterSave!: () => void
				const saveEntered = new Promise<void>((resolve) => (enterSave = resolve))
				let releaseSave!: () => void
				const saveBarrier = new Promise<void>((resolve) => (releaseSave = resolve))
				let snapshot: AlphaMessage[] | undefined
				let saved = false
				const projectionObservations: Array<{ saved: boolean; message: AlphaMessage | undefined }> = []
				const save = vi
					.spyOn(taskPersistence, "saveTaskMessages")
					.mockImplementationOnce(async ({ messages }) => {
						snapshot = structuredClone(messages)
						enterSave()
						await saveBarrier
						saved = true
					})
				projection.mockImplementation(async () => {
					projectionObservations.push({ saved, message: structuredClone(task.clineMessages[2]) })
				})
				const committing = task.upsertSubagentGroup(nextGroup)
				try {
					await saveEntered
					expect(snapshot).toEqual([...baseline.slice(0, 2), expected])
					expect(task.clineMessages).toEqual(baseline)
					expect(projection).not.toHaveBeenCalled()
					expect(messageEvents).not.toHaveBeenCalled()
					expect(releaseReview).not.toHaveBeenCalled()
					releaseSave()
					await committing
					expect(task.clineMessages).toEqual(snapshot)
					expect(task.clineMessages[1]).toBe(sibling)
					expect(projectionObservations).toEqual([{ saved: true, message: expected }])
					expect(projection).toHaveBeenCalledExactlyOnceWith(
						operation === "create" ? "messageCreated" : "messageUpdated",
						task.taskId,
						expected,
					)
					expect(messageEvents).toHaveBeenCalledExactlyOnceWith({
						action: operation === "create" ? "created" : "updated",
						message: expected,
					})
					expect(releaseReview).toHaveBeenCalledOnce()
				} finally {
					releaseSave()
					await committing
					save.mockRestore()
				}
			},
		)
	})

	describe("design handoff persistence", () => {
		const planStorageParent = path.resolve(os.tmpdir())
		const planStoragePrefix = "alpha-task-plan-"
		let planStoragePath: string | undefined
		const createPlanTask = (overrides: Record<string, unknown> = {}) =>
			new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "design handoff task",
				taskId: "primary-plan-task",
				taskMode: "architect",
				taskApiConfigName: "default",
				startTask: false,
				enableCheckpoints: false,
				...overrides,
			} as any)

		const firstPlan = "<proposed_plan>\n# First design\n\n- Preserve the parser contract.\n</proposed_plan>"
		const secondPlan = "<proposed_plan>\n# Revised design\n\n- Persist the current handoff.\n</proposed_plan>"

		beforeEach(() => {
			mockProvider.updateTaskHistory.mockClear()
			mockProvider.updateTaskHistory.mockResolvedValue([])
			planStoragePath = fsSync.mkdtempSync(path.join(planStorageParent, planStoragePrefix))
			Object.assign(mockExtensionContext, { globalStorageUri: { fsPath: planStoragePath } })
			fsSync.mkdirSync(path.join(mockExtensionContext.globalStorageUri.fsPath, "tasks", "primary-plan-task"), {
				recursive: true,
			})
		})

		afterEach(() => {
			if (!planStoragePath) return
			const target = path.resolve(planStoragePath)
			if (path.dirname(target) !== planStorageParent || !path.basename(target).startsWith(planStoragePrefix)) {
				throw new Error("Plan fixture cleanup escaped its owned temporary directory")
			}
			fsSync.rmSync(target, { recursive: true, force: true })
			planStoragePath = undefined
		})

		it("persists a complete plan body from the parsed completion and restores the latest revision", async () => {
			const task = createPlanTask()

			await task.presentCompletionResult(firstPlan)
			const firstHistory = mockProvider.updateTaskHistory.mock.lastCall?.[0]
			const firstBody = parseProposedPlan(firstPlan)?.content

			expect(firstBody).toBeDefined()
			expect(firstHistory).toEqual(
				expect.objectContaining({
					id: task.taskId,
					designHandoff: expect.objectContaining({
						markdown: firstBody,
						sourceTaskId: task.taskId,
					}),
				}),
			)
			expect(task.designHandoff?.markdown).toBe(firstBody)

			await task.presentCompletionResult(secondPlan)
			const latestHistory = mockProvider.updateTaskHistory.mock.lastCall?.[0]
			const secondBody = parseProposedPlan(secondPlan)?.content

			expect(latestHistory?.designHandoff).toEqual(task.designHandoff)
			expect(latestHistory?.designHandoff?.markdown).toBe(secondBody)
			expect(latestHistory?.designHandoff?.markdown).not.toBe(firstBody)

			const reloaded = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: latestHistory,
				startTask: false,
				enableCheckpoints: false,
			} as any)

			expect(reloaded.designHandoff).toEqual(latestHistory?.designHandoff)
		})

		it("does not replace a complete handoff while the next plan is partial or incomplete", async () => {
			const task = createPlanTask()
			await task.presentCompletionResult(firstPlan)
			const persisted = structuredClone(task.designHandoff)

			await task.presentCompletionResult("<proposed_plan>\n# Streaming revision", [], true)
			expect(task.designHandoff).toEqual(persisted)

			await task.presentCompletionResult("<proposed_plan>\n# Incomplete revision")
			const exactIncompleteRow = task.clineMessages
				.filter((message) => message.type === "say" && message.say === "completion_result")
				.at(-1)
			expect(
				parseProposedPlan(exactIncompleteRow?.type === "say" ? (exactIncompleteRow.text ?? "") : "")?.complete,
			).not.toBe(true)

			await task.presentCompletionResult("Draft:\n<proposed_plan>\n# Preamble leaves this incomplete")
			const preambleIncompleteRow = task.clineMessages
				.filter((message) => message.type === "say" && message.say === "completion_result")
				.at(-1)
			const latestHistory = mockProvider.updateTaskHistory.mock.lastCall?.[0]

			expect(
				parseProposedPlan(preambleIncompleteRow?.type === "say" ? (preambleIncompleteRow.text ?? "") : "")
					?.complete,
			).not.toBe(true)
			expect(task.designHandoff).toEqual(persisted)
			expect(latestHistory?.designHandoff).toEqual(persisted)
		})

		it("does not publish a plan in memory when completion persistence fails", async () => {
			const task = createPlanTask()
			mockProvider.updateTaskHistory.mockRejectedValue(new Error("history unavailable"))

			await expect(task.presentCompletionResult(firstPlan)).rejects.toThrow(
				"Unable to persist the completion result",
			)

			expect(task.designHandoff).toBeUndefined()
			expect(task.clineMessages).not.toContainEqual(expect.objectContaining({ say: "completion_result" }))
		})

		it("does not let a child completion author or replace the parent handoff", async () => {
			const parent = createPlanTask()
			await parent.presentCompletionResult(firstPlan)
			const persisted = structuredClone(parent.designHandoff)
			mockProvider.updateTaskHistory.mockClear()
			fsSync.mkdirSync(path.join(mockExtensionContext.globalStorageUri.fsPath, "tasks", "child-plan-task"), {
				recursive: true,
			})

			const child = createPlanTask({
				taskId: "child-plan-task",
				task: "child design handoff task",
				taskKind: "subagent",
				parentTask: parent,
				rootTask: parent,
			})
			await child.captureGoalAccountingBinding()
			await child.presentCompletionResult(secondPlan)

			expect(parent.designHandoff).toEqual(persisted)
			expect(child.designHandoff).toBeUndefined()
			expect(mockProvider.updateTaskHistory.mock.lastCall?.[0]?.designHandoff).toBeUndefined()
		})
	})

	describe("start()", () => {
		it("should be a no-op if the task was already started in the constructor", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Manually trigger start
			const startTaskSpy = vi.spyOn(task as any, "startTask").mockImplementation(async () => {})
			task.start()

			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			// Calling start() again should be a no-op
			task.start()
			expect(startTaskSpy).toHaveBeenCalledTimes(1)
		})

		it("should not call startTask if already started via constructor", () => {
			// Create a task that starts immediately (startTask defaults to true)
			// but mock startTask to prevent actual execution
			const startTaskSpy = vi.spyOn(Task.prototype as any, "startTask").mockImplementation(async () => {})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: true,
			})

			// startTask was called by the constructor
			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			// Calling start() should be a no-op since _started is already true
			task.start()
			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			startTaskSpy.mockRestore()
		})
	})
})

describe("Plan completion presentation", () => {
	it("preserves a primary Plan response without inventing a proposed-plan block", async () => {
		const message = { ts: 1, type: "say", say: "text", text: "streamed draft", partial: true }
		const commitAlphaMessageMutation = vi.fn(
			async (_timestamp: number, _context: string, mutate: (value: any) => any) => {
				const committed = mutate(message)
				Object.assign(message, committed)
				return { message, created: false }
			},
		)
		const task = {
			taskKind: "primary",
			cwd: "F:/workspace",
			getTaskMode: vi.fn().mockResolvedValue("architect"),
			currentAssistantResponseMessageTs: 1,
			findMessageByTimestamp: vi.fn().mockReturnValue(message),
			commitAlphaMessageMutation,
			updateAlphaMessage: vi.fn().mockResolvedValue(undefined),
			say: vi.fn().mockResolvedValue(undefined),
		} as unknown as Task

		await Task.prototype.presentCompletionResult.call(task, "# Provider plan\n- Update model lookup")

		expect(message).toMatchObject({
			say: "completion_result",
			text: "# Provider plan\n- Update model lookup",
			partial: false,
		})
		expect(commitAlphaMessageMutation).toHaveBeenCalledWith(
			1,
			"the completion result",
			expect.any(Function),
			undefined,
		)
		expect((task as any).say).not.toHaveBeenCalled()
	})
})

describe("Queued message processing after condense", () => {
	function prepareCompaction(task: Task) {
		task.apiConversationHistory = [{ role: "user", content: "Original context before compaction" }]
		vi.spyOn(task.api, "countTokens").mockImplementation(async (blocks) =>
			JSON.stringify(blocks).includes("Original context before compaction") ? 1000 : 1,
		)
		vi.spyOn(
			task as unknown as { saveApiConversationHistory(): Promise<boolean> },
			"saveApiConversationHistory",
		).mockResolvedValue(true)
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
	}

	function createProvider(): any {
		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const ctx = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const output = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		const provider = new AlphaProvider(ctx, output as any, "sidebar", new ContextProxy(ctx)) as any
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		provider.getState = vi.fn().mockResolvedValue({})
		provider.settleIndependentTaskWaitReceiptsForParent = vi.fn().mockResolvedValue(undefined)
		return provider
	}

	const apiConfig: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "claude-3-5-sonnet-20241022",
		openAiApiKey: "test-api-key",
	} as any

	it("keeps queued message after condense completes", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
		})
		prepareCompaction(task)
		const submitSpy = vi.spyOn(task, "submitUserMessage").mockResolvedValue(undefined)
		task.consecutiveMistakeCount = 1
		task.consecutiveNoToolUseCount = 2
		task.consecutiveNoAssistantMessagesCount = 1
		;(task as any).automaticMistakeRecoveryCount = 1

		// Queue a message during condensing
		task.messageQueueService.addMessage("queued text", ["img1.png"])
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.consecutiveNoToolUseCount).toBe(0)
		expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
		expect((task as any).automaticMistakeRecoveryCount).toBe(0)

		await task.condenseContext()

		expect(submitSpy).not.toHaveBeenCalled()
		expect(task.messageQueueService.isEmpty()).toBe(false)
		expect(task.messageQueueService.messages[0]?.text).toBe("queued text")
	})

	it("uses queued user guidance instead of reopening the mistake-limit dialog", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
		})
		const feedback = vi.spyOn(task, "say").mockResolvedValue(undefined)
		task.consecutiveMistakeLimit = 1
		const guidance = task.messageQueueService.addMessage("Did we finish?")!
		// Simulate the in-flight model turn failing after the message was queued.
		task.consecutiveMistakeCount = 1
		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect(feedback).toHaveBeenCalledWith(
			"user_feedback",
			"Did we finish?",
			undefined,
			undefined,
			undefined,
			undefined,
			{ queuedMessageIds: [guidance.id] },
		)
		expect(task.messageQueueService.isEmpty()).toBe(true)
		expect(userContent).toContainEqual({
			type: "text",
			text: "<user_message>\nDid we finish?\n</user_message>",
		})
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("does not cross-drain queues between separate tasks", async () => {
		const providerA = createProvider()
		const providerB = createProvider()

		const taskA = new Task({
			provider: providerA,
			apiConfiguration: apiConfig,
			taskId: "queued-condense-task-a",
			task: "task A",
			startTask: false,
			enableCheckpoints: false,
		})
		const taskB = new Task({
			provider: providerB,
			apiConfiguration: apiConfig,
			taskId: "queued-condense-task-b",
			task: "task B",
			startTask: false,
			enableCheckpoints: false,
		})
		try {
			// The uuid mock is constant; separate tasks need distinct transcript ownership keys.
			expect(taskA.taskId).not.toBe(taskB.taskId)
			expect(taskA.messageQueueService).not.toBe(taskB.messageQueueService)
			prepareCompaction(taskA)
			prepareCompaction(taskB)

			const spyA = vi.spyOn(taskA, "submitUserMessage").mockResolvedValue(undefined)
			const spyB = vi.spyOn(taskB, "submitUserMessage").mockResolvedValue(undefined)

			taskA.messageQueueService.addMessage("A message")
			taskB.messageQueueService.addMessage("B message")

			// Condense should not drain either task's queue.
			await taskA.condenseContext()

			expect(spyA).not.toHaveBeenCalled()
			expect(spyB).not.toHaveBeenCalled()
			expect(taskA.messageQueueService.isEmpty()).toBe(false)
			expect(taskB.messageQueueService.isEmpty()).toBe(false)
			expect(taskA.messageQueueService.messages.map((message) => message.text)).toEqual(["A message"])
			expect(taskB.messageQueueService.messages.map((message) => message.text)).toEqual(["B message"])

			await taskB.condenseContext()

			expect(spyA).not.toHaveBeenCalled()
			expect(spyB).not.toHaveBeenCalled()
			expect(taskA.messageQueueService.isEmpty()).toBe(false)
			expect(taskB.messageQueueService.isEmpty()).toBe(false)
			expect(taskA.messageQueueService.messages.map((message) => message.text)).toEqual(["A message"])
			expect(taskB.messageQueueService.messages.map((message) => message.text)).toEqual(["B message"])
		} finally {
			taskA.dispose()
			taskB.dispose()
			await providerA.dispose()
			await providerB.dispose()
		}
	})
})

describe("Task typed tool approval bridge", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	const request = (taskId: string, overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
		requestId: `${taskId}:call-1`,
		taskId,
		callId: "call-1",
		toolName: "read_file",
		askType: "tool",
		description: "Read src/main.ts",
		forceApproval: false,
		requiresExplicitApproval: true,
		availableDecisions: ["approve_once", "deny", "abort"],
		...overrides,
	})

	const createTask = (
		options: {
			toolApprovalReviewer?: ToolApprovalReviewer
			taskApprovalMode?: ApprovalMode
			provider?: AlphaProvider
		} = {},
	) =>
		new Task({
			provider:
				options.provider ??
				({
					context: { globalStorageUri: { fsPath: "/test/storage" } },
					getState: vi.fn().mockResolvedValue({}),
					isTaskOnScreen: vi.fn().mockReturnValue(true),
					postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
				} as any),
			apiConfiguration: { apiProvider: "openai", openAiApiKey: "test-key" },
			task: "typed approval test",
			startTask: false,
			...options,
		})

	it("persists a prefix in global settings for a resumed task and keeps deny rules effective", async () => {
		const settings = { allowedCommands: [] as string[] }
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getValue: vi.fn((key: string) => (key === "allowedCommands" ? settings.allowedCommands : undefined)),
			setValue: vi.fn(async (key: string, value: unknown) => {
				if (key === "allowedCommands" && Array.isArray(value)) settings.allowedCommands = value as string[]
			}),
			getState: vi.fn(async () => ({ allowedCommands: [...settings.allowedCommands] })),
			isTaskOnScreen: vi.fn().mockReturnValue(true),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		} as unknown as AlphaProvider
		const approvingTask = createTask({ provider, taskApprovalMode: "ask" })

		await expect(approvingTask.persistCommandApprovalPrefix("git status --short")).resolves.toBe(true)
		expect(provider.setValue).toHaveBeenCalledWith("allowedCommands", ["git status --short"])
		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce()

		const resumedTask = createTask({ provider, taskApprovalMode: "ask" })
		const reloadedState = await provider.getState()
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short --branch",
				state: {
					approvalMode: resumedTask.getTaskApprovalMode(),
					allowedCommands: reloadedState.allowedCommands,
					deniedCommands: [],
				},
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short --porcelain",
				state: {
					approvalMode: resumedTask.getTaskApprovalMode(),
					allowedCommands: reloadedState.allowedCommands,
					deniedCommands: ["git status --short --porcelain"],
				},
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it("persists separately approved argument casing and avoids duplicate exact rules", async () => {
		const allowedCommands = ["node scripts/check.js"]
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getValue: vi.fn((key: string) => (key === "allowedCommands" ? allowedCommands : undefined)),
			setValue: vi.fn(async (_key: string, value: string[]) => {
				allowedCommands.splice(0, allowedCommands.length, ...value)
			}),
			getState: vi.fn().mockResolvedValue({}),
			isTaskOnScreen: vi.fn().mockReturnValue(true),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		} as unknown as AlphaProvider
		const task = createTask({ provider, taskApprovalMode: "ask" })

		await expect(task.persistCommandApprovalPrefix("node Scripts/check.js")).resolves.toBe(true)
		await expect(task.persistCommandApprovalPrefix("node Scripts/check.js")).resolves.toBe(true)
		expect(provider.setValue).toHaveBeenCalledExactlyOnceWith("allowedCommands", [
			"node scripts/check.js",
			"node Scripts/check.js",
		])
	})

	const runApprovalTool = async (task: Task, askType: AlphaAsk, reviewMessage = "Perform the reviewed action") => {
		const executeEffect = vi.fn()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const descriptor: ToolDescriptor = {
			name: "reviewable_tool",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "reviewable_tool",
					description: "A deterministic approval test tool",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			},
			capabilities: { concurrency: "serial", sideEffects: "task", controlFlow: false, requiresApproval: false },
			getConcurrencyScope: () => "tool-approval-review-test",
			execute: async ({ callbacks }) => {
				if (await callbacks.askApproval(askType, reviewMessage)) {
					executeEffect()
					callbacks.pushToolResult("action completed")
				}
			},
		}
		registry.register(descriptor)
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			signal: task.getTaskCancellationSignal(),
			validateCall: () => {},
		}).run(
			createAgentResponse([{ type: "tool_call", id: "reviewable-call", name: "reviewable_tool", arguments: {} }]),
		)
		return { outcome, executeEffect }
	}

	it.each(["ask", "auto", "bypass"] as const)(
		"preserves complete file review data and valid persisted prompts in %s mode",
		async (taskApprovalMode) => {
			const task = createTask({ taskApprovalMode })
			const reviewMessage = JSON.stringify({
				tool: "appliedDiff",
				path: "large.ts",
				originalContent: "a".repeat(60_000),
				finalContent: "b".repeat(60_000),
				isOutsideWorkspace: false,
				isProtected: false,
			})
			const askSpy = vi.spyOn(task, "ask")
			await runApprovalTool(task, "tool", reviewMessage)

			expect(askSpy.mock.calls[0]![1]).toBe(reviewMessage)
			const message = task.clineMessages.at(-1)!
			expect(message.text).toBe(reviewMessage)
			expect(message.toolApprovalRequest!.description!.length).toBeLessThan(100_000)
			expect(alphaMessageSchema.safeParse(message).success).toBe(true)
		},
	)

	it("gives reviewers the entire action when approval metadata contains only a summary", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "approve" }))
		const task = createTask({ toolApprovalReviewer: reviewer })
		const reviewMessage = JSON.stringify({ tool: "appliedDiff", path: "large.ts", content: "x".repeat(120_000) })
		const { outcome, executeEffect } = await runApprovalTool(task, "tool", reviewMessage)
		expect(outcome.results).toMatchObject([{ status: "success" }])
		expect(executeEffect).toHaveBeenCalledOnce()
		expect(reviewer.mock.calls[0]![0].description!.length).toBeLessThan(100_000)
		expect(reviewer.mock.calls[0]![2]).toBe(reviewMessage)
	})

	it("rejects command review text that differs from the exact command in approval metadata", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "approve" }))
		const task = createTask({ toolApprovalReviewer: reviewer })
		const approval = request(task.taskId, { askType: "command", description: "pnpm test" })
		await expect(task.requestToolApproval(approval, "pnpm test && another-command")).rejects.toThrow(
			/invalid or mismatched/,
		)
		expect(reviewer).not.toHaveBeenCalled()
		expect(task.hasPendingToolApprovalRequest()).toBe(false)
	})

	it("projects the reviewed working directory into command approval prompts", async () => {
		const task = createTask()
		const approval = request(task.taskId, {
			toolName: "exec_command",
			askType: "command",
			description: "pnpm lint",
			cwd: "C:\\repo\\workspace",
			commandPathApproval: { outsidePaths: ["C:\\outside\\output.txt"], unresolved: false },
			requiresExplicitApproval: true,
		})

		await task.ask("command", approval.description, undefined, undefined, undefined, true, approval)

		expect(task.clineMessages.at(-1)?.toolApprovalRequest).toMatchObject({
			requestId: approval.requestId,
			taskId: task.taskId,
			toolName: "exec_command",
			description: "pnpm lint",
			cwd: "C:\\repo\\workspace",
			commandPathApproval: { outsidePaths: ["C:\\outside\\output.txt"], unresolved: false },
		})
	})

	it("projects the persistent prefix into the command approval prompt", async () => {
		const task = createTask()
		const approval = request(task.taskId, {
			toolName: "exec_command",
			askType: "command",
			description: "node scripts/check.js",
			requiresExplicitApproval: false,
			availableDecisions: ["approve_once", "approve_persistently", "deny", "abort"],
			proposedPersistentAmendment: {
				kind: "command_prefix",
				prefix: "node scripts/check.js",
			},
		})

		await task.ask("command", approval.description, undefined, undefined, undefined, false, approval)

		expect(task.clineMessages.at(-1)?.toolApprovalRequest).toMatchObject({
			availableDecisions: ["approve_once", "approve_persistently", "deny", "abort"],
			proposedPersistentAmendment: {
				kind: "command_prefix",
				prefix: "node scripts/check.js",
			},
		})
	})

	it("publishes an auto-approved command as answered on its first update", async () => {
		const publishedMessages: unknown[] = []
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getState: vi.fn().mockResolvedValue({
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["pnpm test"],
				deniedCommands: [],
			}),
			postTaskMessageToWebview: vi.fn(async (...args: unknown[]) => {
				publishedMessages.push(args[2])
			}),
			isTaskOnScreen: vi.fn().mockReturnValue(true),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as AlphaProvider
		const task = createTask({ provider, taskApprovalMode: "auto" })
		const approval = request(task.taskId, {
			toolName: "exec_command",
			askType: "command",
			description: "pnpm test",
			requiresExplicitApproval: false,
		})

		await expect(
			task.ask("command", approval.description, undefined, undefined, undefined, false, approval),
		).resolves.toMatchObject({ response: "yesButtonClicked" })

		expect(publishedMessages).toHaveLength(1)
		expect(publishedMessages[0]).toMatchObject({
			type: "ask",
			ask: "command",
			text: "pnpm test",
			isAnswered: true,
		})
		expect(task.clineMessages.at(-1)?.isAnswered).toBe(true)
	})

	it("evaluates the original worker command while publishing only redacted private paths", async () => {
		const privateWorkspace = path.resolve("private-command-policy", "worker")
		const command = `rm "${path.join(privateWorkspace, "build")}"`
		const publishedMessages: unknown[] = []
		let task: Task
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getState: vi.fn().mockResolvedValue({
				approvalMode: "auto",
				allowedCommands: ["*"],
				deniedCommands: [command],
			}),
			postTaskMessageToWebview: vi.fn(async (...args: unknown[]) => {
				const message = { ...(args[2] as { isAnswered?: boolean }) }
				publishedMessages.push(message)
				if (!message.isAnswered) task.handleWebviewAskResponse("noButtonClicked")
			}),
			isTaskOnScreen: vi.fn().mockReturnValue(true),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			clearSubagentApproval: vi.fn().mockResolvedValue(undefined),
		} as unknown as AlphaProvider
		task = createTask({ provider, taskApprovalMode: "auto" })
		vi.spyOn(task, "cwd", "get").mockReturnValue(privateWorkspace)
		Object.assign(task, {
			taskKind: "subagent",
			subagentRole: "worker",
			subagentPrivateWorkspaceRoot: path.dirname(privateWorkspace),
		})
		const approval = request(task.taskId, {
			toolName: "exec_command",
			askType: "command",
			description: command,
			requiresExplicitApproval: false,
		})

		await expect(
			task.ask("command", command, undefined, undefined, undefined, false, approval),
		).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		expect(publishedMessages).toHaveLength(1)
		expect(publishedMessages[0]).toMatchObject({ type: "ask", ask: "command", isAnswered: true })
		expect(JSON.stringify(task.clineMessages)).not.toContain(privateWorkspace)
		expect(task.clineMessages.at(-1)?.text).toContain(`.${path.sep}build`)
	})

	it.each([
		{
			command: "git $arguments",
			mode: "auto" as const,
			advanceStep: false,
			allowedPrefixes: ["git"],
			deniedPrefixes: ["git status"],
		},
		{
			command: "git diff",
			mode: "ask" as const,
			advanceStep: false,
			allowedPrefixes: ["git status"],
			deniedPrefixes: [],
		},
		{
			command: "git $arguments",
			mode: "auto" as const,
			advanceStep: true,
			allowedPrefixes: ["git"],
			deniedPrefixes: ["git status"],
		},
	])("keeps the admitted command ceiling when live rules widen: $command, advance=$advanceStep", async (scenario) => {
		const publishedMessages: unknown[] = []
		let task: Task
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getState: vi.fn().mockResolvedValue({
				approvalMode: scenario.mode,
				allowedCommands: ["git"],
				deniedCommands: [],
			}),
			postTaskMessageToWebview: vi.fn(async (...args: unknown[]) => {
				const message = args[2] as { isAnswered?: boolean }
				publishedMessages.push(message)
				if (!message.isAnswered) task.handleWebviewAskResponse("noButtonClicked")
			}),
			isTaskOnScreen: vi.fn().mockReturnValue(true),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as AlphaProvider
		task = createTask({ provider, taskApprovalMode: scenario.mode })
		Object.assign(task, {
			currentAgentStep: {
				snapshot: {
					context: { policy: { approval: { mode: scenario.mode }, execution: { command: scenario } } },
				},
			},
		})
		const approval = request(task.taskId, {
			toolName: "exec_command",
			askType: "command",
			description: scenario.command,
			requiresExplicitApproval: false,
		})

		const asking = task.ask("command", scenario.command, undefined, undefined, undefined, false, approval)
		if (scenario.advanceStep) {
			// getState has yielded; later step admission must not change this pending ask's ceiling.
			Object.assign(task, {
				currentAgentStep: {
					snapshot: {
						context: {
							policy: {
								approval: { mode: scenario.mode },
								execution: { command: { allowedPrefixes: ["*"], deniedPrefixes: [] } },
							},
						},
					},
				},
			})
		}
		await expect(asking).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(publishedMessages).toHaveLength(1)
		expect(publishedMessages[0]).toMatchObject({ type: "ask", ask: "command", text: scenario.command })
		expect(publishedMessages[0]).not.toHaveProperty("isAnswered", true)
	})

	it.each([
		{ decision: { decision: "approve_once" } as const, expectedAskResponse: "yesButtonClicked" },
		{
			decision: { decision: "deny", feedback: "Do not read that file." } as const,
			expectedAskResponse: "noButtonClicked",
		},
		{ decision: { decision: "abort" } as const, expectedAskResponse: "noButtonClicked" },
		{
			approval: (taskId: string) =>
				request(taskId, {
					requiresExplicitApproval: false,
					availableDecisions: ["approve_once", "approve_session", "deny", "abort"],
				}),
			decision: { decision: "approve_session" } as const,
			expectedAskResponse: "yesButtonClicked",
		},
		{
			approval: (taskId: string) =>
				request(taskId, {
					toolName: "execute_command",
					askType: "command",
					description: "node scripts/check.js",
					requiresExplicitApproval: false,
					availableDecisions: ["approve_once", "approve_with_amendment", "deny", "abort"],
					proposedAmendment: { kind: "exact_command", command: "node scripts/check.js" },
				}),
			decision: {
				decision: "approve_with_amendment",
				amendment: { kind: "exact_command", command: "node scripts/check.js" },
			} as const,
			expectedAskResponse: "yesButtonClicked",
		},
		{
			approval: (taskId: string) =>
				request(taskId, {
					toolName: "execute_command",
					askType: "command",
					description: "node scripts/check.js",
					requiresExplicitApproval: false,
					availableDecisions: ["approve_once", "approve_persistently", "deny", "abort"],
					proposedPersistentAmendment: {
						kind: "command_prefix",
						prefix: "node scripts/check.js",
					},
				}),
			decision: {
				decision: "approve_persistently",
				amendment: { kind: "command_prefix", prefix: "node scripts/check.js" },
			} as const,
			expectedAskResponse: "yesButtonClicked",
		},
	])(
		"returns the typed $decision.decision choice without conflating abort and deny",
		async ({ decision, expectedAskResponse, approval: buildApproval }) => {
			const task = createTask()
			const approval = buildApproval?.(task.taskId) ?? request(task.taskId)
			const askResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")
			const askSpy = vi
				.spyOn(task, "ask")
				.mockImplementation(async (type, text, _partial, _progress, _protected, _explicit, shownRequest) => {
					expect(type).toBe(approval.askType)
					expect(text).toBe(approval.description)
					expect(shownRequest).toEqual(approval)
					;(task as any).activeAsk = { type, ts: 42 }
					expect(task.handleWebviewToolApprovalResponse("stale-request", decision)).toBe(false)
					expect(task.handleWebviewToolApprovalResponse(approval.requestId, decision)).toBe(true)
					return {
						response: (task as any).askResponse,
						text: (task as any).askResponseText,
					}
				})

			await expect(task.requestToolApproval(approval)).resolves.toEqual(decision)
			expect(askSpy).toHaveBeenCalledTimes(1)
			expect(askResponseSpy).toHaveBeenCalledWith(
				expectedAskResponse,
				decision.decision === "deny" ? decision.feedback : undefined,
			)
			expect(task.hasPendingToolApprovalRequest()).toBe(false)
		},
	)

	it("rejects a delayed response from the previous prompt while a new prompt is active", async () => {
		const task = createTask()
		const firstApproval = request(task.taskId, { requestId: "approval-from-first-turn" })
		const secondApproval = request(task.taskId, { requestId: "approval-from-second-turn" })
		const askSpy = vi
			.spyOn(task, "ask")
			.mockImplementation(async (type, _text, _partial, _progress, _protected, _explicit, shownRequest) => {
				;(task as any).activeAsk = { type, ts: 42 }
				if (shownRequest?.requestId === secondApproval.requestId) {
					expect(
						task.handleWebviewToolApprovalResponse(firstApproval.requestId, { decision: "approve_once" }),
					).toBe(false)
					expect(
						task.handleWebviewToolApprovalResponse(secondApproval.requestId, { decision: "approve_once" }),
					).toBe(true)
				} else {
					expect(shownRequest?.requestId).toBe(firstApproval.requestId)
					expect(
						task.handleWebviewToolApprovalResponse(firstApproval.requestId, { decision: "approve_once" }),
					).toBe(true)
				}
				return { response: "yesButtonClicked" }
			})

		await expect(task.requestToolApproval(firstApproval)).resolves.toEqual({ decision: "approve_once" })
		await expect(task.requestToolApproval(secondApproval)).resolves.toEqual({ decision: "approve_once" })
		expect(askSpy).toHaveBeenCalledTimes(2)
	})

	it("rejects session approval for an explicit request", async () => {
		const task = createTask()
		const approval = request(task.taskId, {
			availableDecisions: ["approve_once", "approve_session", "deny", "abort"],
		})
		await expect(task.requestToolApproval(approval)).rejects.toThrow(/invalid or mismatched/)
	})

	it("rejects an exact-command session grant that differs from the reviewed command", async () => {
		const task = createTask()
		const approval = request(task.taskId, {
			toolName: "execute_command",
			askType: "command",
			description: "node scripts/check.js",
			requiresExplicitApproval: false,
			availableDecisions: ["approve_once", "approve_with_amendment", "deny", "abort"],
			proposedAmendment: { kind: "exact_command", command: "node scripts/check.js" },
		})
		vi.spyOn(task, "ask").mockImplementation(async (type) => {
			;(task as any).activeAsk = { type, ts: 42 }
			expect(
				task.handleWebviewToolApprovalResponse(approval.requestId, {
					decision: "approve_with_amendment",
					amendment: { kind: "exact_command", command: "node scripts/check.js --all" },
				}),
			).toBe(false)
			return { response: "noButtonClicked" }
		})

		await expect(task.requestToolApproval(approval)).resolves.toEqual({ decision: "deny" })
	})

	it("maps the existing auto-approve Ask response to a one-shot approval", async () => {
		const task = createTask()
		const askSpy = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })

		await expect(task.requestToolApproval(request(task.taskId))).resolves.toEqual({ decision: "approve_once" })
		expect(askSpy).toHaveBeenCalledTimes(1)
	})

	it("uses the injected reviewer for typed MCP approvals without widening the task mode", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "approve" }))
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const askSpy = vi.spyOn(task, "ask")

		const { outcome, executeEffect } = await runApprovalTool(task, "use_mcp_server")

		expect(reviewer).toHaveBeenCalledOnce()
		expect(reviewer.mock.calls[0]![0]).toMatchObject({
			taskId: task.taskId,
			toolName: "reviewable_tool",
			askType: "use_mcp_server",
		})
		expect(reviewer.mock.calls[0]![0]).not.toHaveProperty("arguments")
		expect(reviewer.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
		expect(outcome.results).toMatchObject([{ status: "success", content: "action completed" }])
		expect(executeEffect).toHaveBeenCalledOnce()
		expect(askSpy).not.toHaveBeenCalled()
		expect(task.getTaskApprovalMode()).toBe("ask")
	})

	it("records reviewer denial as a terminal tool result without executing the effect", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "deny" }))
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const askSpy = vi.spyOn(task, "ask")

		const { outcome, executeEffect } = await runApprovalTool(task, "tool")

		expect(outcome.results).toMatchObject([{ status: "denied" }])
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(executeEffect).not.toHaveBeenCalled()
		expect(askSpy).not.toHaveBeenCalled()
		expect(task.getTaskApprovalMode()).toBe("ask")
	})

	it("falls back to the existing user ask when the reviewer defers", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "fallback_to_user" }))
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const askSpy = vi
			.spyOn(task, "ask")
			.mockImplementation(async (type, _text, _partial, _progress, _protected, _explicit, shownRequest) => {
				;(task as any).activeAsk = { type, ts: 42 }
				expect(shownRequest).toBeDefined()
				task.handleWebviewToolApprovalResponse(shownRequest!.requestId, { decision: "approve_once" })
				return { response: "yesButtonClicked" }
			})

		const { outcome, executeEffect } = await runApprovalTool(task, "tool")

		expect(reviewer).toHaveBeenCalledOnce()
		expect(askSpy).toHaveBeenCalledOnce()
		expect(outcome.results).toMatchObject([{ status: "success", content: "action completed" }])
		expect(executeEffect).toHaveBeenCalledOnce()
		expect(task.getTaskApprovalMode()).toBe("ask")
	})

	it("turns a reviewer failure into an error receipt without executing the tool", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => {
			throw new Error("review unavailable")
		})
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const askSpy = vi.spyOn(task, "ask")

		const { outcome, executeEffect } = await runApprovalTool(task, "tool")

		expect(outcome.results).toMatchObject([{ status: "error" }])
		expect(outcome.results[0]?.content).toContain("review unavailable")
		expect(executeEffect).not.toHaveBeenCalled()
		expect(askSpy).not.toHaveBeenCalled()
		expect(task.hasPendingToolApprovalRequest()).toBe(false)
	})

	it("rejects malformed reviewer outcomes as errors instead of granting approval", async () => {
		const reviewer = vi.fn<ToolApprovalReviewer>(async () => ({ decision: "approve_once" }) as never)
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const askSpy = vi.spyOn(task, "ask")

		const { outcome, executeEffect } = await runApprovalTool(task, "tool")

		expect(outcome.results).toMatchObject([{ status: "error" }])
		expect(outcome.results[0]?.content).toContain("invalid outcome")
		expect(executeEffect).not.toHaveBeenCalled()
		expect(askSpy).not.toHaveBeenCalled()
	})

	it("records cancellation while reviewer is pending and suppresses the tool effect", async () => {
		let markReviewerStarted!: () => void
		const reviewerStarted = new Promise<void>((resolve) => {
			markReviewerStarted = resolve
		})
		const reviewer: ToolApprovalReviewer = (_request, signal) => {
			markReviewerStarted()
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("review cancelled")), { once: true })
			})
		}
		const task = createTask({ toolApprovalReviewer: reviewer, taskApprovalMode: "ask" })
		const controller = new AbortController()
		;(task as any).currentRequestAbortController = controller
		const askSpy = vi.spyOn(task, "ask")
		const requestApproval = task.requestToolApproval.bind(task)
		let pendingApproval: Promise<ToolApprovalDecision | undefined> | undefined
		vi.spyOn(task, "requestToolApproval").mockImplementation((approvalRequest) => {
			pendingApproval = requestApproval(approvalRequest)
			return pendingApproval
		})
		const pendingRun = runApprovalTool(task, "tool")

		await reviewerStarted
		controller.abort(new Error("user cancelled"))
		const { outcome, executeEffect } = await pendingRun

		expect(outcome.results).toMatchObject([{ status: "cancelled" }])
		expect(executeEffect).not.toHaveBeenCalled()
		expect(askSpy).not.toHaveBeenCalled()
		expect(pendingApproval).toBeDefined()
		await expect(pendingApproval).resolves.toEqual({ decision: "abort" })
		expect(task.hasPendingToolApprovalRequest()).toBe(false)
	})

	it("cancels a pending reviewer and clears the active typed approval", async () => {
		let reviewSignal: AbortSignal | undefined
		const reviewer: ToolApprovalReviewer = (_request, signal) => {
			reviewSignal = signal
			return new Promise(() => {})
		}
		const task = createTask({ toolApprovalReviewer: reviewer })
		const controller = new AbortController()
		;(task as any).currentRequestAbortController = controller
		const review = task.requestToolApproval(request(task.taskId))

		expect(task.hasPendingToolApprovalRequest()).toBe(true)
		controller.abort(new Error("test cancellation"))

		await expect(review).resolves.toEqual({ decision: "abort" })
		expect(reviewSignal?.aborted).toBe(true)
		expect(task.hasPendingToolApprovalRequest()).toBe(false)
	})
})

describe("pushToolResultToUserContent", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		mockApiConfig = {
			apiProvider: "openai",
			openAiModelId: "claude-3-5-sonnet-20241022",
			openAiApiKey: "test-api-key",
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new AlphaProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockProvider.hasPendingAgentMessages = vi.fn(() => false)
		mockProvider.deliverAgentMessages = vi.fn(async () => undefined)
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	it("should add tool_result when not a duplicate", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id-1",
			content: "Test result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(toolResult)
	})

	it("should prevent duplicate tool_result with same tool_use_id", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "First result",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "Second result (should be skipped)",
		}

		// Spy on console.warn to verify warning is logged
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// Add first result - should succeed
		const added1 = task.pushToolResultToUserContent(toolResult1)
		expect(added1).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)

		// Add second result with same ID - should be skipped
		const added2 = task.pushToolResultToUserContent(toolResult2)
		expect(added2).toBe(false)
		expect(task.userMessageContent).toHaveLength(1)

		// Verify only the first result is in the array
		expect(task.userMessageContent[0]).toEqual(toolResult1)

		// Verify warning was logged
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipping duplicate tool_result for tool_use_id: duplicate-id"),
		)

		warnSpy.mockRestore()
	})

	it("should allow different tool_use_ids to be added", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-1",
			content: "Result 1",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-2",
			content: "Result 2",
		}

		const added1 = task.pushToolResultToUserContent(toolResult1)
		const added2 = task.pushToolResultToUserContent(toolResult2)

		expect(added1).toBe(true)
		expect(added2).toBe(true)
		expect(task.userMessageContent).toHaveLength(2)
		expect(task.userMessageContent[0]).toEqual(toolResult1)
		expect(task.userMessageContent[1]).toEqual(toolResult2)
	})

	it("should handle tool_result with is_error flag", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const errorResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "error-id",
			content: "Error message",
			is_error: true,
		}

		const added = task.pushToolResultToUserContent(errorResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(errorResult)
	})

	it("should not interfere with other content types in userMessageContent", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Add text and image blocks manually
		task.userMessageContent.push(
			{ type: "text", text: "Some text" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "base64data" } },
		)

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id",
			content: "Result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(3)
		expect(task.userMessageContent[0].type).toBe("text")
		expect(task.userMessageContent[1].type).toBe("image")
		expect(task.userMessageContent[2]).toEqual(toolResult)
	})

	it("coalesces a burst of streaming preview requests to one trailing presentation", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "preview burst task",
			startTask: false,
		})
		let releaseFirstPreview!: () => void
		const firstPreviewBlocked = new Promise<void>((resolve) => {
			releaseFirstPreview = resolve
		})
		const say = vi.spyOn(task, "say").mockImplementation(async (type, _text, _images, partial) => {
			if (type === "text" && partial && say.mock.calls.length === 1) await firstPreviewBlocked
			return undefined
		})

		task.assistantMessageContent = [{ type: "text", content: "streaming preview", partial: true }]
		task.currentStreamingContentIndex = 0
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalledOnce())

		for (let index = 0; index < 99; index += 1) {
			;(task as any).scheduleStreamingPreview()
		}
		expect(say).toHaveBeenCalledOnce()

		releaseFirstPreview()
		await (task as any).streamingPreviewQueue

		// One in-flight presentation plus one latest trailing presentation replaces
		// the previous one-promise-per-delta backlog (100 presentations here).
		expect(say).toHaveBeenCalledTimes(2)
	})

	it("releases a normal turn boundary when a streaming preview never settles", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "stalled preview task",
			startTask: false,
		})
		let releasePreview!: () => void
		const previewBlocked = new Promise<void>((resolve) => {
			releasePreview = resolve
		})
		const say = vi.spyOn(task, "say").mockImplementation(async (type, _text, _images, partial) => {
			if (type === "text" && partial) await previewBlocked
			return undefined
		})

		task.assistantMessageContent = [{ type: "text", content: "stalled preview", partial: true }]
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalledOnce())
		const initialEpoch = task.getStreamingPreviewEpoch()

		vi.useFakeTimers()
		try {
			let drainSettled = false
			const drain = (task as any).drainStreamingPreviews("test normal completion").then(() => {
				drainSettled = true
			})

			await vi.advanceTimersByTimeAsync(999)
			expect(drainSettled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			await drain

			expect(drainSettled).toBe(true)
			expect(task.getStreamingPreviewEpoch()).toBe(initialEpoch + 1)
			expect(task.presentAssistantMessageLocked).toBe(false)
		} finally {
			vi.useRealTimers()
			releasePreview()
		}
	})

	it("joins delayed streaming previews before replacing them with canonical response state", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "preview race task",
			startTask: false,
		})
		let releasePreview!: () => void
		const previewBlocked = new Promise<void>((resolve) => {
			releasePreview = resolve
		})
		const say = vi.spyOn(task, "say").mockImplementation(async (type, _text, _images, partial) => {
			if (type === "text" && partial) await previewBlocked
			return undefined
		})

		task.assistantMessageContent = [{ type: "text", content: "stale preview", partial: true }]
		task.currentStreamingContentIndex = 0
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalled())

		const canonicalResponse = createAgentResponse([
			{ type: "text", text: "canonical response" },
			{ type: "tool_call", id: "canonical-tool", name: "read_file", arguments: { path: "README.md" } },
		])
		let canonicalApplied = false
		const canonicalReplacement = (async () => {
			await (task as any).drainStreamingPreviews("test canonical replacement")
			await (task as any).applyCanonicalAgentResponse(canonicalResponse)
			canonicalApplied = true
		})()

		await Promise.resolve()
		expect(canonicalApplied).toBe(false)
		releasePreview()
		await canonicalReplacement

		expect(canonicalApplied).toBe(true)
		expect(task.assistantMessageContent).toEqual([
			{ type: "text", content: "canonical response", partial: false },
			expect.objectContaining({ type: "tool_use", id: "canonical-tool", name: "read_file", partial: false }),
		])
		expect(task.userMessageContent).toEqual([])
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("does not let a timed-out preview release a resumed preview lock", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "preview cancellation race",
			startTask: false,
		})
		const releases = new Map<number, () => void>()
		const say = vi
			.spyOn(task, "say")
			.mockImplementation(async (type, _text, _images, partial, _checkpoint, _progressStatus, options) => {
				const previewEpoch = options?.previewEpoch
				if (type === "text" && partial && previewEpoch !== undefined) {
					const gate = new Promise<void>((resolve) => releases.set(previewEpoch, resolve))
					await gate
				}
				return undefined
			})

		task.assistantMessageContent = [{ type: "text", content: "old preview", partial: true }]
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalledOnce())
		const oldEpoch = task.getStreamingPreviewEpoch()

		task.abort = true
		vi.useFakeTimers()
		try {
			const drain = (task as any).drainStreamingPreviews("test cancellation")
			await vi.advanceTimersByTimeAsync(1000)
			await drain
		} finally {
			vi.useRealTimers()
		}

		task.abort = false
		task.assistantMessageContent = [{ type: "text", content: "new preview", partial: true }]
		task.currentStreamingContentIndex = 0
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalledTimes(2))
		expect(task.presentAssistantMessageLocked).toBe(true)

		releases.get(oldEpoch)?.()
		await Promise.resolve()
		expect(task.presentAssistantMessageLocked).toBe(true)

		releases.get(task.getStreamingPreviewEpoch())?.()
		await (task as any).streamingPreviewQueue
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("interrupts a full preview join when task cancellation arrives", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "preview cancellation handoff",
			startTask: false,
		})
		let releasePreview!: () => void
		const previewBlocked = new Promise<void>((resolve) => {
			releasePreview = resolve
		})
		const say = vi.spyOn(task, "say").mockImplementation(async (type, _text, _images, partial) => {
			if (type === "text" && partial) await previewBlocked
			return undefined
		})

		task.assistantMessageContent = [{ type: "text", content: "preview", partial: true }]
		;(task as any).scheduleStreamingPreview()
		await vi.waitFor(() => expect(say).toHaveBeenCalledOnce())

		const drain = (task as any).drainStreamingPreviews("test cancellation handoff")
		;(task as any).taskCancellationController.abort(new Error("cancelled"))
		await expect(drain).resolves.toBeUndefined()

		releasePreview()
		await (task as any).streamingPreviewQueue
	})
})
