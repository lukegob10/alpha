import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleCheckpointRestoreOperation, restartTaskFromMessage } from "../checkpointRestoreHandler"
import { saveTaskMessages } from "../../task-persistence"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

// Mock dependencies
vi.mock("../../task-persistence", () => ({
	saveTaskMessages: vi.fn(),
}))
vi.mock("p-wait-for")
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

describe("checkpointRestoreHandler", () => {
	let mockProvider: any
	let mockCline: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock Alpha instance
		mockCline = {
			taskId: "test-task-123",
			abort: false,
			abortTask: vi.fn(() => {
				mockCline.abort = true
			}),
			waitForTermination: vi.fn(async () => undefined),
			checkpointRestore: vi.fn(),
			messageManager: { rewindToTimestamp: vi.fn() },
			clineMessages: [
				{ ts: 1, type: "user", say: "user", text: "First message" },
				{ ts: 2, type: "assistant", say: "assistant", text: "Response" },
				{
					ts: 3,
					type: "user",
					say: "user",
					text: "Checkpoint message",
					checkpoint: { hash: "abc123" },
				},
				{ ts: 4, type: "assistant", say: "assistant", text: "After checkpoint" },
			],
		}

		// Setup mock provider
		mockProvider = {
			getCurrentTask: vi.fn(() => mockCline),
			getLiveTask: vi.fn(() => mockCline),
			runWorkspaceMutation: vi.fn(async (_task, _label, run) => run()),
			postMessageToWebview: vi.fn(),
			getTaskWithId: vi.fn(() => ({
				historyItem: { id: "test-task-123", messages: mockCline.clineMessages },
			})),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({ resumeWithEditedMessage: vi.fn() }),
			contextProxy: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
		}

		// Mock pWaitFor to resolve immediately
		;(pWaitFor as any).mockImplementation(async (condition: () => boolean) => {
			// Simulate the condition being met
			return Promise.resolve()
		})
	})

	describe("handleCheckpointRestoreOperation", () => {
		it("joins cancellation before rewinding and coalesces duplicate restarts", async () => {
			let release!: () => void
			mockCline.waitForTermination.mockReturnValue(
				new Promise<void>((resolve) => {
					release = resolve
				}),
			)
			const restart = restartTaskFromMessage(mockProvider, mockCline, 3, "Replacement")
			await vi.waitFor(() => expect(mockCline.waitForTermination).toHaveBeenCalledOnce())
			await restartTaskFromMessage(mockProvider, mockCline, 3, "Duplicate")
			expect(mockCline.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
			expect(mockProvider.createTaskWithHistoryItem).not.toHaveBeenCalled()
			release()
			await restart
			expect(mockCline.abortTask).toHaveBeenCalledOnce()
			const resumed = await mockProvider.createTaskWithHistoryItem.mock.results[0].value
			expect(resumed.resumeWithEditedMessage).toHaveBeenCalledExactlyOnceWith("Replacement", undefined)
		})

		it("leaves history intact if cancellation fails", async () => {
			mockCline.waitForTermination.mockRejectedValue(new Error("Persistence failed"))
			await expect(restartTaskFromMessage(mockProvider, mockCline, 3, "Replacement")).rejects.toThrow(
				"Persistence failed",
			)
			expect(mockCline.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
			expect(mockProvider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		})

		it("rejects a replaced task before modifying its history", async () => {
			mockProvider.getLiveTask.mockReturnValue({ taskId: mockCline.taskId })
			await expect(restartTaskFromMessage(mockProvider, mockCline, 3, "Replacement")).rejects.toThrow(
				"task changed",
			)
			expect(mockCline.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
		})

		it("should abort task before checkpoint restore for delete operations", async () => {
			// Simulate a task that hasn't been aborted yet
			mockCline.abort = false

			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})

			// Verify abortTask was called before checkpointRestore
			expect(mockCline.abortTask).toHaveBeenCalled()
			expect(mockCline.checkpointRestore).toHaveBeenCalled()

			// Verify the order of operations
			const abortOrder = mockCline.abortTask.mock.invocationCallOrder[0]
			const restoreOrder = mockCline.checkpointRestore.mock.invocationCallOrder[0]
			expect(abortOrder).toBeLessThan(restoreOrder)
		})

		it("waits for task termination before restoring or rewriting delete history", async () => {
			let releaseTermination!: () => void
			const termination = new Promise<void>((resolve) => {
				releaseTermination = resolve
			})
			mockCline.waitForTermination.mockImplementation(async () => termination)

			const restore = handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})
			await vi.waitFor(() => expect(mockCline.waitForTermination).toHaveBeenCalledOnce())
			expect(mockCline.checkpointRestore).not.toHaveBeenCalled()

			releaseTermination()
			await restore
			expect(mockCline.checkpointRestore).toHaveBeenCalledOnce()
		})

		it("should not abort task if already aborted", async () => {
			// Simulate a task that's already aborted
			mockCline.abort = true

			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})

			// Verify abortTask was not called
			expect(mockCline.abortTask).not.toHaveBeenCalled()
			expect(mockCline.checkpointRestore).toHaveBeenCalled()
		})

		it("restores, rewinds, and resumes edits without a timed handoff", async () => {
			const editData = {
				editedContent: "Edited content",
				images: ["image1.png"],
				apiConversationHistoryIndex: 2,
			}

			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "edit",
				editData,
			})

			expect(mockCline.abortTask).toHaveBeenCalledOnce()
			expect(mockCline.messageManager.rewindToTimestamp).toHaveBeenCalledWith(3, { includeTargetMessage: false })
			expect(mockProvider.createTaskWithHistoryItem).toHaveBeenCalledWith(
				expect.objectContaining({ id: mockCline.taskId }),
				{ startTask: false, preserveExisting: true, background: false },
			)
			const resumed = await mockProvider.createTaskWithHistoryItem.mock.results[0].value
			expect(resumed.resumeWithEditedMessage).toHaveBeenCalledWith("Edited content", ["image1.png"])

			// Verify checkpoint restore was called with edit operation
			expect(mockCline.checkpointRestore).toHaveBeenCalledWith({
				ts: 3,
				commitHash: "abc123",
				mode: "restore",
				operation: "edit",
			})
		})

		it("should save messages after delete operation", async () => {
			// Mock the checkpoint restore to simulate message deletion
			mockCline.checkpointRestore.mockImplementation(async () => {
				mockCline.clineMessages = mockCline.clineMessages.slice(0, 2)
			})

			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})

			// Verify saveTaskMessages was called
			expect(saveTaskMessages).toHaveBeenCalledWith({
				messages: mockCline.clineMessages,
				taskId: "test-task-123",
				globalStoragePath: "/test/storage",
			})

			// Verify createTaskWithHistoryItem was called
			expect(mockProvider.createTaskWithHistoryItem).toHaveBeenCalled()
		})

		it("should reinitialize task with correct history item after delete", async () => {
			const expectedHistoryItem = {
				id: "test-task-123",
				messages: mockCline.clineMessages,
			}

			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "delete",
			})

			// Verify getTaskWithId was called
			expect(mockProvider.getTaskWithId).toHaveBeenCalledWith("test-task-123")

			// Verify createTaskWithHistoryItem was called with the correct history item
			expect(mockProvider.createTaskWithHistoryItem).toHaveBeenCalledWith(expectedHistoryItem)
		})

		it("preserves the foreground task when restarting a background conversation", async () => {
			const editData = {
				editedContent: "Edited content",
				images: [],
				apiConversationHistoryIndex: 2,
			}

			mockProvider.getCurrentTask.mockReturnValue({ taskId: "another-task" })
			await handleCheckpointRestoreOperation({
				provider: mockProvider,
				currentCline: mockCline,
				messageTs: 3,
				messageIndex: 2,
				checkpoint: { hash: "abc123" },
				operation: "edit",
				editData,
			})

			// Verify saveTaskMessages was NOT called for edit operation
			expect(saveTaskMessages).not.toHaveBeenCalled()

			// Rehydrate the addressed task without changing focus.
			expect(mockProvider.createTaskWithHistoryItem).toHaveBeenCalledWith(
				expect.objectContaining({ id: mockCline.taskId }),
				{ startTask: false, preserveExisting: true, background: true },
			)
		})

		it("should handle errors gracefully", async () => {
			// Mock checkpoint restore to throw an error
			mockCline.checkpointRestore.mockRejectedValue(new Error("Checkpoint restore failed"))

			// The function should throw and show an error message
			await expect(
				handleCheckpointRestoreOperation({
					provider: mockProvider,
					currentCline: mockCline,
					messageTs: 3,
					messageIndex: 2,
					checkpoint: { hash: "abc123" },
					operation: "delete",
				}),
			).rejects.toThrow("Checkpoint restore failed")

			// Verify error message was shown
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Error during checkpoint restore: Checkpoint restore failed",
			)
		})
	})
})
