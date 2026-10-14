// npx vitest run __tests__/removeTaskFromStack-delegation.spec.ts

import { afterEach, describe, it, expect, vi } from "vitest"
import { AlphaProvider } from "../core/webview/AlphaProvider"
import { TaskSessionRegistry } from "../core/webview/TaskSessionRegistry"
import type { Task } from "../core/task/Task"

describe("AlphaProvider.removeTaskFromStack() delegation awareness", () => {
	let hostFixtureNumber = 0
	const registeredViews: AlphaProvider[] = []
	const activeInstances = (AlphaProvider as unknown as { activeInstances: Set<AlphaProvider> }).activeInstances
	afterEach(() => {
		for (const view of registeredViews.splice(0)) activeInstances.delete(view)
	})

	/**
	 * Helper to build a minimal mock provider with a single task on the stack.
	 * The task's parentTaskId and taskId are configurable.
	 */
	function buildMockProvider(opts: {
		childTaskId: string
		parentTaskId?: string
		parentHistoryItem?: Record<string, any>
		getTaskWithIdError?: Error
		taskSessions?: TaskSessionRegistry
	}) {
		const childTask = {
			taskId: opts.childTaskId,
			instanceId: "inst-1",
			parentTaskId: opts.parentTaskId,
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const resetNewTaskDraftMode = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = opts.getTaskWithIdError
			? vi.fn().mockRejectedValue(opts.getTaskWithIdError)
			: vi.fn().mockImplementation(async (id: string) => {
					if (id === opts.parentTaskId && opts.parentHistoryItem) {
						return { historyItem: { ...opts.parentHistoryItem } }
					}
					throw new Error("Task not found")
				})

		const provider = {
			taskStack: [childTask] as any[],
			taskEventListeners: new Map(),
			taskSessions: opts.taskSessions ?? new TaskSessionRegistry(),
			currentView: { type: "task", taskId: opts.childTaskId },
			publishedTaskTranscriptRevisions: new Map(),
			getActiveTaskId: vi.fn((): string | undefined => provider.taskSessions.getActiveTaskId()),
			resetNewTaskDraftMode,
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
		}

		Object.setPrototypeOf(provider, AlphaProvider.prototype)
		provider.taskSessions.register(childTask as unknown as Task)
		vi.spyOn(provider.taskSessions, "unregister")
		Object.assign(provider, { postTaskSessionStateToWebview: vi.fn().mockResolvedValue(undefined) })
		return { provider, childTask, updateTaskHistory, getTaskWithId, resetNewTaskDraftMode }
	}

	function sharedView(
		taskSessions: TaskSessionRegistry,
		currentView: { type: "task"; taskId: string } | { type: "newTaskDraft" },
	) {
		const view = {
			taskSessions,
			currentView,
			newTaskDraftMode: "architect",
			publishedTaskTranscriptRevisions: new Map(),
			getActiveTaskId: () => taskSessions.getActiveTaskId(),
			resetNewTaskDraftMode: vi.fn(),
		}
		Object.setPrototypeOf(view, AlphaProvider.prototype)
		const provider = view as unknown as AlphaProvider
		activeInstances.add(provider)
		registeredViews.push(provider)
		return view
	}

	it("resets each affected host view exactly once when the last shared task closes", async () => {
		const host = `remove-task-views-${++hostFixtureNumber}`
		const ownerSessions = TaskSessionRegistry.forGlobalStorage(host)
		const { provider } = buildMockProvider({ childTaskId: "shared-task", taskSessions: ownerSessions })
		const peerSessions = TaskSessionRegistry.forGlobalStorage(host)
		peerSessions.focus("shared-task")
		const peer = sharedView(peerSessions, { type: "task", taskId: "shared-task" })

		await AlphaProvider.prototype.removeTaskFromStack.call(provider as unknown as AlphaProvider)

		expect(provider.currentView).toEqual({ type: "newTaskDraft" })
		expect(peer.currentView).toEqual({ type: "newTaskDraft" })
		expect(provider.resetNewTaskDraftMode).toHaveBeenCalledTimes(1)
		expect(peer.resetNewTaskDraftMode).toHaveBeenCalledTimes(1)
		expect(ownerSessions.getTask("shared-task")).toBeUndefined()
	})

	it("preserves an unrelated view's existing Plan draft when another shared view closes", async () => {
		const host = `remove-task-views-${++hostFixtureNumber}`
		const { provider } = buildMockProvider({
			childTaskId: "closing-task",
			taskSessions: TaskSessionRegistry.forGlobalStorage(host),
		})
		const draft = sharedView(TaskSessionRegistry.forGlobalStorage(host), { type: "newTaskDraft" })

		await AlphaProvider.prototype.removeTaskFromStack.call(provider as unknown as AlphaProvider)

		expect(provider.resetNewTaskDraftMode).toHaveBeenCalledTimes(1)
		expect(draft.currentView).toEqual({ type: "newTaskDraft" })
		expect(draft.newTaskDraftMode).toBe("architect")
		expect(draft.resetNewTaskDraftMode).not.toHaveBeenCalled()
	})

	it("does not reset the selected foreground view when an exact background task closes", async () => {
		const { provider } = buildMockProvider({ childTaskId: "background-task" })
		const foregroundTask = { taskId: "foreground-task" } as Task
		provider.taskSessions.register(foregroundTask)
		provider.currentView = { type: "task", taskId: foregroundTask.taskId }

		await AlphaProvider.prototype.removeTaskFromStack.call(provider as unknown as AlphaProvider, {
			taskId: "background-task",
		})

		expect(provider.currentView).toEqual({ type: "task", taskId: "foreground-task" })
		expect(provider.taskSessions.getActiveTask()).toBe(foregroundTask)
		expect(provider.resetNewTaskDraftMode).not.toHaveBeenCalled()
	})

	it("repairs parent metadata (delegated → active) when a delegated child is removed", async () => {
		const { provider, updateTaskHistory, getTaskWithId, resetNewTaskDraftMode } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})

		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		// Stack should be empty after pop
		expect(provider.taskStack).toHaveLength(0)
		expect(resetNewTaskDraftMode).toHaveBeenCalledTimes(1)

		// Parent lookup should have been called
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1", { includeApiConversationHistory: false })

		// Parent metadata should be repaired
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)
		const updatedParent = updateTaskHistory.mock.calls[0][0]
		expect(updatedParent).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				awaitingChildId: undefined,
			}),
		)

		// Log the repair
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Repaired parent parent-1 metadata"))
	})

	it("does NOT modify parent metadata when the task has no parentTaskId (non-delegated)", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "standalone-1",
			// No parentTaskId — this is a top-level task
		})

		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		// Stack should be empty
		expect(provider.taskStack).toHaveLength(0)

		// No parent lookup or update should happen
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when awaitingChildId does not match the popped child", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-OTHER", // different child
				delegatedToId: "child-OTHER",
				childIds: ["child-OTHER"],
			},
		})

		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		// Parent was looked up but should NOT be updated
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1", { includeApiConversationHistory: false })
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when parent status is not 'delegated'", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "completed", // already completed
				awaitingChildId: "child-1",
				childIds: ["child-1"],
			},
		})

		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		expect(getTaskWithId).toHaveBeenCalledWith("parent-1", { includeApiConversationHistory: false })
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("catches and logs errors during parent metadata repair without blocking the pop", async () => {
		const { provider, childTask, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			getTaskWithIdError: new Error("Storage unavailable"),
		})

		// Should NOT throw
		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		// Stack should still be empty (pop was not blocked)
		expect(provider.taskStack).toHaveLength(0)

		// The abort should still have been called
		expect(childTask.abortTask).toHaveBeenCalledWith(true)

		// Error should be logged as non-fatal
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to repair parent metadata for parent-1 (non-fatal)"),
		)

		// No update should have been attempted
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("handles empty stack gracefully", async () => {
		const provider = {
			taskStack: [] as any[],
			taskEventListeners: new Map(),
			taskSessions: new TaskSessionRegistry(),
			currentView: { type: "newTaskDraft" },
			getActiveTaskId: vi.fn().mockReturnValue(undefined),
			resetNewTaskDraftMode: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory: vi.fn(),
		}

		Object.setPrototypeOf(provider, AlphaProvider.prototype)
		// Should not throw
		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider)

		expect(provider.taskStack).toHaveLength(0)
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("never removes the active task when an exact requested task is missing", async () => {
		const { provider, childTask } = buildMockProvider({ childTaskId: "active-task" })
		Object.assign(provider, {
			getLiveTask: vi.fn().mockReturnValue(undefined),
			getActiveTask: vi.fn().mockReturnValue(childTask),
		})

		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider, {
			taskId: "already-removed-task",
			requireAbortSuccess: true,
		})

		expect(childTask.abortTask).not.toHaveBeenCalled()
		expect(provider.taskSessions.unregister).not.toHaveBeenCalled()
		expect(provider.taskStack).toEqual([childTask])
	})

	it("skips delegation repair when skipDelegationRepair option is true", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})

		// Call with skipDelegationRepair: true (as delegateParentAndOpenChild would)
		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider, { skipDelegationRepair: true })

		// Stack should be empty after pop
		expect(provider.taskStack).toHaveLength(0)

		// Parent lookup should NOT have been called — repair was skipped entirely
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT reset grandparent during A→B→C nested delegation transition", async () => {
		// Scenario: A delegated to B, B is now delegating to C.
		// delegateParentAndOpenChild() pops B via removeTaskFromStack({ skipDelegationRepair: true }).
		// Grandparent A should remain "delegated" — its metadata must not be repaired.
		const grandparentHistory = {
			id: "task-A",
			task: "Grandparent task",
			ts: 1000,
			number: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "task-B",
			delegatedToId: "task-B",
			childIds: ["task-B"],
		}

		const taskB = {
			taskId: "task-B",
			instanceId: "inst-B",
			parentTaskId: "task-A",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "task-A") {
				return { historyItem: { ...grandparentHistory } }
			}
			throw new Error("Task not found")
		})
		const updateTaskHistory = vi.fn().mockResolvedValue([])

		const provider = {
			taskStack: [taskB] as any[],
			taskEventListeners: new Map(),
			taskSessions: new TaskSessionRegistry(),
			publishedTaskTranscriptRevisions: new Map(),
			currentView: { type: "task", taskId: "task-B" },
			getActiveTaskId: vi.fn().mockReturnValue(undefined),
			resetNewTaskDraftMode: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
		}

		Object.setPrototypeOf(provider, AlphaProvider.prototype)
		provider.taskSessions.register(taskB as unknown as Task)
		Object.assign(provider, { postTaskSessionStateToWebview: vi.fn().mockResolvedValue(undefined) })
		// Simulate what delegateParentAndOpenChild does: pop B with skipDelegationRepair
		await (AlphaProvider.prototype as any).removeTaskFromStack.call(provider, { skipDelegationRepair: true })

		// B was popped
		expect(provider.taskStack).toHaveLength(0)

		// Grandparent A should NOT have been looked up or modified
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()

		// Grandparent A's metadata remains intact (delegated, awaitingChildId: task-B)
		// The caller (delegateParentAndOpenChild) will update A to point to C separately.
	})
})
