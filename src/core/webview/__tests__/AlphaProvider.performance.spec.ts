import { describe, expect, it, vi } from "vitest"
import {
	scheduledTaskSchema,
	TaskStatus,
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
