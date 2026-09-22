// npx vitest run __tests__/single-open-invariant.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { AlphaProvider } from "../core/webview/AlphaProvider"
import { API } from "../extension/api"
import * as ProfileValidatorMod from "../shared/ProfileValidator"

// Mock Task class used by AlphaProvider to avoid heavy startup
vi.mock("../core/task/Task", () => {
	class TaskStub {
		public taskId: string
		public instanceId = "inst"
		public parentTask?: any
		public apiConfiguration: any
		public rootTask?: any
		constructor(opts: any) {
			this.taskId = opts.historyItem?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`
			this.parentTask = opts.parentTask
			this.apiConfiguration = opts.apiConfiguration ?? { apiProvider: "vertex" }
			opts.onCreated?.(this)
		}
		start() {}
		on() {}
		off() {}
		emit() {}
	}
	return { Task: TaskStub }
})

describe("Single-open-task invariant", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("User-initiated create: closes existing before opening new", async () => {
		// Allow profile
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)

		const removeTaskFromStack = vi.fn().mockResolvedValue(undefined)
		const addTaskToStack = vi.fn().mockResolvedValue(undefined)

		const provider = {
			// Simulate an existing task present in stack
			taskStack: [{ taskId: "existing-1" }],
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "vertex", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				enableCheckpoints: true,
				checkpointTimeout: 60,
			}),
			getProviderSettingsSnapshot: vi.fn(() => ({ apiProvider: "vertex", consecutiveMistakeLimit: 0 })),
			removeTaskFromStack,
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			addTaskToStack,
			postTaskStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			getStateToPostToWebview: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				getValues: vi.fn(() => ({
					enableCheckpoints: true,
					checkpointTimeout: 60,
					experiments: {},
				})),
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as AlphaProvider

		await (AlphaProvider.prototype as any).createTask.call(provider, "New task")

		expect(removeTaskFromStack).toHaveBeenCalledTimes(1)
		expect(addTaskToStack).toHaveBeenCalledTimes(1)
	})

	it("Extension multi-session create: preserves existing live task", async () => {
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)

		const removeTaskFromStack = vi.fn().mockResolvedValue(undefined)
		const addTaskToStack = vi.fn().mockResolvedValue(undefined)

		const provider = {
			taskStack: [{ taskId: "existing-1" }],
			taskSessions: { canCreateTask: vi.fn(() => true) },
			finalizeActiveCompletionCandidate: vi.fn().mockResolvedValue(undefined),
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "vertex", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				enableCheckpoints: true,
				checkpointTimeout: 60,
			}),
			getProviderSettingsSnapshot: vi.fn(() => ({ apiProvider: "vertex", consecutiveMistakeLimit: 0 })),
			removeTaskFromStack,
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			addTaskToStack,
			postTaskStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				getValues: vi.fn(() => ({
					enableCheckpoints: true,
					checkpointTimeout: 60,
					experiments: {},
				})),
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as AlphaProvider

		await (AlphaProvider.prototype as any).createTask.call(provider, "New task", undefined, undefined, {
			preserveExisting: true,
		})

		expect(removeTaskFromStack).not.toHaveBeenCalled()
		expect(addTaskToStack).toHaveBeenCalledTimes(1)
	})

	it("Extension multi-session create: blocks when live task cap is reached", async () => {
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)
		const addTaskToStack = vi.fn()

		const provider = {
			taskStack: [{ taskId: "existing-1" }],
			taskSessions: { canCreateTask: vi.fn(() => false) },
			finalizeActiveCompletionCandidate: vi.fn().mockResolvedValue(undefined),
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "vertex", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				enableCheckpoints: true,
				checkpointTimeout: 60,
			}),
			getProviderSettingsSnapshot: vi.fn(() => ({ apiProvider: "vertex", consecutiveMistakeLimit: 0 })),
			removeTaskFromStack: vi.fn(),
			addTaskToStack,
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				getValues: vi.fn(() => ({
					enableCheckpoints: true,
					checkpointTimeout: 60,
					experiments: {},
				})),
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as AlphaProvider

		await expect(
			(AlphaProvider.prototype as any).createTask.call(provider, "New task", undefined, undefined, {
				preserveExisting: true,
			}),
		).rejects.toThrow("Maximum live task limit reached")
		expect(addTaskToStack).not.toHaveBeenCalled()
	})

	it("Extension blank task intent: backgrounds current task and resets chat UI", async () => {
		const activeTask = { taskId: "existing-1", emit: vi.fn() }
		const clearFocus = vi.fn()
		const resetNewTaskDraftMode = vi.fn()
		const postTaskStateToWebview = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn(() => new Promise<void>(() => {}))
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = {
			getActiveTask: vi.fn(() => activeTask),
			finalizeActiveCompletionCandidate: vi.fn().mockResolvedValue(undefined),
			taskSessions: { clearFocus },
			resetNewTaskDraftMode,
			postTaskStateToWebview,
			postStateToWebview,
			postMessageToWebview,
			log: vi.fn(),
		} as unknown as AlphaProvider

		await (AlphaProvider.prototype as any).startBlankTask.call(provider)

		expect(clearFocus).toHaveBeenCalledTimes(1)
		expect(resetNewTaskDraftMode).toHaveBeenCalledTimes(1)
		expect(activeTask.emit).toHaveBeenCalledWith("taskUnfocused")
		expect(postTaskStateToWebview).toHaveBeenCalledWith({ clearManagedAgentTree: true })
		expect(postStateToWebview).toHaveBeenCalledTimes(1)
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
			values: { force: true },
		})
		expect(postMessageToWebview).toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})

	it("History delete releases a background live task slot", async () => {
		const removeTaskFromStack = vi.fn().mockResolvedValue(undefined)
		const deleteFromHistory = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = {
			getLiveTask: vi.fn((taskId: string) => (taskId === "background-1" ? { taskId } : undefined)),
			removeTaskFromStack,
			taskHistoryStore: { delete: deleteFromHistory },
			purgeDeletedAgentControlRoots: vi.fn().mockResolvedValue(undefined),
			postStateToWebview,
		} as unknown as AlphaProvider

		await (AlphaProvider.prototype as any).deleteTaskFromState.call(provider, "background-1")

		expect(removeTaskFromStack).toHaveBeenCalledWith({ taskId: "background-1" })
		expect(deleteFromHistory).toHaveBeenCalledWith("background-1")
		expect(postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("History resume path always closes current before rehydration (non-rehydrating case)", async () => {
		const removeTaskFromStack = vi.fn().mockResolvedValue(undefined)
		const addTaskToStack = vi.fn().mockResolvedValue(undefined)
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)

		const provider = {
			getCurrentTask: vi.fn(() => undefined), // ensure not rehydrating
			getLiveTask: vi.fn(() => undefined),
			removeTaskFromStack,
			addTaskToStack,
			updateGlobalState,
			log: vi.fn(),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			},
			agentControlStore: {
				retryPendingMailboxClaimSettlements: vi.fn().mockResolvedValue(undefined),
			},
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "vertex", consecutiveMistakeLimit: 0 },
				enableCheckpoints: true,
				checkpointTimeout: 60,
				experiments: {},
			}),
			// Methods used by createTaskWithHistoryItem for pending edit cleanup
			getPendingEditOperation: vi.fn().mockReturnValue(undefined),
			clearPendingEditOperation: vi.fn(),
			context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
			contextProxy: {
				extensionUri: {},
				getValue: vi.fn(),
				setValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
			postTaskStateToWebview: vi.fn(),
			postStateToWebview: vi.fn(),
		} as unknown as AlphaProvider

		const historyItem = {
			id: "hist-1",
			number: 1,
			ts: Date.now(),
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/tmp",
		}

		const task = await (AlphaProvider.prototype as any).createTaskWithHistoryItem.call(provider, historyItem)
		expect(task).toBeTruthy()
		expect(removeTaskFromStack).toHaveBeenCalledTimes(1)
		expect(addTaskToStack).toHaveBeenCalledTimes(1)
	})

	it("IPC StartNewTask path closes current before new task", async () => {
		const removeTaskFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "ipc-1" })
		const provider = {
			context: {} as any,
			removeTaskFromStack,
			postStateToWebview: vi.fn(),
			postMessageToWebview: vi.fn(),
			createTask,
			getValues: vi.fn(() => ({})),
			providerSettingsManager: { saveConfig: vi.fn() },
			on: vi.fn((ev: any, cb: any) => {
				if (ev === "taskCreated") {
					// no-op for this test
				}
				return provider
			}),
		} as unknown as AlphaProvider

		const output = { appendLine: vi.fn() } as any
		const api = new API(output, provider, undefined, false)
		const configuration = {
			apiProvider: "fake-ai" as const,
			fakeAi: { id: "runtime-provider", createMessage: vi.fn() },
		}

		const taskId = await api.startNewTask({
			configuration,
			text: "hello",
			images: undefined,
			newTab: false,
		})

		expect(taskId).toBe("ipc-1")
		expect(removeTaskFromStack).toHaveBeenCalledTimes(1)
		expect(createTask).toHaveBeenCalledWith(
			"hello",
			undefined,
			undefined,
			expect.objectContaining({ apiConfiguration: configuration }),
			configuration,
		)
	})

	it("keeps runtime task capacity synchronized with programmatic settings writes", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const setMaxLiveTasks = vi.fn()
		const provider = {
			contextProxy: { setValues },
			taskSessions: { setMaxLiveTasks },
			setMaxConcurrentTasks: AlphaProvider.prototype.setMaxConcurrentTasks,
		}

		await (AlphaProvider.prototype as any).setValues.call(provider, { maxConcurrentTasks: 6 })

		expect(setValues).toHaveBeenCalledWith({ maxConcurrentTasks: 6 })
		expect(setMaxLiveTasks).toHaveBeenCalledWith(6)
	})
})
