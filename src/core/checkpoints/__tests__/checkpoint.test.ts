import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { checkpointSave, checkpointRestore, checkpointDiff, getCheckpointService } from "../index"
import { MessageManager } from "../../message-manager"
import * as vscode from "vscode"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn(() => ({})),
		showInformationMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn((path: string) => ({ fsPath: path })),
		parse: vi.fn((uri: string) => ({ with: vi.fn(() => ({})) })),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

// Mock other dependencies
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn(() => "/test/workspace"),
}))

vi.mock("../../../utils/git", () => ({
	checkGitInstalled: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, options?: Record<string, any>) => {
		if (key === "common:errors.wait_checkpoint_long_time") {
			return `Checkpoint initialization is taking longer than ${options?.timeout} seconds...`
		}
		if (key === "common:errors.init_checkpoint_fail_long_time") {
			return `Checkpoint initialization failed after ${options?.timeout} seconds`
		}
		return key
	}),
}))

vi.mock("../../../services/checkpoints")

describe("Checkpoint functionality", () => {
	let mockProvider: any
	let mockTask: any
	let mockCheckpointService: any

	beforeEach(async () => {
		// Create mock checkpoint service
		mockCheckpointService = {
			isInitialized: true,
			saveCheckpoint: vi.fn().mockResolvedValue({ commit: "test-commit-hash" }),
			restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
			getDiff: vi.fn().mockResolvedValue([]),
			on: vi.fn(),
			initShadowGit: vi.fn().mockImplementation(async () => {
				mockCheckpointService.isInitialized = true
			}),
		}

		// Create mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
			postStateToWebview: vi.fn(),
			cancelTask: vi.fn(),
		}

		// Create mock task
		mockTask = {
			taskId: "test-task-id",
			abort: false,
			abortTask: vi.fn().mockResolvedValue(undefined),
			waitForTermination: vi.fn().mockResolvedValue(undefined),
			enableCheckpoints: true,
			checkpointService: mockCheckpointService,
			checkpointServiceInitializing: false,
			checkpointTimeout: 30,
			providerRef: {
				deref: () => mockProvider,
			},
			clineMessages: [],
			apiConversationHistory: [],
			pendingUserMessageCheckpoint: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			overwriteAlphaMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			combineMessages: vi.fn().mockReturnValue([]),
		}
		mockTask.messageManager = new MessageManager(mockTask)

		// Update the mock to return our mockCheckpointService
		const checkpointsModule = await import("../../../services/checkpoints")
		const pathModule = await import("../../../utils/path")
		const gitModule = await import("../../../utils/git")
		vi.mocked(checkpointsModule.RepoPerTaskCheckpointService.create).mockReturnValue(mockCheckpointService)
		vi.mocked(pathModule.getWorkspacePath).mockReturnValue("/test/workspace")
		vi.mocked(gitModule.checkGitInstalled).mockResolvedValue(true)
	})

	afterEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
	})

	describe("checkpointSave", () => {
		it("should wait for checkpoint service initialization before saving", async () => {
			// Start initialization through the same path used by the task loop.
			mockCheckpointService.isInitialized = false
			mockTask.checkpointService = undefined

			// Call checkpointSave
			const savePromise = checkpointSave(mockTask, true)

			// Wait for the save to complete
			const result = await savePromise

			// saveCheckpoint should have been called
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledWith(
				expect.stringContaining("Task: test-task-id"),
				{ allowEmpty: true, suppressMessage: false },
			)

			// Result should contain the commit hash
			expect(result).toEqual({ commit: "test-commit-hash" })

			// Task should still have checkpoints enabled
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		it("should handle timeout when service doesn't initialize", async () => {
			// Service never initializes
			mockCheckpointService.isInitialized = false

			// Call checkpointSave with a task that has no checkpoint service
			const taskWithNoService = {
				...mockTask,
				checkpointService: undefined,
				enableCheckpoints: false,
			}

			const result = await checkpointSave(taskWithNoService, true)

			// Result should be undefined
			expect(result).toBeUndefined()

			// saveCheckpoint should not have been called
			expect(mockCheckpointService.saveCheckpoint).not.toHaveBeenCalled()
		})

		it("should preserve checkpoint data through message deletion flow", async () => {
			// Initialize service
			mockCheckpointService.isInitialized = true
			mockTask.checkpointService = mockCheckpointService

			// Simulate saving checkpoint before user message
			const checkpointResult = await checkpointSave(mockTask, true)
			expect(checkpointResult).toEqual({ commit: "test-commit-hash" })

			// Simulate setting pendingUserMessageCheckpoint
			if (checkpointResult && "commit" in checkpointResult) {
				mockTask.pendingUserMessageCheckpoint = {
					hash: checkpointResult.commit,
					timestamp: Date.now(),
					type: "user_message",
				}
			}

			// Verify checkpoint data is preserved
			expect(mockTask.pendingUserMessageCheckpoint).toBeDefined()
			expect(mockTask.pendingUserMessageCheckpoint.hash).toBe("test-commit-hash")

			// Simulate message deletion and reinitialization
			mockTask.clineMessages = []
			mockTask.checkpointService = mockCheckpointService // Keep service available
			mockTask.checkpointServiceInitializing = false

			// Save checkpoint again after deletion
			const newCheckpointResult = await checkpointSave(mockTask, true)

			// Should still work after reinitialization
			expect(newCheckpointResult).toEqual({ commit: "test-commit-hash" })
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		it("should handle errors gracefully and disable checkpoints", async () => {
			mockCheckpointService.saveCheckpoint.mockRejectedValue(new Error("Save failed"))

			const result = await checkpointSave(mockTask)

			expect(result).toBeUndefined()
			expect(mockTask.enableCheckpoints).toBe(false)
		})
	})

	describe("checkpointRestore", () => {
		it("persists deleted usage after abort without calling the agent output path", async () => {
			mockTask.abortTask.mockImplementation(async () => {
				mockTask.abort = true
			})
			mockTask.say.mockImplementation(async () => {
				if (mockTask.abort) throw new Error("Task aborted")
			})
			mockTask.overwriteAlphaMessages.mockImplementation(async (messages: unknown[]) => {
				mockTask.clineMessages = messages
			})
			await checkpointRestore(mockTask, { ts: 2, commitHash: "abc123", mode: "restore", operation: "edit" })
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(mockTask.clineMessages.at(-1)).toEqual(
				expect.objectContaining({ type: "say", say: "api_req_deleted" }),
			)
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		beforeEach(() => {
			mockTask.clineMessages = [
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "assistant", text: "Message 2" },
				{ ts: 3, say: "user", text: "Message 3" },
			]
			mockTask.apiConversationHistory = [
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
				{ ts: 2, role: "assistant", content: [{ type: "text", text: "Message 2" }] },
				{ ts: 3, role: "user", content: [{ type: "text", text: "Message 3" }] },
			]
		})

		it("should restore checkpoint for delete operation", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: "abc123",
				mode: "restore",
				operation: "delete",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith("abc123")
			expect(mockTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
			])
			expect(mockTask.overwriteAlphaMessages).toHaveBeenCalledWith([{ ts: 1, say: "user", text: "Message 1" }])
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
			expect(mockTask.abortTask).toHaveBeenCalledOnce()
			expect(mockTask.waitForTermination).toHaveBeenCalledOnce()
		})

		it("should restore checkpoint for edit operation", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: "abc123",
				mode: "restore",
				operation: "edit",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith("abc123")
			expect(mockTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
			])
			// For edit operation, should include the message being edited
			expect(mockTask.overwriteAlphaMessages).toHaveBeenCalledWith([
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "assistant", text: "Message 2" },
			])
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})

		it("should handle preview mode without modifying messages", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: "abc123",
				mode: "preview",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith("abc123")
			expect(mockTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
			expect(mockTask.overwriteAlphaMessages).not.toHaveBeenCalled()
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})

		it("joins task termination before restoring the workspace or rewinding messages", async () => {
			const order: string[] = []
			let releaseTermination!: () => void
			const termination = new Promise<void>((resolve) => {
				releaseTermination = resolve
			})
			mockTask.abortTask.mockImplementation(async () => {
				order.push("abort")
			})
			mockTask.waitForTermination.mockImplementation(async () => {
				order.push("wait-start")
				await termination
				order.push("wait-complete")
			})
			mockCheckpointService.restoreCheckpoint.mockImplementation(async () => {
				order.push("restore-workspace")
			})
			mockTask.messageManager.rewindToTimestamp = vi.fn().mockImplementation(async () => {
				order.push("rewind-messages")
			})

			const restore = checkpointRestore(mockTask, {
				ts: 2,
				commitHash: "abc123",
				mode: "restore",
				operation: "delete",
			})

			await vi.waitFor(() => expect(mockTask.waitForTermination).toHaveBeenCalledOnce())
			expect(order).toEqual(["abort", "wait-start"])
			expect(mockCheckpointService.restoreCheckpoint).not.toHaveBeenCalled()
			expect(mockTask.messageManager.rewindToTimestamp).not.toHaveBeenCalled()

			releaseTermination()
			await restore

			expect(order).toEqual(["abort", "wait-start", "wait-complete", "restore-workspace", "rewind-messages"])
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})

		it("should handle missing message gracefully", async () => {
			await checkpointRestore(mockTask, {
				ts: 999, // Non-existent timestamp
				commitHash: "abc123",
				mode: "restore",
			})

			expect(mockCheckpointService.restoreCheckpoint).not.toHaveBeenCalled()
		})

		it("should disable checkpoints and propagate restore errors to the caller", async () => {
			mockCheckpointService.restoreCheckpoint.mockRejectedValue(new Error("Restore failed"))

			await expect(
				checkpointRestore(mockTask, {
					ts: 2,
					commitHash: "abc123",
					mode: "restore",
				}),
			).rejects.toThrow("Restore failed")

			expect(mockTask.enableCheckpoints).toBe(false)
			expect(mockProvider.log).toHaveBeenCalledWith("[checkpointRestore] disabling checkpoints for this task")
			expect(mockTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
			expect(mockTask.overwriteAlphaMessages).not.toHaveBeenCalled()
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})
	})

	describe("checkpointDiff", () => {
		beforeEach(() => {
			mockTask.clineMessages = [
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "checkpoint_saved", text: "commit1" },
				{ ts: 3, say: "user", text: "Message 2" },
				{ ts: 4, say: "checkpoint_saved", text: "commit2" },
			]
		})

		it("should show diff for to-current mode", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: "commit2",
				mode: "to-current",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: "commit2",
				to: undefined,
			})
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.changes",
				"common:errors.checkpoint_diff_to_current",
				expect.any(Array),
			)
		})

		it("should show diff for checkpoint mode with next commit", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)
			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: "commit1",
				mode: "checkpoint",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: "commit1",
				to: "commit2",
			})
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.changes",
				"common:errors.checkpoint_diff_with_next",
				expect.any(Array),
			)
		})

		it("should find next checkpoint automatically in checkpoint mode", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: "commit1",
				mode: "checkpoint",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: "commit1", // Should find the next checkpoint
				to: "commit2",
			})
		})

		it("should show information message when no changes found", async () => {
			mockCheckpointService.getDiff.mockResolvedValue([])

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: "commit2",
				mode: "to-current",
			})

			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:errors.checkpoint_no_changes")
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		})

		it("should disable checkpoints on error", async () => {
			mockCheckpointService.getDiff.mockRejectedValue(new Error("Diff failed"))

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: "commit2",
				mode: "to-current",
			})

			expect(mockTask.enableCheckpoints).toBe(false)
			expect(mockProvider.log).toHaveBeenCalledWith("[checkpointDiff] disabling checkpoints for this task")
		})
	})

	describe("getCheckpointService", () => {
		it("should return existing service if available", async () => {
			const service = await getCheckpointService(mockTask)
			expect(service).toBe(mockCheckpointService)
		})

		it("should return undefined if checkpoints are disabled", async () => {
			mockTask.enableCheckpoints = false
			const service = await getCheckpointService(mockTask)
			expect(service).toBeUndefined()
		})

		it("should create one shared initialization for simultaneous callers", async () => {
			mockTask.checkpointService = undefined
			mockCheckpointService.isInitialized = false

			let releaseInitialization!: () => void
			const initializationBarrier = new Promise<void>((resolve) => {
				releaseInitialization = resolve
			})
			mockCheckpointService.initShadowGit.mockImplementationOnce(async () => {
				await initializationBarrier
				mockCheckpointService.isInitialized = true
			})

			const first = getCheckpointService(mockTask)
			const second = getCheckpointService(mockTask)
			const third = getCheckpointService(mockTask)

			const checkpointsModule = await import("../../../services/checkpoints")
			expect(vi.mocked(checkpointsModule.RepoPerTaskCheckpointService.create)).toHaveBeenCalledWith({
				taskId: "test-task-id",
				workspaceDir: "/test/workspace",
				shadowDir: "/test/storage",
				log: expect.any(Function),
			})
			expect(vi.mocked(checkpointsModule.RepoPerTaskCheckpointService.create)).toHaveBeenCalledOnce()
			expect(mockCheckpointService.initShadowGit).toHaveBeenCalledOnce()

			releaseInitialization()

			await expect(Promise.all([first, second, third])).resolves.toEqual([
				mockCheckpointService,
				mockCheckpointService,
				mockCheckpointService,
			])
			expect(mockTask.checkpointService).toBe(mockCheckpointService)
		})

		it("should disable checkpoints if workspace path is not found", async () => {
			const pathModule = await import("../../../utils/path")
			vi.mocked(pathModule.getWorkspacePath).mockReturnValue(null as any)

			mockTask.checkpointService = undefined
			mockTask.checkpointServiceInitializing = false

			const service = await getCheckpointService(mockTask)

			expect(service).toBeUndefined()
			expect(mockTask.enableCheckpoints).toBe(false)
		})

		it("should settle all waiters immediately when Git is unavailable", async () => {
			const gitModule = await import("../../../utils/git")
			vi.mocked(gitModule.checkGitInstalled).mockResolvedValue(false)
			mockTask.checkpointService = undefined

			const first = getCheckpointService(mockTask)
			const second = getCheckpointService(mockTask)
			await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

			expect(mockTask.enableCheckpoints).toBe(false)
			expect(mockTask.checkpointServiceInitializing).toBe(false)
			expect(mockCheckpointService.initShadowGit).not.toHaveBeenCalled()
		})

		it("should settle all waiters immediately when initialization fails", async () => {
			mockTask.checkpointService = undefined
			mockCheckpointService.isInitialized = false
			mockCheckpointService.initShadowGit.mockRejectedValueOnce(new Error("init failed"))

			const first = getCheckpointService(mockTask)
			const second = getCheckpointService(mockTask)
			await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

			expect(mockTask.enableCheckpoints).toBe(false)
			expect(mockTask.checkpointServiceInitializing).toBe(false)
			expect(mockTask.checkpointService).toBeUndefined()
		})
	})

	describe("getCheckpointService - initialization timeout behavior", () => {
		it("should warn after five seconds and time out waiting callers once", async () => {
			vi.useFakeTimers()
			mockTask.checkpointService = undefined
			mockTask.checkpointTimeout = 10
			mockCheckpointService.isInitialized = false

			let releaseInitialization!: () => void
			const initializationBarrier = new Promise<void>((resolve) => {
				releaseInitialization = resolve
			})
			mockCheckpointService.initShadowGit.mockImplementationOnce(async () => {
				await initializationBarrier
				mockCheckpointService.isInitialized = true
			})

			const backgroundInitialization = getCheckpointService(mockTask)
			const waiter = getCheckpointService(mockTask)

			await vi.advanceTimersByTimeAsync(5000)
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: { type: "WAIT_TIMEOUT", timeout: 5 },
			})

			await vi.advanceTimersByTimeAsync(5000)
			await expect(waiter).resolves.toBeUndefined()
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: { type: "INIT_TIMEOUT", timeout: 10 },
			})
			expect(mockTask.enableCheckpoints).toBe(false)
			await expect(Promise.all([backgroundInitialization, waiter])).resolves.toEqual([undefined, undefined])

			releaseInitialization()
			mockTask.enableCheckpoints = true
			await vi.advanceTimersByTimeAsync(0)
			await expect(backgroundInitialization).resolves.toBeUndefined()
			expect(mockTask.checkpointService).toBeUndefined()
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(2)
		})

		it("should settle the shared promise when checkpoints are disabled during initialization", async () => {
			vi.useFakeTimers()
			mockTask.checkpointService = undefined
			mockTask.checkpointTimeout = 10
			mockCheckpointService.isInitialized = false

			let releaseInitialization!: () => void
			const initializationBarrier = new Promise<void>((resolve) => {
				releaseInitialization = resolve
			})
			mockCheckpointService.initShadowGit.mockImplementationOnce(async () => {
				await initializationBarrier
				mockCheckpointService.isInitialized = true
			})

			const backgroundInitialization = getCheckpointService(mockTask)
			const waiter = getCheckpointService(mockTask)
			mockTask.enableCheckpoints = false

			await vi.advanceTimersByTimeAsync(10000)
			await expect(Promise.all([backgroundInitialization, waiter])).resolves.toEqual([undefined, undefined])
			expect(mockTask.checkpointServiceInitializing).toBe(false)

			releaseInitialization()
			await vi.advanceTimersByTimeAsync(0)
			await expect(backgroundInitialization).resolves.toBeUndefined()
			expect(mockTask.checkpointService).toBeUndefined()
		})

		it("should clear the warning and avoid timeout when initialization succeeds", async () => {
			vi.useFakeTimers()
			mockTask.checkpointService = undefined
			mockTask.checkpointTimeout = 10
			mockCheckpointService.isInitialized = false

			let releaseInitialization!: () => void
			const initializationBarrier = new Promise<void>((resolve) => {
				releaseInitialization = resolve
			})
			mockCheckpointService.initShadowGit.mockImplementationOnce(async () => {
				await initializationBarrier
				mockCheckpointService.isInitialized = true
			})

			const backgroundInitialization = getCheckpointService(mockTask)
			const waiter = getCheckpointService(mockTask)

			await vi.advanceTimersByTimeAsync(5000)
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: { type: "WAIT_TIMEOUT", timeout: 5 },
			})

			releaseInitialization()
			await expect(Promise.all([backgroundInitialization, waiter])).resolves.toEqual([
				mockCheckpointService,
				mockCheckpointService,
			])
			expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: undefined,
			})

			await vi.advanceTimersByTimeAsync(10000)
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: { type: "INIT_TIMEOUT", timeout: 10 },
			})
		})
	})
})
