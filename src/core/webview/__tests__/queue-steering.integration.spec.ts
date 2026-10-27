import type { ExtensionMessage, ExtensionState, QueuedMessage } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { MessageQueueService, type MessageQueuePersistence } from "../../message-queue/MessageQueueService"
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
		alphaMessagesSeq: 0,
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
		alphaMessagesSeq: 0,
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
		alphaMessagesSeq: 0,
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
		agentTurnId: "running-turn",
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
		getAgentLifecycleSnapshot: () => ({ turnId: "running-turn" }),
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

function queuedSteeringFixture(persistence?: MessageQueuePersistence) {
	const queue = new MessageQueueService(persistence)
	const requestController = new AbortController()
	const stepController = new AbortController()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "queued-turn-fence",
		instanceId: "queued-turn-fence-instance",
		taskKind: "primary",
		agentTurnId: "original",
		abort: false,
		abandoned: false,
		didComplete: false,
		isInitialized: true,
		isTaskLoopActive: true,
		isStreaming: true,
		currentRequestAbortController: requestController,
		stepInterruptionController: stepController,
		taskCancellationController: new AbortController(),
		isCurrentApiConversationHistoryOwner: () => true,
		apiConversationHistory: [],
		messageQueueService: queue,
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		emit: vi.fn(),
	}) as Task
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		getLiveTask: (taskId: string) => (taskId === task.taskId ? task : undefined),
		getAgentLifecycleSnapshot: () => ({ turnId: task["agentTurnId"] }),
		canAcceptTaskInput: (taskId: string) => taskId === task.taskId,
		getState: vi.fn(async () => ({})),
		postMessageToWebview: vi.fn(async (_message: ExtensionMessage) => undefined),
		log: vi.fn(),
	}) as AlphaProvider
	Object.assign(task, { providerRef: { deref: () => provider } })
	const request = {
		type: "steerQueuedMessage" as const,
		taskId: task.taskId,
		requestId: "select-queued-input",
		text: "queued-input",
		expectedTurnId: "original",
	}
	return { task, queue, provider, request, requestController, stepController }
}

it("steers queued messages in FIFO order, skipping claimed input and leaving an empty queue alone", async () => {
	const { task, queue, provider } = queuedSteeringFixture()
	try {
		await queue.addMessageDurably("first guidance", [], "first")
		await queue.addMessageDurably("second guidance", ["image.png"], "second")
		vi.spyOn(task, "canAcceptSteerMessage").mockReturnValue(true)
		const handoff = vi.spyOn(task, "steerUserMessage").mockResolvedValue(undefined)
		for (const requestId of ["press-1", "press-2", "empty-press"]) {
			await webviewMessageHandler(provider, {
				type: "steerNextQueuedMessage",
				taskId: task.taskId,
				requestId,
				expectedTurnId: "original",
			})
		}
		expect(handoff.mock.calls.map((args) => args[3])).toEqual([["first"], ["second"]])
		expect(handoff).toHaveBeenNthCalledWith(2, "second guidance", ["image.png"], undefined, ["second"])
		expect(queue.messages).toEqual([])
		expect(queue.getClaimedMessageIds()).toEqual(["first", "second"])
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					requestId: "empty-press",
					command: "steerNextQueuedMessage",
					status: "accepted",
				}),
			}),
		)
	} finally {
		queue.dispose()
	}
})

it("uses the real durable steering boundary for the oldest queued input", async () => {
	const { task, queue, provider, requestController } = queuedSteeringFixture()
	try {
		await queue.addMessageDurably("first", [], "first")
		await queue.addMessageDurably("second", [], "second")
		await webviewMessageHandler(provider, {
			type: "steerNextQueuedMessage",
			taskId: task.taskId,
			requestId: "press",
			expectedTurnId: "original",
		})
		expect(queue.messages.map(({ id }) => id)).toEqual(["second"])
		expect(queue.getClaimedMessageIds()).toEqual(["first"])
		expect(task.hasPendingSteerMessage()).toBe(true)
		expect(requestController.signal.aborted).toBe(true)
		expect(task.abort).toBe(false)
	} finally {
		queue.dispose()
	}
})

it("selects distinct FIFO items when two views request steering during queue hydration", async () => {
	const loaded = barrier()
	const { task, queue, provider } = queuedSteeringFixture({
		load: async () => {
			await loaded.promise
			return [
				{ id: "first", timestamp: 1, text: "first" },
				{ id: "second", timestamp: 2, text: "second" },
			]
		},
		save: async () => undefined,
	})
	vi.spyOn(task, "canAcceptSteerMessage").mockReturnValue(true)
	const deliver = vi.spyOn(task, "steerUserMessage").mockResolvedValue(undefined)
	const requests = ["sidebar", "editor"].map((requestId) =>
		webviewMessageHandler(provider, {
			type: "steerNextQueuedMessage",
			taskId: task.taskId,
			requestId,
			expectedTurnId: "original",
		}),
	)
	try {
		loaded.resolve()
		await Promise.all(requests)
		expect(deliver.mock.calls.map((args) => args[3])).toEqual([["first"], ["second"]])
	} finally {
		loaded.resolve()
		await Promise.all(requests)
		queue.dispose()
	}
})

it.each(["busy", "stale", "failure"])("preserves queued input when next-item steering is %s", async (condition) => {
	const { task, queue, provider, requestController } = queuedSteeringFixture()
	try {
		await queue.addMessageDurably("first", [], "first")
		await queue.addMessageDurably("second", [], "second")
		if (condition === "busy") vi.spyOn(task, "canAcceptSteerMessage").mockReturnValue(false)
		if (condition === "stale") Reflect.set(task, "agentTurnId", "successor")
		if (condition === "failure")
			vi.spyOn(task, "steerQueuedUserMessage").mockRejectedValue(new Error("Delivery failed"))
		await webviewMessageHandler(provider, {
			type: "steerNextQueuedMessage",
			taskId: task.taskId,
			requestId: "press",
			expectedTurnId: "original",
		})
		expect(queue.messages.map(({ id }) => id)).toEqual(["first", "second"])
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(requestController.signal.aborted).toBe(false)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "steerNextQueuedMessage", status: "rejected" }),
			}),
		)
	} finally {
		queue.dispose()
	}
})

it("rejects an invalid queued steering turn identity without selecting input", async () => {
	const { task, queue, provider, request, requestController } = queuedSteeringFixture()
	await queue.addMessageDurably("PRESERVE_INPUT", [], request.text)
	const handoff = vi.spyOn(task, "steerQueuedUserMessage")
	await webviewMessageHandler(provider, { ...request, expectedTurnId: "" })
	expect(handoff).not.toHaveBeenCalled()
	expect(queue.messages).toMatchObject([{ id: request.text, text: "PRESERVE_INPUT" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(requestController.signal.aborted).toBe(false)
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "unknown" }),
		}),
	)
	queue.dispose()
})

it("rejects a queued steering request for an earlier turn before selecting input", async () => {
	const { task, queue, provider, request, requestController } = queuedSteeringFixture()
	await queue.addMessageDurably("PRESERVE_INPUT", [], request.text)
	Reflect.set(task, "agentTurnId", "successor")
	const handoff = vi.spyOn(task, "steerQueuedUserMessage")
	await webviewMessageHandler(provider, request)
	expect(handoff).not.toHaveBeenCalled()
	expect(queue.messages).toMatchObject([{ id: request.text, text: "PRESERVE_INPUT" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(requestController.signal.aborted).toBe(false)
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
		}),
	)
	queue.dispose()
})

it.each(["explicit", "legacy", "next"] as const)(
	"retains %s queued steering when the turn changes during hydration",
	async (client) => {
		const loading = barrier()
		const loaded = barrier()
		const queued = { id: "queued-input", timestamp: 1, text: "PRESERVE_RESTORED_INPUT" }
		const { task, queue, provider, request, requestController, stepController } = queuedSteeringFixture({
			load: async () => {
				loading.resolve()
				await loaded.promise
				return [queued]
			},
			save: async () => undefined,
		})
		const handoff = vi.spyOn(task, "steerQueuedUserMessage")
		const pending = webviewMessageHandler(
			provider,
			client === "next"
				? {
						type: "steerNextQueuedMessage",
						taskId: task.taskId,
						requestId: "next-press",
						expectedTurnId: request.expectedTurnId,
					}
				: { ...request, expectedTurnId: client === "explicit" ? request.expectedTurnId : undefined },
		)
		try {
			await loading.promise
			Reflect.set(task, "agentTurnId", "successor")
			loaded.resolve()
			await pending
			expect(handoff).not.toHaveBeenCalled()
			expect(queue.messages).toEqual([queued])
			expect(queue.getClaimedMessageIds()).toEqual([])
			expect(requestController.signal.aborted).toBe(false)
			expect(stepController.signal.aborted).toBe(false)
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({
					chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
				}),
			)
		} finally {
			loaded.resolve()
			await pending
			queue.dispose()
		}
	},
)

it("releases queued steering without interrupting a successor when claim persistence finishes late", async () => {
	const claiming = barrier()
	const claimed = barrier()
	let savedQueue: QueuedMessage[] = []
	const persistence: MessageQueuePersistence = {
		load: async () => savedQueue,
		save: async (messages) => {
			if (queue.getClaimedMessageIds().includes("queued-input")) {
				claiming.resolve()
				await claimed.promise
			}
			savedQueue = structuredClone([...messages])
		},
	}
	const { task, queue, provider, request, requestController, stepController } = queuedSteeringFixture(persistence)
	await queue.addMessageDurably("PRESERVE_ADMITTED_INPUT", [], request.text)
	const handoff = vi.spyOn(task, "steerUserMessage")
	const pending = webviewMessageHandler(provider, request)
	try {
		await claiming.promise
		Reflect.set(task, "agentTurnId", "successor")
		claimed.resolve()
		await pending
		expect(handoff).not.toHaveBeenCalled()
		expect(queue.messages).toMatchObject([{ id: request.text, text: "PRESERVE_ADMITTED_INPUT" }])
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(requestController.signal.aborted).toBe(false)
		expect(stepController.signal.aborted).toBe(false)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
			}),
		)
		const restored = new MessageQueueService(persistence)
		await restored.ready
		expect(restored.messages).toMatchObject([{ id: request.text, text: "PRESERVE_ADMITTED_INPUT" }])
		restored.dispose()
	} finally {
		claimed.resolve()
		await pending
		queue.dispose()
	}
})
