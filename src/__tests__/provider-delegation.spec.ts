// npx vitest run __tests__/provider-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { RooCodeEventName } from "@alpha-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("persists parent delegation metadata and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = {
			taskId: "parent-1",
			emit: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
			getTaskApiConfigName: vi.fn().mockResolvedValue("profile-1"),
			apiConfiguration: { apiProvider: "anthropic" },
		} as any

		const childStart = vi.fn()
		const updateTaskHistory = vi.fn()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: childStart })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "parent-1") {
				return {
					historyItem: {
						id: "parent-1",
						task: "Parent",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						childIds: [],
					},
				}
			}
			// child-1
			return {
				historyItem: {
					id: "child-1",
					task: "Do something",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}
		})

		const provider = {
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			getLiveTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			getTaskWithId,
			updateTaskHistory,
			handleModeSwitch,
			getModeProviderProfile: vi.fn().mockResolvedValue(undefined),
			getProviderProfile: vi.fn().mockResolvedValue("default"),
			isTaskOnScreen: vi.fn(() => true),
			log: vi.fn(),
		} as unknown as ClineProvider

		const params = {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		}

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, params)

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(removeClineFromStack).toHaveBeenCalledWith({ taskId: "parent-1", skipDelegationRepair: true })
		// Child task is created with startTask: false and initialStatus: "active"
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
			taskMode: "code",
			taskApiConfigName: "profile-1",
			apiConfiguration: parentTask.apiConfiguration,
			background: false,
		})

		// Metadata persistence - parent gets "delegated" status (child status is set at creation via initialStatus)
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)

		// Parent set to "delegated"
		const parentSaved = updateTaskHistory.mock.calls[0][0]
		expect(parentSaved).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: expect.arrayContaining(["child-1"]),
			}),
		)

		// child.start() must be called AFTER parent metadata is persisted
		expect(childStart).toHaveBeenCalledTimes(1)

		// Event emission (provider-level)
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		// Delegation must not mutate foreground mode while seeding the child task.
		expect(handleModeSwitch).not.toHaveBeenCalled()
	})

	it("calls child.start() only after parent metadata is persisted (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = {
			taskId: "parent-1",
			emit: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
			getTaskApiConfigName: vi.fn().mockResolvedValue("profile-1"),
			apiConfiguration: { apiProvider: "anthropic" },
		} as any
		const childStart = vi.fn(() => callOrder.push("child.start"))

		const updateTaskHistory = vi.fn(async () => {
			callOrder.push("updateTaskHistory")
		})
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return { taskId: "child-1", start: childStart }
		})
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				childIds: [],
			},
		})

		const provider = {
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			getLiveTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			getTaskWithId,
			updateTaskHistory,
			handleModeSwitch,
			getModeProviderProfile: vi.fn().mockResolvedValue(undefined),
			getProviderProfile: vi.fn().mockResolvedValue("default"),
			isTaskOnScreen: vi.fn(() => true),
			log: vi.fn(),
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		// Verify ordering: createTask → updateTaskHistory → child.start
		expect(callOrder).toEqual(["createTask", "updateTaskHistory", "child.start"])
	})

	it("delegates from a live parent even when another task is focused", async () => {
		const parentTask = {
			taskId: "parent-1",
			emit: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
			getTaskApiConfigName: vi.fn().mockResolvedValue("profile-1"),
			apiConfiguration: { apiProvider: "anthropic" },
		} as any
		const focusedTask = { taskId: "focused-1" } as any

		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn() })
		const updateTaskHistory = vi.fn()

		const provider = {
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => focusedTask),
			getLiveTask: vi.fn((taskId: string) => (taskId === "parent-1" ? parentTask : undefined)),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "parent-1",
					task: "Parent",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					childIds: [],
				},
			}),
			updateTaskHistory,
			getModeProviderProfile: vi.fn().mockResolvedValue(undefined),
			getProviderProfile: vi.fn().mockResolvedValue("default"),
			isTaskOnScreen: vi.fn(() => false),
			log: vi.fn(),
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(createTask).toHaveBeenCalledWith(
			"Do something",
			undefined,
			parentTask,
			expect.objectContaining({ taskMode: "code", taskApiConfigName: "profile-1", background: true }),
		)
		expect(provider.removeClineFromStack).toHaveBeenCalledWith({
			taskId: "parent-1",
			skipDelegationRepair: true,
		})
	})
})
