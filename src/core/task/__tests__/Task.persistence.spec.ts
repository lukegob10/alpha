// cd src && npx vitest run core/task/__tests__/Task.persistence.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
	agentLifecycleEventSchema,
	type AgentLifecycleEvent,
	type AgentLifecycleSnapshot,
	type GlobalState,
	type HistoryItem,
	type ProviderSettings,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task } from "../Task"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../../agent/lifecycle/reducer"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { createAgentResponse } from "../../agent/AgentResponse"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { getToolBatchIsolationError } from "../../agent/ToolScheduler"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { formatResponse } from "../../prompts/responses"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { EnvironmentContext, type EnvironmentCapture } from "../../environment/EnvironmentContext"
import type { Anthropic } from "@anthropic-ai/sdk"

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockPWaitFor,
	mockRealpath,
	mockLstat,
	mockOpendir,
	mockListFiles,
	MockProviderTranscriptStore,
	MockProviderTranscriptStoreError,
	MockProviderTranscriptRevisionConflictError,
} = vi.hoisted(() => ({
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
	mockTaskMetadata: vi.fn().mockResolvedValue({
		historyItem: { id: "test-id", ts: Date.now(), task: "test" },
		tokenUsage: {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		},
	}),
	mockPWaitFor: vi.fn().mockResolvedValue(undefined),
	mockRealpath: vi.fn(),
	mockLstat: vi.fn(),
	mockOpendir: vi.fn(),
	mockListFiles: vi.fn(),
	MockProviderTranscriptStoreError: class MockProviderTranscriptStoreError extends Error {
		code: string
		taskId = "test-id"
		constructor(code: string, message?: string) {
			super(message ?? code)
			this.code = message ? code : "write_failed"
		}
	},
	MockProviderTranscriptRevisionConflictError: class MockProviderTranscriptRevisionConflictError extends Error {
		code = "revision_conflict"
		taskId = "test-id"
	},
	MockProviderTranscriptStore: vi.fn().mockImplementation((taskId: string) => ({
		read: vi.fn().mockResolvedValue({
			version: 1,
			taskId,
			revision: 0,
			digest: "0".repeat(64),
			writtenAt: 0,
			messages: [],
		}),
		getLastCommitReceipt: vi.fn(),
		commitAuthoritativeTranscript: vi.fn().mockResolvedValue({
			version: 1,
			taskId,
			revision: 1,
			digest: "0".repeat(64),
			writtenAt: 1,
		}),
		verifyCommitReceipt: vi.fn().mockResolvedValue(undefined),
		assertCommitReceipt: vi.fn().mockResolvedValue(undefined),
		repairFromAuthoritativeTranscript: vi.fn().mockResolvedValue({
			version: 1,
			taskId,
			revision: 1,
			digest: "1".repeat(64),
			writtenAt: 1,
		}),
	})),
}))

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("../../../services/glob/list-files", async (importOriginal) => ({
	...(await importOriginal()),
	listFiles: mockListFiles,
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		realpath: mockRealpath,
		lstat: mockLstat,
		opendir: mockOpendir,
		default: {
			mkdir: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue("[]"),
			unlink: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
			realpath: mockRealpath,
			lstat: mockLstat,
			opendir: mockOpendir,
		},
	}
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("../../task-persistence", () => ({
	saveApiMessages: mockSaveApiMessages,
	saveTaskMessages: mockSaveTaskMessages,
	readApiMessages: mockReadApiMessages,
	readTaskMessages: mockReadTaskMessages,
	taskMetadata: mockTaskMetadata,
	TaskHistoryStore: vi.fn().mockImplementation(() => ({
		initialize: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
		get: vi.fn(),
		getAll: vi.fn().mockReturnValue([]),
		upsert: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		deleteMany: vi.fn().mockResolvedValue(undefined),
		reconcile: vi.fn().mockResolvedValue(undefined),
		initialized: Promise.resolve(),
	})),
}))

// Task persistence tests replace the filesystem with narrow write/read mocks.
// Keep the sidecar boundary explicit without making proper-lockfile retries
// part of these legacy-history unit tests; the real store is covered by its
// dedicated restart/CAS/digest suite.
vi.mock("../../task-persistence/ProviderTranscriptStore", () => ({
	ProviderTranscriptStore: MockProviderTranscriptStore,
	ProviderTranscriptStoreError: MockProviderTranscriptStoreError,
	ProviderTranscriptRevisionConflictError: MockProviderTranscriptRevisionConflictError,
	digestProviderTranscript: vi.fn(() => "0".repeat(64)),
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
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
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
	const actual = (await importOriginal()) as Record<string, unknown>
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

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

function createReadFileSurface(execute: ToolDescriptor["execute"]) {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const descriptor: ToolDescriptor = {
		name: "read_file",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a test file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
			},
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		execute,
	}
	registry.register(descriptor)
	return createTaskToolSurface({
		registry,
		schemas: [descriptor.schema],
		visibleToolNames: [descriptor.name],
		allowedToolNames: [descriptor.name],
		mode: "code",
	})
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Task persistence", () => {
	let mockProvider: AlphaProvider & Record<string, any>
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
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
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = new AlphaProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as AlphaProvider & Record<string, any>

		mockApiConfig = {
			apiProvider: "openai",
			openAiModelId: "claude-3-5-sonnet-20241022",
			openAiApiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		// Canonical tool progress only needs the provider's captured verification
		// state at this unit boundary; the real ledger is covered by its own suite.
		mockProvider.getVerificationProgressState = vi.fn(() => ({ stateFingerprint: "task-persistence-fixture" }))
	})

	it("does not overwrite an answered card when a historical task closes before its UI transcript loads", async () => {
		const savedCard = {
			ts: 42,
			type: "say" as const,
			say: "async_user_input" as const,
			asyncUserInput: { questions: [{ title: "Which color?", options: ["Blue", "Green"] }] },
			isAnswered: true,
		}
		let persistedMessages = [savedCard]
		let releaseRead!: () => void
		let signalReadStarted!: () => void
		const readHeld = new Promise<void>((resolve) => {
			releaseRead = resolve
		})
		const readStarted = new Promise<void>((resolve) => {
			signalReadStarted = resolve
		})
		mockReadTaskMessages.mockImplementation(async () => {
			signalReadStarted()
			await readHeld
			return structuredClone(persistedMessages)
		})
		mockSaveTaskMessages.mockImplementation(async ({ messages }) => {
			persistedMessages = structuredClone(messages)
		})

		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			historyItem: {
				id: "answered-card",
				number: 1,
				ts: 1,
				task: "Saved questions",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
			startTask: false,
		})
		const resume = (task as any).resumeTaskFromHistory()
		await readStarted
		expect(task.clineMessages).toEqual([])

		await task.abortTask()
		releaseRead()
		await resume

		expect(mockSaveTaskMessages).not.toHaveBeenCalled()
		expect(persistedMessages).toEqual([savedCard])
	})

	// ── saveApiConversationHistory (via retrySaveApiConversationHistory) ──

	it.each(["ask", "debug", "orchestrator", "custom-mode"])(
		"restores historical %s tasks in Plan without rewriting the input record",
		async (mode) => {
			const historyItem: HistoryItem = {
				id: "retired-mode",
				number: 1,
				ts: 1,
				task: "Saved work",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode,
			}
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem,
				startTask: false,
			})
			expect(await task.getTaskMode()).toBe("architect")
			expect(historyItem.mode).toBe(mode)
			expect(() => task.setTaskMode(mode)).toThrow("Unsupported mode")
			expect(await task.getTaskMode()).toBe("architect")
		},
	)

	it("persists task-scoped approval changes and restores them instead of the current default", async () => {
		const historyItem: HistoryItem = {
			id: "approval-mode-history",
			number: 1,
			ts: 1,
			task: "Persist an approval-mode change",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			approvalMode: "ask",
		}
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			taskId: historyItem.id,
			task: historyItem.task,
			taskApiConfigName: "test-profile",
			taskApprovalMode: "ask",
			startTask: false,
		})
		mockTaskMetadata.mockResolvedValueOnce({
			historyItem: { ...historyItem, approvalMode: "auto" },
			tokenUsage: {
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: 0,
				totalCacheReads: 0,
				totalCost: 0,
				contextTokens: 0,
			},
		})

		expect(task.getTaskApprovalMode()).toBe("ask")
		expect(task.setTaskApprovalMode("auto")).toBe(true)
		await (task as unknown as { taskApprovalModePersistence: Promise<boolean> }).taskApprovalModePersistence

		expect(mockTaskMetadata).toHaveBeenCalledWith(expect.objectContaining({ approvalMode: "auto" }))
		const savedHistoryItem = vi.mocked(mockProvider.updateTaskHistory).mock.calls.at(-1)?.[0]
		expect(savedHistoryItem?.approvalMode).toBe("auto")

		const restoredTask = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			historyItem: savedHistoryItem!,
			startTask: false,
		})
		expect(restoredTask.getTaskApprovalMode()).toBe("auto")
	})

	it("restores task constraints and skill identities while invalidating interrupted checks", async () => {
		const historyItem: HistoryItem = {
			id: "saved-work-context",
			number: 1,
			ts: 1,
			task: "Saved work",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workContext: {
				plan: {
					objective: "Finish the workflow",
					constraints: ["Preserve source inputs"],
					notes: ["artifact: output.txt"],
					checks: [
						{
							id: "behavior",
							description: "Check behavior",
							command: "node check.js",
							cwd: null,
							paths: ["check.js"],
							reusable: true,
						},
					],
				},
				receipts: [
					{
						checkId: "behavior",
						definitionDigest: "digest",
						executionId: "interrupted",
						status: "running",
						observedAt: 1,
					},
				],
				skills: [{ name: "workflow", path: "/skills/workflow/SKILL.md", digest: "instructions" }],
			},
		}
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			historyItem,
			startTask: false,
		})
		expect(task.workContext?.plan).toEqual(historyItem.workContext?.plan)
		expect(task.workContext?.skills).toEqual(historyItem.workContext?.skills)
		expect(task.workContext?.receipts[0].status).toBe("stale")
		expect(historyItem.workContext?.receipts[0].status).toBe("running")
	})

	it("persists the inline synopsis alongside its full reasoning without changing provider history", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test",
			startTask: false,
		})
		const message = {
			ts: 1,
			type: "say" as const,
			say: "reasoning" as const,
			text: "Complete source reasoning.",
			reasoningSummary: "Checking implementation against the docs.",
			reasoningSummaryUsage: { tokensIn: 10, tokensOut: 5, cacheWrites: 0, cacheReads: 0, cost: 0.01 },
		}
		await task.overwriteAlphaMessages([message])
		expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ messages: [message] }))
		expect(task.apiConversationHistory).toEqual([])
		expect(mockSaveApiMessages).not.toHaveBeenCalled()
	})

	it("persists ordered signed Anthropic thinking blocks without prepending the legacy aggregate", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "anthropic ordered history",
			startTask: false,
		})
		task.apiConfiguration = { ...mockApiConfig, apiProvider: "vertex", apiModelId: "claude-sonnet-4" }
		const response = createAgentResponse([
			{ type: "text", text: "Before." },
			{ type: "reasoning", text: "First " },
			{ type: "reasoning", text: "block.", signature: "first-signature" },
			{ type: "tool_call", id: "read-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "reasoning", text: "Second block.", signature: "second-signature" },
			{ type: "text", text: "After." },
		])
		;(task as any).api = { getThoughtSignature: () => "legacy-aggregate-signature" }

		const persisted = await (task as any).persistAssistantResponseBeforeEffects(
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Before." },
					{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "a.ts" } },
					{ type: "text", text: "After." },
				],
			},
			response.reasoning,
			response,
		)

		expect(persisted).toBe(true)
		expect(task.apiConversationHistory.at(-1)?.content).toEqual([
			{ type: "text", text: "Before." },
			{ type: "thinking", thinking: "First block.", signature: "first-signature" },
			{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "thinking", thinking: "Second block.", signature: "second-signature" },
			{ type: "text", text: "After." },
		])
	})

	it("persists adjacent completed reasoning blocks without combining their signed payloads", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "adjacent signed reasoning",
			startTask: false,
		})
		task.apiConfiguration = { ...mockApiConfig, apiProvider: "vertex", apiModelId: "claude-sonnet-4" }
		;(task as any).api = { getThoughtSignature: () => "legacy-aggregate-signature" }
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "reasoning", text: "First block." })
		await accumulator.add({ type: "thinking_complete", signature: "first-signature" })
		await accumulator.add({ type: "reasoning", text: "Second " })
		await accumulator.add({ type: "reasoning", text: "block." })
		await accumulator.add({ type: "thinking_complete", signature: "second-signature" })
		await accumulator.add({ type: "text", text: "Answer." })
		const response = await accumulator.finish()

		expect(
			await (task as any).persistAssistantResponseBeforeEffects(
				{ role: "assistant", content: [{ type: "text", text: "Answer." }] },
				response.reasoning,
				response,
			),
		).toBe(true)
		const savedMessages = mockSaveApiMessages.mock.calls.at(-1)?.[0].messages
		expect(JSON.parse(JSON.stringify(savedMessages)).at(-1).content).toEqual([
			{ type: "thinking", thinking: "First block.", signature: "first-signature" },
			{ type: "thinking", thinking: "Second block.", signature: "second-signature" },
			{ type: "text", text: "Answer." },
		])
	})

	it("uses ordered Anthropic thinking for terminal responses and retains other provider metadata fallbacks", async () => {
		const anthropicTask = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "anthropic terminal history",
			startTask: false,
		})
		anthropicTask.apiConfiguration = {
			...mockApiConfig,
			apiProvider: "vertex",
			apiModelId: "claude-sonnet-4",
		}
		const terminalResponse = createAgentResponse(
			[
				{ type: "text", text: "Before." },
				{ type: "reasoning", text: "Reasoned result.", signature: "terminal-signature" },
				{ type: "text", text: "After." },
			],
			{ status: "failed", reason: "provider failure" },
		)
		;(anthropicTask as any).api = { getThoughtSignature: () => "legacy-aggregate-signature" }

		const terminal = await (anthropicTask as any).persistTerminalCanonicalResponse(
			terminalResponse,
			"failed",
			"provider failure",
		)

		expect(terminal.assistantPersisted).toBe(true)
		expect(anthropicTask.apiConversationHistory.at(-1)?.content).toEqual([
			{ type: "text", text: "Before." },
			{ type: "thinking", thinking: "Reasoned result.", signature: "terminal-signature" },
			{ type: "text", text: "After." },
		])

		const openAiTask = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "other provider metadata",
			startTask: false,
		})
		const openAiResponse = createAgentResponse([
			{ type: "reasoning", text: "Reasoning summary.", signature: "provider-signature" },
			{ type: "text", text: "Answer." },
		])
		;(openAiTask as any).api = {
			getEncryptedContent: () => ({ encrypted_content: "encrypted-reasoning", id: "reasoning-id" }),
			getThoughtSignature: () => "provider-signature",
			getReasoningDetails: () => [{ type: "summary", text: "provider detail" }],
			getStatefulMarker: () => "vscode-state",
		}
		const openAiSaved = await (openAiTask as any).persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: [{ type: "text", text: "Answer." }] },
			openAiResponse.reasoning,
			openAiResponse,
		)

		expect(openAiSaved).toBe(true)
		expect(openAiTask.apiConversationHistory.at(-1)).toMatchObject({
			vscodeLmStatefulMarker: "vscode-state",
			reasoning_details: [{ type: "summary", text: "provider detail" }],
			content: [
				{ type: "reasoning", encrypted_content: "encrypted-reasoning", id: "reasoning-id" },
				{ type: "text", text: "Answer." },
				{ type: "thoughtSignature", thoughtSignature: "provider-signature" },
			],
		})
	})

	it("persists and replays every encrypted OpenAI Responses reasoning item in order", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: { ...mockApiConfig, openAiModelId: "gpt-6-sol" },
			task: "preserve provider reasoning",
			startTask: false,
		})
		const reasoningItems = [
			{
				id: "reasoning-1",
				encrypted_content: "opaque-1",
				summary: [{ type: "summary_text", text: "First thought" }],
			},
			{
				id: "reasoning-2",
				encrypted_content: "opaque-2",
				summary: [{ type: "summary_text", text: "Second thought" }],
			},
		]
		Object.assign(task.api, { getReasoningItems: () => reasoningItems })
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		const response = createAgentResponse([{ type: "text", text: "Answer." }])
		await (task as any).persistAssistantResponseBeforeEffects(
			{ role: "assistant", content: [{ type: "text", text: "Answer." }] },
			undefined,
			response,
		)

		expect(task.apiConversationHistory.at(-1)?.content).toEqual([
			{ type: "reasoning", ...reasoningItems[0] },
			{ type: "reasoning", ...reasoningItems[1] },
			{ type: "text", text: "Answer." },
		])
		const cleanHistory = (task as any).buildCleanConversationHistory(task.apiConversationHistory)
		expect(cleanHistory).toEqual([
			{ type: "reasoning", ...reasoningItems[0] },
			{ type: "reasoning", ...reasoningItems[1] },
			{ role: "assistant", content: "Answer." },
		])
		expect(buildOpenAiResponsesInput("", undefined, cleanHistory, false)).toEqual([
			{ type: "reasoning", encrypted_content: "opaque-1", summary: reasoningItems[0].summary },
			{ type: "reasoning", encrypted_content: "opaque-2", summary: reasoningItems[1].summary },
			{ role: "assistant", content: "Answer." },
		])
		expect(buildOpenAiResponsesInput("", undefined, cleanHistory, true)).toEqual([
			{ type: "reasoning", ...reasoningItems[0] },
			{ type: "reasoning", ...reasoningItems[1] },
			{ role: "assistant", content: "Answer." },
		])
	})

	it("replays encrypted reasoning between assistant output items in provider order", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: { ...mockApiConfig, openAiModelId: "gpt-6-sol" },
			task: "interleaved provider reasoning",
			startTask: false,
		})
		const firstReasoning = { type: "reasoning", id: "r1", encrypted_content: "opaque-1", summary: [] }
		const secondReasoning = { type: "reasoning", id: "r2", encrypted_content: "opaque-2", summary: [] }
		const toolUse = { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }
		task.apiConversationHistory = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Before." },
					firstReasoning,
					toolUse,
					secondReasoning,
					{ type: "text", text: "After." },
				],
				ts: 1,
			} as any,
		]

		const cleanHistory = (task as any).buildCleanConversationHistory(task.apiConversationHistory)
		expect(buildOpenAiResponsesInput("", undefined, cleanHistory, false)).toEqual([
			{ role: "assistant", content: "Before." },
			{ type: "reasoning", encrypted_content: "opaque-1", summary: [] },
			{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
			{ type: "reasoning", encrypted_content: "opaque-2", summary: [] },
			{ role: "assistant", content: "After." },
		])
	})

	describe("environment delivery fence", () => {
		function createEnvironmentTask() {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "environment",
				startTask: false,
			})
			const internal = task as unknown as {
				persistUserContentWithEnvironment(
					content: Anthropic.Messages.ContentBlockParam[],
					capture?: EnvironmentCapture,
					signal?: AbortSignal,
					onPersisted?: () => void,
					hookPrompt?: { event: "Stop" | "SubagentStop"; fragments: { hook_run_id: string; text: string }[] },
				): Promise<void>
				refreshEnvironmentContext(state?: undefined, signal?: AbortSignal): Promise<void>
				saveApiConversationHistory(): Promise<boolean>
				settleAllPersistedWaitAgentResultClaims(): Promise<void>
				environmentContext: EnvironmentContext
			}
			const capture = {
				details: "<environment_details>A</environment_details>",
				commit: vi.fn(),
				release: vi.fn(),
			}
			return { task, internal, capture, content: [{ type: "text" as const, text: capture.details }] }
		}

		it("attaches structured hook provenance to the persisted continuation without sending it to the provider", async () => {
			const { task, internal } = createEnvironmentTask()
			const provenance = {
				event: "Stop" as const,
				fragments: [{ hook_run_id: "hook-run-1", text: "Check the tests." }],
			}
			await internal.persistUserContentWithEnvironment(
				[{ type: "text", text: "Check the tests." }],
				undefined,
				undefined,
				undefined,
				provenance,
			)
			expect(task.apiConversationHistory.at(-1)?.hook_prompt).toEqual(provenance)
			const clean = (task as any).buildCleanConversationHistory(task.apiConversationHistory)
			expect(clean.at(-1)).not.toHaveProperty("hook_prompt")
		})

		it.each([false, true])(
			"acknowledges a durable event before later mailbox failure (save retry: %s)",
			async (retry) => {
				const { task, internal, capture, content } = createEnvironmentTask()
				const save = vi.spyOn(internal, "saveApiConversationHistory").mockResolvedValue(true)
				if (retry) save.mockResolvedValueOnce(false)
				vi.spyOn(internal, "settleAllPersistedWaitAgentResultClaims").mockRejectedValue(
					new Error("mailbox failed"),
				)
				await expect(internal.persistUserContentWithEnvironment(content, capture)).rejects.toThrow(
					"mailbox failed",
				)
				expect(capture.commit).toHaveBeenCalledOnce()
				expect(task.apiConversationHistory.at(-1)?.content).toEqual(content)
			},
		)

		it("rolls back only the staged identity on failed save and leaves events unread", async () => {
			const { task, internal, capture, content } = createEnvironmentTask()
			const before = { role: "user" as const, content: "before", ts: 1 }
			const later = { role: "user" as const, content: "unrelated later message", ts: 3 }
			task.apiConversationHistory = [before]
			let finishSave!: (saved: boolean) => void
			vi.spyOn(internal, "saveApiConversationHistory").mockImplementation(
				() =>
					new Promise((resolve) => {
						finishSave = resolve
					}),
			)
			vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
			const saving = internal.persistUserContentWithEnvironment(content, capture)
			task.apiConversationHistory.push(later)
			finishSave(false)
			await expect(saving).rejects.toThrow("Failed to persist")
			expect(task.apiConversationHistory).toEqual([before, later])
			expect(capture.commit).not.toHaveBeenCalled()
			expect(capture.release).toHaveBeenCalledOnce()
		})

		it("releases a cancelled capture before any save begins", async () => {
			const { internal, capture, content } = createEnvironmentTask()
			const save = vi.spyOn(internal, "saveApiConversationHistory")
			const controller = new AbortController()
			controller.abort(new Error("cancelled"))
			await expect(
				internal.persistUserContentWithEnvironment(content, capture, controller.signal),
			).rejects.toThrow("cancelled")
			expect(save).not.toHaveBeenCalled()
			expect(capture.commit).not.toHaveBeenCalled()
			expect(capture.release).toHaveBeenCalledOnce()
		})

		it("acknowledges a save that becomes durable during cancellation", async () => {
			const { task, internal, capture, content } = createEnvironmentTask()
			const controller = new AbortController()
			let finishSave!: (saved: boolean) => void
			vi.spyOn(internal, "saveApiConversationHistory").mockImplementation(
				() =>
					new Promise((resolve) => {
						finishSave = resolve
					}),
			)
			const saving = internal.persistUserContentWithEnvironment(content, capture, controller.signal)
			controller.abort()
			finishSave(true)
			await saving
			expect(capture.commit).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory.at(-1)?.content).toEqual(content)
		})

		it("preserves the exact retained message when adding a baseline, and rolls back a failed refresh", async () => {
			const { task, internal, capture } = createEnvironmentTask()
			const previous = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "previous terminal output" }],
				ts: 1,
			}
			task.apiConversationHistory = [previous]
			vi.mocked(captureEnvironmentDetails).mockResolvedValueOnce(capture)
			const save = vi.spyOn(internal, "saveApiConversationHistory").mockResolvedValue(false)
			vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)
			await expect(internal.refreshEnvironmentContext()).rejects.toThrow("persist")
			expect(task.apiConversationHistory[0]).toBe(previous)
			expect(task.apiConversationHistory).toHaveLength(1)
			expect(capture.commit).not.toHaveBeenCalled()
			vi.mocked(captureEnvironmentDetails).mockResolvedValueOnce(capture)
			save.mockResolvedValue(true)
			await internal.refreshEnvironmentContext()
			expect(capture.commit).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory[0]).toBe(previous)
			expect(task.apiConversationHistory[0].content).toEqual(previous.content)
			expect(task.apiConversationHistory).toHaveLength(2)
			expect(task.apiConversationHistory[1]).toMatchObject({
				role: "user",
				content: [{ type: "text", text: capture.details }],
			})
		})

		it("requires a full environment snapshot after same-instance rewind removes its baseline", async () => {
			const { task, internal } = createEnvironmentTask()
			const fields = [{ name: "Workspace", value: "original workspace facts" }]
			const baseline = internal.environmentContext.prepare("same-task", fields, "", [])
			baseline.commit()
			task.apiConversationHistory = [
				{ role: "user", content: "original task", ts: 1 },
				{ role: "assistant", content: "investigation", ts: 2 },
				{ role: "user", content: baseline.details, ts: 3 },
			]
			task.clineMessages = [
				{ type: "say", say: "text", text: "original task", ts: 1 },
				{ type: "say", say: "user_feedback", text: "edit this turn", ts: 3 },
			]
			vi.spyOn(internal, "saveApiConversationHistory").mockResolvedValue(true)
			expect(internal.environmentContext.prepare("same-task", fields, "", []).details).toBe("")

			await task.messageManager.rewindToTimestamp(3, { skipCleanup: true })

			expect(task.apiConversationHistory.map((message) => message.ts)).toEqual([1, 2])
			const nextCapture = internal.environmentContext.prepare("same-task", fields, "", [])
			expect(nextCapture.details).toContain("# Environment Snapshot")
			expect(nextCapture.details).toContain("original workspace facts")
			nextCapture.release()
		})

		it.each([true, false])("invalidates rewritten history before its save settles (saved: %s)", async (saved) => {
			const { task, internal } = createEnvironmentTask()
			const fields = [{ name: "Workspace", value: "original facts" }]
			const cursor = { terminalId: 7, processIndex: 2 }
			internal.environmentContext.prepare("same-task", fields, "", [], [], cursor).commit()
			const staleCapture = internal.environmentContext.prepare("same-task", fields, "", [])
			const rewritten = [{ role: "user" as const, content: "rewound task", ts: 1 }]
			let finishSave!: (value: boolean) => void
			vi.spyOn(internal, "saveApiConversationHistory").mockImplementation(
				() => new Promise<boolean>((resolve) => (finishSave = resolve)),
			)

			const rewriting = task.overwriteApiConversationHistory(rewritten)
			expect(internal.environmentContext.needsFullSnapshot).toBe(true)
			staleCapture.commit()
			expect(internal.environmentContext.needsFullSnapshot).toBe(true)
			expect(internal.environmentContext.terminalOutputCursor).toEqual(cursor)
			finishSave(saved)
			await expect(rewriting).resolves.toBe(saved)
			expect(task.apiConversationHistory).toBe(rewritten)
			expect(internal.environmentContext.prepare("same-task", fields, "", []).details).toContain(
				"# Environment Snapshot",
			)
		})

		it("retains the full-snapshot requirement when a rewritten history save rejects", async () => {
			const { task, internal } = createEnvironmentTask()
			const fields = [{ name: "Workspace", value: "original facts" }]
			internal.environmentContext.prepare("same-task", fields, "", []).commit()
			vi.spyOn(internal, "saveApiConversationHistory").mockRejectedValue(new Error("save failed"))

			await expect(task.overwriteApiConversationHistory([])).rejects.toThrow("save failed")

			expect(task.apiConversationHistory).toEqual([])
			expect(internal.environmentContext.prepare("same-task", fields, "", []).details).toContain(
				"# Environment Snapshot",
			)
		})
	})

	describe("saveApiConversationHistory", () => {
		it("returns true on success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			})

			const result = await task.retrySaveApiConversationHistory()
			expect(result).toBe(true)
		})

		it("does not advance the sidecar when the authoritative legacy write fails", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockRejectedValue(new Error("legacy history unavailable"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const store = MockProviderTranscriptStore.mock.results.at(-1)?.value as {
				commitAuthoritativeTranscript: ReturnType<typeof vi.fn>
			}

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()

			expect(await promise).toBe(false)
			expect(store.commitAuthoritativeTranscript).not.toHaveBeenCalled()
			vi.useRealTimers()
		})

		it("reports false when the sidecar fails after legacy history is durable", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockResolvedValue(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const store = MockProviderTranscriptStore.mock.results.at(-1)?.value as {
				commitAuthoritativeTranscript: ReturnType<typeof vi.fn>
			}
			store.commitAuthoritativeTranscript.mockRejectedValue(
				new MockProviderTranscriptStoreError("sidecar unavailable"),
			)

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()

			expect(await promise).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)
			expect(store.commitAuthoritativeTranscript).toHaveBeenCalledTimes(3)
			vi.useRealTimers()
		})

		it("returns false on failure", async () => {
			vi.useFakeTimers()

			// All 3 retry attempts must fail for retrySaveApiConversationHistory to return false
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockRejectedValueOnce(new Error("fail 3"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)

			vi.useRealTimers()
		})

		it("succeeds on 2nd retry attempt", async () => {
			vi.useFakeTimers()

			mockSaveApiMessages.mockRejectedValueOnce(new Error("fail 1")).mockResolvedValueOnce(undefined) // succeeds on 2nd try

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)

			vi.useRealTimers()
		})

		it("snapshots the array before passing to saveApiMessages", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const originalMsg = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "snapshot test" }],
			}
			task.apiConversationHistory.push(originalMsg)

			await task.retrySaveApiConversationHistory()

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveApiMessages.mock.calls[0][0]
			// The messages passed should be a COPY, not the live reference
			expect(callArgs.messages).not.toBe(task.apiConversationHistory)
			// But the content should be the same
			expect(callArgs.messages).toEqual(task.apiConversationHistory)
		})

		it("serializes replacement instances so an older delayed save cannot land after the replacement", async () => {
			let releaseOldWrite!: () => void
			const oldWrite = new Promise<void>((resolve) => (releaseOldWrite = resolve))
			const persistedSnapshots: any[][] = []
			mockSaveApiMessages.mockImplementationOnce(async ({ messages }: { messages: any[] }) => {
				persistedSnapshots.push(messages)
				await oldWrite
			})
			mockSaveApiMessages.mockImplementationOnce(async ({ messages }: { messages: any[] }) => {
				persistedSnapshots.push(messages)
			})

			const oldTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				taskId: "replacement-race",
				startTask: false,
			})
			oldTask.apiConversationHistory = [{ role: "user", content: "old snapshot" } as any]
			const oldSave = (oldTask as Record<string, any>).saveApiConversationHistory()
			await vi.waitFor(() => expect(mockSaveApiMessages).toHaveBeenCalledTimes(1))

			const replacementTask = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				taskId: "replacement-race",
				startTask: false,
			})
			replacementTask.apiConversationHistory = [{ role: "user", content: "replacement snapshot" } as any]
			const replacementSave = (replacementTask as Record<string, any>).saveApiConversationHistory()

			// The replacement is queued behind the in-flight old write; it must not
			// bypass the queue or allow the old snapshot to become the final state.
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			releaseOldWrite()
			await Promise.all([oldSave, replacementSave])

			expect(persistedSnapshots).toHaveLength(2)
			expect(persistedSnapshots[0]).toEqual([{ role: "user", content: "old snapshot" }])
			expect(persistedSnapshots[1]).toEqual([{ role: "user", content: "replacement snapshot" }])
		})
	})

	describe("bounded transcript finalization", () => {
		const createTask = () =>
			new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "bounded persistence",
				startTask: false,
			})

		it("loads nonempty history for hydration without a sidecar backfill write", async () => {
			const task = createTask()
			const messages = [{ role: "user", content: "durable original" }]
			mockReadApiMessages.mockResolvedValueOnce(messages)
			const reconcile = vi.spyOn(task as any, "reconcileProviderTranscriptSidecar")
			expect(await (task as any).getSavedApiConversationHistory({ hydrateOnly: true })).toEqual(messages)
			expect(mockReadApiMessages).toHaveBeenCalledOnce()
			expect(reconcile).not.toHaveBeenCalled()
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("still requires verified canonical recovery for empty legacy history during hydration", async () => {
			const task = createTask()
			const messages = [{ role: "user", content: "verified canonical history" }]
			mockReadApiMessages.mockResolvedValueOnce([])
			const store = (task as any).providerTranscriptStore
			store.read.mockResolvedValueOnce({ version: 2, taskId: task.taskId, messages })
			expect(await (task as any).getSavedApiConversationHistory({ hydrateOnly: true })).toEqual(messages)
			expect(store.read).toHaveBeenCalledOnce()
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it.each(["initial", "queued"])(
			"returns verified v2 history when the %s legacy read was stale-empty",
			async (phase) => {
				const task = createTask()
				const verifiedMessages = [{ role: "user", content: "concurrent durable snapshot" }]
				if (phase === "queued")
					mockReadApiMessages.mockResolvedValueOnce([{ role: "user", content: "older snapshot" }])
				mockReadApiMessages.mockResolvedValueOnce([])
				const store = (task as any).providerTranscriptStore
				store.read.mockResolvedValueOnce({ version: 2, taskId: task.taskId, messages: verifiedMessages })
				expect(await (task as any).getSavedApiConversationHistory()).toEqual(verifiedMessages)
				expect(mockSaveApiMessages).not.toHaveBeenCalled()
			},
		)

		it.each(["initial", "queued"])(
			"propagates a %s legacy read refusal instead of returning an older prefix",
			async (phase) => {
				const task = createTask()
				const failure = new MockProviderTranscriptStoreError("read_failed", "Missing v2 authority")
				if (phase === "queued")
					mockReadApiMessages.mockResolvedValueOnce([{ role: "user", content: "older snapshot" }])
				mockReadApiMessages.mockRejectedValueOnce(failure)
				await expect((task as any).getSavedApiConversationHistory()).rejects.toBe(failure)
				await expect(task.flushApiConversationHistoryPersistence()).rejects.toBe(failure)
				expect(mockSaveApiMessages).not.toHaveBeenCalled()
			},
		)

		it("rejects saturation before copying, drains accepted snapshots, and only a later retry clears failure", async () => {
			const task = createTask()
			task.apiConversationHistory = [{ role: "user", content: "snapshot" }]
			expect(await (task as any).saveApiConversationHistory()).toBe(true)
			task.assistantMessageSavedToHistory = true
			mockSaveApiMessages.mockClear()
			let release!: () => void
			const blocked = new Promise<void>((resolve) => {
				release = resolve
			})
			mockSaveApiMessages.mockImplementationOnce(() => blocked)
			const accepted = Array.from({ length: 8 }, () => (task as any).saveApiConversationHistory())
			await vi.waitFor(() => expect(mockSaveApiMessages).toHaveBeenCalledOnce())
			const clone = vi.spyOn(globalThis, "structuredClone")
			expect(await (task as any).saveApiConversationHistory()).toBe(false)
			expect(clone).not.toHaveBeenCalled()
			clone.mockRestore()
			await expect((task as any).assertCurrentProviderTranscriptBeforeEffects()).rejects.toThrow("receipt")
			let drained = false
			const drain = task.flushApiConversationHistoryPersistence().finally(() => {
				drained = true
			})
			const failure = expect(drain).rejects.toMatchObject({ code: "queue_full" })
			await Promise.resolve()
			expect(drained).toBe(false)
			release()
			expect(await Promise.all(accepted)).toEqual(Array(8).fill(false))
			await failure
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(8)
			expect(await (task as any).saveApiConversationHistory()).toBe(true)
			await expect(task.flushApiConversationHistoryPersistence()).resolves.toBeUndefined()
			await expect((task as any).assertCurrentProviderTranscriptBeforeEffects()).resolves.toBeUndefined()
		})

		it("aborts workers and disposes cancellation resources before reporting persistence failure", async () => {
			const task = createTask()
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk unavailable"))
			expect(await (task as any).saveApiConversationHistory()).toBe(false)
			const stop = vi.spyOn(task as any, "stopActiveTaskCommands").mockResolvedValue(undefined)
			const dispose = vi.spyOn(task, "dispose")
			const signal = (task as any).getTaskLifetimeCancellationSignal() as AbortSignal
			await expect(task.abortTask()).rejects.toThrow("disk unavailable")
			expect(stop).toHaveBeenCalledOnce()
			expect(dispose).toHaveBeenCalledOnce()
			expect(signal.aborted).toBe(true)
			await expect(task.flushApiConversationHistoryPersistence()).rejects.toThrow("disk unavailable")
		})

		it("does not finalize an empty result buffer over an unresolved persistence failure", async () => {
			const task = createTask()
			mockProvider.prepareTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			mockProvider.rollbackTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			vi.spyOn(task, "getCompletionGateDecision").mockResolvedValue({ allowed: true } as any)
			const completed = vi.spyOn(task, "markCompleted")
			mockSaveApiMessages.mockRejectedValueOnce(new Error("completion disk failure"))
			expect(await (task as any).saveApiConversationHistory()).toBe(false)
			expect(task.userMessageContent).toEqual([])
			await expect(task.finalizeTaskCompletion()).rejects.toThrow("completion disk failure")
			expect(completed).not.toHaveBeenCalled()
			expect(mockProvider.rollbackTaskCompletionLifecycle).toHaveBeenCalledOnce()
		})

		it("rejects a save that starts and settles during the final verification gate", async () => {
			const task = createTask()
			mockProvider.prepareTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			mockProvider.rollbackTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			vi.spyOn(task, "getCompletionGateDecision").mockImplementation(async () => {
				expect(await (task as any).saveApiConversationHistory()).toBe(true)
				await task.flushApiConversationHistoryPersistence()
				return { allowed: true, modelCanResolveRejection: true }
			})
			const completed = vi.spyOn(task, "markCompleted")
			await expect(task.finalizeTaskCompletion()).rejects.toThrow("still pending")
			expect(completed).not.toHaveBeenCalled()
		})

		it("rejects a save admitted during the final verification gate without marking completed", async () => {
			const task = createTask()
			mockProvider.prepareTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			mockProvider.rollbackTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
			let release!: () => void
			const blocked = new Promise<void>((resolve) => {
				release = resolve
			})
			mockSaveApiMessages.mockImplementationOnce(() => blocked)
			let save!: Promise<boolean>
			vi.spyOn(task, "getCompletionGateDecision").mockImplementation(async () => {
				save = (task as any).saveApiConversationHistory()
				return { allowed: true } as any
			})
			const completed = vi.spyOn(task, "markCompleted")
			await expect(task.finalizeTaskCompletion()).rejects.toThrow("still pending")
			expect(completed).not.toHaveBeenCalled()
			release()
			expect(await save).toBe(true)
			await task.flushApiConversationHistoryPersistence()
		})
	})

	describe("assistant response persistence boundary", () => {
		describe("mixed barrier receipts", () => {
			afterEach(() => {
				mockSaveApiMessages.mockReset().mockResolvedValue(undefined)
				mockReadApiMessages.mockReset().mockResolvedValue([])
			})

			it.each([false, true])(
				"retains one request_user_input barrier rejection across persistence and replay (cancelled=%s)",
				async (cancelled) => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "mixed barrier lifecycle",
						startTask: false,
					})
					let snapshot: AgentLifecycleSnapshot | undefined
					const published: AgentLifecycleEvent[] = []
					const lifecycleProvider = {
						replayAgentLifecycle: vi.fn(async () => snapshot),
						getAgentLifecycleSnapshot: vi.fn(() => snapshot),
						publishAgentLifecycleEvent: vi.fn(async (input: Record<string, unknown>) => {
							const base =
								snapshot ??
								createAgentLifecycleSnapshot({
									taskId: String(input.taskId),
									runId: String(input.runId),
									turnId: String(input.turnId),
								})
							const event = agentLifecycleEventSchema.parse({ ...input, sequence: base.lastSequence + 1 })
							snapshot = reduceAgentLifecycleEvent(base, event)
							published.push(event)
							return { accepted: true }
						}),
					}
					Object.assign(task, { providerRef: { deref: () => lifecycleProvider } })
					await (task as any).beginCanonicalLifecycleTurn()
					const schemas = getNativeTools({ planMode: true })
					const surface = createTaskToolSurface({
						registry: new ToolRegistry({ nativeTools: schemas }),
						schemas,
						mode: "architect",
					})
					// Capture the same provider/runtime boundary used by production persistence.
					const step = (task as any).captureAgentStep(
						0,
						"Barrier persistence fixture",
						[],
						surface.schemas,
						undefined,
						{ taskId: task.taskId },
						"architect",
						task.api.getModel().info,
						surface,
					)
					await (task as any).ensureCanonicalLifecycleStepStarted(step)
					const calls = [
						{ type: "tool_call" as const, id: "read", name: "read_file", arguments: {} },
						{ type: "tool_call" as const, id: "barrier", name: "request_user_input", arguments: {} },
					]
					const response = createAgentResponse(calls)
					const error = getToolBatchIsolationError(
						surface.registry,
						calls.map((call) => call.name),
					)
					expect(error).toBeDefined()
					for (const call of calls)
						task.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: call.id,
							content: formatResponse.toolError(error!),
							is_error: true,
						})
					const earlyReceipts = [...task.userMessageContent]
					const writes: Task["apiConversationHistory"][] = []
					mockSaveApiMessages.mockImplementation(async ({ messages }) => {
						writes.push(structuredClone(messages))
						if (cancelled && writes.length === 1) task.abort = true
					})
					const persisted = await (task as any).persistAssistantResponseBeforeEffects(
						{
							role: "assistant",
							content: calls.map((call) => ({
								type: "tool_use",
								id: call.id,
								name: call.name,
								input: call.arguments,
							})),
						},
						undefined,
						response,
					)
					expect(persisted).toBe(true)
					expect(writes[0]).toHaveLength(1)
					expect(writes[0][0].role).toBe("assistant")
					expect(published.filter((event) => event.type === "tool_result_recorded")).toHaveLength(2)

					expect(task.userMessageContent).toEqual(earlyReceipts)
					await expect(task.flushPendingToolResultsToHistory({ allowAborted: true })).resolves.toBe(true)
					await expect(task.flushPendingToolResultsToHistory({ allowAborted: true })).resolves.toBe(true)
					expect(writes.at(-1)?.map((message) => message.role)).toEqual(["assistant", "user"])
					expect(writes.at(-1)?.[1].content).toEqual(earlyReceipts)
					for (const receipt of earlyReceipts) {
						if (receipt.type === "tool_result")
							expect(task.pushToolResultToUserContent(receipt)).toBe(false)
					}

					const replacement = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						taskId: task.taskId,
						startTask: false,
					})
					Object.assign(replacement, { providerRef: { deref: () => lifecycleProvider } })
					mockReadApiMessages.mockResolvedValue(writes.at(-1))
					const loaded = await (replacement as any).getSavedApiConversationHistory()
					expect(loaded.map((message: { role: string }) => message.role)).toEqual(["assistant", "user"])
					expect(loaded[1].content).toEqual(earlyReceipts)
					await (replacement as any).replayCanonicalLifecycle()
					await (replacement as any).publishCanonicalLifecyclePendingToolResults(response, step)
					const terminalEvents = published.filter((event) => event.type === "tool_result_recorded")
					expect(terminalEvents).toHaveLength(2)
					expect(terminalEvents.map((event) => event.payload.item.status)).toEqual(["error", "error"])
					expect(snapshot).toMatchObject({
						acceptedToolCallIds: ["read", "barrier"],
						terminalToolCallIds: ["read", "barrier"],
					})
				},
			)
		})

		it("wires Task boundaries through the canonical publisher with one terminal receipt", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "canonical lifecycle task",
				startTask: false,
			})

			let snapshot: AgentLifecycleSnapshot | undefined
			const published: AgentLifecycleEvent[] = []
			const lifecycleProvider = {
				replayAgentLifecycle: vi.fn(async () => snapshot),
				getAgentLifecycleSnapshot: vi.fn(() => snapshot),
				publishAgentLifecycleEvent: vi.fn(async (input: Record<string, unknown>) => {
					const identityChanged =
						snapshot !== undefined && (snapshot.runId !== input.runId || snapshot.turnId !== input.turnId)
					const base =
						!snapshot || identityChanged
							? createAgentLifecycleSnapshot({
									taskId: String(input.taskId),
									runId: String(input.runId),
									turnId: String(input.turnId),
								})
							: snapshot
					const event = agentLifecycleEventSchema.parse({
						...input,
						sequence: base.lastSequence + 1,
					})
					snapshot = reduceAgentLifecycleEvent(base, event)
					published.push(event)
					return {
						kind: "applied",
						status: "applied",
						accepted: true,
						applied: true,
						replayed: false,
						taskId: event.taskId,
						event,
						snapshot,
					}
				}),
			}
			;(task as any).providerRef = { deref: () => lifecycleProvider }
			;(task as any).canonicalLifecycleQueue = Promise.resolve()

			await (task as any).beginCanonicalLifecycleTurn()
			expect((task as any).agentRunId).toEqual(expect.any(String))
			expect((task as any).agentTurnId).toEqual(expect.any(String))
			expect(lifecycleProvider.replayAgentLifecycle).toHaveBeenCalledOnce()
			expect(published.length).toBeGreaterThan(0)
			const step = { stepId: "step-1" }
			;(task as any).currentAgentStep = step
			await (task as any).ensureCanonicalLifecycleStepStarted(step)
			const response = {
				items: [{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
				text: "",
				reasoning: "",
				toolCalls: [{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
			}
			await (task as any).publishCanonicalLifecycleResponseItems(response, step)
			await (task as any).publishCanonicalLifecycleSchedulerEvent({
				type: "approval_request",
				requestId: "approval-1",
				callId: "call-1",
			})
			await (task as any).publishCanonicalLifecycleSchedulerEvent({
				type: "approval_result",
				requestId: "approval-1",
				decision: "approved",
			})
			await (task as any).publishCanonicalLifecycleSchedulerEvent({
				type: "approval_result",
				requestId: "approval-1",
				decision: "approved",
			})
			await (task as any).publishCanonicalLifecycleToolResult(
				{ callId: "call-1", status: "success", content: "ok" },
				step,
			)
			await (task as any).finishCanonicalLifecycleTurn({
				status: "completed",
				steps: 1,
				response,
				completionReason: "host",
			})
			await (task as any).finishCanonicalLifecycleTurn({
				status: "completed",
				steps: 1,
				response,
				completionReason: "host",
			})

			expect(snapshot).toMatchObject({
				status: "completed",
				acceptedToolCallIds: ["call-1"],
				terminalToolCallIds: ["call-1"],
			})
			expect(published.filter((event) => event.type === "turn_terminal")).toHaveLength(1)
			expect(published.filter((event) => event.type === "tool_result_recorded")).toHaveLength(1)
			expect(published.filter((event) => event.type === "approval_requested")).toHaveLength(1)
			expect(published.filter((event) => event.type === "approval_resolved")).toHaveLength(1)
			expect(snapshot?.items.find((item) => item.type === "approval")).toMatchObject({ status: "approved" })
			expect(lifecycleProvider.publishAgentLifecycleEvent).toHaveBeenCalled()
		})

		it("resumes after the highest recovered step without reusing step or item identities", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "resume canonical lifecycle",
				startTask: false,
			})
			let snapshot = createAgentLifecycleSnapshot({ taskId: task.taskId, runId: "run-1", turnId: "turn-1" })
			const append = (value: Record<string, unknown>) => {
				const event = agentLifecycleEventSchema.parse({
					version: 1,
					eventId: `event-${snapshot.lastSequence + 1}`,
					taskId: task.taskId,
					runId: "run-1",
					turnId: "turn-1",
					occurredAt: snapshot.lastSequence + 1,
					sequence: snapshot.lastSequence + 1,
					...value,
				})
				snapshot = reduceAgentLifecycleEvent(snapshot, event)
			}
			append({ type: "turn_started", payload: { phase: "starting" } })
			append({ type: "step_started", stepId: "turn-1:step-7", payload: { phase: "working" } })

			const publishAgentLifecycleEvent = vi.fn()
			;(task as any).providerRef = {
				deref: () => ({
					replayAgentLifecycle: vi.fn(async () => snapshot),
					getAgentLifecycleSnapshot: vi.fn(() => snapshot),
					publishAgentLifecycleEvent,
				}),
			}

			await (task as any).beginCanonicalLifecycleTurn()

			expect((task as any).agentRunId).toBe("run-1")
			expect((task as any).agentTurnId).toBe("turn-1")
			expect((task as any).agentTurnStep).toBe(7)
			expect(publishAgentLifecycleEvent).not.toHaveBeenCalled()
		})

		it.each([
			{ scenario: "without a persisted result", result: undefined, expectedStatus: "indeterminate" },
			{
				scenario: "with a persisted successful result",
				result: { content: "file written", is_error: false },
				expectedStatus: "success",
			},
			{
				scenario: "with a persisted failed result",
				result: { content: "write failed: permission denied", is_error: true },
				expectedStatus: "error",
			},
		])(
			"recovers an interrupted effect-start $scenario without replaying it",
			async ({ scenario: _scenario, result, expectedStatus }) => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "recover interrupted effect",
					startTask: false,
				})
				let snapshot: AgentLifecycleSnapshot | undefined
				const published: AgentLifecycleEvent[] = []
				const lifecycleProvider = {
					replayAgentLifecycle: vi.fn(async () => snapshot),
					getAgentLifecycleSnapshot: vi.fn(() => snapshot),
					publishAgentLifecycleEvent: vi.fn(
						async (input: Record<string, unknown>, options?: { durable?: boolean }) => {
							const identityChanged =
								snapshot !== undefined &&
								(snapshot.runId !== input.runId || snapshot.turnId !== input.turnId)
							const base =
								!snapshot || identityChanged
									? createAgentLifecycleSnapshot({
											taskId: String(input.taskId),
											runId: String(input.runId),
											turnId: String(input.turnId),
										})
									: snapshot
							const event = agentLifecycleEventSchema.parse({ ...input, sequence: base.lastSequence + 1 })
							snapshot = reduceAgentLifecycleEvent(base, event)
							published.push(event)
							return { accepted: true, event, snapshot, durable: options?.durable === true }
						},
					),
				}
				;(task as any).providerRef = { deref: () => lifecycleProvider }
				;(task as any).canonicalLifecycleQueue = Promise.resolve()

				await (task as any).beginCanonicalLifecycleTurn()
				expect(snapshot?.effectTrackingVersion).toBe(1)
				const step = { stepId: `${(task as any).agentTurnId}:step-1` }
				;(task as any).currentAgentStep = step
				await (task as any).ensureCanonicalLifecycleStepStarted(step)
				const toolCall = {
					type: "tool_call" as const,
					id: "mutate-before-reload",
					name: "write_to_file",
					arguments: { path: "state.txt" },
				}
				await (task as any).publishCanonicalLifecycleResponseItems(
					{ items: [toolCall], text: "", reasoning: "", toolCalls: [toolCall] },
					step,
				)
				await (task as any).enqueueCanonicalLifecycleEvent(
					"tool_effect_started",
					{ toolCallId: toolCall.id },
					step.stepId,
					undefined,
					{ durable: true, required: true },
				)
				expect(lifecycleProvider.publishAgentLifecycleEvent).toHaveBeenLastCalledWith(
					expect.objectContaining({ type: "tool_effect_started" }),
					{ durable: true },
				)
				if (result) {
					;(task as any).apiConversationHistory = [
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: toolCall.id,
									name: toolCall.name,
									input: toolCall.arguments,
								},
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolCall.id,
									content: result.content,
									is_error: result.is_error,
								},
							],
						},
					]
				}

				await (task as any).recoverIncompleteCanonicalToolCallsForResume()

				expect(snapshot).toMatchObject({
					status: "interrupted",
					effectTrackingVersion: 1,
					effectStartedToolCallIds: [toolCall.id],
					terminalToolCallIds: [toolCall.id],
				})
				const resultItem = snapshot?.items.find((item) => item.type === "tool_result")
				expect(resultItem?.status).toBe(expectedStatus)
				if (result) {
					expect(resultItem).toMatchObject({ toolCallId: toolCall.id, output: result.content })
				} else {
					expect(resultItem?.output).toEqual(expect.stringContaining("outcome is unknown"))
				}
				expect(published.filter((event) => event.type === "tool_result_recorded")).toHaveLength(1)
			},
		)

		it("recovers an accepted legacy call without an effect marker as indeterminate", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "recover legacy accepted tool call",
				startTask: false,
			})
			const runId = "legacy-run"
			const turnId = "legacy-turn"
			const stepId = `${turnId}:step-1`
			let snapshot = createAgentLifecycleSnapshot({ taskId: task.taskId, runId, turnId })
			const append = (event: Record<string, unknown>) => {
				const parsed = agentLifecycleEventSchema.parse({
					version: 1,
					eventId: `legacy-event-${snapshot.lastSequence + 1}`,
					sequence: snapshot.lastSequence + 1,
					taskId: task.taskId,
					runId,
					turnId,
					occurredAt: snapshot.lastSequence + 1,
					...event,
				})
				snapshot = reduceAgentLifecycleEvent(snapshot, parsed)
			}
			append({ type: "turn_started", payload: { phase: "starting" } })
			append({ type: "step_started", stepId, payload: { phase: "working" } })
			append({
				type: "tool_call_accepted",
				stepId,
				payload: {
					item: {
						itemId: `${stepId}:tool-call-legacy-call`,
						stepId,
						type: "tool_call",
						toolCallId: "legacy-call",
						name: "write_to_file",
						arguments: { path: "state.txt" },
						status: "accepted",
					},
				},
			})

			const lifecycleProvider = {
				replayAgentLifecycle: vi.fn(async () => snapshot),
				getAgentLifecycleSnapshot: vi.fn(() => snapshot),
				publishAgentLifecycleEvent: vi.fn(async (input: Record<string, unknown>) => {
					const event = agentLifecycleEventSchema.parse({
						...input,
						sequence: snapshot.lastSequence + 1,
					})
					snapshot = reduceAgentLifecycleEvent(snapshot, event)
					return { accepted: true, event, snapshot }
				}),
			}
			;(task as any).providerRef = { deref: () => lifecycleProvider }
			;(task as any).canonicalLifecycleQueue = Promise.resolve()

			await (task as any).recoverIncompleteCanonicalToolCallsForResume()

			expect(snapshot.effectTrackingVersion).toBeUndefined()
			expect(snapshot.status).toBe("interrupted")
			expect(snapshot.items.find((item) => item.type === "tool_result")).toMatchObject({
				toolCallId: "legacy-call",
				status: "indeterminate",
				output: expect.stringContaining("outcome is unknown"),
			})
		})

		it("joins delayed accepted calls before persisting staged mixed receipts and cancelling approvals", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "cancel canonical lifecycle",
				startTask: false,
			})
			let snapshot: AgentLifecycleSnapshot | undefined
			let releaseAcceptance!: () => void
			let markAcceptanceStarted!: () => void
			const acceptanceGate = new Promise<void>((resolve) => {
				releaseAcceptance = resolve
			})
			const acceptanceStarted = new Promise<void>((resolve) => {
				markAcceptanceStarted = resolve
			})
			let delayed = false
			const lifecycleProvider = {
				replayAgentLifecycle: vi.fn(async () => snapshot),
				getAgentLifecycleSnapshot: vi.fn(() => snapshot),
				publishAgentLifecycleEvent: vi.fn(async (input: Record<string, unknown>) => {
					if (input.type === "tool_call_accepted" && !delayed) {
						delayed = true
						markAcceptanceStarted()
						await acceptanceGate
					}
					const identityChanged =
						snapshot !== undefined && (snapshot.runId !== input.runId || snapshot.turnId !== input.turnId)
					const base =
						!snapshot || identityChanged
							? createAgentLifecycleSnapshot({
									taskId: String(input.taskId),
									runId: String(input.runId),
									turnId: String(input.turnId),
								})
							: snapshot
					const event = agentLifecycleEventSchema.parse({ ...input, sequence: base.lastSequence + 1 })
					snapshot = reduceAgentLifecycleEvent(base, event)
					return { accepted: true, event, snapshot }
				}),
			}
			;(task as any).providerRef = { deref: () => lifecycleProvider }
			await (task as any).beginCanonicalLifecycleTurn()
			const step = { stepId: `${(task as any).agentTurnId}:step-1` }
			;(task as any).currentAgentStep = step
			await (task as any).ensureCanonicalLifecycleStepStarted(step)
			const calls = [
				{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
				{ type: "tool_call", id: "call-2", name: "attempt_completion", arguments: {} },
			]
			const response = { items: calls, text: "", reasoning: "", toolCalls: calls }
			const ownedLifecycle = (async () => {
				await (task as any).publishCanonicalLifecycleResponseItems(response, step)
				await (task as any).publishCanonicalLifecycleSchedulerEvent({
					type: "approval_request",
					requestId: "approval-pending",
					callId: "call-1",
				})
			})()
			;(task as any).ownBackgroundLifecycle("start", ownedLifecycle)
			await acceptanceStarted

			task.apiConversationHistory = [
				{
					role: "assistant",
					content: calls.map((call) => ({
						type: "tool_use" as const,
						id: call.id,
						name: call.name,
						input: call.arguments,
					})),
				},
			]
			task.assistantMessageSavedToHistory = true
			task.userMessageContent.push(
				{ type: "tool_result", tool_use_id: "call-1", content: "completed", is_error: false },
				{ type: "tool_result", tool_use_id: "call-2", content: "isolated", is_error: true },
			)

			await task.abortTask()
			let terminated = false
			const termination = task.waitForTermination().then(() => {
				terminated = true
			})
			await Promise.resolve()
			expect(terminated).toBe(false)

			releaseAcceptance()
			await termination

			expect(snapshot).toMatchObject({
				status: "interrupted",
				acceptedToolCallIds: ["call-1", "call-2"],
				terminalToolCallIds: ["call-1", "call-2"],
			})
			expect(snapshot?.items.filter((item) => item.type === "approval" && item.status === "requested")).toEqual(
				[],
			)
			expect(snapshot?.items.find((item) => item.type === "approval")).toMatchObject({ status: "cancelled" })
			expect(task.userMessageContent).toEqual([])
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1" },
					{ type: "tool_result", tool_use_id: "call-2" },
				],
			})
		})

		it("joins a retained sub-agent follow-up when cancellation interrupts the resumed loop", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "retained child",
				taskKind: "subagent",
				startTask: false,
			})
			let releaseLoop!: () => void
			const loop = new Promise<void>((resolve) => {
				releaseLoop = resolve
			})
			const resumeLoop = vi.spyOn(task as any, "resumeTaskFromHistory").mockImplementation(async () => loop)

			const resume = task.resumeSubagentFollowup("continue")
			await vi.waitFor(() => expect(resumeLoop).toHaveBeenCalledOnce())
			await task.abortTask()
			let joined = false
			const termination = task.waitForTermination().then(() => {
				joined = true
			})
			await Promise.resolve()
			expect(joined).toBe(false)

			releaseLoop()
			await Promise.all([resume, termination])
			expect(joined).toBe(true)
		})

		it("joins a delegated parent resume when cancellation interrupts its new loop", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "delegated parent",
				startTask: false,
			})
			task.apiConversationHistory = [{ role: "user", content: [{ type: "text", text: "resume" }] }]
			vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
			let releaseLoop!: () => void
			const loop = new Promise<void>((resolve) => {
				releaseLoop = resolve
			})
			const initiate = vi.spyOn(task as any, "initiateTaskLoop").mockImplementation(async () => loop)

			const resume = task.resumeAfterDelegation()
			await vi.waitFor(() => expect(initiate).toHaveBeenCalledOnce())
			await task.abortTask()
			let joined = false
			const termination = task.waitForTermination().then(() => {
				joined = true
			})
			await Promise.resolve()
			expect(joined).toBe(false)

			releaseLoop()
			await Promise.all([resume, termination])
			expect(joined).toBe(true)
		})

		it("persists deterministic provider receipts when the effect fence rejects before the first tool", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "pre-effect fence",
				startTask: false,
			})
			const execute = vi.fn(async ({ callbacks }) => callbacks.pushToolResult("unexpected"))
			const surface = createReadFileSurface(execute)
			const call = { type: "tool_call" as const, id: "call-1", name: "read_file", arguments: { path: "a.txt" } }
			const response = { items: [call], text: "", reasoning: "", toolCalls: [call] }
			task.apiConversationHistory = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }],
				},
			]
			task.assistantMessageSavedToHistory = true
			vi.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects").mockRejectedValue(
				new Error("stale transcript receipt"),
			)

			const outcome = await (task as any).executeCanonicalToolCalls(
				response,
				surface,
				"code",
				undefined,
				new AbortController().signal,
			)

			expect(outcome).toMatchObject({
				status: "failed",
				results: [{ callId: "call-1", status: "error" }],
				failure: { kind: "effect_fence", callId: "call-1", message: "stale transcript receipt" },
			})
			expect(execute).not.toHaveBeenCalled()
			expect(task.userMessageContent).toEqual([])
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true }],
			})
		})

		it("preserves a completed result and persists remaining failures when the next effect fence rejects", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "mid-batch effect fence",
				startTask: false,
			})
			const execute = vi.fn(async ({ call, callbacks }) => callbacks.pushToolResult(`completed:${call.id}`))
			const surface = createReadFileSurface(execute)
			const calls = [
				{ type: "tool_call" as const, id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
				{ type: "tool_call" as const, id: "call-2", name: "read_file", arguments: { path: "b.txt" } },
			]
			const response = { items: calls, text: "", reasoning: "", toolCalls: calls }
			task.apiConversationHistory = [
				{
					role: "assistant",
					content: calls.map((call) => ({
						type: "tool_use" as const,
						id: call.id,
						name: call.name,
						input: call.arguments,
					})),
				},
			]
			task.assistantMessageSavedToHistory = true
			let fenceChecks = 0
			vi.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects").mockImplementation(async () => {
				fenceChecks += 1
				if (fenceChecks === 3) throw new Error("receipt changed after first effect")
			})

			const outcome = await (task as any).executeCanonicalToolCalls(
				response,
				surface,
				"code",
				undefined,
				new AbortController().signal,
			)

			expect(outcome).toMatchObject({
				status: "failed",
				results: [
					{ callId: "call-1", status: "success" },
					{ callId: "call-2", status: "error" },
				],
				failure: { callId: "call-2", message: "receipt changed after first effect" },
			})
			expect(execute).toHaveBeenCalledOnce()
			expect(task.userMessageContent).toEqual([])
			expect(task.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1", is_error: false },
					{ type: "tool_result", tool_use_id: "call-2", is_error: true },
				],
			})
		})

		it("keeps long-running tool execution cancellable after the provider stream ends", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "steer a running tool",
				startTask: false,
			})
			let toolSignal: AbortSignal | undefined
			const execute = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
				toolSignal = signal
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
			})
			const surface = createReadFileSurface(execute as ToolDescriptor["execute"])
			const call = {
				type: "tool_call" as const,
				id: "long-tool",
				name: "read_file",
				arguments: { path: "a.txt" },
			}
			const response = { items: [call], text: "", reasoning: "", toolCalls: [call] }
			task.assistantMessageSavedToHistory = true
			;(task as any).isTaskLoopActive = true
			vi.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects").mockResolvedValue(undefined)

			const run = (task as any).executeCanonicalToolCallsForTurn(response, surface, "code", undefined)
			await vi.waitFor(() => expect(toolSignal).toBeInstanceOf(AbortSignal))

			await task.steerUserMessage("stop this tool and use the new direction")
			const outcome = await run

			expect(toolSignal?.aborted).toBe(true)
			expect(outcome).toMatchObject({
				status: "aborted",
				results: [{ callId: "long-tool", status: "cancelled" }],
			})
			expect(task.currentRequestAbortController).toBeUndefined()
			expect((task as any).currentRequestSignal).toBeUndefined()
			expect((task as any).pendingSteerMessage).toMatchObject({
				text: "stop this tool and use the new direction",
			})
			expect(task.abort).toBe(false)
		})

		it("stops the turn before effects when assistant history cannot be saved", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			vi.spyOn(task as any, "addToApiConversationHistory").mockResolvedValue(false)
			const retry = vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(false)

			const persisted = await (task as any).persistAssistantResponseBeforeEffects({
				role: "assistant",
				content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
			})

			expect(persisted).toBe(false)
			expect(retry).toHaveBeenCalledOnce()
			expect(task.assistantMessageSavedToHistory).toBe(false)
			expect((task as any).pendingTurnSuspension?.reason).toContain("could not be saved")
		})

		it("opens the effects boundary only after a failed save is recovered", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			vi.spyOn(task as any, "addToApiConversationHistory").mockResolvedValue(false)
			vi.spyOn(task, "retrySaveApiConversationHistory").mockResolvedValue(true)

			const persisted = await (task as any).persistAssistantResponseBeforeEffects({
				role: "assistant",
				content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
			})

			expect(persisted).toBe(true)
			expect(task.assistantMessageSavedToHistory).toBe(true)
			expect((task as any).pendingTurnSuspension).toBeUndefined()
		})
	})

	describe("background lifecycle failure ownership", () => {
		it("owns failures from start() without changing its void contract", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const startupFailure = new Error("startup failed")
			vi.spyOn(task as any, "startTask").mockRejectedValue(startupFailure)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

			try {
				expect(task.start()).toBeUndefined()
				await vi.waitFor(() =>
					expect(consoleError).toHaveBeenCalledWith(
						expect.stringContaining("Background start failed"),
						startupFailure,
					),
				)
			} finally {
				consoleError.mockRestore()
			}
		})

		it("owns constructor-started resume failures", async () => {
			const resumeFailure = new Error("resume failed")
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			const historyItem: HistoryItem = {
				id: "resume-failure",
				number: 1,
				ts: Date.now(),
				task: "resume task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			try {
				new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem,
					onCreated: (task) => {
						vi.spyOn(task as any, "resumeTaskFromHistory").mockRejectedValue(resumeFailure)
					},
				})

				await vi.waitFor(() =>
					expect(consoleError).toHaveBeenCalledWith(
						expect.stringContaining("Background resume failed"),
						resumeFailure,
					),
				)
			} finally {
				consoleError.mockRestore()
			}
		})
	})

	// ── saveAlphaMessages ────────────────────────────────────────────────

	describe("saveAlphaMessages", () => {
		it("returns true on success", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveAlphaMessages()
			expect(result).toBe(true)
		})

		it("returns false on failure", async () => {
			mockSaveTaskMessages.mockRejectedValueOnce(new Error("write error"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveAlphaMessages()
			expect(result).toBe(false)
		})

		it("snapshots the array before passing to saveTaskMessages", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.clineMessages.push({
				type: "say",
				say: "text",
				text: "snapshot test",
				ts: Date.now(),
			})

			await (task as Record<string, any>).saveAlphaMessages()

			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveTaskMessages.mock.calls[0][0]
			// The messages passed should be a COPY, not the live reference
			expect(callArgs.messages).not.toBe(task.clineMessages)
			// But the content should be the same
			expect(callArgs.messages).toEqual(task.clineMessages)
		})

		it("serializes concurrent writes so a terminal transcript cannot be overwritten by a stale save", async () => {
			let releaseFirst!: () => void
			const firstWrite = new Promise<void>((resolve) => (releaseFirst = resolve))
			let activeWrites = 0
			let peakWrites = 0

			mockSaveTaskMessages
				.mockImplementationOnce(async () => {
					activeWrites++
					peakWrites = Math.max(peakWrites, activeWrites)
					await firstWrite
					activeWrites--
				})
				.mockImplementationOnce(async () => {
					activeWrites++
					peakWrites = Math.max(peakWrites, activeWrites)
					activeWrites--
				})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			task.clineMessages.push({ type: "say", say: "text", text: "working", ts: 1 })

			const staleSave = (task as Record<string, any>).saveAlphaMessages()
			await vi.waitFor(() => expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1))

			task.clineMessages.push({
				type: "say",
				say: "completion_result",
				text: "terminal report",
				ts: 2,
			})
			const terminalSave = (task as Record<string, any>).saveAlphaMessages()
			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1)

			releaseFirst()
			await Promise.all([staleSave, terminalSave])

			expect(peakWrites).toBe(1)
			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(2)
			expect(mockSaveTaskMessages.mock.calls[1][0].messages).toEqual(task.clineMessages)
		})
	})

	// ── flushPendingToolResultsToHistory — save failure/success ───────────

	describe("flushPendingToolResultsToHistory persistence", () => {
		it("retains userMessageContent on save failure", async () => {
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk full"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-fail",
					content: "Result that should be retained",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(false)
			// userMessageContent should NOT be cleared on failure
			expect(task.userMessageContent.length).toBeGreaterThan(0)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "tool-fail",
			})
		})

		it("clears userMessageContent on save success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-ok",
					content: "Result that should be cleared",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(true)
			// userMessageContent should be cleared on success
			expect(task.userMessageContent).toEqual([])
		})
	})

	describe("saved retired tool calls", () => {
		it("persists one terminal unknown-tool receipt for a saved list_files call", async () => {
			const cwd = path.resolve(os.tmpdir(), "alpha-code-retired-list-files")
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "replay retired list_files call",
				taskMode: "code",
				taskKind: "primary",
				workspacePath: cwd,
				startTask: false,
			})
			const schemas = getNativeTools()
			const registry = new ToolRegistry({ nativeTools: schemas })
			const surface = createTaskToolSurface({ registry, schemas, mode: "code", cwd })
			const call = {
				type: "tool_call" as const,
				id: "saved-list-files",
				name: "list_files" as const,
				arguments: { path: ".", recursive: false },
			}
			const response = createAgentResponse([call])

			expect(registry.resolve("list_files")).toBeUndefined()
			expect(surface.isCallable("list_files")).toBe(false)

			const saved = await (task as any).persistAssistantResponseBeforeEffects(
				{
					role: "assistant",
					content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }],
				},
				undefined,
				response,
			)
			expect(saved).toBe(true)

			const outcome = await (task as any).executeCanonicalToolCallsForTurn(response, surface, "code", undefined)

			expect(outcome).toMatchObject({
				status: "completed",
				results: [{ callId: "saved-list-files", name: "list_files", status: "error" }],
			})
			expect(String(outcome.results[0].content)).toContain("not registered")
			expect(mockListFiles).not.toHaveBeenCalled()
			expect(await task.flushPendingToolResultsToHistory({ allowAborted: true })).toBe(true)
			expect(mockSaveApiMessages.mock.calls.at(-1)?.[0].messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "saved-list-files", is_error: true }],
			})
		})
	})
})
