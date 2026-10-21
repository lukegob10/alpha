import { EventEmitter } from "events"
import fs from "node:fs/promises"
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
import { crossTaskWorktreeService } from "../CrossTaskWorktreeService"
import * as threadTaskStorage from "../ThreadTaskStorage"
import * as taskStorage from "../../../utils/storage"
import { AgentLifecycleJournal } from "../../agent/lifecycle"

type FakeTask = EventEmitter & Record<string, any>
const temporaryDirectories: string[] = []

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (
			path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
			!path.basename(directory).startsWith("alpha-cross-task-")
		)
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
		getTaskApprovalMode: vi.fn(() => "ask"),
		isCompleted: vi.fn(() => false),
		isTurnActive: vi.fn(() => true),
		steerUserMessage: vi.fn(async () => undefined),
		steerAgentMessage: vi.fn(async () => "steered"),
		receiveAgentMessage: vi.fn(async () => undefined),
		recordAgentStopRequest: vi.fn(async () => undefined),
		resumeWithAgentMessages: vi.fn(async () => undefined),
		resumeCompletedTaskFollowup: vi.fn(async () => undefined),
		submitUserMessage: vi.fn(async () => undefined),
		messageQueueService: { addMessage: vi.fn(() => true) },
		updateApiConfiguration: vi.fn(),
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
			"explicit user request",
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
				taskApprovalMode: "ask",
				apiConfiguration: parent.apiConfiguration,
				orchestrationParentTaskId: parent.taskId,
			}),
		)
		expect(child.taskKind).toBe("primary")
		expect(created).toMatchObject({ task_id: "child-1", objective: "Inspect parser", lifecycle: "running" })
	})

	it("inherits the host presentation-call opt-out when creating an independent peer", async () => {
		const { provider, internals, tasks, metadata } = createProviderFixture()
		const parent = createTask({ presentationModelCalls: false })
		const child = createTask({
			taskId: "governed-peer",
			orchestrationParentTaskId: parent.taskId,
			presentationModelCalls: false,
		})
		tasks.set(parent.taskId, parent)
		metadata.set(child.taskId, { id: child.taskId, lifecycle: TaskLifecycleState.Running })
		internals.createTask = vi.fn(async () => child)

		await provider.createIndependentTask(parent as unknown as Task, "Inspect parser", "shared")

		expect(internals.createTask).toHaveBeenCalledWith(
			"Inspect parser",
			undefined,
			undefined,
			expect.objectContaining({ presentationModelCalls: false }),
		)
	})

	it.each(["caller", "source", "saved"])(
		"preserves presentation-call suppression from the %s in a cold fork's history",
		async (source) => {
			const { provider, tasks, history } = createProviderFixture()
			const caller = createTask({ ...(source === "caller" ? { presentationModelCalls: false } : {}) })
			const peer = createTask({
				taskId: "peer",
				isCompleted: () => true,
				isTurnActive: () => false,
				apiConversationHistory: [{ role: "user", content: "Inspect parser", ts: 10 }],
				...(source === "source" ? { presentationModelCalls: false } : {}),
			})
			tasks.set(peer.taskId, peer)
			history.set(peer.taskId, {
				...taskHistoryItem(peer.taskId, "original-parent"),
				status: "completed",
				...(source === "saved" ? { presentationModelCalls: false } : {}),
			})

			const fork = await provider.forkIndependentTask(caller as unknown as Task, peer.taskId)

			expect(history.get(fork.task_id)).toHaveProperty("presentationModelCalls", false)
		},
	)

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
		"attributes peer input during ask %s without answering the human input boundary",
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
			).rejects.toThrow("current workspace")
			await expect(
				provider.steerIndependentTask(child as unknown as Task, parent.taskId, "Take over"),
			).resolves.toEqual({ task_id: parent.taskId, status: "steered" })
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
		expect(child.steerAgentMessage).toHaveBeenCalledWith({
			id: expect.any(String),
			senderTaskId: parent.taskId,
			text: "Focus on parser recovery",
		})
		expect(child.steerUserMessage).not.toHaveBeenCalled()
		await expect(
			provider.steerIndependentTask(parent as unknown as Task, "unrelated", "Take over"),
		).rejects.toThrow("current workspace")
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
		expect(child.recordAgentStopRequest).toHaveBeenCalledExactlyOnceWith(parent.taskId, undefined)
	})

	it("persists the peer stop notice before starting cancellation", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		let release!: () => void
		let entered!: () => void
		const noticeCommitted = new Promise<void>((resolve) => {
			release = resolve
		})
		const noticeEntered = new Promise<void>((resolve) => {
			entered = resolve
		})
		const peer = createTask({
			taskId: "peer",
			recordAgentStopRequest: vi.fn(async () => {
				entered()
				await noticeCommitted
			}),
		})
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, caller.taskId))
		const stopping = provider.stopIndependentTask(caller as unknown as Task, peer.taskId, "Work is complete")
		try {
			expect(await Promise.race([noticeEntered.then(() => "notice"), stopping.then(() => "stopped")])).toBe(
				"notice",
			)
			expect(internals.removeTaskFromStack).not.toHaveBeenCalled()
			expect(peer.abort).toBe(false)
			release()
			await expect(stopping).resolves.toEqual({ task_id: peer.taskId, status: "stopped" })
			expect(peer.recordAgentStopRequest).toHaveBeenCalledExactlyOnceWith(caller.taskId, "Work is complete")
		} finally {
			release()
			await stopping
		}
	})

	it("does not cancel a peer when its stop notice fails to persist", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const peer = createTask({
			taskId: "peer",
			recordAgentStopRequest: vi.fn(async () => {
				throw new Error("Stop notice persistence failed")
			}),
		})
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, caller.taskId))
		await expect(provider.stopIndependentTask(caller as unknown as Task, peer.taskId)).rejects.toThrow(
			"Stop notice persistence failed",
		)
		expect(internals.removeTaskFromStack).not.toHaveBeenCalled()
		expect(peer.abort).toBe(false)
	})

	it("discovers unrelated independent peers with bounded, stable pages and excludes other authority scopes", async () => {
		const { provider, tasks, history, metadata } = createProviderFixture()
		const caller = createTask()
		for (const id of ["peer-a", "peer-b", "peer-c", "archived", "foreign", "managed", "diagnostic", "legacy"]) {
			const record = { ...taskHistoryItem(id, "other-parent"), orchestrationParentTaskId: undefined }
			if (id === "foreign") record.workspace = "C:/other-repo"
			if (id === "managed") record.taskKind = "subagent"
			history.set(id, {
				...record,
				...(id === "peer-b" ? { generatedTitle: "Review parser" } : {}),
				...(id === "archived" ? { archived: true } : {}),
				...(id === "diagnostic" ? { diagnosticSession: true } : {}),
				...(id === "legacy" ? { parentTaskId: "legacy-parent" } : {}),
			})
		}
		tasks.set("peer-a", createTask({ taskId: "peer-a" }))
		metadata.set("peer-a", { id: "peer-a", lifecycle: TaskLifecycleState.Running, lastUpdatedAt: 10 })

		const first = await provider.listIndependentThreads(caller as unknown as Task, { limit: 2 })
		expect(first.threads.map((thread) => thread.id)).toEqual(["peer-a", "peer-b"])
		expect(first.threads[1]?.title).toBe("Review parser")
		expect(first.nextCursor).toEqual(expect.any(String))
		const next = await provider.listIndependentThreads(caller as unknown as Task, {
			limit: 2,
			cursor: first.nextCursor!,
		})
		expect(next.threads.map((thread) => thread.id)).toEqual(["peer-c"])
		expect(next.nextCursor).toBeNull()
		const archived = await provider.listIndependentThreads(caller as unknown as Task, { archived: true })
		expect(archived.threads.map((thread) => thread.id)).toEqual(["archived"])
		await expect(provider.listIndependentThreads(caller as unknown as Task, { cursor: "broken" })).rejects.toThrow(
			"cursor",
		)
	})

	it.each([
		{ taskKind: "subagent" },
		{ diagnosticSession: true },
		{ parentTaskId: "legacy-parent" },
		{ rootTaskId: "another-root" },
	])("rejects model control from restricted callers %o", async (overrides) => {
		const { provider } = createProviderFixture()
		const caller = createTask(overrides) as unknown as Task
		await expect(provider.listIndependentThreads(caller)).rejects.toThrow("independent primary")
		await expect(provider.sendIndependentTaskMessage(caller, "peer", "Hello")).rejects.toThrow(
			"independent primary",
		)
		await expect(provider.stopIndependentTask(caller, "peer")).rejects.toThrow("independent primary")
	})

	it("resumes an unrelated completed peer using its existing configuration and agent provenance", async () => {
		const { provider, tasks, history } = createProviderFixture()
		const caller = createTask()
		const configuration = { apiProvider: "vertex", apiModelId: "target-model" }
		const peer = createTask({ taskId: "peer", isCompleted: () => true, apiConfiguration: configuration })
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, { ...taskHistoryItem(peer.taskId, "other-parent"), status: "completed" })

		await expect(
			provider.sendIndependentTaskMessage(caller as unknown as Task, peer.taskId, "Follow up"),
		).resolves.toEqual({
			task_id: peer.taskId,
			status: "resumed",
		})
		expect(peer.receiveAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ senderTaskId: caller.taskId, text: "Follow up" }),
		)
		expect(peer.resumeCompletedTaskFollowup).toHaveBeenCalledWith(
			"Continue with the pending agent messages.",
			[],
			"agent",
		)
		expect(peer.apiConfiguration).toBe(configuration)
		expect(peer.updateApiConfiguration).not.toHaveBeenCalled()
	})

	it("hydrates an unloaded peer in the background with its saved authority before agent continuation", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const saved = {
			...taskHistoryItem("peer", "another-parent"),
			status: "completed",
			mode: "architect",
			apiConfigName: "peer-profile",
			approvalMode: "ask",
		}
		history.set("peer", saved)
		const peer = createTask({ taskId: "peer", isTurnActive: () => false })
		internals.createTaskWithHistoryItem = vi.fn(async () => {
			tasks.set(peer.taskId, peer)
			return peer
		})

		await expect(
			provider.sendIndependentTaskMessage(caller as unknown as Task, "peer", "Inspect status"),
		).resolves.toEqual({ task_id: "peer", status: "resumed" })
		expect(internals.createTaskWithHistoryItem).toHaveBeenCalledWith(
			saved,
			expect.objectContaining({
				startTask: false,
				background: true,
				preserveSelection: true,
				preserveExisting: true,
				requireSavedConfiguration: true,
			}),
		)
		expect(peer.receiveAgentMessage).toHaveBeenCalledBefore(peer.resumeWithAgentMessages)
		expect(peer.resumeWithAgentMessages).toHaveBeenCalledOnce()
		expect(peer.submitUserMessage).not.toHaveBeenCalled()
	})

	it("routes messages and steering to the peer owner across extension views", async () => {
		const callerView = createProviderFixture()
		const targetView = createProviderFixture()
		const caller = createTask()
		const peer = createTask({ taskId: "peer" })
		targetView.tasks.set(peer.taskId, peer)
		targetView.history.set(peer.taskId, taskHistoryItem(peer.taskId, "unrelated-parent"))
		vi.spyOn(callerView.provider, "getTaskOwner").mockReturnValue(targetView.provider)

		await callerView.provider.sendIndependentTaskMessage(caller as unknown as Task, peer.taskId, "Report back")
		await callerView.provider.steerIndependentTask(caller as unknown as Task, peer.taskId, "Focus on current work")
		expect(peer.receiveAgentMessage).toHaveBeenCalledOnce()
		expect(peer.steerAgentMessage).toHaveBeenCalledOnce()
	})

	it("serializes concurrent stop requests for an unrelated peer", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const peer = createTask({ taskId: "peer" })
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, "other-parent"))
		const results = await Promise.all([
			provider.stopIndependentTask(caller as unknown as Task, peer.taskId),
			provider.stopIndependentTask(caller as unknown as Task, peer.taskId),
		])
		expect(results.map((result) => result.status)).toEqual(["stopped", "already_terminal"])
		expect(internals.removeTaskFromStack).toHaveBeenCalledOnce()
	})

	it("preserves the original parent's completion delivery when an unrelated thread waits", async () => {
		const { provider, internals, tasks, history, metadata } = createProviderFixture()
		const caller = createTask()
		let completed = false
		const peer = createTask({
			taskId: "peer",
			orchestrationParentTaskId: "original-parent",
			isCompleted: () => completed,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Peer result" }],
		})
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, "original-parent"))
		metadata.set(peer.taskId, { id: peer.taskId, lifecycle: TaskLifecycleState.Running })
		const record = internals.getCrossTaskRecord.bind(provider)
		internals.getCrossTaskRecord = vi.fn(async (...args: unknown[]) => {
			const value = await record(...args)
			if (peer.listenerCount(AlphaCodeEventName.TaskCompleted)) {
				completed = true
				peer.emit(AlphaCodeEventName.TaskCompleted, peer.taskId)
			}
			return value
		})
		const waiting = provider.waitForIndependentTask(caller as unknown as Task, peer.taskId, 0)
		await expect(waiting).resolves.toMatchObject({ task_id: peer.taskId })
		expect(await waiting).not.toHaveProperty("completion_receipt_id")
		expect(internals.independentTaskWaiters.size).toBe(0)
		expect(history.get(peer.taskId)?.orchestrationCompletionNotifications).toBeUndefined()
	})

	it("rejects self lifecycle control and foreign, missing, managed, or diagnostic thread targets", async () => {
		const { provider, tasks, history } = createProviderFixture()
		const caller = createTask()
		tasks.set(caller.taskId, caller)
		for (const [id, overrides] of Object.entries({
			foreign: { workspace: "C:/other" },
			managed: { taskKind: "subagent" },
			diagnostic: { diagnosticSession: true },
		}))
			history.set(id, { ...taskHistoryItem(id, "other"), ...overrides })
		await expect(provider.stopIndependentTask(caller as unknown as Task, caller.taskId)).rejects.toThrow("itself")
		for (const id of ["foreign", "managed", "diagnostic", "../../missing"])
			await expect(provider.sendIndependentTaskMessage(caller as unknown as Task, id, "Hello")).rejects.toThrow(
				"current workspace",
			)
	})

	it("reads bounded peer conversation content without exposing provider state or hidden reasoning", async () => {
		const { provider, tasks, history } = createProviderFixture()
		const caller = createTask()
		const peer = createTask({
			taskId: "peer",
			isCompleted: () => true,
			apiConversationHistory: [
				{ role: "user", content: "Inspect parser", ts: 10 },
				{
					role: "assistant",
					content: "Parser is stable",
					ts: 11,
					encrypted_content: "opaque-provider-state",
					reasoning_content: "hidden-reasoning",
				},
			],
		})
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, { ...taskHistoryItem(peer.taskId, "other-parent"), status: "completed" })
		const result = await provider.readIndependentThread(caller as unknown as Task, peer.taskId)
		expect(result.thread).toMatchObject({ id: peer.taskId, kind: "alpha", status: { type: "idle" } })
		expect(JSON.stringify(result)).toContain("Parser is stable")
		expect(JSON.stringify(result)).not.toContain("opaque-provider-state")
		expect(JSON.stringify(result)).not.toContain("hidden-reasoning")
	})

	it.each(["failed", "interrupted"] as const)(
		"reads an older cold journal %s turn after a newer completion and through pagination",
		async (status) => {
			const { provider, internals, history } = createProviderFixture()
			const caller = createTask()
			const taskId = "cold-peer"
			const storagePath = internals.contextProxy.globalStorageUri.fsPath
			history.set(taskId, { ...taskHistoryItem(taskId, "other-parent"), status: "completed" })
			await saveApiMessages({
				taskId,
				globalStoragePath: storagePath,
				messages: [
					{ role: "user", input_origin: "human", content: "First request", ts: 11 },
					{ role: "assistant", content: "Candidate rejected by the host", phase: "final_answer", ts: 12 },
					{ role: "user", input_origin: "human", content: "Second request", ts: 21 },
					{ role: "assistant", content: "Second request completed", phase: "final_answer", ts: 22 },
				],
			})
			const journal = new AgentLifecycleJournal(taskId, storagePath)
			for (const [turnId, startedAt, terminalStatus] of [
				["first", 10, status],
				["second", 20, "completed"],
			] as const) {
				const identity = { version: 1 as const, taskId, runId: `run:${turnId}`, turnId }
				await journal.append({
					...identity,
					eventId: `${turnId}:started`,
					occurredAt: startedAt,
					type: "turn_started",
					payload: {},
				})
				await journal.append({
					...identity,
					eventId: `${turnId}:terminal`,
					occurredAt: startedAt + 3,
					type: "turn_terminal",
					payload: { status: terminalStatus },
				})
			}
			await journal.close()
			const newest = await provider.readIndependentThread(caller as unknown as Task, taskId)
			const older = await provider.readIndependentThread(caller as unknown as Task, taskId, {
				cursor: newest.page.nextCursor ?? undefined,
			})

			expect(newest.turns.map((turn) => turn.status)).toEqual(["completed"])
			expect(newest.page.hasMore).toBe(true)
			expect(older.turns.map((turn) => turn.status)).toEqual([status])
			expect(older.page.hasMore).toBe(false)
		},
	)

	it("forks committed peer history into an idle persisted task without launching a turn", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const api = [
			{
				role: "user",
				input_origin: "human",
				content: "Inspect parser",
				ts: 10,
				queued_message_ids: ["old-human-input"],
			},
			{ role: "assistant", content: "Parser is stable", ts: 11, encrypted_content: "opaque-provider-state" },
		]
		const peer = createTask({
			taskId: "peer",
			isCompleted: () => true,
			isTurnActive: () => false,
			apiConversationHistory: api,
			clineMessages: [{ ts: 11, type: "say", say: "completion_result", text: "Parser is stable" }],
		})
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, {
			...taskHistoryItem(peer.taskId, "original-parent"),
			mode: "architect",
			apiConfigName: "peer-profile",
			approvalMode: "ask",
			status: "completed",
			tokensIn: 3000,
			totalCost: 1,
		})
		internals.createTask = vi.fn()
		internals.createTaskWithHistoryItem = vi.fn()
		const result = await provider.forkIndependentTask(caller as unknown as Task, peer.taskId)
		expect(result.task_id).not.toBe(peer.taskId)
		expect(result).toMatchObject({ forked_from_id: peer.taskId, lifecycle: "closed" })
		const saved = history.get(result.task_id)
		expect(saved).toMatchObject({
			mode: "architect",
			apiConfigName: "peer-profile",
			approvalMode: "ask",
			tokensIn: 0,
			totalCost: 0,
		})
		expect(saved).not.toHaveProperty("orchestrationParentTaskId")
		const cloned = await readApiMessages({
			taskId: result.task_id,
			globalStoragePath: internals.contextProxy.globalStorageUri.fsPath,
		})
		expect(cloned).toHaveLength(2)
		expect(cloned[1]).toHaveProperty("encrypted_content", "opaque-provider-state")
		expect(cloned[0]).not.toHaveProperty("queued_message_ids")
		expect(peer.apiConversationHistory).toEqual(api)
		expect(tasks.has(result.task_id)).toBe(false)
		expect(internals.createTask).not.toHaveBeenCalled()
		expect(internals.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("archives peers and their descendants and rejects archiving an ancestor of the caller", async () => {
		const { provider, tasks, history } = createProviderFixture()
		const caller = createTask()
		for (const [id, parent] of [
			["peer", "other"],
			["descendant", "peer"],
		]) {
			tasks.set(id, createTask({ taskId: id, orchestrationParentTaskId: parent }))
			history.set(id, taskHistoryItem(id, parent))
		}
		await expect(
			provider.setIndependentTaskArchived(caller as unknown as Task, "peer", true),
		).resolves.toMatchObject({ archived: true })
		expect(history.get("descendant")).toHaveProperty("archived", true)
		expect(tasks.size).toBe(0)
		expect((await provider.listIndependentThreads(caller as unknown as Task)).threads).toEqual([])
		expect(
			(await provider.listIndependentThreads(caller as unknown as Task, { archived: true })).threads,
		).toHaveLength(2)
		await provider.setIndependentTaskArchived(caller as unknown as Task, "peer", false)
		expect(history.get("peer")).toHaveProperty("archived", false)
		history.set(caller.taskId, taskHistoryItem(caller.taskId, "peer"))
		await expect(provider.setIndependentTaskArchived(caller as unknown as Task, "peer", true)).rejects.toThrow(
			"ancestor",
		)
	})

	it("inspects unloaded legacy history without migrating or modifying source files", async () => {
		const { provider, internals, history } = createProviderFixture()
		const caller = createTask()
		history.set("legacy-peer", { ...taskHistoryItem("legacy-peer", "other"), status: "completed" })
		const storagePath = internals.contextProxy.globalStorageUri.fsPath
		await saveApiMessages({
			taskId: "legacy-peer",
			globalStoragePath: storagePath,
			messages: [
				{ role: "user", content: "Original request" },
				{ role: "assistant", content: "Original answer" },
			],
		})
		const file = path.join(storagePath, "tasks", "legacy-peer", "api_conversation_history.json")
		const legacyFile = path.join(path.dirname(file), "claude_messages.json")
		await fs.rename(file, legacyFile)
		const before = await fs.readFile(legacyFile, "utf8")
		const result = await provider.readIndependentThread(caller as unknown as Task, "legacy-peer")
		expect(JSON.stringify(result.turns)).toContain("Original answer")
		expect(result.turns[0].status).toBe("completed")
		expect(await fs.readFile(legacyFile, "utf8")).toBe(before)
		await expect(fs.access(file)).rejects.toHaveProperty("code", "ENOENT")
	})

	it("routes a title change through the existing label owner without altering the task objective", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const peer = createTask({ taskId: "peer" })
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, "other"))
		internals.renameTask = vi.fn(async (id: string, displayName: string) => {
			const renamed = { ...history.get(id), displayName }
			history.set(id, renamed)
			return renamed
		})
		await expect(
			provider.setIndependentTaskTitle(caller as unknown as Task, peer.taskId, "Parser review"),
		).resolves.toMatchObject({ title: "Parser review", objective: "Child objective" })
		expect(internals.renameTask).toHaveBeenCalledWith(peer.taskId, "Parser review")
		await expect(provider.setIndependentTaskTitle(caller as unknown as Task, peer.taskId, " ")).rejects.toThrow(
			"title",
		)
	})

	it("requires human model intent and restricts peer model overrides to idle targets", async () => {
		const { provider, tasks, history } = createProviderFixture()
		const caller = createTask({
			apiConversationHistory: [
				{ role: "user", input_origin: "human", content: "Send a follow up using target-model" },
			],
		})
		const peer = createTask({ taskId: "peer" })
		tasks.set(peer.taskId, peer)
		history.set(peer.taskId, taskHistoryItem(peer.taskId, "other"))
		await expect(
			provider.sendIndependentTaskMessage(caller as unknown as Task, peer.taskId, "Hello", {
				model: "unrequested",
			}),
		).rejects.toThrow("latest human request")
		await expect(
			provider.sendIndependentTaskMessage(caller as unknown as Task, peer.taskId, "Hello", {
				model: "target-model",
			}),
		).rejects.toThrow("idle")
		peer.isCompleted = () => true
		await provider.sendIndependentTaskMessage(caller as unknown as Task, peer.taskId, "Hello", {
			model: "target-model",
		})
		expect(history.get(peer.taskId)).toHaveProperty("threadModelOverride", "target-model")
		expect(peer.updateApiConfiguration).toHaveBeenCalledWith(
			expect.objectContaining({ apiProvider: "openai", openAiModelId: "target-model" }),
		)
	})

	it("uses polling without automatic completion input for canonical created threads", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const parent = createTask()
		const child = createTask({
			taskId: "child",
			orchestrationParentTaskId: parent.taskId,
			orchestrationNotifyCompletion: false,
			isCompleted: () => true,
			clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Done" }],
		})
		tasks.set(parent.taskId, parent)
		tasks.set(child.taskId, child)
		internals.createTask = vi.fn(async () => child)
		await provider.createIndependentTask(parent as unknown as Task, "Inspect parser", "shared", undefined, {
			notifyOnCompletion: false,
		})
		expect(internals.createTask).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			undefined,
			expect.objectContaining({ orchestrationNotifyCompletion: false }),
		)
		history.set(child.taskId, {
			...taskHistoryItem(child.taskId, parent.taskId),
			status: "completed",
			orchestrationNotifyCompletion: false,
		})
		await internals.notifyIndependentTaskCompletion(child)
		await internals.reconcileIndependentTaskCompletions(parent.taskId)
		expect(parent.receiveAgentMessage).not.toHaveBeenCalled()
		expect(history.get(child.taskId)?.orchestrationCompletionNotifications).toBeUndefined()
	})

	it("requires an archived peer to be restored before message delivery", async () => {
		const { provider, internals, history } = createProviderFixture()
		const parent = createTask()
		history.set("peer", { ...taskHistoryItem("peer", "other"), archived: true })
		internals.createTaskWithHistoryItem = vi.fn()
		await expect(
			provider.sendIndependentTaskMessage(parent as unknown as Task, "peer", "Resume work"),
		).rejects.toThrow("archived")
		expect(internals.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("preserves a worktree fork's source owner and resolves its recorded execution directory when inspected", async () => {
		const { provider, internals, tasks, history } = createProviderFixture()
		const caller = createTask()
		const source = createTask({
			taskId: "source-worktree",
			isCompleted: () => true,
			isTurnActive: () => false,
			orchestrationWorkspaceMode: "worktree",
			workspacePath: "C:/isolated/packages/parser",
			apiConversationHistory: [
				{ role: "user", content: "Inspect", ts: 10 },
				{ role: "assistant", content: "Done", ts: 11 },
			],
			clineMessages: [{ ts: 11, type: "say", say: "completion_result", text: "Done" }],
		})
		tasks.set(source.taskId, source)
		history.set(source.taskId, {
			...taskHistoryItem(source.taskId, "other"),
			status: "completed",
			orchestrationWorkspaceMode: "worktree",
			orchestrationWorkspaceRelativePath: "packages/parser",
		})
		const fork = await provider.forkIndependentTask(caller as unknown as Task, source.taskId)
		expect(history.get(fork.task_id)).toHaveProperty("orchestrationWorkspaceTaskId", source.taskId)
		const resolve = vi.spyOn(crossTaskWorktreeService, "resolve").mockResolvedValue("C:/isolated/packages/parser")
		try {
			const read = await provider.readIndependentThread(caller as unknown as Task, fork.task_id)
			expect(resolve).toHaveBeenCalledWith(
				internals.contextProxy.globalStorageUri.fsPath,
				source.taskId,
				"packages/parser",
			)
			expect(read.thread.cwd).toBe("C:/isolated/packages/parser")
			expect(read.thread.createdAt).toBe(10)
			resolve.mockRejectedValueOnce(new Error("The task worktree is missing"))
			await expect(provider.readIndependentThread(caller as unknown as Task, fork.task_id)).rejects.toThrow(
				"worktree is missing",
			)
		} finally {
			resolve.mockRestore()
		}
	})

	it("rejects a corrupt fallback provider transcript without replacing its evidence", async () => {
		const { provider, internals, history } = createProviderFixture()
		const caller = createTask()
		history.set("peer", taskHistoryItem("peer", "other"))
		const directory = path.join(internals.contextProxy.globalStorageUri.fsPath, "tasks", "peer")
		await fs.mkdir(directory, { recursive: true })
		const file = path.join(directory, "provider_transcript.json")
		const contents = JSON.stringify({
			version: 1,
			taskId: "peer",
			revision: 1,
			writtenAt: 1,
			digest: "0".repeat(64),
			messages: [{ role: "user", content: "Original request" }],
		})
		await fs.writeFile(file, contents)
		await expect(provider.readIndependentThread(caller as unknown as Task, "peer")).rejects.toThrow("digest")
		expect(await fs.readFile(file, "utf8")).toBe(contents)
	})

	it("rejects an already cancelled history read before resolving storage or performing file I/O", async () => {
		const resolve = vi.spyOn(taskStorage, "resolveExistingTaskDirectoryPathReadOnly")
		const stat = vi.spyOn(fs, "lstat")
		const read = vi.spyOn(fs, "readFile")
		const controller = new AbortController()
		const cancellation = new Error("The thread wait was cancelled")
		controller.abort(cancellation)
		try {
			await expect(
				threadTaskStorage.readThreadApiMessages("peer", "unused-storage", controller.signal),
			).rejects.toBe(cancellation)
			expect(resolve).not.toHaveBeenCalled()
			expect(stat).not.toHaveBeenCalled()
			expect(read).not.toHaveBeenCalled()
		} finally {
			resolve.mockRestore()
			stat.mockRestore()
			read.mockRestore()
		}
	})

	it("forwards a thread read's cancellation signal to the disk reader", async () => {
		const { provider, internals, history } = createProviderFixture()
		const caller = createTask()
		history.set("peer", taskHistoryItem("peer", "other"))
		const controller = new AbortController()
		const cancellation = new Error("Another peer completed first")
		const read = vi
			.spyOn(threadTaskStorage, "readThreadApiMessages")
			.mockImplementation(async (_taskId, _storagePath, signal) => {
				expect(signal).toBe(controller.signal)
				controller.abort(cancellation)
				signal?.throwIfAborted()
				return []
			})
		try {
			await expect(
				provider.readIndependentThread(caller as unknown as Task, "peer", {}, controller.signal),
			).rejects.toBe(cancellation)
			expect(read).toHaveBeenCalledWith("peer", internals.contextProxy.globalStorageUri.fsPath, controller.signal)
		} finally {
			read.mockRestore()
		}
	})

	it.each(["active", "blocked", "delegated", undefined])(
		"rejects unloaded thread controls for saved status %s before any effects",
		async (status) => {
			const { provider, internals, history } = createProviderFixture()
			const caller = createTask()
			const saved = { ...taskHistoryItem("peer", "other"), status }
			history.set("peer", saved)
			internals.createTaskWithHistoryItem = vi.fn()
			await expect(
				provider.sendIndependentTaskMessage(caller as unknown as Task, "peer", "Continue work"),
			).rejects.toThrow("owning VS Code window")
			await expect(provider.stopIndependentTask(caller as unknown as Task, "peer")).rejects.toThrow(
				"not terminal",
			)
			await expect(provider.setIndependentTaskArchived(caller as unknown as Task, "peer", true)).rejects.toThrow(
				"not terminal",
			)
			expect(internals.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(internals.removeTaskFromStack).not.toHaveBeenCalled()
			expect(internals.updateTaskHistory).not.toHaveBeenCalled()
			expect(history.get("peer")).toEqual(saved)
		},
	)

	it.each(["primary", "subagent"])(
		"preflights an unloaded nonterminal %s descendant before stopping or archiving its live parent",
		async (taskKind) => {
			const { provider, internals, tasks, history } = createProviderFixture()
			const caller = createTask()
			const peer = createTask({ taskId: "peer" })
			tasks.set(peer.taskId, peer)
			history.set(peer.taskId, taskHistoryItem(peer.taskId, "other"))
			history.set("descendant", {
				...taskHistoryItem("descendant", peer.taskId),
				taskKind,
				...(taskKind === "subagent" ? { parentTaskId: peer.taskId } : {}),
			})
			const before = structuredClone([...history])
			await expect(
				provider.setIndependentTaskArchived(caller as unknown as Task, peer.taskId, true),
			).rejects.toThrow("not terminal")
			expect(internals.removeTaskFromStack).not.toHaveBeenCalled()
			expect(internals.updateTaskHistory).not.toHaveBeenCalled()
			expect([...history]).toEqual(before)
			expect(tasks.get(peer.taskId)).toBe(peer)
		},
	)

	it.each(["completed", "failed", "interrupted", "cancelled", "timed_out"])(
		"keeps known terminal saved status %s eligible for cold stop, archive, and resume",
		async (status) => {
			const { provider, internals, tasks, history } = createProviderFixture()
			const caller = createTask()
			const saved = {
				...taskHistoryItem("peer", "other"),
				status,
				mode: "architect",
				apiConfigName: "peer-profile",
			}
			history.set("peer", saved)
			await expect(provider.stopIndependentTask(caller as unknown as Task, "peer")).resolves.toEqual({
				task_id: "peer",
				status: "already_terminal",
			})
			expect(internals.updateTaskHistory).not.toHaveBeenCalled()
			await expect(
				provider.setIndependentTaskArchived(caller as unknown as Task, "peer", true),
			).resolves.toMatchObject({ archived: true })
			await provider.setIndependentTaskArchived(caller as unknown as Task, "peer", false)
			const peer = createTask({ taskId: "peer", isTurnActive: () => false })
			internals.createTaskWithHistoryItem = vi.fn(async () => {
				tasks.set(peer.taskId, peer)
				return peer
			})
			await expect(
				provider.sendIndependentTaskMessage(caller as unknown as Task, "peer", "Continue work"),
			).resolves.toEqual({ task_id: "peer", status: "resumed" })
			expect(internals.createTaskWithHistoryItem).toHaveBeenCalledWith(
				expect.objectContaining({ status, mode: "architect", apiConfigName: "peer-profile" }),
				expect.objectContaining({ startTask: false, background: true, requireSavedConfiguration: true }),
			)
			expect(peer.receiveAgentMessage).toHaveBeenCalledOnce()
			expect(peer.resumeWithAgentMessages).toHaveBeenCalledOnce()
		},
	)
})
