import { describe, expect, it, vi } from "vitest"
import {
	scheduledTaskSchema,
	TaskStatus,
	type HistoryItem,
	type AlphaCodeSettings,
	type ExtensionMessage,
	type ScheduledTaskState,
	type TaskReasoningProjection,
} from "@alpha-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const scheduleState = (id: string): ScheduledTaskState => ({
	tasks: [
		scheduledTaskSchema.parse({
			id,
			name: id,
			prompt: "Review the repository",
			enabled: true,
			schedule: { type: "daily", startAt: 1, timezone: "UTC" },
			permissions: {},
			notificationPreference: "never",
			createdAt: 1,
			updatedAt: 1,
		}),
	],
	runs: [{ id: `run-${id}`, taskId: id, status: "succeeded", trigger: "manual", scheduledFor: 1, prompt: id }],
})

const reasoning: TaskReasoningProjection = {
	requested: { kind: "default" },
	effective: { kind: "off" },
	capabilities: { kind: "unavailable", canDisable: false },
	fallbackReason: "unavailable",
}

const createProvider = () => {
	const values: AlphaCodeSettings = { apiProvider: "openai", mode: "code", autoSteer: false }
	const getValues = vi.fn(() => values)
	const contextProxy: ContextProxy = Object.assign(Object.create(ContextProxy.prototype), {
		getValues,
		getValue: vi.fn((key: keyof AlphaCodeSettings) => values[key]),
	})
	const taskSessions = new TaskSessionRegistry()
	let scheduled = scheduleState("initial")
	const getScheduledState = vi.fn(() => scheduled)
	const post = vi.fn(async (_message: ExtensionMessage): Promise<void> => undefined)
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		contextProxy,
		context: { extension: { packageJSON: { version: "test" } }, workspaceState: { get: () => false } },
		customModesManager: { getCustomModes: vi.fn(async () => []) },
		scheduledTaskService: { getState: getScheduledState },
		taskSessions,
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: { get: () => undefined, getByWorkspace: () => [] },
		currentWorkspacePath: "/workspace",
		currentView: { type: "newTaskDraft" },
		newTaskDraftMode: "code",
		taskNavigationGeneration: 0,
		alphaMessagesSeq: 0,
		taskStateSeq: 0,
		messageQueueSeq: 0,
		currentTaskTodosSeq: 0,
		publishedTaskTranscriptRevisions: new Map(),
		mergeAllowedCommands: () => [],
		mergeDeniedCommands: () => [],
		getReasoningProjection: async () => reasoning,
		buildManagedAgentTreeProjection: async () => undefined,
		getAgentLifecycleDegraded: () => ({}),
		getHostProviders: () => [provider],
		postMessageToWebview: post,
		log: vi.fn(),
	})
	return {
		provider,
		contextProxy,
		values,
		getValues,
		getScheduledState,
		post,
		taskSessions,
		setScheduled: (next: ScheduledTaskState) => (scheduled = next),
	}
}

describe("webview state projection work", () => {
	it("hydrates a new-chat draft before saved-history recovery finishes", async () => {
		const { provider, post } = createProvider()
		const recovery = barrier()
		Object.assign(provider, { taskHistoryStoreReady: recovery.promise })
		try {
			await provider.postStateToWebview({ deferTaskHistory: true })
			expect(post).toHaveBeenCalledWith({
				type: "state",
				state: expect.objectContaining({
					apiConfiguration: expect.objectContaining({ apiProvider: "openai" }),
					currentView: { type: "newTaskDraft" },
				}),
			})
			expect(post.mock.calls[0][0].state).not.toHaveProperty("taskHistory")
		} finally {
			recovery.resolve()
		}
	}, 1_000)

	it("publishes recovered history after the draft without clearing the cached inventory first", async () => {
		const { provider, post } = createProvider()
		const recovery = barrier()
		const publishedHistory = barrier()
		const history: HistoryItem[] = [
			{ id: "saved", number: 1, ts: 1, task: "Saved chat", tokensIn: 0, tokensOut: 0, totalCost: 0 },
		]
		const getByWorkspace = vi.fn(() => history)
		Object.assign(provider, {
			taskHistoryStoreReady: recovery.promise,
			taskHistoryStore: { get: () => undefined, getByWorkspace },
		})
		post.mockImplementation(async (message) => {
			if (message.state?.taskHistory) publishedHistory.resolve()
		})
		await provider.postStateToWebview({ deferTaskHistory: true })
		expect(getByWorkspace).not.toHaveBeenCalled()
		expect(post).toHaveBeenCalledTimes(1)
		recovery.resolve()
		await publishedHistory.promise
		expect(post).toHaveBeenCalledTimes(2)
		expect(post.mock.calls[1][0].state?.taskHistory).toEqual(history)
		expect(post.mock.calls[1][0].state?.taskStateSeq).toBeGreaterThan(
			post.mock.calls[0][0].state?.taskStateSeq ?? 0,
		)
	})

	it.each(["disposed", "replaced", "navigated"] as const)(
		"does not refresh the startup draft after its view is %s",
		async (transition) => {
			const { provider, post } = createProvider()
			const recovery = barrier()
			const finished = barrier()
			const recover = recovery.promise.then(() => {
				// Join the deferred publication's decision before asserting absence.
				queueMicrotask(finished.resolve)
			})
			Object.assign(provider, { taskHistoryStoreReady: recover })
			await provider.postStateToWebview({ deferTaskHistory: true })
			if (transition === "disposed") Object.assign(provider, { _disposed: true })
			if (transition === "replaced") Object.assign(provider, { view: {} })
			if (transition === "navigated") Object.assign(provider, { taskNavigationGeneration: 1 })
			recovery.resolve()
			await finished.promise
			expect(post).toHaveBeenCalledTimes(1)
		},
	)

	it("keeps a saved-task projection behind recovery even when history is omitted", async () => {
		const { provider, getValues } = createProvider()
		const recovery = barrier()
		Object.assign(provider, {
			taskHistoryStoreReady: recovery.promise,
			currentView: { type: "task", taskId: "saved" },
		})
		const projecting = provider.getStateToPostToWebview({ includeTaskHistory: false })
		expect(getValues).not.toHaveBeenCalled()
		recovery.resolve()
		await projecting
		expect(getValues).toHaveBeenCalled()
	})

	it("rechecks recovery if navigation changes while draft configuration loads", async () => {
		const { provider, taskSessions } = createProvider()
		const recovery = barrier()
		const modes = barrier()
		const entered = barrier()
		const historyAwaited = barrier()
		const getTaskMode = vi.fn(async () => "code")
		Object.assign(provider, {
			customModesManager: {
				getCustomModes: async () => {
					entered.resolve()
					await modes.promise
					return []
				},
			},
		})
		Object.defineProperty(provider, "taskHistoryStoreReady", {
			get: () => {
				historyAwaited.resolve()
				return recovery.promise
			},
		})
		const projecting = provider.getStateToPostToWebview({ includeTaskHistory: false })
		await entered.promise
		taskSessions.register({
			taskId: "saved",
			taskKind: "primary",
			taskStatus: TaskStatus.Running,
			apiConfiguration: { apiProvider: "openai" },
			alphaMessages: [],
			getTaskMode,
			getTaskApiConfigName: async () => "default",
		} as unknown as Task)
		Object.assign(provider, { currentView: { type: "task", taskId: "saved" } })
		modes.resolve()
		await historyAwaited.promise
		expect(getTaskMode).not.toHaveBeenCalled()
		recovery.resolve()
		await projecting
		expect(getTaskMode).toHaveBeenCalledOnce()
	})

	it("reads schedules once and keeps tasks and runs from the same snapshot for default state callers", async () => {
		const { provider, getScheduledState } = createProvider()
		const first = scheduleState("first")
		getScheduledState.mockReturnValueOnce(first).mockReturnValue(scheduleState("later"))

		const state = await provider.getState()

		expect(getScheduledState).toHaveBeenCalledOnce()
		expect(state.scheduledTasks).toBe(first.tasks)
		expect(state.scheduledTaskRuns).toBe(first.runs)
	})

	it("skips schedule projection when a caller will capture it later", async () => {
		const { provider, getScheduledState } = createProvider()

		const state = await provider.getState({ includeScheduledTasks: false })

		expect(getScheduledState).not.toHaveBeenCalled()
		expect(state.scheduledTasks).toEqual([])
		expect(state.scheduledTaskRuns).toEqual([])
	})

	it.each([
		"postStateToWebview",
		"postStateToWebviewWithoutTaskHistory",
		"postStateToWebviewWithoutAlphaMessages",
	] as const)("%s sends one fresh paired schedule snapshot", async (method) => {
		const { provider, getScheduledState, post } = createProvider()
		const scheduled = scheduleState("current")
		getScheduledState.mockReturnValue(scheduled)

		await provider[method]()

		expect(getScheduledState).toHaveBeenCalledOnce()
		expect(post).toHaveBeenCalledWith({
			type: "state",
			state: expect.objectContaining({ scheduledTasks: scheduled.tasks, scheduledTaskRuns: scheduled.runs }),
		})
	})

	it("captures schedules after asynchronous task metadata resolves", async () => {
		const { provider, taskSessions, getScheduledState, setScheduled } = createProvider()
		const entered = barrier()
		const finish = barrier()
		const task = {
			taskId: "selected",
			taskKind: "primary",
			taskStatus: TaskStatus.Running,
			apiConfiguration: { apiProvider: "openai" },
			alphaMessages: [],
			getTaskMode: async () => {
				entered.resolve()
				await finish.promise
				return "code"
			},
			getTaskApiConfigName: async () => "default",
		} as unknown as Task
		taskSessions.register(task)
		Object.assign(provider, { currentView: { type: "task", taskId: task.taskId } })
		const pending = provider.getStateToPostToWebview()
		await entered.promise
		const current = scheduleState("updated-while-waiting")
		try {
			expect(getScheduledState).not.toHaveBeenCalled()
			setScheduled(current)
		} finally {
			finish.resolve()
		}
		const state = await pending

		expect(getScheduledState).toHaveBeenCalledOnce()
		expect(state.scheduledTasks).toBe(current.tasks)
		expect(state.scheduledTaskRuns).toBe(current.runs)
	})

	it("enumerates settings only for the state and validated provider projections", async () => {
		const { provider, contextProxy, getValues } = createProvider()
		const getProviderSettings = vi.spyOn(contextProxy, "getProviderSettings")

		const state = await provider.getState()

		expect(state.apiConfiguration.apiProvider).toBe("openai")
		expect(getProviderSettings).toHaveBeenCalledOnce()
		expect(getValues).toHaveBeenCalledTimes(2)
		expect(contextProxy.getValue).not.toHaveBeenCalledWith("apiProvider")
	})

	it.each([
		{ configured: "openai", expected: "openai" },
		{ configured: undefined, expected: "vertex" },
	] as const)("preserves the provider fallback to $expected without enumerating settings again", async (input) => {
		const { provider, contextProxy, values, getValues } = createProvider()
		values.apiProvider = input.configured
		vi.spyOn(contextProxy, "getProviderSettings").mockReturnValue({})

		const state = await provider.getState()

		expect(state.apiConfiguration.apiProvider).toBe(input.expected)
		expect(getValues).toHaveBeenCalledOnce()
		expect(contextProxy.getValue).toHaveBeenCalledWith("apiProvider")
	})
})
