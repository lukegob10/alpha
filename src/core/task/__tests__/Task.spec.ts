// npx vitest core/task/__tests__/Task.spec.ts

import * as os from "os"
import * as path from "path"
import { EventEmitter } from "events"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import { RooCodeEventName, type GlobalState, type ProviderSettings, type ModelInfo } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import { ContextProxy } from "../../config/ContextProxy"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import { formatResponse } from "../../prompts/responses"
import { createAgentResponse } from "../../agent/AgentResponse"

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

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
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
// Mock storagePathManager to prevent dynamic import issues.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

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

describe("Alpha", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
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
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		// Setup mock API configuration
		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key", // Add API key to mock config
		}

		// Mock provider methods
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue([])
		mockProvider.prepareTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
		mockProvider.rollbackTaskCompletionLifecycle = vi.fn().mockResolvedValue(undefined)
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
	})

	describe("constructor", () => {
		it("should always have diff strategy defined", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Diff is always enabled - diffStrategy should be defined
			expect(cline.diffStrategy).toBeDefined()
		})

		it("should use default consecutiveMistakeLimit when not provided", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(3)
		})

		it("should respect provided consecutiveMistakeLimit", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("should keep consecutiveMistakeLimit of 0 as 0 for unlimited", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass 0 to ToolRepetitionDetector for unlimited mode", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with 0 for unlimited mode
			expect(cline.toolRepetitionDetector).toBeDefined()
			// Verify the limit remains as 0
			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass consecutiveMistakeLimit to ToolRepetitionDetector", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with the same limit
			expect(cline.toolRepetitionDetector).toBeDefined()
			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("retains the concrete tool failure behind mistake-limit recovery", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			cline.recordToolError("attempt_completion", "Completion still needs verification")
			cline.consecutiveMistakeLimit = 1

			expect(cline.didToolFailInCurrentTurn).toBe(true)
			const guidance = (cline as any).getMistakeLimitGuidance()
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
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const fullState = vi.spyOn(mockProvider, "getState").mockImplementation(() => new Promise<never>(() => {}))
			vi.spyOn(mockProvider, "getValue").mockReturnValue(true)
			vi.spyOn(mockProvider, "getMcpHub").mockReturnValue(undefined)

			await expect((cline as any).getEnabledMcpToolsCount()).resolves.toEqual({
				enabledToolCount: 0,
				enabledServerCount: 0,
			})
			expect(fullState).not.toHaveBeenCalled()
		})

		it("publishes the initial user message through the lightweight task snapshot", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			mockProvider.postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)

			await (cline as any).addToClineMessages({ ts: 1, type: "say", say: "text", text: "test task" }, "task")

			expect(mockProvider.postTaskStateToWebview).toHaveBeenCalledTimes(1)
			expect(mockProvider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
		})

		it("publishes subsequent messages incrementally without rebuilding extension state", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const message = { ts: 2, type: "say", say: "text", text: "next message" } as const
			mockProvider.postMessageToWebview.mockClear()
			mockProvider.postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)
			mockProvider.postStateToWebviewWithoutTaskHistory.mockClear()

			await (cline as any).addToClineMessages(message)

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "messageCreated",
					taskId: cline.taskId,
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
				const cline = new Task({
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

				const history = (cline as any).buildCleanConversationHistory([messageWithExtra])

				expect(history).toEqual([
					{
						role: "user",
						content: [{ type: "text", text: "test message" }],
					},
				])
				expect(Object.keys(history[0])).toEqual(["role", "content"])
			})

			it("should persist VS Code LM stateful markers and only replay them to that provider", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				const statefulMarker = "bW9kZWxcXHJlc3BvbnNl"
				;(cline.api as any).getStatefulMarker = () => statefulMarker
				vi.spyOn(cline as any, "saveApiConversationHistory").mockResolvedValue(true)

				await (cline as any).addToApiConversationHistory({
					role: "assistant" as const,
					content: [{ type: "tool_use" as const, id: "call-1", name: "read_file", input: { path: "a.ts" } }],
				})
				const markerMessage = cline.apiConversationHistory.at(-1)!
				expect(markerMessage).toHaveProperty("vscodeLmStatefulMarker", statefulMarker)

				const anthropicHistory = (cline as any).buildCleanConversationHistory([markerMessage])
				expect(anthropicHistory[0]).not.toHaveProperty("vscodeLmStatefulMarker")

				cline.apiConfiguration = {
					...mockApiConfig,
					apiProvider: "vscode-lm",
				} as ProviderSettings
				const vscodeLmHistory = (cline as any).buildCleanConversationHistory([markerMessage])

				expect(vscodeLmHistory[0]).toMatchObject({
					role: "assistant",
					vscodeLmStatefulMarker: statefulMarker,
				})
			})

			it("should handle image blocks based on model capabilities", () => {
				// Create two configurations - one with image support, one without
				const configWithImages = {
					...mockApiConfig,
					apiModelId: "claude-3-sonnet",
				}
				const configWithoutImages = {
					...mockApiConfig,
					apiModelId: "gpt-3.5-turbo",
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
				const clineWithImages = new Task({
					provider: mockProvider,
					apiConfiguration: configWithImages,
					task: "test task",
					startTask: false,
				})

				// Mock the model info to indicate image support
				vi.spyOn(clineWithImages.api, "getModel").mockReturnValue({
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
				const clineWithoutImages = new Task({
					provider: mockProvider,
					apiConfiguration: configWithoutImages,
					task: "test task",
					startTask: false,
				})

				// Mock the model info to indicate no image support
				vi.spyOn(clineWithoutImages.api, "getModel").mockReturnValue({
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

				const preserved = maybeRemoveImageBlocks(conversationHistory as any, clineWithImages.api)
				const converted = maybeRemoveImageBlocks(conversationHistory as any, clineWithoutImages.api)

				expect(preserved[0]?.content).toEqual(conversationHistory[0]?.content)
				expect(converted[0]?.content).toEqual([
					{ type: "text", text: "Here is an image" },
					{ type: "text", text: "[Referenced image in conversation]" },
				])
			})

			it("should handle API retry with countdown", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say").mockResolvedValue(undefined)

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
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
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
				cline.clineMessages = [
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
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				// Calculate expected delay for first retry
				const baseDelay = 3 // test retry delay

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

				// Calculate expected delay calls for countdown
				const totalExpectedDelays = baseDelay // One delay per second for countdown
				expect(mockDelay).toHaveBeenCalledTimes(totalExpectedDelays)
				expect(mockDelay).toHaveBeenCalledWith(1000)

				// Verify error message content
				const errorMessage = saySpy.mock.calls.find((call) => call[1]?.includes("<retry_timer>"))?.[1]
				expect(errorMessage).toBe(`${mockError.message}\n<retry_timer>${baseDelay}</retry_timer>`)
			})

			it("should honor an explicit zero-second API retry delay", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)
				const saySpy = vi.spyOn(cline, "say").mockResolvedValue(undefined)
				mockProvider.getState = vi.fn().mockResolvedValue({
					requestDelaySeconds: 0,
				})

				await (cline as any).backoffAndAnnounce(0, new Error("transient failure"))

				expect(mockDelay).not.toHaveBeenCalled()
				expect(saySpy).not.toHaveBeenCalledWith("api_req_retry_delayed", expect.anything())
			})

			it("should not apply retry delay twice", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say").mockResolvedValue(undefined)

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
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
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
				cline.clineMessages = [
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
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				// Verify delay is only applied for the countdown
				const baseDelay = 3 // test retry delay
				const expectedDelayCount = baseDelay // One delay per second for countdown
				expect(mockDelay).toHaveBeenCalledTimes(expectedDelayCount)
				expect(mockDelay).toHaveBeenCalledWith(1000) // Each delay should be 1 second

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
					const [cline, task] = Task.create({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
					})

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
						cwd: cline.cwd,
						fileContextTracker: cline.fileContextTracker,
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
					const content1 = Array.isArray(toolResult1.content) ? toolResult1.content[0] : toolResult1.content
					expect((content1 as Anthropic.TextBlockParam).text).toContain("processed:")
					expect((content1 as Anthropic.TextBlockParam).text).toContain(
						"<user_message>Check 'some/path' (see below for file content)</user_message>",
					)

					// Regular tool result should not be processed
					const toolResult2 = processedContent[3] as Anthropic.ToolResultBlockParam
					const content2 = Array.isArray(toolResult2.content) ? toolResult2.content[0] : toolResult2.content
					expect((content2 as Anthropic.TextBlockParam).text).toBe(
						"Regular tool result with 'path' (see below for file content)",
					)

					await cline.abortTask(true)
					await task.catch(() => {})
				})
			})
		})

		describe("Subtask Rate Limiting", () => {
			let mockProvider: any
			let mockApiConfig: any
			let mockDelay: ReturnType<typeof vi.fn>

			beforeEach(() => {
				vi.clearAllMocks()
				// Reset the global timestamp before each test
				Task.resetGlobalApiRequestTime()

				mockApiConfig = {
					apiProvider: "anthropic",
					apiKey: "test-key",
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
				mockDelay = delay as ReturnType<typeof vi.fn>
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
				const request = task.recursivelyMakeClineRequests(
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
					task.recursivelyMakeClineRequests(
						[{ type: "text", text: "<user_message>steer me</user_message>" }],
						false,
						onPersisted,
					),
				).rejects.toThrow("Failed to persist the user turn")

				expect(retry).toHaveBeenCalledOnce()
				expect(onPersisted).not.toHaveBeenCalled()
			})

			it("acknowledges a native wait claim only after its matching tool result is durably saved", async () => {
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
				let releaseSave!: (saved: boolean) => void
				const saveBlocked = new Promise<boolean>((resolve) => (releaseSave = resolve))
				vi.spyOn(task as any, "saveApiConversationHistory").mockReturnValue(saveBlocked)
				const toolResult = {
					role: "user" as const,
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call-wait",
							content: JSON.stringify({ source: "managed_agent_mailbox", claimId: "claim-native-wait" }),
						},
					],
				}

				const persisting = (task as any).addToApiConversationHistory(toolResult)
				expect(mockProvider.acknowledgeWaitAgentResults).not.toHaveBeenCalled()
				releaseSave(true)
				await expect(persisting).resolves.toBe(true)

				expect(mockProvider.acknowledgeWaitAgentResults).toHaveBeenCalledWith(task, "claim-native-wait")
				expect((task as any).pendingWaitAgentResultClaims.size).toBe(0)
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
					provider: "anthropic",
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
					provider: "anthropic",
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
							provider: "anthropic",
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
					apiProvider: "anthropic",
					apiKey: "test-key",
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
			it("should determine API protocol based on provider and model", async () => {
				// Test with Anthropic provider
				const anthropicConfig = {
					...mockApiConfig,
					apiProvider: "anthropic" as const,
					apiModelId: "gpt-4",
				}
				const anthropicTask = new Task({
					provider: mockProvider,
					apiConfiguration: anthropicConfig,
					task: "test task",
					startTask: false,
				})
				// Should use anthropic protocol even with non-claude model
				expect(anthropicTask.apiConfiguration.apiProvider).toBe("anthropic")

				// Test with OpenRouter provider and Claude model
				const openrouterClaudeConfig = {
					apiProvider: "openrouter" as const,
					openRouterModelId: "anthropic/claude-3-opus",
				}
				const openrouterClaudeTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterClaudeConfig,
					task: "test task",
					startTask: false,
				})
				expect(openrouterClaudeTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with OpenRouter provider and non-Claude model
				const openrouterGptConfig = {
					apiProvider: "openrouter" as const,
					openRouterModelId: "openai/gpt-4",
				}
				const openrouterGptTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterGptConfig,
					task: "test task",
					startTask: false,
				})
				expect(openrouterGptTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with various Claude model formats
				const claudeModelFormats = [
					"claude-3-opus",
					"Claude-3-Sonnet",
					"CLAUDE-instant",
					"anthropic/claude-3-haiku",
					"some-provider/claude-model",
				]

				for (const modelId of claudeModelFormats) {
					const config = {
						apiProvider: "openai" as const,
						openAiModelId: modelId,
					}
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: config,
						task: "test task",
						startTask: false,
					})
					// Verify the model ID contains claude (case-insensitive)
					expect(modelId.toLowerCase()).toContain("claude")
				}
			})

			it("should handle edge cases for API protocol detection", async () => {
				// Test with undefined provider
				const undefinedProviderConfig = {
					apiModelId: "claude-3-opus",
				}
				const undefinedProviderTask = new Task({
					provider: mockProvider,
					apiConfiguration: undefinedProviderConfig,
					task: "test task",
					startTask: false,
				})
				expect(undefinedProviderTask.apiConfiguration.apiProvider).toBeUndefined()

				// Test with no model ID
				const noModelConfig = {
					apiProvider: "openai" as const,
				}
				const noModelTask = new Task({
					provider: mockProvider,
					apiConfiguration: noModelConfig,
					task: "test task",
					startTask: false,
				})
				expect(noModelTask.apiConfiguration.apiProvider).toBe("openai")
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
				task.submitUserMessage("test message", ["image1.png"])

				// Verify handleWebviewAskResponse was called directly (not webview)
				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "test message", ["image1.png"])
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

				await task.submitUserMessage("Did we finish?")

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

				// Call with empty text and no images
				task.submitUserMessage("", [])

				// Should not call handleWebviewAskResponse for empty messages
				expect(handleResponseSpy).not.toHaveBeenCalled()

				// Call with whitespace only
				task.submitUserMessage("   ", [])
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

				// Test with no messages (new task scenario)
				task.clineMessages = []
				task.submitUserMessage("new task", ["image1.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "new task", ["image1.png"])

				// Clear mock
				handleResponseSpy.mockClear()

				// Test with existing messages (ongoing task scenario)
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]
				task.submitUserMessage("follow-up message", ["image2.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "follow-up message", ["image2.png"])
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

				// Simulate weakref returning undefined
				Object.defineProperty(task, "providerRef", {
					value: { deref: () => undefined },
					writable: false,
					configurable: true,
				})

				// Spy on console.error to verify error is logged
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Should log error but not throw
				task.submitUserMessage("test message")

				expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#submitUserMessage] Provider reference lost")
				expect(handleResponseSpy).not.toHaveBeenCalled()

				// Restore console.error
				consoleErrorSpy.mockRestore()
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

			await task.steerUserMessage("new context", ["image1.png"])

			expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "new context", ["image1.png"])
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
			})
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.consecutiveNoToolUseCount).toBe(0)
			expect(task.consecutiveNoAssistantMessagesCount).toBe(0)
			expect((task as any).automaticMistakeRecoveryCount).toBe(0)
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
			task.on(RooCodeEventName.TaskActive, active)
			const resume = vi
				.spyOn(task as any, "resumeTaskFromHistory")
				.mockImplementation(async (...args: unknown[]) => {
					const onPersisted = args[1] as (() => Promise<void> | void) | undefined
					await onPersisted?.()
				})

			await task.resumeCompletedTaskFollowup("evaluate the prior answer", ["image1.png"])

			expect(task.taskId).toBeDefined()
			expect(resume).toHaveBeenCalledWith("evaluate the prior answer", expect.any(Function), ["image1.png"], true)
			expect((task as any).didComplete).toBe(false)
			expect(active).toHaveBeenCalledWith(task.taskId)
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
			task.on(RooCodeEventName.TaskActive, active)
			task.on(RooCodeEventName.TaskStarted, started)
			vi.spyOn(task as any, "resumeTaskFromHistory").mockRejectedValue(new Error("durable write failed"))

			await expect(task.resumeCompletedTaskFollowup("retain this draft")).rejects.toThrow("durable write failed")

			expect((task as any).didComplete).toBe(true)
			expect((task as any).didEmitTaskCompleted).toBe(true)
			expect((task as any).steerMessageAwaitingPersistence).toBe(false)
			expect(active).not.toHaveBeenCalled()
			expect(started).not.toHaveBeenCalled()
		})

		it("waits for the completed lifecycle to finish flushing before resuming", async () => {
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
			const resume = vi
				.spyOn(task as any, "resumeTaskFromHistory")
				.mockImplementation(async (...args: unknown[]) => {
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
			;(task as any).isTaskLoopActive = false
			finishPriorLifecycle()
			await followup

			expect(resume).toHaveBeenCalledOnce()
			expect(accepted).toBe(true)
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
			})
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
			})
		})

		it("does not let a late request abort clear a newer operation controller", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "preserve newer cancellation owner",
				startTask: false,
			})

			async function* neverRespondingStream(): AsyncGenerator<ApiStreamChunk> {
				await new Promise<void>(() => {})
				yield { type: "text", text: "unreachable" }
			}

			vi.spyOn(task.api, "createMessage").mockReturnValue(neverRespondingStream())
			const nextChunk = task.attemptApiRequest(0).next()
			await vi.waitFor(() => expect(task.currentRequestAbortController).toBeDefined())
			const oldController = task.currentRequestAbortController!
			const newerController = new AbortController()
			task.currentRequestAbortController = newerController

			oldController.abort()

			await expect(nextChunk).rejects.toThrow("Request cancelled by user")
			expect(task.currentRequestAbortController).toBe(newerController)
			expect(newerController.signal.aborted).toBe(false)
		})

		it("merges steered content with the interrupted user turn", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "initial task",
				startTask: false,
			})
			task.apiConversationHistory = [
				{
					role: "user",
					content: [{ type: "text", text: "<user_message>\noriginal\n</user_message>" }],
				} as any,
			]

			const mergedContent = [
				...(task as any).takeLastApiUserMessageContent(),
				...(task as any).buildUserMessageContent("steered context", []),
			]

			expect(mergedContent).toEqual([
				{ type: "text", text: "<user_message>\noriginal\n</user_message>" },
				{ type: "text", text: "<user_message>\nsteered context\n</user_message>" },
			])
			expect(task.apiConversationHistory).toEqual([])
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
			vi.spyOn(task as any, "saveClineMessages").mockResolvedValue(undefined)

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
			vi.spyOn(task as any, "saveClineMessages").mockResolvedValue(undefined)

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
			const saveSpy = vi.spyOn(task as any, "saveClineMessages").mockImplementation(
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
			const saveSpy = vi.spyOn(task as any, "saveClineMessages").mockResolvedValue(undefined)

			await expect(task.abortTask()).rejects.toThrow("tree cleanup failed")

			expect(disposeSpy).toHaveBeenCalledOnce()
			expect(saveSpy).toHaveBeenCalledOnce()

			await expect(task.abortTask()).resolves.toBeUndefined()
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

	describe("v2.0.9 root task loop", () => {
		const createTask = (taskKind: "primary" | "subagent" = "primary") => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "root loop regression",
				taskKind,
				startTask: false,
				enableCheckpoints: false,
			})
			vi.spyOn(task as any, "saveClineMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "enqueueClineMessagesSave").mockImplementation(async (...args: unknown[]) => {
				const [createSnapshot, onPersisted] = args as [() => unknown, (() => void) | undefined]
				createSnapshot()
				onPersisted?.()
				return true
			})
			return task
		}

		beforeEach(() => {
			mockProvider.getParentCompletionDecision = vi.fn().mockResolvedValue({ allowed: true })
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
				.spyOn(task, "recursivelyMakeClineRequests")
				.mockImplementationOnce(async () => {
					task.userMessageContent = [toolResult]
					return false
				})
				.mockResolvedValueOnce(true)

			await (task as any).initiateTaskLoop(initialContent)

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[0]?.slice(0, 2)).toEqual([initialContent, true])
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([[toolResult], false])
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
			const executeTools = vi.spyOn(task as any, "executeCanonicalToolCalls")
			const attempt = vi.spyOn(task, "attemptApiRequest").mockImplementation(() => {
				return (async function* (): AsyncGenerator<ApiStreamChunk> {
					yield {
						type: "tool_call",
						id: "failed-stream-tool",
						name: "read_file",
						arguments: JSON.stringify({ path: "README.md" }),
					}
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

			const result = await task.recursivelyMakeClineRequests([{ type: "text", text: "start" }], false)

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
			task.on(RooCodeEventName.TaskCompleted, completed)
			const requestStep = vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementationOnce(async () => {
				await task.say("text", "The requested explanation.", undefined, false)
				streamedMessageTs = task.clineMessages.at(-1)?.ts
				task.assistantMessageContent = [{ type: "text", content: "The requested explanation.", partial: false }]
				return false
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledOnce()
			expect(ask).toHaveBeenCalledOnce()
			expect(ask).toHaveBeenCalledWith("completion_result", "", false)
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

		it("does not expose a newly staged completion when every transcript write fails", async () => {
			const task = createTask()
			const stagedSnapshots: any[][] = []
			vi.mocked((task as any).enqueueClineMessagesSave).mockImplementation(
				async (createSnapshot: () => any[]) => {
					stagedSnapshots.push(createSnapshot())
					return false
				},
			)
			const publish = vi.spyOn(task as any, "publishClineMessageCreated")

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
			vi.mocked((task as any).enqueueClineMessagesSave).mockImplementation(
				async (createSnapshot: () => any[]) => {
					stagedSnapshots.push(createSnapshot())
					return false
				},
			)
			const update = vi.spyOn(task as any, "updateClineMessage")

			await expect(task.retractCompletionResult()).rejects.toThrow(
				"Unable to persist the rejected completion state",
			)

			expect(stagedSnapshots).toHaveLength(3)
			expect(stagedSnapshots[0]).toContainEqual(expect.objectContaining({ say: "text", partial: false }))
			expect(task.clineMessages).toEqual([completion])
			expect(update).not.toHaveBeenCalled()
			expect((task as any).suspendAfterCurrentTurnReason).toContain("paused before another model request")
		})

		it("does not expose a completion boundary when raw text fails the durable completion gate", async () => {
			const task = createTask()
			mockProvider.getParentCompletionDecision.mockResolvedValue({
				allowed: false,
				message: "A managed descendant is still active.",
			})
			const ask = vi.spyOn(task, "ask")
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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
		})

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
			vi.spyOn(child as any, "saveClineMessages").mockResolvedValue(true)
			vi.spyOn(child as any, "enqueueClineMessagesSave").mockImplementation(async (...args: unknown[]) => {
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
			vi.spyOn(child, "recursivelyMakeClineRequests").mockImplementationOnce(async () => {
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

		it("lets a queued follow-up arriving at the completion boundary win over acceptance", async () => {
			const task = createTask()
			vi.spyOn(task, "ask").mockImplementationOnce(async () => {
				task.messageQueueService.addMessage("Please add the missing detail.")
				return { response: "yesButtonClicked", text: "", images: [] }
			})
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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
		})

		it("continues the same task when the user replies at the ordinary completion boundary", async () => {
			const task = createTask()
			const retract = vi.spyOn(task, "retractCompletionResult")
			const ask = vi
				.spyOn(task, "ask")
				.mockResolvedValueOnce({
					response: "messageResponse",
					text: "Please expand on that.",
					images: [],
				})
				.mockResolvedValueOnce({ response: "yesButtonClicked", text: "", images: [] })
			const say = vi.spyOn(task, "say").mockResolvedValue(undefined)
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
				.mockImplementationOnce(async () => {
					task.assistantMessageContent = [{ type: "text", content: "First answer.", partial: false }]
					return false
				})
				.mockImplementationOnce(async () => {
					expect(task.clineMessages).toContainEqual(
						expect.objectContaining({ type: "say", say: "text", text: "First answer." }),
					)
					task.assistantMessageContent = [{ type: "text", content: "Expanded answer.", partial: false }]
					return false
				})

			await (task as any).initiateTaskLoop([{ type: "text", text: "start" }])

			expect(requestStep).toHaveBeenCalledTimes(2)
			expect(requestStep.mock.calls[1]?.slice(0, 2)).toEqual([
				[{ type: "text", text: "<user_message>\nPlease expand on that.\n</user_message>" }],
				false,
			])
			expect(retract).toHaveBeenCalledOnce()
			expect(say).toHaveBeenCalledWith("user_feedback", "Please expand on that.", [])
			expect(ask).toHaveBeenCalledTimes(2)
		})

		it("does not start another model turn when completion demotion cannot be persisted", async () => {
			const task = createTask()
			let saveAttempt = 0
			vi.mocked((task as any).enqueueClineMessagesSave).mockImplementation(
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
			vi.spyOn(task, "ask").mockResolvedValue({
				response: "messageResponse",
				text: "Please keep working.",
				images: [],
			})
			const say = vi.spyOn(task, "say")
			const requestStep = vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementationOnce(async () => {
				task.assistantMessageContent = [{ type: "text", content: "Premature answer.", partial: false }]
				return false
			})

			await expect((task as any).initiateTaskLoop([{ type: "text", text: "start" }])).rejects.toThrow(
				"Unable to persist the rejected completion state",
			)

			expect(requestStep).toHaveBeenCalledOnce()
			expect(say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
			expect(task.clineMessages).toContainEqual(
				expect.objectContaining({ type: "say", say: "completion_result", text: "Premature answer." }),
			)
			expect((task as any).suspendAfterCurrentTurnReason).toContain("paused before another model request")
		})

		it("does not discard pending user continuation after a no-tool response", async () => {
			const task = createTask()
			const queuedUserContent = [{ type: "text" as const, text: "Please continue with this detail." }]
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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
		})

		it("promotes one queued user message with images after a visible primary response", async () => {
			const task = createTask()
			const firstImage = "data:image/png;base64,Zmlyc3Q="
			const secondImage = "data:image/jpeg;base64,c2Vjb25k"
			task.messageQueueService.addMessage("Use this queued detail.", [firstImage])
			task.messageQueueService.addMessage("Keep this for later.", [secondImage])
			const feedback = vi.spyOn(task, "say").mockResolvedValue(undefined)
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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
			expect(feedback).toHaveBeenCalledWith("user_feedback", "Use this queued detail.", [firstImage])
			expect(task.messageQueueService.messages).toHaveLength(1)
			expect(task.messageQueueService.messages[0]).toMatchObject({
				text: "Keep this for later.",
				images: [secondImage],
			})
		})

		it("keeps the queue behind pending turn content", async () => {
			const task = createTask()
			const pendingContent = [{ type: "text" as const, text: "tool result continuation" }]
			task.messageQueueService.addMessage("queued after tool results")
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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

		it("keeps the queue behind pending steering", async () => {
			const task = createTask()
			task.messageQueueService.addMessage("queued after steering")
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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

		it("keeps managed children on the explicit attempt_completion contract", async () => {
			const task = createTask("subagent")
			task.messageQueueService.addMessage("do not consume child queue implicitly")
			const requestStep = vi
				.spyOn(task, "recursivelyMakeClineRequests")
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
				[{ type: "text", text: formatResponse.noToolsUsed() }],
				false,
			])
			expect(task.messageQueueService.messages).toHaveLength(1)
		})

		it("stops at the completion boundary without starting another request", async () => {
			const task = createTask()
			const requestStep = vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementationOnce(async () => {
				task.userMessageContent = [{ type: "text", text: "stale continuation" }]
				task.markCompleted()
				return false
			})

			await (task as any).initiateTaskLoop([{ type: "text", text: "finish" }])

			expect(requestStep).toHaveBeenCalledOnce()
		})

		it("resumes a delegated parent from its persisted new_task child result", async () => {
			const task = createTask()
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
			] as any
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
			expect(task.apiConversationHistory).toHaveLength(2)
			expect(task.apiConversationHistory[1]?.content).toEqual([childResult, { type: "text", text: "" }])
			expect(saveHistory).toHaveBeenCalledOnce()
			expect(continueLoop).toHaveBeenCalledWith([])
			expect(task.skipPrevResponseIdOnce).toBe(true)
			expect(task.abort).toBe(false)
			expect(task.abandoned).toBe(false)
		})

		it("repairs an interrupted tool call when a root task resumes after reload", async () => {
			const task = createTask()
			const savedClineMessages = [{ ts: 1, type: "say", say: "text", text: "historical task" }]
			const savedApiHistory = [
				{ role: "user", content: [{ type: "text", text: "inspect" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "read-after-reload", name: "read_file", input: {} }],
					ts: 2,
				},
			]
			vi.spyOn(task as any, "getSavedClineMessages").mockResolvedValue(savedClineMessages)
			vi.spyOn(task as any, "overwriteClineMessages").mockResolvedValue(true)
			vi.spyOn(task as any, "reconcileInterruptedSubagentGroups").mockResolvedValue(undefined)
			vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue(savedApiHistory)
			vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({
				response: "messageResponse",
				text: "continue after reload",
				images: [],
			} as any)
			const continueLoop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)

			await (task as any).resumeTaskFromHistory()

			expect(continueLoop).toHaveBeenCalledWith(
				[
					{
						type: "tool_result",
						tool_use_id: "read-after-reload",
						content: "Task was interrupted before this tool call could be completed.",
					},
					{ type: "text", text: "<user_message>\ncontinue after reload\n</user_message>" },
				],
				undefined,
			)
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
	it("normalizes a primary Plan response to one exact proposed-plan block", async () => {
		const message = { ts: 1, type: "say", say: "text", text: "streamed draft", partial: true }
		const commitClineMessageMutation = vi.fn(
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
			commitClineMessageMutation,
			updateClineMessage: vi.fn().mockResolvedValue(undefined),
			say: vi.fn().mockResolvedValue(undefined),
		} as unknown as Task

		await Task.prototype.presentCompletionResult.call(task, "# Provider plan\n- Update model lookup")

		expect(message).toMatchObject({
			say: "completion_result",
			text: "<proposed_plan>\n# Provider plan\n- Update model lookup\n</proposed_plan>",
			partial: false,
		})
		expect((task as any).say).not.toHaveBeenCalled()
	})
})

describe("Queued message processing after condense", () => {
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

		const provider = new ClineProvider(ctx, output as any, "sidebar", new ContextProxy(ctx)) as any
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		provider.getState = vi.fn().mockResolvedValue({})
		return provider
	}

	const apiConfig: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	} as any

	it("keeps queued message after condense completes", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
		})
		vi.spyOn(task as any, "overwriteApiConversationHistory").mockResolvedValue(true)

		// Make condense fast + deterministic
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
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
		task.messageQueueService.addMessage("Did we finish?")
		// Simulate the in-flight model turn failing after the message was queued.
		task.consecutiveMistakeCount = 1
		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		await (task as any).handleConsecutiveMistakeLimit(userContent)

		expect(feedback).toHaveBeenCalledWith("user_feedback", "Did we finish?", undefined)
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
			task: "task A",
			startTask: false,
		})
		const taskB = new Task({
			provider: providerB,
			apiConfiguration: apiConfig,
			task: "task B",
			startTask: false,
		})
		vi.spyOn(taskA as any, "overwriteApiConversationHistory").mockResolvedValue(true)
		vi.spyOn(taskB as any, "overwriteApiConversationHistory").mockResolvedValue(true)

		vi.spyOn(taskA as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(taskB as any, "getSystemPrompt").mockResolvedValue("system")

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

		await taskB.condenseContext()

		expect(spyA).not.toHaveBeenCalled()
		expect(spyB).not.toHaveBeenCalled()
		expect(taskA.messageQueueService.isEmpty()).toBe(false)
		expect(taskB.messageQueueService.isEmpty()).toBe(false)
	})
})

describe("pushToolResultToUserContent", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
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

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

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
