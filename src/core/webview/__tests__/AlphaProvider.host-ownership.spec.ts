import EventEmitter from "node:events"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import * as vscode from "vscode"

import { type HistoryItem, AlphaCodeEventName, TaskLifecycleState } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { AgentLifecycleProjector } from "../AgentLifecycleProjection"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { SubagentNicknameRegistry } from "../../agent/SubagentNicknameRegistry"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import { TaskHistoryStore, saveTaskMessages } from "../../task-persistence"
import { AgentMessageInbox } from "../../task-persistence/AgentMessageInbox"
import { API } from "../../../extension/api"
import { openAlphaInNewTab } from "../../../activate/registerCommands"

vi.mock("../../task/Task", () => ({ Task: vi.fn() }))
vi.mock("../../../activate/registerCommands", () => ({ openAlphaInNewTab: vi.fn() }))

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const instances = (AlphaProvider as unknown as { activeInstances: Set<AlphaProvider> }).activeInstances
const created: AlphaProvider[] = []

function makeTask(taskId: string) {
	return Object.assign(new EventEmitter(), {
		taskId,
		instanceId: crypto.randomUUID(),
		taskKind: "primary" as const,
		metadata: { task: taskId },
		alphaMessages: [],
		apiConfiguration: { apiProvider: "openai" },
		taskMode: "code",
		getTaskMode: vi.fn(async () => "code"),
		abortTask: vi.fn(async () => undefined),
		messageQueueService: new MessageQueueService(),
	}) as unknown as Task
}

function makeProvider(storagePath: string) {
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		renderContext: "sidebar",
		taskSessions: TaskSessionRegistry.forGlobalStorage(storagePath, 3),
		taskStack: [],
		taskNavigationGeneration: 0,
		currentView: { type: "newTaskDraft" },
		newTaskDraftMode: "code",
		context: { globalState: { get: () => true } },
		contextProxy: {
			globalStorageUri: { fsPath: storagePath },
			getValues: () => ({ currentApiConfigName: "default" }),
			getValue: (key: string) =>
				key === "currentApiConfigName" ? "default" : key === "mode" ? "code" : undefined,
		},
		providerSettingsManager: {
			listConfig: vi.fn(async () => [{ id: "default-profile", name: "default", apiProvider: "openai" }]),
			getProfile: vi.fn(async () => ({ id: "default-profile", name: "default", apiProvider: "openai" })),
			getAvailableProfile: vi.fn(async () => ({ apiProvider: "openai" })),
		},
		taskCreationQueue: Promise.resolve(),
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: {
			initialize: vi.fn(async () => undefined),
			get: () => undefined,
			getAll: () => [],
			dispose: vi.fn(),
		},
		agentControlStore: store,
		agentControlStoreReady: store.initialize(),
		agentLifecycleProjector: new AgentLifecycleProjector(),
		agentLifecycleDegradedSignals: new Map(),
		agentLifecycleMessageQueue: Promise.resolve(),
		agentLifecycleJournals: new Map(),
		preparedSubagentGroups: new Map(),
		subagentNicknameRegistry: new SubagentNicknameRegistry(),
		subagentDescriptors: new Map(),
		subagentGroupControllers: new Map(),
		subagentRunFinalizations: new Map(),
		subagentResidencyEvictions: new Map(),
		reservedSubagentSlots: new Map(),
		publishedSubagentResults: new Set(),
		legacyHandoffInputBuffers: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		taskEventListeners: new WeakMap(),
		taskCreationCallback: vi.fn(),
		independentTaskWaiters: new Map(),
		alphaMessagesSeq: 0,
		taskStateSeq: 0,
		messageQueueSeq: 0,
		currentTaskTodosSeq: 0,
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		disposables: [],
		postMessageToWebview: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutAlphaMessages: vi.fn(async () => undefined),
		scheduleVisibleTranscript: vi.fn(),
		updateGlobalState: vi.fn(async () => undefined),
		getProviderSettingsSnapshot: () => ({ apiProvider: "openai" }),
		flushGlobalStateWriteThrough: vi.fn(async () => undefined),
		closeAgentLifecycleJournals: vi.fn(async () => undefined),
		removeAllListeners: vi.fn(),
		log: vi.fn(),
		htmlDocumentAutoOpen: { handle: vi.fn(async () => undefined) },
	}) as AlphaProvider
	instances.add(provider)
	created.push(provider)
	return provider
}

const history: HistoryItem = {
	id: "retained",
	number: 1,
	ts: 1,
	task: "retained task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}
const sessions = (provider: AlphaProvider) =>
	(provider as unknown as { taskSessions: TaskSessionRegistry }).taskSessions
const storage = () => path.join(os.tmpdir(), `alpha-host-ownership-${crypto.randomUUID()}`)

describe("agent hotkey view ownership", () => {
	beforeEach(() => vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined))

	it("keeps independently launched tasks alive when the originating editor is disposed", async () => {
		const host = storage()
		const sidebar = makeProvider(host)
		const editor = makeProvider(host)
		const savedHistory = new Map<string, HistoryItem>()
		for (const owner of [sidebar, editor])
			Object.assign(owner.taskHistoryStore, {
				get: (taskId: string) => savedHistory.get(taskId),
				getAll: () => [...savedHistory.values()],
				upsert: vi.fn(async (item: HistoryItem) => {
					savedHistory.set(item.id, item)
					return [...savedHistory.values()]
				}),
			})
		Object.assign(editor, { renderContext: "editor" })
		const parent = Object.assign(makeTask("launcher"), {
			metadata: { task: "Launch a new chat thread" },
			workspacePath: "C:/repo",
			historyWorkspacePath: "C:/repo",
			apiConversationHistory: [],
			getTaskApiConfigName: vi.fn(async () => "default"),
			getTaskApprovalMode: vi.fn(() => "ask"),
			reasoningPreference: { kind: "default" },
			isCompleted: vi.fn(() => false),
			isTurnActive: vi.fn(() => true),
		})
		await editor.addTaskToStack(parent)
		const child = Object.assign(makeTask("independent"), {
			start: vi.fn(),
			workspacePath: parent.workspacePath,
			historyWorkspacePath: parent.historyWorkspacePath,
			getTaskApiConfigName: vi.fn(async () => "default"),
			getTaskApprovalMode: vi.fn(() => "ask"),
			reasoningPreference: { kind: "default" },
			isCompleted: vi.fn(() => false),
			isTurnActive: vi.fn(() => true),
		})
		for (const owner of [sidebar, editor]) {
			vi.spyOn(owner, "createTask").mockImplementation(async (_text, _images, _parent, options) => {
				Object.assign(child, { orchestrationParentTaskId: options?.orchestrationParentTaskId })
				await owner.addTaskToStack(child, { focus: false })
				return child
			})
		}

		await editor.createIndependentTask(parent, "Continue independently", "shared")

		expect(sidebar.createTask).toHaveBeenCalledOnce()
		expect(editor.createTask).not.toHaveBeenCalled()
		expect(sidebar.getTaskOwner(child.taskId)).toBe(sidebar)
		await editor.dispose()
		expect(child.abortTask).not.toHaveBeenCalled()
		expect(sidebar.getLiveTask(child.taskId)).toBe(child)
	})

	it("routes keyboard commands to the focused sidebar despite an active editor panel", async () => {
		const sidebar = makeProvider(storage())
		const editor = makeProvider(storage())
		Object.assign(sidebar, { view: { visible: true } })
		Object.assign(editor, { view: { visible: true, active: true }, renderContext: "editor" })
		await sidebar.setWebviewFocused(true)
		expect(AlphaProvider.getVisibleInstance()).toBe(sidebar)
		expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("setContext", "alpha.focusedWebview", "sidebar")
		await editor.setWebviewFocused(true)
		await sidebar.setWebviewFocused(false)
		expect(AlphaProvider.getVisibleInstance()).toBe(editor)
		expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("setContext", "alpha.focusedWebview", "editor")
	})

	it("clears disposed focus and ignores focus notifications from hidden or disposed views", async () => {
		const sidebar = makeProvider(storage())
		Object.assign(sidebar, { view: { visible: false } })
		vi.mocked(vscode.commands.executeCommand).mockClear()
		await sidebar.setWebviewFocused(true)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		Object.assign(sidebar, { view: { visible: true } })
		await sidebar.setWebviewFocused(true)
		Object.assign(sidebar, { _disposed: true })
		;(sidebar as unknown as { clearWebviewResources(): void }).clearWebviewResources()
		expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("setContext", "alpha.focusedWebview", undefined)
		vi.mocked(vscode.commands.executeCommand).mockClear()
		await sidebar.setWebviewFocused(true)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(AlphaProvider.getVisibleInstance()).toBeUndefined()
	})

	it("prefers the active editor panel over a more recently created visible view", () => {
		const active = makeProvider(storage())
		const inactive = makeProvider(storage())
		Object.assign(active, { view: { visible: true, active: true } })
		Object.assign(inactive, { view: { visible: true, active: false } })
		expect(AlphaProvider.getVisibleInstance()).toBe(active)
		Object.assign(active, { view: { visible: false, active: true } })
		expect(AlphaProvider.getVisibleInstance()).toBe(inactive)
	})

	it("opens the next newer history task without cancelling either view's work", async () => {
		const directory = storage()
		const sidebar = makeProvider(directory)
		const panel = makeProvider(directory)
		const first = makeTask("first")
		const second = makeTask("second")
		await sidebar.addTaskToStack(first)
		await panel.addTaskToStack(second)
		Object.assign(sidebar, {
			taskHistoryStore: {
				getByWorkspace: () => [
					{ ...history, id: "second", ts: 2 },
					{ ...history, id: "first", ts: 1 },
				],
			},
		})
		await sidebar.navigateTask(1)
		expect(sidebar.getActiveTaskId()).toBe("second")
		expect(panel.getActiveTaskId()).toBe("second")
		expect(first.abortTask).not.toHaveBeenCalled()
		expect(second.abortTask).not.toHaveBeenCalled()
		expect(sidebar.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	it("walks older saved chats in order and stops at both ends instead of cycling loaded tasks", async () => {
		const provider = makeProvider(storage())
		let current = "newest"
		const rows = [
			{ ...history, id: "newest", ts: 3 },
			{ ...history, id: "middle", ts: 2 },
			{ ...history, id: "oldest", ts: 1 },
		]
		Object.assign(provider, { taskHistoryStore: { getByWorkspace: () => rows } })
		vi.spyOn(provider, "getActiveTaskId").mockImplementation(() => current)
		const open = vi.spyOn(provider, "showTaskWithId").mockImplementation(async (id) => {
			current = id
		})
		await provider.navigateTask(-1)
		await provider.navigateTask(-1)
		await provider.navigateTask(-1)
		expect(open.mock.calls.map(([id]) => id)).toEqual(["middle", "oldest"])
		await provider.navigateTask(1)
		await provider.navigateTask(1)
		await provider.navigateTask(1)
		expect(open.mock.calls.map(([id]) => id)).toEqual(["middle", "oldest", "middle", "newest"])
	})

	it("advances repeated Previous keys while an earlier live chat publication is held", async () => {
		const provider = makeProvider(storage())
		const tasks = [makeTask("newest"), makeTask("middle"), makeTask("oldest")]
		for (const task of tasks) await provider.addTaskToStack(task)
		await provider.focusTask("newest")
		Object.assign(provider, {
			taskHistoryStore: {
				getByWorkspace: () => tasks.map((task, index) => ({ ...history, id: task.taskId, ts: 3 - index })),
			},
		})
		const entered = barrier()
		const release = barrier()
		vi.mocked(provider.postTaskStateToWebview).mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const first = provider.navigateTask(-1)
		await entered.promise
		try {
			await provider.navigateTask(-1)
			expect(provider.getActiveTaskId()).toBe("oldest")
		} finally {
			release.resolve()
			await first
		}
		expect(provider.getActiveTaskId()).toBe("oldest")
		await provider.navigateTask(-1)
		expect(provider.getActiveTaskId()).toBe("oldest")
		for (const task of tasks) expect(task.abortTask).not.toHaveBeenCalled()
	})

	it("retries the same history neighbor after a failed cold restore", async () => {
		const provider = makeProvider(storage())
		const rows = ["newest", "middle", "oldest"].map((id, index) => ({ ...history, id, ts: 3 - index }))
		Object.assign(provider, { taskHistoryStore: { getByWorkspace: () => rows } })
		vi.spyOn(provider, "getActiveTaskId").mockReturnValue("newest")
		const open = vi.spyOn(provider, "showTaskWithId").mockRejectedValue(new Error("Restore failed"))
		await expect(provider.navigateTask(-1)).rejects.toThrow("Restore failed")
		await expect(provider.navigateTask(-1)).rejects.toThrow("Restore failed")
		expect(open.mock.calls.map(([id]) => id)).toEqual(["middle", "middle"])
	})

	it("keeps input-seeking navigation independent of saved-history initialization", async () => {
		const provider = makeProvider(storage())
		const ready = barrier()
		Object.assign(provider, { taskHistoryStoreReady: ready.promise })
		vi.spyOn(sessions(provider), "getAdjacentTaskId").mockReturnValue("question")
		vi.spyOn(provider, "getActiveTaskId").mockReturnValue("question")
		const open = vi.spyOn(provider, "showTaskWithId").mockResolvedValue(undefined)
		try {
			await provider.navigateTask(1, true)
			expect(open).toHaveBeenCalledExactlyOnceWith("question")
		} finally {
			ready.resolve()
		}
	})

	it.each(["selection", "workspace", "disposal"])(
		"does not apply a history hotkey after %s changes while initialization is pending",
		async (change) => {
			const provider = makeProvider(storage())
			await provider.addTaskToStack(makeTask("newest"))
			const ready = barrier()
			Object.assign(provider, {
				taskHistoryStoreReady: ready.promise,
				taskHistoryStore: { getByWorkspace: () => [{ ...history, id: "older" }] },
			})
			const open = vi.spyOn(provider, "showTaskWithId")
			const navigation = provider.navigateTask(-1)
			if (change === "selection") await provider.focusTask("newest")
			else if (change === "workspace") Object.assign(provider, { currentWorkspacePath: "/other-workspace" })
			else Object.assign(provider, { _disposed: true })
			ready.resolve()
			await navigation
			expect(open).not.toHaveBeenCalled()
		},
	)

	it("restores a saved history neighbor through the existing cold-open path", async () => {
		const provider = makeProvider(storage())
		const newest = makeTask("newest")
		await provider.addTaskToStack(newest)
		const older = { ...history, id: "older", ts: 1 }
		Object.assign(provider, {
			taskHistoryStore: { getByWorkspace: () => [{ ...history, id: "newest", ts: 2 }, older] },
		})
		const load = vi.spyOn(provider, "getTaskWithId").mockResolvedValue({
			historyItem: older,
			taskDirPath: "/saved/older",
			apiConversationHistoryFilePath: "/saved/older/api_conversation_history.json",
			uiMessagesFilePath: "/saved/older/ui_messages.json",
			apiConversationHistory: [],
		})
		const restore = vi.spyOn(provider, "createTaskWithHistoryItem").mockImplementation(async (item, options) => {
			const task = makeTask(item.id)
			sessions(provider).register(task)
			await provider.focusTask(task.taskId, options?.navigationGeneration)
			return task
		})
		await provider.navigateTask(-1)
		expect(load).toHaveBeenCalledWith("older", { includeApiConversationHistory: false })
		expect(restore).toHaveBeenCalledWith(older, expect.objectContaining({ preserveExisting: true }))
		expect(provider.getActiveTaskId()).toBe("older")
		expect(newest.abortTask).not.toHaveBeenCalled()
	})
})

afterEach(async () => {
	for (const provider of created.splice(0)) {
		await provider.setWebviewFocused(false)
		instances.delete(provider)
		sessions(provider).disposeView()
	}
	vi.restoreAllMocks()
})

describe("AlphaProvider host ownership", () => {
	it("routes a cross-view independent wait to the child owner before reserving completion", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-host-wait-"))
		const store = new TaskHistoryStore(directory)
		try {
			await store.initialize()
			const sidebar = makeProvider(directory)
			const panel = makeProvider(directory)
			for (const provider of [sidebar, panel]) {
				Object.assign(provider, {
					taskHistoryStore: store,
					updateTaskHistory: vi.fn((item) => store.upsert(item)),
				})
			}
			const parent = Object.assign(makeTask("parent"), { apiConversationHistory: [], isCompleted: () => false })
			let completed = false
			const child = Object.assign(makeTask("child"), {
				orchestrationParentTaskId: parent.taskId,
				isCompleted: () => completed,
				alphaMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
			})
			await sidebar.addTaskToStack(parent)
			await panel.addTaskToStack(child)
			await store.upsert({
				...history,
				id: child.taskId,
				orchestrationParentTaskId: parent.taskId,
				taskKind: "primary",
				status: "active",
			})
			const subscribed = barrier()
			const once = child.once.bind(child)
			vi.spyOn(child, "once").mockImplementation((event, listener) => {
				const result = once(event, listener)
				if (event === AlphaCodeEventName.TaskCompleted) subscribed.resolve()
				return result
			})
			const waiting = sidebar.waitForIndependentTask(parent, child.taskId, 5000)
			await subscribed.promise
			completed = true
			;(child as unknown as EventEmitter).emit(AlphaCodeEventName.TaskCompleted, child.taskId)
			await (panel as any).notifyIndependentTaskCompletion(child)
			const result = await waiting
			expect(result).toMatchObject({ lifecycle: "completed", completion_receipt_id: expect.any(String) })
			expect(store.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
				expect.objectContaining({ id: result.completion_receipt_id, deliveredVia: "wait" }),
			])
			const inboxDelivery = vi.fn(async () => undefined)
			await new AgentMessageInbox(parent.taskId, directory).deliver(inboxDelivery)
			expect(inboxDelivery).not.toHaveBeenCalled()
		} finally {
			store.dispose()
			await store.flushIndex()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("serializes concurrent unloaded completion delivery across separate provider history caches", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-host-outbox-"))
		const firstStore = new TaskHistoryStore(directory)
		const secondStore = new TaskHistoryStore(directory)
		try {
			await firstStore.initialize()
			const child = Object.assign(makeTask("child"), {
				orchestrationParentTaskId: "parent",
				alphaMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
			})
			await firstStore.upsert({
				...history,
				id: child.taskId,
				orchestrationParentTaskId: "parent",
				taskKind: "primary",
				status: "completed",
			})
			await firstStore.flushIndex()
			await secondStore.initialize()
			await saveTaskMessages({
				taskId: child.taskId,
				globalStoragePath: directory,
				messages: child.alphaMessages as any,
			})
			const first = makeProvider(directory)
			const second = makeProvider(directory)
			const entered = barrier()
			const release = barrier()
			Object.assign(first, {
				taskHistoryStore: firstStore,
				updateTaskHistory: vi.fn(async (item) => {
					if (item.orchestrationCompletionNotifications?.[0]?.deliveredAt === undefined) {
						entered.resolve()
						await release.promise
					}
					return firstStore.upsert(item)
				}),
			})
			Object.assign(second, {
				taskHistoryStore: secondStore,
				updateTaskHistory: vi.fn((item) => secondStore.upsert(item)),
			})
			const delivery = (first as any).notifyIndependentTaskCompletion(child)
			await entered.promise
			const replay = (second as any).reconcileIndependentTaskCompletions()
			release.resolve()
			await Promise.all([delivery, replay])
			const inboxDelivery = vi.fn(async () => undefined)
			await new AgentMessageInbox("parent", directory).deliver(inboxDelivery)
			expect(inboxDelivery).toHaveBeenCalledOnce()
			expect((second as any).updateTaskHistory).not.toHaveBeenCalled()
			expect(secondStore.get(child.taskId)?.orchestrationCompletionNotifications).toEqual([
				expect.objectContaining({ deliveredVia: "inbox", deliveredAt: expect.any(Number) }),
			])
		} finally {
			firstStore.dispose()
			secondStore.dispose()
			await Promise.all([firstStore.flushIndex(), secondStore.flushIndex()])
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("shares runtime identity and keeps view focus independent", async () => {
		const host = storage()
		const sidebar = makeProvider(host)
		const panel = makeProvider(host)
		const first = makeTask("first")
		const second = makeTask("second")
		await sidebar.addTaskToStack(first)
		await panel.addTaskToStack(second)
		expect(panel.getLiveTask("first")).toBe(first)
		expect(panel.getTaskOwner("first")).toBe(sidebar)
		await panel.focusTask("first")
		await sidebar.focusTask("second")
		expect(panel.getActiveTaskId()).toBe("first")
		expect(sidebar.getActiveTaskId()).toBe("second")
		expect(sidebar.isTaskOnScreen("first")).toBe(true)
	})

	it("compacts a borrowed task and acknowledges the requesting view without changing ownership", async () => {
		const host = storage()
		const owner = makeProvider(host)
		const borrower = makeProvider(host)
		const task = Object.assign(makeTask("shared-compaction"), {
			condenseContext: vi.fn(async () => undefined),
		})
		await owner.addTaskToStack(task)
		await borrower.focusTask(task.taskId)

		await expect(borrower.condenseTaskContext(task.taskId)).resolves.toBeUndefined()

		expect(task.condenseContext).toHaveBeenCalledOnce()
		expect(borrower.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
		expect(owner.postMessageToWebview).not.toHaveBeenCalled()
		expect(borrower.getLiveTask(task.taskId)).toBe(task)
		expect(borrower.getTaskOwner(task.taskId)).toBe(owner)
	})

	it("rejects compaction from another host while acknowledging the failed request", async () => {
		const owner = makeProvider(storage())
		const requester = makeProvider(storage())
		const task = Object.assign(makeTask("foreign-compaction"), {
			condenseContext: vi.fn(async () => undefined),
		})
		await owner.addTaskToStack(task)

		await expect(requester.condenseTaskContext(task.taskId)).rejects.toThrow(
			`Task with id ${task.taskId} not found`,
		)

		expect(task.condenseContext).not.toHaveBeenCalled()
		expect(requester.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
		expect(owner.postMessageToWebview).not.toHaveBeenCalled()
		expect(owner.getLiveTask(task.taskId)).toBe(task)
		expect(owner.getTaskOwner(task.taskId)).toBe(owner)
	})

	it("disposing a borrowed view does not terminate its selected task", async () => {
		const host = storage()
		const owner = makeProvider(host)
		const borrower = makeProvider(host)
		const task = makeTask("running")
		await owner.addTaskToStack(task)
		await borrower.focusTask(task.taskId)
		await borrower.dispose()
		expect(task.abortTask).not.toHaveBeenCalled()
		expect(owner.getLiveTask(task.taskId)).toBe(task)
		expect(owner.getTaskOwner(task.taskId)).toBe(owner)
	})

	it("retains an ordinary task after failed disposal and coalesces a cleanup retry", async () => {
		const owner = makeProvider(storage())
		const task = makeTask("cleanup")
		await owner.addTaskToStack(task)
		vi.mocked(task.abortTask).mockRejectedValueOnce(new Error("termination failed"))
		await expect(owner.dispose()).rejects.toThrow("termination failed")
		expect(owner.getLiveTask(task.taskId)).toBe(task)
		expect(owner.getTaskOwner(task.taskId)).toBe(owner)
		await Promise.all([owner.dispose(), owner.dispose()])
		expect(task.abortTask).toHaveBeenCalledTimes(2)
		expect(owner.getLiveTask(task.taskId)).toBeUndefined()
	})

	it("joins one host startup recovery and guards a retained terminal owner", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		const task = makeTask("worker")
		await first.addTaskToStack(task)
		sessions(first).markLifecycle(task.taskId, TaskLifecycleState.Completed)
		const recovery = vi.fn(async (hasOwner: (id: string) => boolean) => {
			expect(hasOwner(task.taskId)).toBe(true)
		})
		for (const provider of [first, second])
			Object.assign(provider, {
				recoverManagedWorkerArtifacts: recovery,
				reconcileInterruptedSubagentState: vi.fn(async () => undefined),
				reconcileIndependentTaskCompletions: vi.fn(async () => undefined),
			})
		await Promise.all([first, second].map((provider) => (provider as any).initializeTaskHistoryStore()))
		expect(recovery).toHaveBeenCalledOnce()
	})

	it("hydrates one runtime when two views open the same missing history concurrently", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		const entered = barrier()
		const release = barrier()
		const task = makeTask(history.id)
		const hydrate = vi.fn(async () => {
			entered.resolve()
			await release.promise
			await first.addTaskToStack(task)
			return task
		})
		Object.assign(first, { createTaskWithHistoryItemUnderOwnership: hydrate })
		const otherHydrate = vi.fn()
		Object.assign(second, { createTaskWithHistoryItemUnderOwnership: otherHydrate })
		const firstOpen = first.createTaskWithHistoryItem(history)
		await entered.promise
		const secondOpen = second.createTaskWithHistoryItem(history)
		release.resolve()
		expect(await firstOpen).toBe(task)
		expect(await secondOpen).toBe(task)
		expect(hydrate).toHaveBeenCalledOnce()
		expect(otherHydrate).not.toHaveBeenCalled()
		expect(task.abortTask).not.toHaveBeenCalled()
	})

	it("registers a restored task before its constructor can start a history loop", async () => {
		const provider = makeProvider(storage())
		const task = makeTask(history.id)
		vi.mocked(Task).mockImplementationOnce(function (options) {
			options.onCreated?.(task)
			expect(provider.getLiveTask(history.id)).toBe(task)
			expect(provider.getTaskOwner(history.id)).toBe(provider)
			return task
		})
		expect(await provider.createTaskWithHistoryItem(history, { preserveExisting: true })).toBe(task)
	})

	it.each(["allowedMaxCost", "allowedMaxRequests"] as const)(
		"suppresses optional presentation calls before restoring a task with finite positive %s",
		async (budget) => {
			const provider = makeProvider(storage())
			vi.spyOn(provider.contextProxy, "getValues").mockReturnValue({
				currentApiConfigName: "default",
				[budget]: 1,
			})
			const task = makeTask(history.id)
			vi.mocked(Task).mockImplementationOnce(function (options) {
				expect(options.presentationModelCalls).toBe(false)
				options.onCreated?.(task)
				return task
			})

			await provider.createTaskWithHistoryItem(history, { preserveExisting: true, startTask: false })
		},
	)

	it("keeps a live task's presentation opt-out when its older history snapshot is restored", async () => {
		const provider = makeProvider(storage())
		const oldTask = makeTask(history.id)
		Object.assign(oldTask, { presentationModelCalls: false })
		await provider.addTaskToStack(oldTask)
		const restored = makeTask(history.id)
		vi.mocked(Task).mockImplementationOnce(function (options) {
			expect(options.presentationModelCalls).toBe(false)
			options.onCreated?.(restored)
			return restored
		})

		await provider.createTaskWithHistoryItem(history, { preserveExisting: true, startTask: false })
	})

	it("routes explicit cancellation to the canonical owner without borrowing its focus", async () => {
		const host = storage()
		const owner = makeProvider(host)
		const borrower = makeProvider(host)
		const task = makeTask("target")
		const other = makeTask("other")
		await owner.addTaskToStack(task)
		await owner.addTaskToStack(other)
		await borrower.focusTask(task.taskId)
		const cancel = vi.spyOn(owner, "cancelTask").mockResolvedValue(undefined)
		await borrower.cancelTask(task.taskId, "webview_stop")
		expect(cancel).toHaveBeenCalledWith(task.taskId, "webview_stop", undefined)
		expect(owner.getActiveTaskId()).toBe(other.taskId)
		expect(borrower.getActiveTaskId()).toBe(task.taskId)
	})

	it("projects task updates to both views and queues only to matching selections", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		await first.addTaskToStack(makeTask("first"))
		await second.addTaskToStack(makeTask("second"))
		const message = { ts: 1, type: "say" as const, say: "text" as const, text: "progress" }
		await first.postTaskMessageToWebview("messageCreated", "first", message)
		expect(second.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "first", type: "messageCreated" }),
		)
		vi.mocked(first.postMessageToWebview).mockClear()
		vi.mocked(second.postMessageToWebview).mockClear()
		await first.postTaskQueueToWebview("first", [])
		expect(first.postMessageToWebview).toHaveBeenCalledOnce()
		expect(second.postMessageToWebview).not.toHaveBeenCalled()
		await first.postTaskSessionStateToWebview()
		expect(second.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ state: expect.objectContaining({ activeTaskId: "second" }) }),
		)
	})

	it.each(["messages", "todos"] as const)(
		"reserves %s broadcast sequences across views before a transport yields",
		async (surface) => {
			const host = storage()
			const first = makeProvider(host)
			const second = makeProvider(host)
			const task = makeTask("shared")
			await first.addTaskToStack(task)
			await second.focusTask(task.taskId)
			for (const provider of [first, second]) vi.mocked(provider.postMessageToWebview).mockClear()
			const entered = barrier()
			const release = barrier()
			vi.mocked(first.postMessageToWebview).mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
			})
			const broadcast = (text: string) =>
				surface === "messages"
					? first.postTaskMessageToWebview("messageUpdated", task.taskId, {
							ts: 1,
							type: "say",
							say: "text",
							text,
						})
					: first.postTaskTodosToWebview(task.taskId, [{ id: "todo", content: text, status: "pending" }])
			const older = broadcast("older")
			await entered.promise
			await broadcast("newer")
			release.resolve()
			await older
			const publications = vi.mocked(second.postMessageToWebview).mock.calls.map(([message]) => {
				if (message.type === "messageUpdated") {
					return { text: message.alphaMessage?.text, sequence: message.alphaMessagesSeq ?? 0 }
				}
				return {
					text: message.state?.currentTaskTodos?.[0].content,
					sequence: message.state?.currentTaskTodosSeq ?? 0,
				}
			})
			expect(publications).toHaveLength(2)
			expect(publications.sort((a, b) => a.sequence - b.sequence).map(({ text }) => text)).toEqual([
				"older",
				"newer",
			])
		},
	)

	it("shares prepared-task capacity across providers before preparation yields", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		await first.addTaskToStack(makeTask("first-root"))
		await second.addTaskToStack(makeTask("second-root"))
		await Promise.all([(first as any).agentControlStoreReady, (second as any).agentControlStoreReady])
		;(first as any).reserveSubagentSlots("first-group", "first-root", 1, 3, 2)
		expect(() => (second as any).reserveSubagentSlots("second-group", "second-root", 1, 3, 2)).toThrow(
			"Not enough task capacity",
		)
		;(first as any).releaseSubagentGroup("first-group")
		expect(() => (second as any).reserveSubagentSlots("second-group", "second-root", 1, 3, 2)).not.toThrow()
	})

	it("publishes consumed input with its queue receipt only to views selecting the task", async () => {
		const host = storage()
		const owner = makeProvider(host)
		const borrowed = makeProvider(host)
		const unrelated = makeProvider(host)
		const task = makeTask("input-task")
		task.alphaMessages.push({ ts: 1, type: "say", say: "user_feedback", text: "accepted input" })
		await owner.addTaskToStack(task)
		await borrowed.focusTask(task.taskId)
		await unrelated.addTaskToStack(makeTask("different-task"))
		for (const provider of [owner, borrowed, unrelated]) vi.mocked(provider.postMessageToWebview).mockClear()
		await owner.postTaskQueueToWebview(task.taskId, [], { includeTranscript: true })
		for (const provider of [owner, borrowed]) {
			expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "state",
				state: {
					currentTaskId: task.taskId,
					messageQueue: [],
					messageQueueSeq: expect.any(Number),
					alphaMessages: task.alphaMessages,
					alphaMessagesSeq: expect.any(Number),
					taskStateSeq: expect.any(Number),
				},
			})
		}
		expect(unrelated.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("acknowledges durable admission only after persistence and deduplicates a retry", async () => {
		const provider = makeProvider(storage())
		const task = makeTask("queue")
		const saveEntered = barrier()
		const saved = barrier()
		Object.assign(task, {
			messageQueueService: new MessageQueueService({
				load: async () => [],
				save: async () => {
					saveEntered.resolve()
					await saved.promise
				},
			}),
		})
		await provider.addTaskToStack(task)
		let acknowledged = false
		const admission = provider
			.queueMessageForTaskDurably(task.taskId, "guidance", undefined, "request-id")
			.then((accepted) => {
				acknowledged = accepted
			})
		await saveEntered.promise
		expect(acknowledged).toBe(false)
		saved.resolve()
		await admission
		expect(acknowledged).toBe(true)
		expect(await provider.queueMessageForTaskDurably(task.taskId, "guidance", undefined, "request-id")).toBe(true)
		expect(task.messageQueueService.messages).toHaveLength(1)
	})

	it("persists the child ID on its initiating legacy ask and moves only views selecting that parent", async () => {
		const host = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-legacy-link-"))
		try {
			const owner = makeProvider(host)
			const borrower = makeProvider(host)
			const parent = Object.assign(makeTask("parent"), {
				flushPendingToolResultsToHistory: vi.fn(async () => true),
				getTaskApiConfigName: vi.fn(async () => "default"),
				alphaMessages: [
					{
						ts: 1,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "newTask" }),
						childTaskId: "older-child",
					},
					{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newTask" }) },
				],
			}) as unknown as Task
			const other = makeTask("other")
			const child = Object.assign(makeTask("new-child"), { start: vi.fn() })
			await owner.addTaskToStack(parent)
			await owner.addTaskToStack(other)
			await borrower.focusTask(parent.taskId)
			vi.spyOn(owner, "getModeProviderProfile" as any).mockResolvedValue(undefined)
			vi.spyOn(owner, "getProviderProfile" as any).mockResolvedValue("default")
			vi.spyOn(owner, "getTaskWithId").mockResolvedValue({
				historyItem: { ...history, id: parent.taskId },
			} as any)
			vi.spyOn(owner, "updateTaskHistory").mockResolvedValue([])
			vi.spyOn(owner, "createTask").mockImplementation(async (_text, _images, _parent, options) => {
				await owner.addTaskToStack(child, { focus: !options?.background })
				return child
			})
			await borrower.delegateParentAndOpenChild({
				parentTaskId: parent.taskId,
				message: "child objective",
				initialTodos: [],
				mode: "code",
			})
			const messages = await readTaskMessages({ globalStoragePath: host, taskId: parent.taskId })
			expect(messages[0].childTaskId).toBe("older-child")
			expect(messages[1].childTaskId).toBe(child.taskId)
			expect(child.start).toHaveBeenCalledOnce()
			expect(owner.getActiveTaskId()).toBe(other.taskId)
			expect(borrower.getActiveTaskId()).toBe(child.taskId)
		} finally {
			await fs.rm(host, { recursive: true, force: true })
		}
	})
})

describe("AlphaProvider final history disposal", () => {
	it("starts cleanup for sidebar and editor providers and joins both before global shutdown", async () => {
		const sidebar = makeProvider(storage())
		const editor = makeProvider(storage())
		Object.assign(editor, { renderContext: "editor" })
		const held = barrier()
		const disposeSidebar = vi.spyOn(sidebar, "dispose").mockImplementationOnce(() => held.promise)
		const disposeEditor = vi.spyOn(editor, "dispose").mockResolvedValue(undefined)
		let settled = false
		const closing = AlphaProvider.disposeAll().then(() => {
			settled = true
		})
		try {
			expect(disposeSidebar).toHaveBeenCalledOnce()
			expect(disposeEditor).toHaveBeenCalledOnce()
			await Promise.resolve()
			expect(settled).toBe(false)
		} finally {
			held.resolve()
			await closing
		}
	})

	it("joins other provider cleanup before reporting an aggregated failure", async () => {
		const sidebar = makeProvider(storage())
		const editor = makeProvider(storage())
		const failure = new Error("Sidebar cleanup failed")
		const held = barrier()
		vi.spyOn(sidebar, "dispose").mockRejectedValue(failure)
		const disposeEditor = vi.spyOn(editor, "dispose").mockImplementationOnce(() => held.promise)
		let settled = false
		const closing = AlphaProvider.disposeAll()
		const outcome = closing.then(
			() => {
				settled = true
			},
			(error: unknown) => {
				settled = true
				return error
			},
		)
		try {
			expect(disposeEditor).toHaveBeenCalledOnce()
			await Promise.resolve()
			expect(settled).toBe(false)
		} finally {
			held.resolve()
		}
		const error = await outcome
		expect(error).toBeInstanceOf(AggregateError)
		expect((error as AggregateError).errors).toEqual([failure])
	})

	it("keeps provider disposal pending until the final history write settles", async () => {
		const owner = makeProvider(storage())
		const entered = barrier()
		const release = barrier()
		const history = Reflect.get(owner, "taskHistoryStore") as TaskHistoryStore
		vi.spyOn(history, "dispose").mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		let closed = false
		const closing = owner.dispose().then(() => {
			closed = true
		})
		await entered.promise
		let closedBeforeRelease = false
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			closedBeforeRelease = closed
		} finally {
			release.resolve()
			await closing
		}
		expect(closedBeforeRelease).toBe(false)
	})

	it("retains final history disposal failure for a caller and retries cleanup explicitly", async () => {
		const owner = makeProvider(storage())
		const failure = new Error("controlled final history disposal failure")
		const rejected = Promise.reject(failure)
		void rejected.catch(() => undefined)
		const history = Reflect.get(owner, "taskHistoryStore") as TaskHistoryStore
		const dispose = vi
			.spyOn(history, "dispose")
			.mockImplementationOnce(() => rejected)
			.mockResolvedValue(undefined)
		const [result] = await Promise.allSettled([owner.dispose()])
		expect(result).toEqual({ status: "rejected", reason: failure })
		await owner.dispose()
		expect(dispose).toHaveBeenCalledTimes(2)
	})
})

describe("AlphaProvider task admission", () => {
	beforeEach(() => vi.mocked(Task).mockReset())

	function prepareTask(taskId: string) {
		const task = Object.assign(makeTask(taskId), {
			start: vi.fn(),
			persistFrozenSubagentInstructions: vi.fn(async () => undefined),
		})
		vi.mocked(Task).mockImplementationOnce(function () {
			return task
		})
		return task
	}

	it("joins direct task admission before disposing resources and rejects after configuration resumes", async () => {
		const owner = makeProvider(storage())
		const entered = barrier()
		const configuration = barrier()
		Object.defineProperty(owner, "configurationQueue", {
			value: {
				then(resolve: () => void) {
					entered.resolve()
					return configuration.promise.then(resolve)
				},
			},
		})
		const task = prepareTask("late-task")
		const admission = owner.createTask("late admission", undefined, undefined, { taskId: task.taskId })
		const outcome = Promise.allSettled([admission])
		await entered.promise
		const history = Reflect.get(owner, "taskHistoryStore") as TaskHistoryStore
		const disposing = owner.dispose()
		await new Promise<void>((resolve) => setImmediate(resolve))
		const disposedHistoryBeforeRelease = vi.mocked(history.dispose).mock.calls.length
		configuration.resolve()
		const [result] = await outcome
		await disposing

		expect(disposedHistoryBeforeRelease).toBe(0)
		expect(result).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: expect.stringContaining("disposed provider") }),
		})
		expect(task.start).not.toHaveBeenCalled()
		expect(owner.getLiveTask(task.taskId)).toBeUndefined()
	})

	it("does not start a registered task after its presentation wait is interrupted by disposal", async () => {
		const owner = makeProvider(storage())
		const entered = barrier()
		const presentation = barrier()
		vi.mocked(owner.postTaskStateToWebview).mockImplementationOnce(async () => {
			entered.resolve()
			await presentation.promise
		})
		const task = prepareTask("registered-task")
		const admission = owner.createTask("prepared", undefined, undefined, { taskId: task.taskId })
		const outcome = Promise.allSettled([admission])
		await entered.promise
		const disposing = owner.dispose()
		presentation.resolve()
		const [result] = await outcome
		await disposing

		expect(result.status).toBe("rejected")
		expect(task.start).not.toHaveBeenCalled()
		expect(task.abortTask).toHaveBeenCalledOnce()
		expect(owner.getLiveTask(task.taskId)).toBeUndefined()
	})

	it.each([false, true])(
		"enforces shared capacity in a fresh editor with preserveExisting=%s",
		async (preserveExisting) => {
			const host = storage()
			const sidebar = makeProvider(host)
			const editor = makeProvider(host)
			sessions(sidebar).setMaxLiveTasks(1)
			await sidebar.addTaskToStack(makeTask("running-root"))
			const task = prepareTask("over-capacity")

			await expect(
				editor.createTask("new editor", undefined, undefined, { taskId: task.taskId, preserveExisting }),
			).rejects.toThrow("Maximum live task limit reached")
			expect(task.start).not.toHaveBeenCalled()
			expect(sessions(editor).getLiveTaskIds()).toEqual(["running-root"])
		},
	)

	it("enforces shared capacity when the public API opens a fresh editor", async () => {
		const host = storage()
		const sidebar = makeProvider(host)
		const editor = makeProvider(host)
		sessions(sidebar).setMaxLiveTasks(1)
		const running = makeTask("running-root")
		await sidebar.addTaskToStack(running)
		const task = prepareTask("api-over-capacity")
		vi.mocked(openAlphaInNewTab).mockResolvedValueOnce(editor)
		vi.spyOn(editor, "postStateToWebview").mockResolvedValue(undefined)
		vi.spyOn(editor, "setValues").mockResolvedValue(undefined)
		const api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, sidebar)

		await expect(
			api.startNewTask({ newTab: true, text: "new editor", configuration: { apiProvider: "openai" } }),
		).rejects.toThrow("Maximum live task limit reached")
		expect(task.start).not.toHaveBeenCalled()
		expect(running.abortTask).not.toHaveBeenCalled()
		expect(sessions(sidebar).getLiveTaskIds()).toEqual([running.taskId])
	})

	it("joins disposal requested synchronously by task construction without waiting on itself", async () => {
		const owner = makeProvider(storage())
		const task = Object.assign(makeTask("construction-disposal"), { start: vi.fn() })
		let disposing: Promise<void> | undefined
		vi.mocked(Task).mockImplementationOnce(function () {
			disposing = owner.dispose()
			return task
		})

		await expect(
			owner.createTask("dispose during construction", undefined, undefined, { taskId: task.taskId }),
		).rejects.toThrow("disposed provider")
		await disposing
		expect(task.start).not.toHaveBeenCalled()
		expect(task.abortTask).toHaveBeenCalledOnce()
		expect(owner.getLiveTask(task.taskId)).toBeUndefined()
	})

	it("routes opposite cross-view child admissions before taking either creation queue", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		sessions(first).setMaxLiveTasks(4)
		const firstParent = makeTask("first-parent")
		const secondParent = makeTask("second-parent")
		await first.addTaskToStack(firstParent)
		await second.addTaskToStack(secondParent)
		const children = new Map(
			["first-child", "second-child"].map((id) => [id, Object.assign(makeTask(id), { start: vi.fn() })]),
		)
		vi.mocked(Task).mockImplementation(function (options) {
			return children.get(options?.taskId ?? "")!
		})

		const tasks = await Promise.all([
			first.createTask("second child", undefined, secondParent, { taskId: "second-child" }),
			second.createTask("first child", undefined, firstParent, { taskId: "first-child" }),
		])
		expect(tasks.map(({ taskId }) => taskId)).toEqual(["second-child", "first-child"])
		expect(sessions(first).getOwner("first-child")).toBe(sessions(first))
		expect(sessions(second).getOwner("second-child")).toBe(sessions(second))
	})

	it("reuses a released replacement slot at the shared maximum", async () => {
		const owner = makeProvider(storage())
		sessions(owner).setMaxLiveTasks(1)
		const previous = makeTask("previous")
		await owner.addTaskToStack(previous)
		const replacement = prepareTask("replacement")

		await expect(
			owner.createTask("replacement", undefined, undefined, {
				taskId: replacement.taskId,
				preserveExisting: false,
			}),
		).resolves.toBe(replacement)
		expect(previous.abortTask).toHaveBeenCalledOnce()
		expect(replacement.start).toHaveBeenCalledOnce()
		expect(sessions(owner).getLiveTaskIds()).toEqual([replacement.taskId])
	})

	it("retains a failed construction cleanup for a later disposal retry", async () => {
		const owner = makeProvider(storage())
		sessions(owner).setMaxLiveTasks(1)
		const task = prepareTask("failed-cleanup")
		task.persistFrozenSubagentInstructions.mockRejectedValueOnce(new Error("instruction write failed"))
		vi.mocked(task.abortTask).mockRejectedValueOnce(new Error("process still running"))
		await expect(
			owner.createTask("preparing", undefined, undefined, {
				taskId: task.taskId,
				subagentInstructionPlacement: "system",
			}),
		).rejects.toThrow("process still running")
		expect(owner.getLiveTask(task.taskId)).toBe(task)
		expect(sessions(owner).getAvailableTaskCapacity()).toBe(0)

		await owner.dispose()
		expect(task.abortTask).toHaveBeenCalledTimes(2)
		expect(owner.getLiveTask(task.taskId)).toBeUndefined()
	})

	it("keeps explicit start requests behind runtime registration", async () => {
		const owner = makeProvider(storage())
		const task = prepareTask("explicit-start")
		await owner.createTask("start", undefined, undefined, { taskId: task.taskId, startTask: true })

		expect(Task).toHaveBeenLastCalledWith(expect.objectContaining({ startTask: false }))
		expect(task.start).toHaveBeenCalledOnce()
	})

	it("admits an owned prepared child at the shared maximum", async () => {
		const owner = makeProvider(storage())
		sessions(owner).setMaxLiveTasks(2)
		const parent = makeTask("parent")
		await owner.addTaskToStack(parent)
		sessions(owner).reserveTaskSlots("group", {
			rootTaskId: parent.taskId,
			count: 1,
			maxTotalTasks: 2,
			maxRootTasks: 1,
			activeRootTasks: 0,
			isRootTaskRegistered: () => false,
		})
		sessions(owner).setReservedTaskIds("group", ["reserved-child"])
		const task = prepareTask("reserved-child")
		await expect(owner.createTask("child", undefined, parent, { taskId: task.taskId })).resolves.toBe(task)
		expect(task.start).toHaveBeenCalledOnce()
		expect(sessions(owner).getAvailableTaskCapacity()).toBe(0)
	})

	it("counts in-flight construction against other views and releases a failed admission", async () => {
		const host = storage()
		const first = makeProvider(host)
		const second = makeProvider(host)
		sessions(first).setMaxLiveTasks(1)
		const entered = barrier()
		const instructions = barrier()
		const task = prepareTask("preparing")
		task.persistFrozenSubagentInstructions.mockImplementationOnce(async () => {
			entered.resolve()
			await instructions.promise
			throw new Error("instruction write failed")
		})
		const admission = first.createTask("preparing", undefined, undefined, {
			taskId: task.taskId,
			subagentInstructionPlacement: "system",
			preserveExisting: true,
		})
		const outcome = Promise.allSettled([admission])
		await entered.promise
		const availableDuringPreparation = sessions(second).getAvailableTaskCapacity()
		instructions.resolve()
		const [result] = await outcome

		expect(availableDuringPreparation).toBe(0)
		expect(result).toMatchObject({ status: "rejected", reason: new Error("instruction write failed") })
		expect(task.abortTask).toHaveBeenCalledOnce()
		expect(sessions(second).getAvailableTaskCapacity()).toBe(1)
	})
})
