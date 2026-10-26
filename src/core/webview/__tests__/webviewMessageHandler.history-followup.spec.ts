import { TaskLifecycleState, type AlphaMessage } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import type { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { webviewMessageHandler } from "../webviewMessageHandler"

function restoredTaskFixture() {
	const queue = new MessageQueueService({ load: async () => [], save: async () => {} })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "restored-completed-task",
		instanceId: "restored-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		isInitialized: false,
		_started: true,
		initialHistoryResumePending: true,
		didComplete: false,
		clineMessages: [{ ts: 10, type: "say", say: "completion_result", text: "Previous result" }] as AlphaMessage[],
		apiConversationHistory: [],
		messageQueueService: queue,
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.clineMessages.push(message)),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		cancelAutoApprovalTimeout: vi.fn(),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
	}) as Task
	const registry = new TaskSessionRegistry()
	registry.register(task)
	const provider = {
		getLiveTask: vi.fn((taskId: string) => registry.getTask(taskId)),
		canAcceptTaskInput: vi.fn((taskId: string) => registry.canAcceptInput(taskId)),
		getState: vi.fn(async () => ({})),
		isTaskOnScreen: vi.fn(() => true),
		postMessageToWebview: vi.fn(async () => {}),
		postTaskQueueToWebview: vi.fn(async () => {}),
		log: vi.fn(),
	} as unknown as AlphaProvider
	Object.assign(task, { providerRef: { deref: () => provider } })
	const request = {
		type: "resumeCompletedTask" as const,
		taskId: task.taskId,
		requestId: "restored-followup",
		text: "Continue the restored task",
		images: [],
	}
	return { task, queue, registry, provider, request }
}

describe("restored task follow-up routing", () => {
	afterEach(() => vi.useRealTimers())

	it.each([false, true])(
		"durably queues a follow-up before the restored resume ask (initialized: %s)",
		async (initialized) => {
			const { task, queue, provider, request } = restoredTaskFixture()
			task.isInitialized = initialized
			expect(task.isCompleted()).toBe(false)
			await webviewMessageHandler(provider, request)
			expect(queue.messages).toMatchObject([{ id: request.requestId, text: request.text }])
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({
					chatCommandResult: expect.objectContaining({ status: "accepted", deliveryState: "queued" }),
				}),
			)
			// A retry of the accepted command cannot duplicate the retained instruction.
			await webviewMessageHandler(provider, request)
			expect(queue.messages).toHaveLength(1)
			await expect(task.ask("resume_completed_task", "Resume?", false)).resolves.toMatchObject({
				response: "messageResponse",
				text: request.text,
				queuedMessageIds: [request.requestId],
			})
			expect(queue.getClaimedMessageIds()).toEqual([request.requestId])
		},
	)

	it("routes a stale completed-task command to the restored task's newly published resume ask", async () => {
		vi.useFakeTimers()
		const { task, provider, request, registry } = restoredTaskFixture()
		task.isInitialized = true
		const pending = task.ask("resume_completed_task", "Resume?", false)
		void pending.catch(() => {})
		try {
			await vi.waitFor(() => expect(task.getActiveAskTimestamp()).toBeDefined())
			expect(registry.getMetadata()[task.taskId].lifecycle).toBe(TaskLifecycleState.Completed)
			expect(task.isCompleted()).toBe(false)
			await webviewMessageHandler(provider, request)
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "accepted" }) }),
			)
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).resolves.toMatchObject({
				response: "messageResponse",
				text: request.text,
				queuedMessageIds: [request.requestId],
			})
		} finally {
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await pending.catch(() => {})
		}
	})

	it.each([
		{ label: "an active task loop", state: { isTaskLoopActive: true } },
		{ label: "an active turn engine", state: { isAgentTurnEngineActive: true } },
		{ label: "provider streaming", state: { isStreaming: true } },
		{ label: "a pending provider response", state: { isWaitingForFirstChunk: true } },
		{ label: "an aborted task", state: { abort: true } },
		{ label: "an abandoned task", state: { abandoned: true } },
		{ label: "a managed child", state: { taskKind: "subagent" } },
		{ label: "a completed restoration", state: { initialHistoryResumePending: false } },
		{ label: "a typed approval", state: { activeToolApprovalRequest: {} } },
		{ label: "a tool ask", state: { activeAsk: { type: "command", ts: 11 } } },
		{ label: "a completion review", state: { activeAsk: { type: "completion_result", ts: 11 } } },
		{ label: "an already-answered resume ask", state: { askResponse: "messageResponse" } },
	])("rejects a stale completed-task command during $label", async ({ state }) => {
		const { task, queue, provider, request } = restoredTaskFixture()
		Object.assign(task, state)
		await webviewMessageHandler(provider, request)
		expect(queue.messages).toHaveLength(0)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				requestId: request.requestId,
				taskId: task.taskId,
				chatCommandResult: expect.objectContaining({ status: "rejected" }),
			}),
		)
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith(expect.objectContaining({ type: "invoke" }))
	})

	it.each([TaskLifecycleState.Closed, TaskLifecycleState.Failed])(
		"preserves the host's %s session admission boundary",
		async (lifecycle) => {
			const { task, queue, provider, request, registry } = restoredTaskFixture()
			registry.markLifecycle(task.taskId, lifecycle)
			await webviewMessageHandler(provider, request)
			expect(queue.messages).toHaveLength(0)
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "rejected" }) }),
			)
		},
	)

	it.each(["active", "aborted", "replaced"] as const)(
		"rechecks the restored task when image resolution ends after it becomes %s",
		async (transition) => {
			const { task, queue, provider, request } = restoredTaskFixture()
			let releaseImages!: () => void
			let resolutionStarted!: () => void
			const resolving = new Promise<void>((resolve) => (resolutionStarted = resolve))
			vi.mocked(provider.getState).mockImplementationOnce(async () => {
				resolutionStarted()
				await new Promise<void>((resolve) => (releaseImages = resolve))
				return {} as Awaited<ReturnType<AlphaProvider["getState"]>>
			})
			// Attached images use provider limits; plain text bypasses this resolution boundary.
			const pending = webviewMessageHandler(provider, {
				...request,
				images: ["data:image/png;base64,attached"],
			})
			await Promise.race([
				resolving,
				pending.then(() => {
					throw new Error("The image-bearing follow-up did not reach the resolution boundary")
				}),
			])
			if (transition === "active") task.isStreaming = true
			else if (transition === "aborted") task.abort = true
			else vi.mocked(provider.getLiveTask).mockReturnValue(undefined)
			releaseImages()
			await pending
			expect(queue.messages).toHaveLength(0)
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "rejected" }) }),
			)
		},
	)
})
