import { TaskLifecycleState, type ExtensionMessage, type QueuedMessage } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import type { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { webviewMessageHandler } from "../webviewMessageHandler"

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

function completedTaskFixture(load?: () => Promise<QueuedMessage[]>) {
	let savedQueue: QueuedMessage[] = []
	const queue = new MessageQueueService({
		load: load ?? (async () => savedQueue),
		save: async (messages) => {
			savedQueue = structuredClone([...messages])
		},
	})
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "completed-queued-followup",
		instanceId: "completed-queued-followup-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		isInitialized: true,
		_started: true,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		taskCancellationController: new AbortController(),
		alphaMessages: [],
		apiConversationHistory: [],
		messageQueueService: queue,
		resetMistakeRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
	}) as Task
	task.markCompleted()
	const prepare = vi.fn(task["prepareForRetainedLifecycle"].bind(task))
	const resume = vi.fn(
		async (
			text: string,
			persisted?: () => void | Promise<void>,
			_images?: string[],
			options?: { queuedMessageIds?: string[] },
		) => {
			const ids = options?.queuedMessageIds ?? []
			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text }],
				queued_message_ids: ids,
			})
			queue.acknowledgeMessages(ids)
			await queue.flush()
			await persisted?.()
		},
	)
	Object.assign(task, { prepareForRetainedLifecycle: prepare, resumeTaskFromHistory: resume })
	const registry = new TaskSessionRegistry()
	registry.register(task)
	registry.markLifecycle(task.taskId, TaskLifecycleState.Completed)
	const provider = {
		getLiveTask: vi.fn((taskId: string) => registry.getTask(taskId)),
		getLiveTaskMetadata: vi.fn(() => registry.getMetadata()),
		canAcceptTaskInput: vi.fn((taskId: string) => registry.canAcceptInput(taskId)),
		getState: vi.fn(async () => ({})),
		postMessageToWebview: vi.fn(async (_message: ExtensionMessage) => {}),
		postTaskQueueToWebview: vi.fn(async () => {}),
		log: vi.fn(),
	} as unknown as AlphaProvider
	Object.assign(task, { providerRef: { deref: () => provider } })
	const request = {
		type: "steerQueuedMessage" as const,
		taskId: task.taskId,
		requestId: "retry-existing-input",
		text: "existing-input",
	}
	return { task, queue, registry, provider, prepare, resume, request, saved: () => savedQueue }
}

describe("completed task queued follow-up retry", () => {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}))
	afterEach(() => vi.restoreAllMocks())

	it("retries retained accepted input after preparation fails and commits its original receipt exactly once", async () => {
		const { task, queue, provider, prepare, resume, request, saved } = completedTaskFixture()
		prepare.mockRejectedValueOnce(new Error("follow-up preparation failed"))
		await webviewMessageHandler(provider, {
			type: "resumeCompletedTask",
			taskId: task.taskId,
			requestId: request.text,
			text: "Continue the long conversation",
			images: ["data:image/png;base64,attached"],
		})
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ status: "accepted", deliveryState: "queued" }),
			}),
		)
		expect(provider.canAcceptTaskInput(task.taskId)).toBe(false)
		expect(queue.messages).toMatchObject([{ id: request.text, text: "Continue the long conversation" }])
		expect(resume).not.toHaveBeenCalled()

		await webviewMessageHandler(provider, request)

		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					command: "steerQueuedMessage",
					requestId: request.requestId,
					status: "accepted",
				}),
			}),
		)
		expect(resume).toHaveBeenCalledExactlyOnceWith(
			"Continue the long conversation",
			expect.any(Function),
			["data:image/png;base64,attached"],
			expect.objectContaining({ queuedMessageIds: [request.text] }),
		)
		expect(task.apiConversationHistory.map((message) => message.queued_message_ids)).toEqual([[request.text]])
		expect(queue.hasUnconsumedInput()).toBe(false)
		expect(saved()).toEqual([])

		// A late retry cannot create another instruction after the model finishes.
		task.markCompleted()
		await webviewMessageHandler(provider, request)
		expect(resume).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toHaveLength(1)
		queue.dispose()
	})

	it("keeps the same accepted input available when explicit retry also fails, until a later retry succeeds", async () => {
		const { task, queue, provider, prepare, resume, request, saved } = completedTaskFixture()
		prepare
			.mockRejectedValueOnce(new Error("initial preparation failed"))
			.mockRejectedValueOnce(new Error("retry preparation failed"))
		await task.submitUserMessage("Keep the accepted follow-up", [], undefined, undefined, undefined, request.text)
		await webviewMessageHandler(provider, request)
		expect(prepare).toHaveBeenCalledTimes(2)
		expect(resume).not.toHaveBeenCalled()
		expect(task.isCompleted()).toBe(true)
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(saved()).toMatchObject([{ id: request.text, text: "Keep the accepted follow-up" }])
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "rejected" }) }),
		)

		await webviewMessageHandler(provider, { ...request, requestId: "retry-again" })
		expect(prepare).toHaveBeenCalledTimes(3)
		expect(resume).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory.map((message) => message.queued_message_ids)).toEqual([[request.text]])
		expect(queue.hasUnconsumedInput()).toBe(false)
		queue.dispose()
	})

	it.each(["failed", "closed", "aborted", "abandoned", "managed child", "replaced"] as const)(
		"rejects an eligible task that becomes %s while queue restoration is pending",
		async (transition) => {
			const loaded = barrier()
			const queued = { id: "existing-input", text: "Retain this follow-up", timestamp: 1 }
			const { task, queue, registry, provider, prepare, resume, request } = completedTaskFixture(async () => {
				await loaded.promise
				return [queued]
			})
			const pending = webviewMessageHandler(provider, request)
			if (transition === "failed") registry.markLifecycle(task.taskId, TaskLifecycleState.Failed)
			else if (transition === "closed") registry.markLifecycle(task.taskId, TaskLifecycleState.Closed)
			else if (transition === "aborted") task.abort = true
			else if (transition === "abandoned") task.abandoned = true
			else if (transition === "managed child") Object.assign(task, { taskKind: "subagent" })
			else vi.mocked(provider.getLiveTask).mockReturnValue(undefined)
			loaded.resolve()
			await pending
			expect(prepare).not.toHaveBeenCalled()
			expect(resume).not.toHaveBeenCalled()
			expect(queue.messages).toEqual([queued])
			expect(queue.getClaimedMessageIds()).toEqual([])
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({
					chatCommandResult: expect.objectContaining({
						status: "rejected",
						errorCode: transition === "replaced" ? "stale_turn" : "task_unavailable",
					}),
				}),
			)
			queue.dispose()
		},
	)

	it.each(["closed", "replaced"] as const)(
		"releases its existing receipt when the task becomes %s while the old lifecycle drains",
		async (transition) => {
			const { task, queue, registry, provider, resume, request } = completedTaskFixture()
			await queue.addMessageDurably("Retain the selected input", [], request.text)
			const ending = barrier()
			const selected = barrier()
			Object.assign(task, { ownedLifecyclePromise: ending.promise })
			const claim = queue.claimMessage.bind(queue)
			vi.spyOn(queue, "claimMessage").mockImplementation((id) => {
				const message = claim(id)
				selected.resolve()
				return message
			})
			const pending = webviewMessageHandler(provider, request)
			await selected.promise
			if (transition === "closed") registry.markLifecycle(task.taskId, TaskLifecycleState.Closed)
			else vi.mocked(provider.getLiveTask).mockReturnValue(undefined)
			ending.resolve()
			await pending
			expect(resume).not.toHaveBeenCalled()
			expect(queue.getClaimedMessageIds()).toEqual([])
			expect(queue.messages).toMatchObject([{ id: request.text, text: "Retain the selected input" }])
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "rejected" }) }),
			)
			queue.dispose()
		},
	)

	it("releases a completed follow-up selection if a successor turn starts while the old lifecycle drains", async () => {
		const { task, queue, provider, prepare, resume, request } = completedTaskFixture()
		Object.assign(task, { agentTurnId: "original" })
		await queue.addMessageDurably("Retain the selected input", [], request.text)
		const ending = barrier()
		const selected = barrier()
		Object.assign(task, { ownedLifecyclePromise: ending.promise })
		const claim = queue.claimMessage.bind(queue)
		vi.spyOn(queue, "claimMessage").mockImplementation((id) => {
			const message = claim(id)
			selected.resolve()
			return message
		})
		const pending = webviewMessageHandler(provider, { ...request, expectedTurnId: "original" })
		try {
			await selected.promise
			Reflect.set(task, "agentTurnId", "successor")
			ending.resolve()
			await pending
			expect(prepare).not.toHaveBeenCalled()
			expect(resume).not.toHaveBeenCalled()
			expect(queue.getClaimedMessageIds()).toEqual([])
			expect(queue.messages).toMatchObject([{ id: request.text, text: "Retain the selected input" }])
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({
					chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
				}),
			)
		} finally {
			ending.resolve()
			await pending
			queue.dispose()
		}
	})
})
