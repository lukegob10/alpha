import type { Mock } from "vitest"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies first
vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
			update: vi.fn(),
		}),
	},
	Uri: {
		file: vi.fn((path) => ({ fsPath: path })),
	},
	env: {
		uriScheme: "vscode",
	},
}))

vi.mock("../../task-persistence", () => ({
	saveTaskMessages: vi.fn(),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn(),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../checkpointRestoreHandler", async (importOriginal) => ({
	...(await importOriginal<typeof import("../checkpointRestoreHandler")>()),
	handleCheckpointRestoreOperation: vi.fn(),
}))

// Import after mocks
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"
import type { AlphaMessage } from "@alpha-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { MessageManager } from "../../message-manager"
import { handleCheckpointRestoreOperation } from "../checkpointRestoreHandler"

describe("webviewMessageHandler - Edit Message with Timestamp Fallback", () => {
	let mockAlphaProvider: AlphaProvider
	let mockCurrentTask: any

	it.each([false, true])(
		"resends the opening prompt in the addressed task with images (checkpoint: %s)",
		async (restoreCheckpoint) => {
			const images = ["data:image/png;base64,aGVsbG8="]
			mockCurrentTask.clineMessages = [
				{ ts: 1000, type: "say", say: "text", text: "Original prompt" },
				{ ts: 1001, type: "say", say: "checkpoint_saved", text: "original-checkpoint" },
				{ ts: 2000, type: "say", say: "completion_result", text: "Original answer" },
			]
			mockCurrentTask.apiConversationHistory = [
				{ ts: 1000, role: "user", content: [{ type: "text", text: "Original prompt" }] },
			]
			mockCurrentTask.submitUserMessage = vi.fn()
			mockCurrentTask.overwriteAlphaMessages.mockImplementation(async (messages: AlphaMessage[]) => {
				mockCurrentTask.clineMessages = messages
			})
			mockAlphaProvider.postStateToWebview = vi.fn()
			mockAlphaProvider.getLiveTask = vi.fn().mockReturnValue(mockCurrentTask)
			const otherTask = { taskId: "different-task", clineMessages: [], apiConversationHistory: [] }
			;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(otherTask)
			await webviewMessageHandler(mockAlphaProvider, {
				type: "submitEditedMessage",
				taskId: mockCurrentTask.taskId,
				value: 1000,
				editedMessageContent: "",
				images,
				messageAction: "restart",
			})
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				taskId: mockCurrentTask.taskId,
				messageTs: 1000,
				text: "",
				images,
				hasCheckpoint: true,
				messageAction: "restart",
			})
			await webviewMessageHandler(mockAlphaProvider, {
				type: "editMessageConfirm",
				taskId: mockCurrentTask.taskId,
				messageTs: 1000,
				text: "",
				images,
				restoreCheckpoint,
			})
			if (restoreCheckpoint) {
				expect(handleCheckpointRestoreOperation).toHaveBeenCalledWith(
					expect.objectContaining({
						currentAlpha: mockCurrentTask,
						messageTs: 1000,
						checkpoint: { hash: "original-checkpoint" },
						editData: expect.objectContaining({ editedContent: "", images }),
					}),
				)
			} else {
				expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([])
				expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
				const resumed = await vi.mocked(mockAlphaProvider.createTaskWithHistoryItem).mock.results[0].value
				expect(resumed.resumeWithEditedMessage).toHaveBeenCalledWith("", images)
			}
			expect(otherTask.clineMessages).toEqual([])
		},
	)

	it("does not fall back to the foreground task for a stale task ID", async () => {
		mockAlphaProvider.getLiveTask = vi.fn().mockReturnValue(undefined)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			taskId: "closed-task",
			messageTs: 1000,
			text: "Retry",
		})
		expect(mockCurrentTask.overwriteAlphaMessages).not.toHaveBeenCalled()
		expect(mockAlphaProvider.getCurrentTask).not.toHaveBeenCalled()
	})

	beforeEach(() => {
		vi.clearAllMocks()

		// Create a mock task with messages
		mockCurrentTask = {
			taskId: "test-task-id",
			clineMessages: [] as AlphaMessage[],
			apiConversationHistory: [] as ApiMessage[],
			overwriteAlphaMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			abortTask: vi.fn(),
			waitForTermination: vi.fn(),
		}
		mockCurrentTask.messageManager = new MessageManager(mockCurrentTask)

		// Create mock provider
		mockAlphaProvider = {
			getCurrentTask: vi.fn().mockReturnValue(mockCurrentTask),
			getLiveTask: vi.fn().mockImplementation(() => mockCurrentTask),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "test-task-id" } }),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({ resumeWithEditedMessage: vi.fn() }),
			postMessageToWebview: vi.fn(),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				maxImageFileSize: 5,
				maxTotalImageSize: 20,
			}),
			getSubagentChangeSetActionCapability: vi.fn(),
			applySubagentChangeSet: vi.fn(),
			discardSubagentChangeSet: vi.fn(),
		} as unknown as AlphaProvider
	})

	it("should not modify API history when apiConversationHistoryIndex is -1", async () => {
		// Setup: User message followed by attempt_completion
		const userMessageTs = 1000
		const assistantMessageTs = 2000
		const completionMessageTs = 3000

		// UI messages (clineMessages)
		mockCurrentTask.clineMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as AlphaMessage,
			{
				ts: completionMessageTs,
				type: "say",
				say: "completion_result",
				text: "Task Completed!",
			} as AlphaMessage,
		]

		// API conversation history - note the user message is missing (common scenario after condense)
		mockCurrentTask.apiConversationHistory = [
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I'll help you with that.",
					},
				],
			},
			{
				ts: completionMessageTs,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "attempt_completion",
						id: "tool-1",
						input: {
							result: "Task Completed!",
						},
					},
				],
			},
		] as ApiMessage[]

		// Trigger edit confirmation
		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World", // edited content
			restoreCheckpoint: false,
		})

		// Verify that UI messages were truncated at the correct index
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith(
			[], // All messages before index 0 (empty array)
		)

		// API history should be truncated from first message at/after edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})

	it("should preserve messages before the edited message when message not in API history", async () => {
		const earlierMessageTs = 500
		const userMessageTs = 1000
		const assistantMessageTs = 2000

		// UI messages
		mockCurrentTask.clineMessages = [
			{
				ts: earlierMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Earlier message",
			} as AlphaMessage,
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as AlphaMessage,
			{
				ts: assistantMessageTs,
				type: "say",
				say: "text",
				text: "Response",
			} as AlphaMessage,
		]

		// API history - missing the exact user message at ts=1000
		mockCurrentTask.apiConversationHistory = [
			{
				ts: earlierMessageTs,
				role: "user",
				content: [{ type: "text", text: "Earlier message" }],
			},
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [{ type: "text", text: "Response" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// Verify UI messages were truncated to preserve earlier message
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([
			{
				ts: earlierMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Earlier message",
			},
		])

		// API history should be truncated from the first API message at/after the edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
			{
				ts: earlierMessageTs,
				role: "user",
				content: [{ type: "text", text: "Earlier message" }],
			},
		])
	})

	it("should not use fallback when exact apiConversationHistoryIndex is found", async () => {
		const userMessageTs = 1000
		const assistantMessageTs = 2000

		// Both UI and API have the message at the same timestamp
		mockCurrentTask.clineMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as AlphaMessage,
			{
				ts: assistantMessageTs,
				type: "say",
				say: "text",
				text: "Response",
			} as AlphaMessage,
		]

		mockCurrentTask.apiConversationHistory = [
			{
				ts: userMessageTs,
				role: "user",
				content: [{ type: "text", text: "Hello" }],
			},
			{
				ts: assistantMessageTs,
				role: "assistant",
				content: [{ type: "text", text: "Response" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// Both should be truncated at index 0
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([])
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})

	it("should handle case where no API messages match timestamp criteria", async () => {
		const userMessageTs = 3000

		mockCurrentTask.clineMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as AlphaMessage,
		]

		// All API messages have timestamps before the edited message
		mockCurrentTask.apiConversationHistory = [
			{
				ts: 1000,
				role: "assistant",
				content: [{ type: "text", text: "Old message 1" }],
			},
			{
				ts: 2000,
				role: "assistant",
				content: [{ type: "text", text: "Old message 2" }],
			},
		] as ApiMessage[]

		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// UI messages truncated
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([])

		// API history should not be modified when no API messages meet the timestamp criteria
		expect(mockCurrentTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("should handle empty API conversation history gracefully", async () => {
		const userMessageTs = 1000

		mockCurrentTask.clineMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Hello",
			} as AlphaMessage,
		]

		mockCurrentTask.apiConversationHistory = []

		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Hello World",
			restoreCheckpoint: false,
		})

		// UI messages should be truncated
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([])

		// API history should not be modified when message not found
		expect(mockCurrentTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("should correctly handle attempt_completion in API history", async () => {
		const userMessageTs = 1000
		const completionTs = 2000
		const feedbackTs = 3000

		mockCurrentTask.clineMessages = [
			{
				ts: userMessageTs,
				type: "say",
				say: "user_feedback",
				text: "Do something",
			} as AlphaMessage,
			{
				ts: completionTs,
				type: "say",
				say: "completion_result",
				text: "Task Completed!",
			} as AlphaMessage,
			{
				ts: feedbackTs,
				type: "say",
				say: "user_feedback",
				text: "Thanks",
			} as AlphaMessage,
		]

		// API history with attempt_completion tool use (user message missing)
		mockCurrentTask.apiConversationHistory = [
			{
				ts: completionTs,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "attempt_completion",
						id: "tool-1",
						input: {
							result: "Task Completed!",
						},
					},
				],
			},
			{
				ts: feedbackTs,
				role: "user",
				content: [
					{
						type: "text",
						text: "Thanks",
					},
				],
			},
		] as ApiMessage[]

		// Edit the first user message
		await webviewMessageHandler(mockAlphaProvider, {
			type: "editMessageConfirm",
			messageTs: userMessageTs,
			text: "Do something else",
			restoreCheckpoint: false,
		})

		// UI messages truncated at edited message
		expect(mockCurrentTask.overwriteAlphaMessages).toHaveBeenCalledWith([])

		// API history should be truncated from first message at/after edited timestamp (fallback)
		expect(mockCurrentTask.overwriteApiConversationHistory).toHaveBeenCalledWith([])
	})

	it("routes Apply from the webview to the provider and returns the explicit result", async () => {
		const result = {
			action: "apply" as const,
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
			success: true,
			changeSetStatus: "applied" as const,
			message: "Worker changes were applied.",
		}
		vi.mocked(mockAlphaProvider.applySubagentChangeSet).mockResolvedValue(result)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "applySubagentChangeSet",
			taskId: "parent-1",
			groupId: "group-1",
			changeSetId: "change-1",
			requestId: "request-1",
		})

		expect(mockAlphaProvider.applySubagentChangeSet).toHaveBeenCalledWith("parent-1", "group-1", "change-1")
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "subagentChangeSetActionResult",
			requestId: "request-1",
			subagentChangeSetActionResult: result,
		})
	})
})
