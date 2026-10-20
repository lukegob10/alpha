import type { ExtensionMessage, ExtensionState, QueuedMessage } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"

vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	readApiMessages: vi.fn(async () => []),
}))

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

function preferenceViews(initialAutoSteer: boolean) {
	let autoSteer: boolean | undefined = initialAutoSteer
	const contextProxy = {
		getValue: (key: string) => (key === "autoSteer" ? autoSteer : undefined),
		setValue: async (key: string, value: boolean | undefined) => {
			if (key === "autoSteer") autoSteer = value
		},
	}
	const sidebarMessages: ExtensionMessage[] = []
	const editorMessages: ExtensionMessage[] = []
	const makeView = (received: ExtensionMessage[]) => ({
		webview: {
			postMessage: vi.fn(async (message: ExtensionMessage) => {
				received.push(structuredClone(message))
				return true
			}),
		},
	})
	const sidebar = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "newTaskDraft" },
		contextProxy,
		view: makeView(sidebarMessages),
		clineMessagesSeq: 0,
		taskStateSeq: 0,
		messageQueueSeq: 0,
		currentTaskTodosSeq: 0,
		getStateToPostToWebview: vi.fn(async () => ({ autoSteer }) as ExtensionState),
	}) as AlphaProvider
	const editor = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "task", taskId: "editor-task" },
		contextProxy,
		view: makeView(editorMessages),
	}) as AlphaProvider
	Object.assign(sidebar, { getHostProviders: () => [sidebar, editor] })
	return { sidebar, editor, contextProxy, sidebarMessages, editorMessages }
}

it.each([true, false])(
	"publishes saved auto-steer=%s to an already-open peer without its transcript",
	async (autoSteer) => {
		const { sidebar, editor, editorMessages } = preferenceViews(!autoSteer)
		await webviewMessageHandler(sidebar, { type: "updateSettings", updatedSettings: { autoSteer } })
		expect(editorMessages).toEqual([{ type: "state", state: { autoSteer } }])
		expect(editor["currentView"]).toEqual({ type: "task", taskId: "editor-task" })
	},
)

it("publishes reset and imported steering preferences through the existing full-state refresh", async () => {
	const { sidebar, contextProxy, editorMessages } = preferenceViews(true)
	await contextProxy.setValue("autoSteer", undefined)
	await sidebar.postStateToWebview()
	await contextProxy.setValue("autoSteer", true)
	await sidebar.postStateToWebview()
	expect(editorMessages).toEqual([
		{ type: "state", state: { autoSteer: false } },
		{ type: "state", state: { autoSteer: true } },
	])
})

it("does not restore an old steering preference when full-state assembly settles after a newer Save", async () => {
	const { sidebar, sidebarMessages, editorMessages } = preferenceViews(true)
	const assembling = barrier()
	const assembled = barrier()
	vi.mocked(sidebar.getStateToPostToWebview).mockImplementationOnce(async () => {
		assembling.resolve()
		await assembled.promise
		return { autoSteer: true } as ExtensionState
	})
	const olderRefresh = sidebar.postStateToWebview()
	await assembling.promise
	await webviewMessageHandler(sidebar, { type: "updateSettings", updatedSettings: { autoSteer: false } })
	assembled.resolve()
	await olderRefresh
	expect(sidebarMessages.at(-1)?.state?.autoSteer).toBe(false)
	expect(editorMessages.at(-1)?.state?.autoSteer).toBe(false)
})

it("dispatches the peer preference without waiting for the originating view's transport", async () => {
	const { sidebar, editorMessages } = preferenceViews(true)
	const sending = barrier()
	const sent = barrier()
	vi.spyOn(sidebar["view"]!.webview, "postMessage").mockImplementationOnce(async () => {
		sending.resolve()
		await sent.promise
		return true
	})
	const save = webviewMessageHandler(sidebar, { type: "updateSettings", updatedSettings: { autoSteer: false } })
	try {
		await sending.promise
		expect(editorMessages).toEqual([{ type: "state", state: { autoSteer: false } }])
	} finally {
		sent.resolve()
		await save
	}
})

it("does not revive delivered input in another view when an earlier publication settles late", async () => {
	const entered = barrier()
	const held = barrier()
	const received: ExtensionMessage[] = []
	const first = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "task", taskId: "shared-task" },
		messageQueueSeq: 0,
		taskStateSeq: 1,
		clineMessagesSeq: 0,
		postMessageToWebview: vi.fn().mockImplementationOnce(async () => {
			entered.resolve()
			await held.promise
		}),
	}) as AlphaProvider
	const second = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		currentView: { type: "task", taskId: "shared-task" },
		messageQueueSeq: 0,
		taskStateSeq: 1,
		clineMessagesSeq: 0,
		postMessageToWebview: vi.fn(async (message: ExtensionMessage) => {
			received.push(structuredClone(message))
		}),
	}) as AlphaProvider
	const publisher = Object.assign(Object.create(AlphaProvider.prototype), {
		getHostProviders: () => [first, second],
	}) as AlphaProvider
	const publishing = publisher.postTaskQueueToWebview("shared-task", [
		{ id: "input", timestamp: 1, text: "arbitrary input", deliveryState: "delivering" },
	])
	await entered.promise
	await publisher.postTaskQueueToWebview("shared-task", [])
	held.resolve()
	await publishing
	const latest = received.at(-1)!.state!
	expect(latest.messageQueue).toEqual([])
	const sequences = received.map((message) => message.state!.messageQueueSeq!)
	expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
})

it("leaves active-turn input queued until an explicit Steer selects it without consuming older guidance", async () => {
	let savedQueue: QueuedMessage[] = []
	const persistence = {
		load: async () => savedQueue,
		save: async (messages: readonly QueuedMessage[]) => {
			savedQueue = structuredClone([...messages])
		},
	}
	const queue = new MessageQueueService(persistence)
	const request = new AbortController()
	const step = new AbortController()
	const lifetime = new AbortController()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "background-task",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		isInitialized: true,
		isTaskLoopActive: true,
		isStreaming: true,
		steerMessageAwaitingPersistence: false,
		currentRequestAbortController: request,
		stepInterruptionController: step,
		taskCancellationController: lifetime,
		isCurrentApiConversationHistoryOwner: () => true,
		apiConversationHistory: [],
		messageQueueService: queue,
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		emit: vi.fn(),
	}) as Task
	const getCurrentTask = vi.fn()
	const postMessageToWebview = vi.fn(async (_message: ExtensionMessage) => undefined)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		contextProxy: { globalStorageUri: { fsPath: "unused-storage" } },
		legacyHandoffInputBuffers: new Map(),
		getTaskOwner: () => provider,
		getLiveTask: (taskId: string) => (taskId === task.taskId ? task : undefined),
		getCurrentTask,
		canAcceptTaskInput: (taskId: string) => taskId === task.taskId,
		postMessageToWebview,
		postTaskQueueToWebview: vi.fn(async () => undefined),
		log: vi.fn(),
	}) as AlphaProvider

	for (const [requestId, text] of [
		["older-input", "Continue with the current plan"],
		["selected-input", "Check the configuration first"],
	]) {
		await webviewMessageHandler(provider, { type: "queueMessage", taskId: task.taskId, requestId, text })
		expect(postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "queueMessage", requestId, status: "accepted" }),
			}),
		)
	}

	expect(queue.messages.map(({ id }) => id)).toEqual(["older-input", "selected-input"])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(savedQueue.map(({ id }) => id)).toEqual(["older-input", "selected-input"])
	expect(request.signal.aborted).toBe(false)
	expect(step.signal.aborted).toBe(false)
	expect(lifetime.signal.aborted).toBe(false)
	expect(task.hasPendingSteerMessage()).toBe(false)

	await webviewMessageHandler(provider, {
		type: "steerQueuedMessage",
		taskId: task.taskId,
		requestId: "manual-steer",
		text: "selected-input",
	})

	expect(postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({
			chatCommandResult: expect.objectContaining({
				command: "steerQueuedMessage",
				requestId: "manual-steer",
				status: "accepted",
			}),
		}),
	)
	expect(request.signal.aborted).toBe(true)
	expect(step.signal.aborted).toBe(true)
	expect(lifetime.signal.aborted).toBe(false)
	expect(task.abort).toBe(false)
	expect(task.hasPendingSteerMessage()).toBe(true)
	expect(queue.messages.map(({ id }) => id)).toEqual(["older-input"])
	expect(queue.getClaimedMessageIds()).toEqual(["selected-input"])
	expect(queue.visibleMessages).toContainEqual(
		expect.objectContaining({ id: "selected-input", deliveryState: "delivering" }),
	)
	expect(getCurrentTask).not.toHaveBeenCalled()

	const restored = new MessageQueueService(persistence)
	await restored.ready
	expect(restored.messages.map(({ id }) => id)).toEqual(["selected-input", "older-input"])
	queue.dispose()
	restored.dispose()
})
