// npx vitest run __tests__/history-resume-delegation.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { RooCodeEventName } from "@alpha-code/types"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

// Mock persistence BEFORE importing provider
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
}))

import { ClineProvider } from "../core/webview/ClineProvider"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { readApiMessages, saveApiMessages, saveTaskMessages } from "../core/task-persistence"

const createLiveChild = (taskId: string) => ({
	taskId,
	abort: false,
	getCompletionGateDecision: vi.fn(async () => ({ allowed: true, modelCanResolveRejection: true })),
	suspendAfterCurrentTurn: vi.fn(),
	messageQueueService: {
		on: vi.fn(),
		off: vi.fn(),
		isEmpty: vi.fn(() => true),
		addMessage: vi.fn(() => true),
	},
})

const runWorkspaceMutation = vi.fn(async (_task: unknown, _label: string, run: () => Promise<unknown>) => run())

describe("History resume delegation - parent metadata transitions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reopenParentFromDelegation persists parent metadata (delegated → active) before reopen", async () => {
		const providerEmit = vi.fn()
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: ["child-1"],
				ts: Date.now(),
				task: "Parent task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
				workspace: "/tmp",
			},
		})

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const liveChild = createLiveChild("child-1")
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({
			taskId: "parent-1",
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
		})

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId,
			emit: providerEmit,
			getCurrentTask: vi.fn(() => ({ taskId: "child-1" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack,
			createTaskWithHistoryItem,
			updateTaskHistory,
			runWorkspaceMutation,
		} as unknown as ClineProvider

		// Mock persistence reads to return empty arrays
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-1",
			childTaskId: "child-1",
			completionResultSummary: "Child done",
		})

		// Assert: metadata updated BEFORE createTaskWithHistoryItem
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				completedByChildId: "child-1",
				completionResultSummary: "Child done",
				awaitingChildId: undefined,
				childIds: ["child-1"],
			}),
		)

		// Verify call ordering: updateTaskHistory before createTaskWithHistoryItem
		const updateCall = updateTaskHistory.mock.invocationCallOrder[0]
		const createCall = createTaskWithHistoryItem.mock.invocationCallOrder[0]
		expect(updateCall).toBeLessThan(createCall)

		// Verify child closed and parent reopened with updated metadata
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "active",
				completedByChildId: "child-1",
			}),
			{ startTask: false, preserveExisting: true, background: true },
		)
	})

	it("reopenParentFromDelegation injects subtask_result into both UI and API histories", async () => {
		const liveChild = createLiveChild("c1")
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p1",
					status: "delegated",
					awaitingChildId: "c1",
					childIds: [],
					ts: 100,
					task: "Parent",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c1" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p1",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		// Start with existing messages in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "Old tool", ts: 50 }]
		const existingApiMessages = [{ role: "user", content: [{ type: "text", text: "Old request" }], ts: 50 }]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p1",
			childTaskId: "c1",
			completionResultSummary: "Subtask completed successfully",
		})

		// Verify UI history injection (say: subtask_result)
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						type: "say",
						say: "subtask_result",
						text: "Subtask completed successfully",
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
			}),
		)

		// Verify API history injection (user role message)
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "text",
								text: expect.stringContaining("Subtask c1 completed"),
							}),
						]),
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
			}),
		)

		// Verify both include original messages
		const uiCall = vi.mocked(saveTaskMessages).mock.calls[0][0]
		expect(uiCall.messages).toHaveLength(2) // 1 original + 1 injected

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(2) // 1 original + 1 injected
	})

	it("reopenParentFromDelegation injects tool_result when new_task tool_use exists in API history", async () => {
		const liveChild = createLiveChild("c-tool")
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p-tool",
					status: "delegated",
					awaitingChildId: "c-tool",
					childIds: [],
					ts: 100,
					task: "Parent with tool_use",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-tool" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		// Include an assistant message with new_task tool_use to exercise the tool_result path
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "new_task request", ts: 50 }]
		const existingApiMessages = [
			{ role: "user", content: [{ type: "text", text: "Create a subtask" }], ts: 40 },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "new_task",
						id: "toolu_abc123",
						input: { mode: "code", message: "Do something" },
					},
				],
				ts: 50,
			},
		]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-tool",
			childTaskId: "c-tool",
			completionResultSummary: "Subtask completed via tool_result",
		})

		// Verify API history injection uses tool_result (not text fallback)
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "tool_result",
								tool_use_id: "toolu_abc123",
								content: expect.stringContaining("Subtask c-tool completed"),
							}),
						]),
					}),
				]),
				taskId: "p-tool",
				globalStoragePath: "/storage",
			}),
		)

		// Verify total message count: 2 original + 1 injected user message with tool_result
		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(3)

		// Verify the injected message is a user message with tool_result type
		const injectedMsg = apiCall.messages[2]
		expect(injectedMsg.role).toBe("user")
		expect((injectedMsg.content[0] as any).type).toBe("tool_result")
		expect((injectedMsg.content[0] as any).tool_use_id).toBe("toolu_abc123")
	})

	it("reopenParentFromDelegation injects plain text when no new_task tool_use exists in API history", async () => {
		const liveChild = createLiveChild("c-no-tool")
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p-no-tool",
					status: "delegated",
					awaitingChildId: "c-no-tool",
					childIds: [],
					ts: 100,
					task: "Parent without tool_use",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-no-tool" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-no-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		// No assistant tool_use in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "subtask request", ts: 50 }]
		const existingApiMessages = [{ role: "user", content: [{ type: "text", text: "Create a subtask" }], ts: 40 }]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-no-tool",
			childTaskId: "c-no-tool",
			completionResultSummary: "Subtask completed without tool_use",
		})

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		// Should append a user text note
		expect(apiCall.messages).toHaveLength(2)
		const injected = apiCall.messages[1]
		expect(injected.role).toBe("user")
		expect((injected.content[0] as any).type).toBe("text")
		expect((injected.content[0] as any).text).toContain("Subtask c-no-tool completed")
	})

	it("reopenParentFromDelegation sets skipPrevResponseIdOnce via resumeAfterDelegation", async () => {
		const liveChild = createLiveChild("child-2")
		const parentInstance: any = {
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockImplementation(async function (this: any) {
				// Simulate what the real resumeAfterDelegation does
				this.skipPrevResponseIdOnce = true
			}),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "parent-2",
					status: "delegated",
					awaitingChildId: "child-2",
					childIds: [],
					ts: 200,
					task: "P",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-2" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-2",
			childTaskId: "child-2",
			completionResultSummary: "Done",
		})

		// Critical: verify skipPrevResponseIdOnce set to true by resumeAfterDelegation
		expect(parentInstance.skipPrevResponseIdOnce).toBe(true)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation emits events in correct order: TaskDelegationCompleted → TaskDelegationResumed", async () => {
		const liveChild = createLiveChild("c3")
		const emitSpy = vi.fn()
		const updateTaskHistory = vi.fn().mockResolvedValue([])

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p3",
					status: "delegated",
					awaitingChildId: "c3",
					childIds: [],
					ts: 300,
					task: "P3",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "c3" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory,
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p3",
			childTaskId: "c3",
			completionResultSummary: "Summary",
		})

		// Verify both events emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).toContain(RooCodeEventName.TaskDelegationCompleted)
		expect(eventNames).toContain(RooCodeEventName.TaskDelegationResumed)

		// CRITICAL: verify ordering (TaskDelegationCompleted before TaskDelegationResumed)
		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)

		// RPD-05: verify parent metadata persistence happens before TaskDelegationCompleted emit
		const parentUpdateCallIdx = updateTaskHistory.mock.calls.findIndex((call) => {
			const item = call[0] as { id?: string; status?: string } | undefined
			return item?.id === "p3" && item.status === "active"
		})
		expect(parentUpdateCallIdx).toBeGreaterThanOrEqual(0)

		const parentUpdateCallOrder = updateTaskHistory.mock.invocationCallOrder[parentUpdateCallIdx]
		const completedEmitCallOrder = emitSpy.mock.invocationCallOrder[completedIdx]
		expect(parentUpdateCallOrder).toBeLessThan(completedEmitCallOrder)
	})

	it("reopenParentFromDelegation continues when overwrite operations fail and still resumes/emits (RPD-06)", async () => {
		const liveChild = createLiveChild("child-rpd06")
		const emitSpy = vi.fn()
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockRejectedValue(new Error("ui overwrite failed")),
			overwriteApiConversationHistory: vi.fn().mockRejectedValue(new Error("api overwrite failed")),
		}

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd06") {
					return {
						historyItem: {
							id: "parent-rpd06",
							status: "delegated",
							awaitingChildId: "child-rpd06",
							childIds: ["child-rpd06"],
							ts: 800,
							task: "Parent RPD-06",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}

				return {
					historyItem: {
						id: "child-rpd06",
						status: "active",
						ts: 801,
						task: "Child RPD-06",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd06" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-rpd06",
				childTaskId: "child-rpd06",
				completionResultSummary: "Subtask finished despite overwrite failures",
			}),
		).resolves.toBeUndefined()

		expect(parentInstance.overwriteClineMessages).toHaveBeenCalledTimes(1)
		expect(parentInstance.overwriteApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)

		expect(emitSpy).toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationCompleted,
			"parent-rpd06",
			"child-rpd06",
			"Subtask finished despite overwrite failures",
		)
		expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent-rpd06", "child-rpd06")

		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)
	})

	it("reopenParentFromDelegation does NOT emit TaskPaused or TaskUnpaused (new flow only)", async () => {
		const liveChild = createLiveChild("c4")
		const emitSpy = vi.fn()

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p4",
					status: "delegated",
					awaitingChildId: "c4",
					childIds: [],
					ts: 400,
					task: "P4",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "c4" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p4",
			childTaskId: "c4",
			completionResultSummary: "S",
		})

		// CRITICAL: verify legacy pause/unpause events NOT emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).not.toContain(RooCodeEventName.TaskPaused)
		expect(eventNames).not.toContain(RooCodeEventName.TaskUnpaused)
		expect(eventNames).not.toContain(RooCodeEventName.TaskSpawned)
	})

	it("reopenParentFromDelegation closes only the live background child when the foreground differs (RPD-02)", async () => {
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(parentInstance)
		const liveChild = createLiveChild("child-rpd02")

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd02") {
					return {
						historyItem: {
							id: "parent-rpd02",
							status: "delegated",
							awaitingChildId: "child-rpd02",
							childIds: ["child-rpd02"],
							ts: 600,
							task: "Parent RPD-02",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}
				return {
					historyItem: {
						id: "child-rpd02",
						status: "active",
						ts: 601,
						task: "Child RPD-02",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "different-open-task" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack,
			createTaskWithHistoryItem,
			updateTaskHistory,
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-rpd02",
			childTaskId: "child-rpd02",
			completionResultSummary: "Child done without being current",
		})

		expect(removeClineFromStack).toHaveBeenCalledWith({
			taskId: "child-rpd02",
			skipDelegationRepair: true,
			requireAbortSuccess: true,
			ownedDelegationHandoff: true,
		})
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-rpd02",
				status: "completed",
			}),
		)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-rpd02",
				status: "active",
				completedByChildId: "child-rpd02",
			}),
			{ startTask: false, preserveExisting: true, background: true },
		)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation logs child status persistence failure and continues reopen flow (RPD-04)", async () => {
		const liveChild = createLiveChild("child-rpd04")
		const logSpy = vi.fn()
		const emitSpy = vi.fn()
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockImplementation(async (historyItem: { id?: string }) => {
			if (historyItem.id === "child-rpd04") {
				throw new Error("child status persist failed")
			}
			return []
		})

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd04") {
					return {
						historyItem: {
							id: "parent-rpd04",
							status: "delegated",
							awaitingChildId: "child-rpd04",
							childIds: ["child-rpd04"],
							ts: 700,
							task: "Parent RPD-04",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}
				return {
					historyItem: {
						id: "child-rpd04",
						status: "active",
						ts: 701,
						task: "Child RPD-04",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: emitSpy,
			log: logSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd04" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory,
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-rpd04",
				childTaskId: "child-rpd04",
				completionResultSummary: "Child completion with persistence failure",
			}),
		).resolves.toBeUndefined()

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("[reopenParentFromDelegation] Parent committed but child status repair failed:"),
		)
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-rpd04",
				status: "active",
				completedByChildId: "child-rpd04",
			}),
		)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent-rpd04", "child-rpd04")
	})

	it("rolls back the staged parent and preserves guidance that arrives before child removal", async () => {
		const parentTaskId = "parent-precommit-race"
		const childTaskId = "child-precommit-race"
		const operations: string[] = []
		const childQueue = {
			isEmpty: vi.fn(() => true),
			on: vi.fn(),
			off: vi.fn(),
			addMessage: vi.fn(() => true),
		}
		const liveChild = {
			...createLiveChild(childTaskId),
			messageQueueService: childQueue,
		}
		const parentInstance = {
			taskId: parentTaskId,
			messageQueueService: { addMessage: vi.fn(() => true) },
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const originalParentHistory = {
			id: parentTaskId,
			status: "delegated",
			delegatedToId: childTaskId,
			awaitingChildId: childTaskId,
			childIds: [childTaskId],
			ts: 900,
			task: "Parent precommit race",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const updateTaskHistory = vi.fn(async (historyItem: { status?: string }) => {
			operations.push(`history:${historyItem.status}`)
			return []
		})
		const removeClineFromStack = vi.fn(async (options: { taskId?: string }) => {
			operations.push(`remove:${options.taskId}`)
		})
		let provider: ClineProvider
		const createTaskWithHistoryItem = vi.fn(async (_historyItem: unknown, options: unknown) => {
			operations.push("stage-parent")
			expect(options).toEqual({ startTask: false, preserveExisting: true, background: true })
			expect(
				(ClineProvider.prototype as any).queueMessageForTask.call(
					provider,
					childTaskId,
					"Please incorporate this before finishing",
					["queued-image"],
				),
			).toBe(true)
			return parentInstance
		})

		provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: originalParentHistory }),
			getLiveTask: vi.fn((taskId: string) => (taskId === childTaskId ? liveChild : undefined)),
			isTaskOnScreen: vi.fn(() => true),
			emit: vi.fn(),
			removeClineFromStack,
			createTaskWithHistoryItem,
			updateTaskHistory,
			runWorkspaceMutation,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([{ type: "say", say: "text", text: "before", ts: 1 }] as any)
		vi.mocked(readApiMessages).mockResolvedValue([
			{ role: "user", content: [{ type: "text", text: "before" }], ts: 1 },
		] as any)
		vi.mocked(saveTaskMessages).mockResolvedValue(undefined)
		vi.mocked(saveApiMessages).mockResolvedValue({
			taskId: parentTaskId,
			filePath: "/storage/api_conversation_history.json",
			digest: "0".repeat(64),
			byteLength: 2,
			commitId: "11111111-1111-4111-8111-111111111111",
		})

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId,
				childTaskId,
				completionResultSummary: "Child result",
			}),
		).rejects.toThrow("Queued user guidance arrived before the delegated child handoff committed")

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(removeClineFromStack).toHaveBeenCalledWith({
			taskId: parentTaskId,
			skipDelegationRepair: true,
			requireAbortSuccess: true,
		})
		expect(operations).toEqual(["history:active", "stage-parent", `remove:${parentTaskId}`, "history:delegated"])
		expect(childQueue.addMessage).toHaveBeenCalledWith("Please incorporate this before finishing", ["queued-image"])
		expect(parentInstance.messageQueueService.addMessage).not.toHaveBeenCalled()
		expect(parentInstance.resumeAfterDelegation).not.toHaveBeenCalled()
		expect(vi.mocked(saveTaskMessages)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(saveApiMessages)).toHaveBeenCalledTimes(2)
	})

	it("routes child-addressed guidance to the parent during removal and an in-flight resume", async () => {
		const parentTaskId = "parent-remove-race"
		const childTaskId = "child-remove-race"
		const parentQueue = { addMessage: vi.fn(() => true) }
		let signalResumeStarted!: () => void
		let releaseResume!: () => void
		const resumeStarted = new Promise<void>((resolve) => {
			signalResumeStarted = resolve
		})
		const resumeGate = new Promise<void>((resolve) => {
			releaseResume = resolve
		})
		const childQueue = {
			isEmpty: vi.fn(() => true),
			on: vi.fn(),
			off: vi.fn(),
			addMessage: vi.fn(() => true),
		}
		const liveChild = {
			...createLiveChild(childTaskId),
			messageQueueService: childQueue,
		}
		const parentInstance = {
			taskId: parentTaskId,
			messageQueueService: parentQueue,
			resumeAfterDelegation: vi.fn(async () => {
				signalResumeStarted()
				await resumeGate
			}),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const parentHistory = {
			id: parentTaskId,
			status: "delegated",
			delegatedToId: childTaskId,
			awaitingChildId: childTaskId,
			childIds: [childTaskId],
			ts: 910,
			task: "Parent remove race",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		let childIsLive = true
		let parentIsStaged = false
		let provider: ClineProvider
		const removeClineFromStack = vi.fn(async (options: { taskId?: string }) => {
			expect(options).toEqual({
				taskId: childTaskId,
				skipDelegationRepair: true,
				requireAbortSuccess: true,
				ownedDelegationHandoff: true,
			})
			expect(
				(ClineProvider.prototype as any).queueMessageForTask.call(
					provider,
					childTaskId,
					"Queued while the child is closing",
					["race-image"],
				),
			).toBe(true)
			childIsLive = false
		})
		const focusTask = vi.fn().mockResolvedValue(true)

		provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn(async (taskId: string) => ({
				historyItem:
					taskId === parentTaskId
						? parentHistory
						: {
								id: childTaskId,
								status: "active",
								ts: 911,
								task: "Child remove race",
								tokensIn: 0,
								tokensOut: 0,
								totalCost: 0,
							},
			})),
			getLiveTask: vi.fn((taskId: string) => {
				if (taskId === childTaskId && childIsLive) return liveChild
				if (taskId === parentTaskId && parentIsStaged) return parentInstance
				return undefined
			}),
			isTaskOnScreen: vi.fn((taskId: string) => taskId === childTaskId),
			emit: vi.fn(),
			removeClineFromStack,
			createTaskWithHistoryItem: vi.fn(async (_historyItem: unknown, options: unknown) => {
				expect(options).toEqual({ startTask: false, preserveExisting: true, background: true })
				parentIsStaged = true
				return parentInstance
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
			focusTask,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		vi.mocked(saveTaskMessages).mockResolvedValue(undefined)
		vi.mocked(saveApiMessages).mockResolvedValue({
			taskId: parentTaskId,
			filePath: "/storage/api_conversation_history.json",
			digest: "0".repeat(64),
			byteLength: 2,
			commitId: "11111111-1111-4111-8111-111111111111",
		})

		const handoffPromise = (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId,
			childTaskId,
			completionResultSummary: "Child result",
		})
		await resumeStarted

		// The one-time pre-resume drain has already run. A stale child-addressed
		// message must now be forwarded synchronously instead of waiting for finally.
		expect(
			(ClineProvider.prototype as any).queueMessageForTask.call(
				provider,
				childTaskId,
				"Queued after the initial drain",
			),
		).toBe(true)
		expect(parentQueue.addMessage).toHaveBeenCalledWith("Queued after the initial drain", undefined)
		expect((provider as any).legacyHandoffInputBuffers.get(childTaskId).messages).toHaveLength(0)

		releaseResume()
		await expect(handoffPromise).resolves.toBeUndefined()

		expect(parentQueue.addMessage).toHaveBeenCalledWith("Queued while the child is closing", ["race-image"])
		expect(parentQueue.addMessage).toHaveBeenCalledTimes(2)
		expect(childQueue.addMessage).not.toHaveBeenCalled()
		expect(focusTask).toHaveBeenCalledWith(parentTaskId)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect((provider as any).legacyHandoffInputBuffers.size).toBe(0)
	})

	it("handles empty history gracefully when injecting synthetic messages", async () => {
		const liveChild = createLiveChild("c5")
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p5",
					status: "delegated",
					awaitingChildId: "c5",
					childIds: [],
					ts: 500,
					task: "P5",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c5" })),
			getLiveTask: vi.fn((taskId: string) => (taskId === liveChild.taskId ? liveChild : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			runWorkspaceMutation,
		} as unknown as ClineProvider

		// Mock read failures or empty returns
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "p5",
				childTaskId: "c5",
				completionResultSummary: "Result",
			}),
		).resolves.toBeUndefined()

		// Verify saves still occurred with just the injected message
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						type: "say",
						say: "subtask_result",
					}),
				],
			}),
		)

		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						role: "user",
					}),
				],
			}),
		)
	})
})
