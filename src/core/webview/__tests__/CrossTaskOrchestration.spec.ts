import { EventEmitter } from "events"

import { AlphaCodeEventName, TaskLifecycleState } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"

type FakeTask = EventEmitter & Record<string, any>

function createTask(overrides: Record<string, unknown> = {}): FakeTask {
	return Object.assign(new EventEmitter(), {
		taskId: "parent-1",
		taskKind: "primary",
		orchestrationParentTaskId: undefined,
		parentTaskId: undefined,
		rootTaskId: undefined,
		workspacePath: "C:/repo",
		historyWorkspacePath: "C:/repo",
		apiConfiguration: { apiProvider: "openai", openAiModelId: "test" },
		reasoningPreference: { kind: "default" },
		subagentDelegationPolicy: { enabled: false },
		subagentDelegationExplicitlyEnabled: false,
		metadata: { task: "Parent objective" },
		clineMessages: [],
		abort: false,
		abortReason: undefined,
		taskAsk: undefined,
		getTaskMode: vi.fn(async () => "code"),
		getTaskApiConfigName: vi.fn(async () => "profile-a"),
		isCompleted: vi.fn(() => false),
		isTurnActive: vi.fn(() => true),
		steerUserMessage: vi.fn(async () => undefined),
		resumeCompletedTaskFollowup: vi.fn(async () => undefined),
		submitUserMessage: vi.fn(async () => undefined),
		messageQueueService: { addMessage: vi.fn(() => true) },
		...overrides,
	}) as FakeTask
}

function createProviderFixture() {
	const provider = Object.create(AlphaProvider.prototype) as AlphaProvider
	const tasks = new Map<string, FakeTask>()
	const history = new Map<string, Record<string, unknown>>()
	const metadata = new Map<string, Record<string, unknown>>()
	const internals = provider as unknown as Record<string, any>
	Object.assign(internals, {
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: {
			get: (taskId: string) => history.get(taskId),
			getAll: () => Array.from(history.values()),
		},
		taskSessions: {
			canCreateTask: () => true,
			getMaxLiveTasks: () => 3,
			getTask: (taskId: string) => tasks.get(taskId),
			getMetadata: () => Object.fromEntries(metadata),
		},
		contextProxy: { globalStorageUri: { fsPath: "C:/storage" } },
		log: vi.fn(),
		taskLifecycleHistoryWrites: new Map(),
		independentTaskWaiters: new Map(),
		cancelTask: vi.fn(async (taskId: string, source: string) => {
			const task = tasks.get(taskId)
			if (task) task.abort = true
			void source
		}),
		removeTaskFromStack: vi.fn(async (options: { taskId: string }) => {
			const task = tasks.get(options.taskId)
			if (task) task.abort = true
			tasks.delete(options.taskId)
			const record = history.get(options.taskId)
			if (record) record.status = "interrupted"
			const taskMetadata = metadata.get(options.taskId)
			if (taskMetadata) taskMetadata.lifecycle = TaskLifecycleState.Closed
		}),
		updateTaskHistory: vi.fn(async (item: Record<string, unknown>) => {
			history.set(String(item.id), item)
			return []
		}),
	})
	return {
		provider,
		internals,
		tasks,
		history,
		metadata,
	}
}

const taskHistoryItem = (id: string, parentId: string, task = "Child objective") => ({
	id,
	task,
	orchestrationParentTaskId: parentId,
	orchestrationWorkspaceMode: "shared",
	taskKind: "primary",
	status: "active",
	ts: 10,
	number: 2,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: "C:/repo",
})

describe("Cross-task orchestration host", () => {
	it("creates a background primary task with the parent's execution snapshot and a distinct persisted owner", async () => {
		const { provider, internals, tasks, metadata } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			orchestrationWorkspaceMode: "shared",
			metadata: { task: "Inspect parser" },
		})
		tasks.set(parent.taskId, parent)
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })
		internals.createTask = vi.fn(async () => child)

		const created = await provider.createIndependentTask(parent as unknown as Task, "Inspect parser", "shared")

		expect(internals.createTask).toHaveBeenCalledWith(
			"Inspect parser",
			undefined,
			undefined,
			expect.objectContaining({
				taskId: expect.any(String),
				background: true,
				preserveExisting: true,
				workspacePath: parent.workspacePath,
				historyWorkspacePath: parent.historyWorkspacePath,
				taskMode: "code",
				taskApiConfigName: "profile-a",
				apiConfiguration: parent.apiConfiguration,
				orchestrationParentTaskId: parent.taskId,
			}),
		)
		expect(child.taskKind).toBe("primary")
		expect(created).toMatchObject({ task_id: "child-1", objective: "Inspect parser", lifecycle: "running" })
	})

	it("permanently stops a child if the create call is cancelled after the child starts", async () => {
		const { provider, internals, tasks, history, metadata } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			orchestrationWorkspaceMode: "shared",
			metadata: { task: "Inspect parser" },
		})
		const controller = new AbortController()
		const cancellation = new Error("Cancelled by the parent")
		internals.createTask = vi.fn(async () => {
			tasks.set(child.taskId, child)
			history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId, "Inspect parser"))
			metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })
			controller.abort(cancellation)
			return child
		})

		await expect(
			provider.createIndependentTask(parent as unknown as Task, "Inspect parser", "shared", controller.signal),
		).rejects.toBe(cancellation)

		expect(internals.cancelTask).not.toHaveBeenCalled()
		expect(internals.removeTaskFromStack).toHaveBeenCalledWith({
			taskId: child.taskId,
			requireAbortSuccess: true,
		})
		expect(tasks.has(child.taskId)).toBe(false)
		expect(history.get(child.taskId)?.status).toBe("interrupted")
	})

	it("waits on lifecycle events and returns the child's terminal response", async () => {
		const { provider, tasks, history, metadata } = createProviderFixture()
		const parent = createTask()
		let completed = false
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			isCompleted: vi.fn(() => completed),
			clineMessages: [
				{ type: "say", say: "completion_result", partial: false, text: "Parser result is stable." },
			],
		})
		const once = child.once.bind(child)
		child.once = ((event: string, listener: (...args: any[]) => void) => {
			once(event, listener)
			if (event === AlphaCodeEventName.TaskCompleted) {
				queueMicrotask(() => {
					completed = true
					child.emit(AlphaCodeEventName.TaskCompleted, child.taskId)
				})
			}
			return child
		}) as FakeTask["once"]
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

		await expect(
			provider.waitForIndependentTask(parent as unknown as Task, child.taskId, 5000),
		).resolves.toMatchObject({
			task_id: child.taskId,
			lifecycle: "completed",
			result: "Parser result is stable.",
		})
	})

	it("attributes child-to-parent input, rejects unrelated IDs, and does not allow a child to steer its parent", async () => {
		const { provider, tasks, history, metadata } = createProviderFixture()
		const parent = createTask()
		const child = createTask({ taskId: "child-1", orchestrationParentTaskId: parent.taskId })
		tasks.set(parent.taskId, parent)
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

		await expect(
			provider.sendIndependentTaskMessage(child as unknown as Task, parent.taskId, "Change focus"),
		).resolves.toEqual({
			task_id: parent.taskId,
			status: "queued",
		})
		await expect(
			provider.sendIndependentTaskMessage(child as unknown as Task, "parent", "Finished the review"),
		).resolves.toEqual({ task_id: parent.taskId, status: "queued" })
		expect(parent.messageQueueService.addMessage).toHaveBeenCalledWith(
			`Message from task ${child.taskId}:\nChange focus`,
		)
		expect(parent.messageQueueService.addMessage).toHaveBeenCalledWith(
			`Message from task ${child.taskId}:\nFinished the review`,
		)
		await expect(
			provider.sendIndependentTaskMessage(parent as unknown as Task, "unrelated", "Hello"),
		).rejects.toThrow("direct child")
		await expect(
			provider.steerIndependentTask(child as unknown as Task, parent.taskId, "Take over"),
		).rejects.toThrow("top-level primary task")
	})

	it("returns a completed child's result to a parent that has finished its turn", async () => {
		const { provider, internals, tasks, history, metadata } = createProviderFixture()
		const parent = createTask({ isCompleted: vi.fn(() => true) })
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			isCompleted: vi.fn(() => true),
			clineMessages: [
				{ type: "say", say: "completion_result", partial: false, text: "Parser result is stable." },
			],
		})
		tasks.set(parent.taskId, parent)
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Completed, lastUpdatedAt: 10 })

		await internals.notifyIndependentTaskCompletion(child)

		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledOnce()
		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledWith(
			`Message from task ${child.taskId}:\nCompleted.\nParser result is stable.`,
		)
	})

	it("queues parent messages and applies steering to only the addressed direct child", async () => {
		const { provider, tasks, history, metadata } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			steerUserMessage: vi.fn(async () => undefined),
		})
		tasks.set(parent.taskId, parent)
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

		await expect(
			provider.sendIndependentTaskMessage(parent as unknown as Task, child.taskId, "Keep the report brief"),
		).resolves.toEqual({ task_id: child.taskId, status: "queued" })
		expect(child.messageQueueService.addMessage).toHaveBeenCalledWith(
			`Message from parent task ${parent.taskId}:\nKeep the report brief`,
		)

		await expect(
			provider.steerIndependentTask(parent as unknown as Task, child.taskId, "Focus on parser recovery"),
		).resolves.toEqual({ task_id: child.taskId, status: "steered" })
		expect(child.steerUserMessage).toHaveBeenCalledWith(
			`Message from parent task ${parent.taskId}:\nFocus on parser recovery`,
		)
		await expect(
			provider.steerIndependentTask(parent as unknown as Task, "unrelated", "Take over"),
		).rejects.toThrow("direct child")
	})

	it("closes only direct children without rehydrating them and makes repeated stop requests idempotent", async () => {
		const { provider, internals, tasks, history, metadata } = createProviderFixture()
		const parent = createTask()
		const child = createTask({ taskId: "child-1", orchestrationParentTaskId: parent.taskId })
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

		await expect(provider.stopIndependentTask(parent as unknown as Task, child.taskId)).resolves.toEqual({
			task_id: child.taskId,
			status: "stopped",
		})
		expect(internals.removeTaskFromStack).toHaveBeenCalledTimes(1)
		expect(internals.removeTaskFromStack).toHaveBeenCalledWith({
			taskId: child.taskId,
			requireAbortSuccess: true,
		})
		expect(internals.cancelTask).not.toHaveBeenCalled()
		expect(history.get(child.taskId)?.status).toBe("interrupted")
		await expect(provider.stopIndependentTask(parent as unknown as Task, child.taskId)).resolves.toEqual({
			task_id: child.taskId,
			status: "already_terminal",
		})
		expect(internals.removeTaskFromStack).toHaveBeenCalledTimes(1)
	})
})
