import { EventEmitter } from "events"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { AlphaCodeEventName, TaskLifecycleState } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"
import { AgentMessageInbox } from "../../task-persistence/AgentMessageInbox"
import { TaskHistoryStore, saveTaskMessages } from "../../task-persistence"
import { readApiMessages, saveApiMessages } from "../../task-persistence/apiMessages"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

type FakeTask = EventEmitter & Record<string, any>
const temporaryDirectories: string[] = []

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("alpha-cross-task-"))
			throw new Error("Unexpected cross-task test cleanup path")
		await fs.rm(directory, { recursive: true, force: true })
	}
})

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
		metadata: { task: "Can you launch a test thread?" },
		clineMessages: [],
		apiConversationHistory: [],
		abort: false,
		abortReason: undefined,
		taskAsk: undefined,
		getTaskMode: vi.fn(async () => "code"),
		getTaskApiConfigName: vi.fn(async () => "profile-a"),
		isCompleted: vi.fn(() => false),
		isTurnActive: vi.fn(() => true),
		steerUserMessage: vi.fn(async () => undefined),
		receiveAgentMessage: vi.fn(async () => undefined),
		resumeCompletedTaskFollowup: vi.fn(async () => undefined),
		submitUserMessage: vi.fn(async () => undefined),
		messageQueueService: { addMessage: vi.fn(() => true) },
		...overrides,
	}) as FakeTask
}

function createProviderFixture(storagePath?: string) {
	const globalStoragePath = storagePath ?? path.join(os.tmpdir(), `alpha-cross-task-${crypto.randomUUID()}`)
	if (!storagePath) temporaryDirectories.push(globalStoragePath)
	const provider = Object.create(AlphaProvider.prototype) as AlphaProvider
	const tasks = new Map<string, FakeTask>()
	const history = new Map<string, Record<string, unknown>>()
	const metadata = new Map<string, Record<string, unknown>>()
	const internals = provider as unknown as Record<string, any>
	const sessions = storagePath ? TaskSessionRegistry.forGlobalStorage(storagePath) : new TaskSessionRegistry()
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
			runOwnershipOperation: sessions.runOwnershipOperation.bind(sessions),
		},
		contextProxy: { globalStorageUri: { fsPath: globalStoragePath } },
		log: vi.fn(),
		taskLifecycleHistoryWrites: new Map(),
		independentTaskWaiters: new Map(),
		getAgentLifecycleSnapshot: vi.fn(() => ({ turnId: "turn-1" })),
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
		sessions,
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
	it("rejects independent task creation without an explicit user request", async () => {
		const { provider, internals, tasks } = createProviderFixture()
		const parent = createTask({
			apiConversationHistory: [{ role: "user", content: "Fix the parser with managed sub-agents if useful." }],
		})
		tasks.set(parent.taskId, parent)
		internals.createTask = vi.fn()

		await expect(
			provider.createIndependentTask(parent as unknown as Task, "Inspect parser", "shared"),
		).rejects.toThrow(/explicit.*task|explicit.*thread/i)
		expect(internals.createTask).not.toHaveBeenCalled()
	})

	it("rejects recursive independent-child launch even when its model-authored objective requests a new task", async () => {
		const { provider, internals } = createProviderFixture()
		const child = createTask({
			orchestrationParentTaskId: "original-parent",
			apiConversationHistory: [],
			metadata: { task: "Create a new independent task for the next step" },
		})
		internals.createTask = vi.fn()
		await expect(provider.createIndependentTask(child as unknown as Task, "Next step", "shared")).rejects.toThrow(
			"top-level primary task",
		)
		expect(internals.createTask).not.toHaveBeenCalled()
	})

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
				{ ts: 100, type: "say", say: "completion_result", partial: false, text: "Parser result is stable." },
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
		tasks.set(parent.taskId, parent)
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

	it.each([AlphaCodeEventName.TaskInteractive, AlphaCodeEventName.TaskResumable])(
		"observes %s when attention changes between the snapshot and listener registration",
		async (event) => {
			vi.useFakeTimers()
			try {
				const { provider, internals, tasks, history, metadata } = createProviderFixture()
				const parent = createTask()
				const child = createTask({ taskId: "child-1", orchestrationParentTaskId: parent.taskId })
				tasks.set(child.taskId, child)
				history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
				metadata.set(child.taskId, { lifecycle: TaskLifecycleState.Running })
				const getRecord = internals.getCrossTaskRecord.bind(provider)
				vi.spyOn(internals, "getCrossTaskRecord").mockImplementationOnce(async (...args: unknown[]) => {
					const snapshot = await getRecord(...args)
					metadata.set(child.taskId, { lifecycle: TaskLifecycleState.Waiting })
					child.emit(event, child.taskId)
					return snapshot
				})
				const waited = provider.waitForIndependentTask(parent as unknown as Task, child.taskId, 1000)
				await vi.runAllTimersAsync()
				await expect(waited).resolves.toMatchObject({ task_id: child.taskId, lifecycle: "waiting" })
				expect(await waited).not.toHaveProperty("timed_out")
				for (const name of [
					AlphaCodeEventName.TaskCompleted,
					AlphaCodeEventName.TaskAborted,
					AlphaCodeEventName.TaskInteractive,
					AlphaCodeEventName.TaskResumable,
				])
					expect(child.listenerCount(name)).toBe(0)
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it.each([undefined, "tool", "followup"])(
		"attributes child-to-parent input during ask %s, rejects unrelated IDs, and does not allow a child to steer its parent",
		async (taskAsk) => {
			const { provider, tasks, history, metadata } = createProviderFixture()
			const parent = createTask({ taskAsk })
			const child = createTask({ taskId: "child-1", orchestrationParentTaskId: parent.taskId })
			tasks.set(parent.taskId, parent)
			tasks.set(child.taskId, child)
			history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
			metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

			await expect(
				provider.sendIndependentTaskMessage(child as unknown as Task, parent.taskId, "Change focus"),
			).resolves.toEqual({
				task_id: parent.taskId,
				status: "buffered",
			})
			await expect(
				provider.sendIndependentTaskMessage(child as unknown as Task, "parent", "Finished the review"),
			).resolves.toEqual({ task_id: parent.taskId, status: "buffered" })
			expect(parent.receiveAgentMessage).toHaveBeenCalledWith(
				expect.objectContaining({ senderTaskId: child.taskId, text: "Change focus" }),
			)
			expect(parent.messageQueueService.addMessage).not.toHaveBeenCalled()
			expect(parent.submitUserMessage).not.toHaveBeenCalled()
			expect(parent.receiveAgentMessage).toHaveBeenCalledWith(
				expect.objectContaining({ senderTaskId: child.taskId, text: "Finished the review" }),
			)
			expect(parent.messageQueueService.addMessage).not.toHaveBeenCalled()
			expect(parent.submitUserMessage).not.toHaveBeenCalled()
			await expect(
				provider.sendIndependentTaskMessage(parent as unknown as Task, "unrelated", "Hello"),
			).rejects.toThrow("direct child")
			await expect(
				provider.steerIndependentTask(child as unknown as Task, parent.taskId, "Take over"),
			).rejects.toThrow("top-level primary task")
		},
	)

	it("returns a completed child's result to a parent that has finished its turn", async () => {
		const { provider, internals, tasks, history, metadata } = createProviderFixture()
		const parent = createTask({ isCompleted: vi.fn(() => true) })
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			isCompleted: vi.fn(() => true),
			clineMessages: [
				{ ts: 100, type: "say", say: "completion_result", partial: false, text: "Parser result is stable." },
			],
		})
		tasks.set(parent.taskId, parent)
		tasks.set(child.taskId, child)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Completed, lastUpdatedAt: 10 })

		await internals.notifyIndependentTaskCompletion(child)
		await internals.notifyIndependentTaskCompletion(child)

		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledOnce()
		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledWith(
			"Continue with the pending agent messages.",
			[],
			"agent",
		)
		expect(parent.receiveAgentMessage).toHaveBeenCalledOnce()
		expect(history.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
			expect.objectContaining({ completionMessageTs: 100, turnId: "turn-1", deliveredVia: "inbox" }),
		])
	})

	it("reserves a stable completion identity before delivery and retries wake failures without duplicating committed input", async () => {
		const { internals, tasks, history } = createProviderFixture()
		const parent = createTask({ isCompleted: vi.fn(() => true) })
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
		})
		tasks.set(parent.taskId, parent)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		parent.resumeCompletedTaskFollowup.mockRejectedValueOnce(new Error("wake failed"))
		await expect(internals.notifyIndependentTaskCompletion(child)).rejects.toThrow("wake failed")
		const receipt = (history.get(child.taskId)?.orchestrationCompletionNotifications as any[])[0]
		expect(receipt).not.toHaveProperty("deliveredAt")
		await internals.notifyIndependentTaskCompletion(child)
		expect(parent.receiveAgentMessage.mock.calls.map(([message]: [any]) => message.id)).toEqual([
			receipt.id,
			receipt.id,
		])
		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledTimes(2)

		child.clineMessages.push({ ts: 200, type: "say", say: "completion_result", text: "Result" })
		internals.updateTaskHistory.mockImplementationOnce(async (item: Record<string, unknown>) => {
			history.set(child.taskId, item)
		})
		internals.updateTaskHistory.mockRejectedValueOnce(new Error("receipt write failed"))
		parent.receiveAgentMessage.mockImplementationOnce(async (message: any) => {
			parent.apiConversationHistory.push({ role: "user", agent_message_id: message.id, content: message.text })
		})
		await expect(internals.notifyIndependentTaskCompletion(child)).rejects.toThrow("receipt write failed")
		await internals.notifyIndependentTaskCompletion(child)
		expect(parent.receiveAgentMessage).toHaveBeenCalledTimes(3)
		expect(parent.resumeCompletedTaskFollowup).toHaveBeenCalledTimes(3)
		const receipts = history.get(child.taskId)?.orchestrationCompletionNotifications as any[]
		expect(new Set(receipts.map((item) => item.id)).size).toBe(2)
		expect(receipts.every((item) => item.deliveredAt !== undefined)).toBe(true)
	})

	it("reserves completion for wait until its exact successful tool result is durable", async () => {
		const { internals, tasks, history } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
		})
		tasks.set(parent.taskId, parent)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		await internals.notifyIndependentTaskCompletion(child, true)
		await internals.notifyIndependentTaskCompletion(child)
		expect(parent.receiveAgentMessage).not.toHaveBeenCalled()
		expect(history.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
			expect.objectContaining({ deliveredVia: "wait" }),
		])
		expect(
			(history.get(child.taskId)?.orchestrationCompletionNotifications as any[])[0].deliveredAt,
		).toBeUndefined()
	})

	it("does not block transcript replacement on stale unrelated child metadata without a saved wait receipt", async () => {
		const { provider, internals, history } = createProviderFixture()
		history.set("old-child", taskHistoryItem("old-child", "parent-1"))
		internals.taskHistoryStore.invalidate = vi.fn(async () => {
			throw new Error("The old child history file was removed")
		})
		await expect(provider.settleIndependentTaskWaitReceiptsForParent("parent-1")).resolves.toBeUndefined()
		expect(internals.taskHistoryStore.invalidate).not.toHaveBeenCalled()
	})

	it("serializes duplicate completion callbacks and never evicts an undelivered receipt at the bound", async () => {
		const { internals, tasks, history } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
		})
		tasks.set(parent.taskId, parent)
		const pending = Array.from({ length: 100 }, (_, index) => ({
			id: `pending-${index}`,
			turnId: `turn-${index}`,
			completionMessageTs: index,
			createdAt: index,
		}))
		history.set(child.taskId, {
			...taskHistoryItem(child.taskId, parent.taskId),
			orchestrationCompletionNotifications: pending,
		})
		await expect(internals.notifyIndependentTaskCompletion(child)).rejects.toThrow("100 undelivered")
		expect(history.get(child.taskId)?.orchestrationCompletionNotifications).toEqual(pending)
		expect(parent.receiveAgentMessage).not.toHaveBeenCalled()
		history.set(child.taskId, {
			...history.get(child.taskId),
			orchestrationCompletionNotifications: pending.map((item, index) =>
				index === 0 ? { ...item, deliveredAt: 1, deliveredVia: "inbox" } : item,
			),
		})
		await Promise.all([
			internals.notifyIndependentTaskCompletion(child),
			internals.notifyIndependentTaskCompletion(child),
		])
		expect(parent.receiveAgentMessage).toHaveBeenCalledOnce()
		const receipts = history.get(child.taskId)?.orchestrationCompletionNotifications as any[]
		expect(receipts).toHaveLength(100)
		expect(receipts.filter((item) => item.deliveredAt === undefined)).toEqual(pending.slice(1))
	})

	it("recovers an unloaded parent's completion inbox and receipts across provider reload", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-independent-completion-"))
		const store = new TaskHistoryStore(directory)
		const reloadedStore = new TaskHistoryStore(directory)
		try {
			await store.initialize()
			const { internals, history } = createProviderFixture()
			internals.contextProxy.globalStorageUri.fsPath = directory
			internals.taskHistoryStore = store
			internals.updateTaskHistory = vi.fn((item) => store.upsert(item))
			const child = createTask({
				taskId: "child-1",
				orchestrationParentTaskId: "parent-1",
				clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
			})
			const item = {
				...taskHistoryItem(child.taskId, "parent-1"),
				status: "completed" as const,
				taskKind: "primary" as const,
				orchestrationWorkspaceMode: "shared" as const,
			}
			await store.upsert(item)
			await saveTaskMessages({
				taskId: child.taskId,
				globalStoragePath: directory,
				messages: child.clineMessages,
			})
			// Crash after inbox append, before the delivered receipt commits.
			internals.updateTaskHistory.mockImplementationOnce((value: Parameters<TaskHistoryStore["upsert"]>[0]) =>
				store.upsert(value),
			)
			internals.updateTaskHistory.mockRejectedValueOnce(new Error("receipt unavailable"))
			await expect(internals.notifyIndependentTaskCompletion(child)).rejects.toThrow("receipt unavailable")
			expect(store.get(child.taskId)?.orchestrationCompletionNotifications?.[0].deliveredAt).toBeUndefined()
			await reloadedStore.initialize()
			const reloaded = createProviderFixture()
			reloaded.internals.contextProxy.globalStorageUri.fsPath = directory
			reloaded.internals.taskHistoryStore = reloadedStore
			reloaded.internals.updateTaskHistory = vi.fn((value) => reloadedStore.upsert(value))
			await reloaded.internals.reconcileIndependentTaskCompletions()
			await reloaded.internals.reconcileIndependentTaskCompletions()
			const persist = vi.fn(async () => undefined)
			await new AgentMessageInbox("parent-1", directory).deliver(persist)
			expect(persist).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ senderTaskId: child.taskId, text: "Completed.\nResult" }),
			)
			expect(reloadedStore.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
				expect.objectContaining({ deliveredAt: expect.any(Number), deliveredVia: "inbox" }),
			])
			expect(history.size).toBe(0)
		} finally {
			store.dispose()
			reloadedStore.dispose()
			await Promise.all([store.flushIndex(), reloadedStore.flushIndex()])
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("fences compaction after a failed wait receipt write and reloads without second parent input", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-independent-wait-"))
		const store = new TaskHistoryStore(directory)
		const reloadedStore = new TaskHistoryStore(directory)
		try {
			await store.initialize()
			const { internals, tasks } = createProviderFixture(directory)
			internals.taskHistoryStore = store
			internals.updateTaskHistory = vi.fn((item) => store.upsert(item))
			const parent = createTask()
			const child = createTask({
				taskId: "child-1",
				orchestrationParentTaskId: parent.taskId,
				clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
			})
			tasks.set(parent.taskId, parent)
			await store.upsert({
				...taskHistoryItem(child.taskId, parent.taskId),
				status: "completed" as const,
				taskKind: "primary" as const,
				orchestrationWorkspaceMode: "shared" as const,
			})
			await saveTaskMessages({
				taskId: child.taskId,
				globalStoragePath: directory,
				messages: child.clineMessages,
			})
			await internals.notifyIndependentTaskCompletion(child, true)
			const reserved = store.get(child.taskId)!.orchestrationCompletionNotifications![0]
			expect(reserved).toMatchObject({ deliveredVia: "wait" })
			expect(reserved.deliveredAt).toBeUndefined()
			await saveApiMessages({
				taskId: parent.taskId,
				globalStoragePath: directory,
				messages: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "other-1", name: "exec_command", input: {} }],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "other-1",
								content: JSON.stringify({ lifecycle: "completed", completion_receipt_id: reserved.id }),
							},
						],
					},
				],
			})
			await internals.notifyIndependentTaskCompletion(child)
			expect(store.get(child.taskId)?.orchestrationCompletionNotifications?.[0].deliveredAt).toBeUndefined()
			await saveApiMessages({
				taskId: parent.taskId,
				globalStoragePath: directory,
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "wait-1", name: "wait_task", input: { task_id: child.taskId } },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "wait-1",
								content: JSON.stringify({
									task_id: child.taskId,
									lifecycle: "completed",
									completion_receipt_id: reserved.id,
									result: "Result",
								}),
							},
						],
					},
				],
			})
			internals.updateTaskHistory.mockRejectedValueOnce(new Error("final wait receipt unavailable"))
			await expect(internals.notifyIndependentTaskCompletion(child)).rejects.toThrow(
				"final wait receipt unavailable",
			)
			expect(parent.receiveAgentMessage).not.toHaveBeenCalled()
			const refresh = vi
				.spyOn(store, "invalidate")
				.mockRejectedValueOnce(new Error("history refresh unavailable"))
			await expect(internals.settleIndependentTaskWaitReceiptsForParent(parent.taskId)).rejects.toThrow(
				"history refresh unavailable",
			)
			expect(refresh).toHaveBeenCalledWith(child.taskId, { requireExisting: true })
			refresh.mockRestore()
			internals.updateTaskHistory.mockRejectedValueOnce(new Error("compaction receipt unavailable"))
			await expect(internals.settleIndependentTaskWaitReceiptsForParent(parent.taskId)).rejects.toThrow(
				"compaction receipt unavailable",
			)
			expect(
				JSON.stringify(await readApiMessages({ taskId: parent.taskId, globalStoragePath: directory })),
			).toContain(reserved.id)
			expect(store.get(child.taskId)?.orchestrationCompletionNotifications?.[0].deliveredAt).toBeUndefined()
			await internals.settleIndependentTaskWaitReceiptsForParent(parent.taskId)
			await saveApiMessages({
				taskId: parent.taskId,
				globalStoragePath: directory,
				messages: [{ role: "user", content: "Compacted conversation" }],
			})
			await reloadedStore.initialize()
			const reloaded = createProviderFixture(directory)
			reloaded.internals.taskHistoryStore = reloadedStore
			reloaded.internals.updateTaskHistory = vi.fn((item) => reloadedStore.upsert(item))
			await reloaded.internals.reconcileIndependentTaskCompletions()
			await reloaded.internals.reconcileIndependentTaskCompletions()
			const inboxDelivery = vi.fn(async () => undefined)
			await new AgentMessageInbox(parent.taskId, directory).deliver(inboxDelivery)
			expect(inboxDelivery).not.toHaveBeenCalled()
			expect(reloadedStore.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
				expect.objectContaining({ id: reserved.id, deliveredVia: "wait", deliveredAt: expect.any(Number) }),
			])
		} finally {
			store.dispose()
			reloadedStore.dispose()
			await Promise.all([store.flushIndex(), reloadedStore.flushIndex()])
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("recovers an interrupted wait without a durable tool result through its same reserved inbox identity", async () => {
		const { internals, tasks, history } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child-1",
			orchestrationParentTaskId: parent.taskId,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
		})
		tasks.set(parent.taskId, parent)
		history.set(child.taskId, taskHistoryItem(child.taskId, parent.taskId))
		await internals.notifyIndependentTaskCompletion(child, true)
		const receipt = (history.get(child.taskId)?.orchestrationCompletionNotifications as any[])[0]
		tasks.delete(parent.taskId)
		await internals.notifyIndependentTaskCompletion(child)
		await internals.notifyIndependentTaskCompletion(child)
		const inboxDelivery = vi.fn(async () => undefined)
		await new AgentMessageInbox(parent.taskId, internals.contextProxy.globalStorageUri.fsPath).deliver(
			inboxDelivery,
		)
		expect(inboxDelivery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: receipt.id }))
		expect(history.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
			expect.objectContaining({ id: receipt.id, deliveredVia: "inbox", deliveredAt: expect.any(Number) }),
		])
	})

	it("buffers parent messages outside the human queue and applies steering to only the addressed direct child", async () => {
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
		).resolves.toEqual({ task_id: child.taskId, status: "buffered" })
		expect(child.receiveAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ senderTaskId: parent.taskId, text: "Keep the report brief" }),
		)
		expect(child.messageQueueService.addMessage).not.toHaveBeenCalled()
		expect(child.submitUserMessage).not.toHaveBeenCalled()

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
