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
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../../agent/lifecycle/reducer"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { createAgentResponse } from "../../agent/AgentResponse"
import { getToolBatchIsolationError } from "../../agent/ToolScheduler"
import { formatResponse } from "../../prompts/responses"

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockPWaitFor,
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
	MockProviderTranscriptStoreError: class MockProviderTranscriptStoreError extends Error {
		code = "write_failed"
		taskId = "test-id"
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
		commit: vi.fn().mockResolvedValue({
			version: 1,
			taskId,
			revision: 1,
			digest: "1".repeat(64),
			writtenAt: 1,
		}),
		verifyCommitReceipt: vi.fn().mockResolvedValue(undefined),
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

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		default: {
			mkdir: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue("[]"),
			unlink: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
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
}))

vi.mock("../../ignore/RooIgnoreController")

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
	let mockProvider: ClineProvider & Record<string, any>
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

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as ClineProvider & Record<string, any>

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	// ── saveApiConversationHistory (via retrySaveApiConversationHistory) ──

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
			const store = MockProviderTranscriptStore.mock.results.at(-1)?.value as { commit: ReturnType<typeof vi.fn> }

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()

			expect(await promise).toBe(false)
			expect(store.commit).not.toHaveBeenCalled()
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
			const store = MockProviderTranscriptStore.mock.results.at(-1)?.value as { commit: ReturnType<typeof vi.fn> }
			store.commit.mockRejectedValue(new MockProviderTranscriptStoreError("sidecar unavailable"))

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()

			expect(await promise).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)
			expect(store.commit).toHaveBeenCalledTimes(3)
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

	describe("assistant response persistence boundary", () => {
		describe("mixed barrier receipts", () => {
			afterEach(() => {
				mockSaveApiMessages.mockReset().mockResolvedValue(undefined)
				mockReadApiMessages.mockReset().mockResolvedValue([])
			})

			it.each(
				["wait_agent", "switch_mode", "ask_followup_question"].flatMap((barrier) =>
					[false, true].map((cancelled) => ({ barrier, cancelled })),
				),
			)(
				"retains one $barrier rejection across persistence and replay (cancelled=$cancelled)",
				async ({ barrier, cancelled }) => {
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
					const step = { stepId: "barrier-step" }
					Object.assign(task, { currentAgentStep: step })
					await (task as any).ensureCanonicalLifecycleStepStarted(step)
					const calls = [
						{ type: "tool_call" as const, id: "read", name: "read_file", arguments: {} },
						{ type: "tool_call" as const, id: "barrier", name: barrier, arguments: {} },
					]
					const response = createAgentResponse(calls)
					const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code" })
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
					const fence = vi
						.spyOn(task as any, "assertCurrentProviderTranscriptBeforeEffects")
						.mockResolvedValue(undefined)
					const usage = vi.spyOn(task, "recordToolUsage")
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

					const outcome = await (task as any).executeCanonicalToolCallsForTurn(
						response,
						surface,
						"code",
						undefined,
					)
					expect(outcome).toMatchObject({
						status: cancelled ? "aborted" : "completed",
						results: [
							{ callId: "read", status: "error" },
							{ callId: "barrier", status: "error" },
						],
					})
					expect(usage).not.toHaveBeenCalled()
					expect(fence).toHaveBeenCalledOnce()
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
					for (const receipt of outcome.results) {
						await (replacement as any).publishCanonicalLifecycleToolResult(receipt, step)
					}
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
			expect((task as any).suspendAfterCurrentTurnReason).toContain("could not be saved")
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
			expect((task as any).suspendAfterCurrentTurnReason).toBeUndefined()
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

	// ── saveClineMessages ────────────────────────────────────────────────

	describe("saveClineMessages", () => {
		it("returns true on success", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveClineMessages()
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

			const result = await (task as Record<string, any>).saveClineMessages()
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

			await (task as Record<string, any>).saveClineMessages()

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

			const staleSave = (task as Record<string, any>).saveClineMessages()
			await vi.waitFor(() => expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1))

			task.clineMessages.push({
				type: "say",
				say: "completion_result",
				text: "terminal report",
				ts: 2,
			})
			const terminalSave = (task as Record<string, any>).saveClineMessages()
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
})
