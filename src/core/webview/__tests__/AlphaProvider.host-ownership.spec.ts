import EventEmitter from "node:events"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"

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

vi.mock("../../task/Task", () => ({ Task: vi.fn() }))

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
		clineMessages: [],
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
		taskSessions: TaskSessionRegistry.forGlobalStorage(storagePath, 3),
		taskStack: [],
		taskNavigationGeneration: 0,
		currentView: { type: "newTaskDraft" },
		newTaskDraftMode: "code",
		context: { globalState: { get: () => true } },
		contextProxy: { globalStorageUri: { fsPath: storagePath }, getValues: () => ({}), getValue: () => "code" },
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
		reservedSubagentSlots: new Map(),
		publishedSubagentResults: new Set(),
		legacyHandoffInputBuffers: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		taskEventListeners: new WeakMap(),
		taskCreationCallback: vi.fn(),
		independentTaskWaiters: new Map(),
		clineMessagesSeq: 0,
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

afterEach(() => {
	for (const provider of created.splice(0)) {
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
				clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
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
				clineMessages: [{ ts: 100, type: "say", say: "completion_result", text: "Result" }],
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
				messages: child.clineMessages as any,
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
		vi.mocked(Task).mockImplementationOnce((options) => {
			options.onCreated?.(task)
			expect(provider.getLiveTask(history.id)).toBe(task)
			expect(provider.getTaskOwner(history.id)).toBe(provider)
			return task
		})
		expect(await provider.createTaskWithHistoryItem(history, { preserveExisting: true })).toBe(task)
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
		expect(cancel).toHaveBeenCalledWith(task.taskId, "webview_stop")
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
					return { text: message.clineMessage?.text, sequence: message.clineMessagesSeq ?? 0 }
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
		task.clineMessages.push({ ts: 1, type: "say", say: "user_feedback", text: "accepted input" })
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
					clineMessages: task.clineMessages,
					clineMessagesSeq: expect.any(Number),
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
				clineMessages: [
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
