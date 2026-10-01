import type { AlphaAsk, AlphaMessage } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function correlatedFixture(save: () => Promise<void>) {
	const queue = new MessageQueueService({ load: async () => [], save })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "correlated-published-ask",
		workspacePath: process.cwd(),
		taskKind: "primary",
		abort: false,
		isInitialized: false,
		_started: false,
		clineMessages: [],
		apiConversationHistory: [],
		activeAsk: { type: "followup", ts: 10 },
		messageQueueService: queue,
		cancelAutoApprovalTimeout: vi.fn(),
		resetMistakeRecoveryState: vi.fn(),
		checkpointSave: vi.fn(async () => undefined),
	}) as Task
	const provider = {
		getLiveTask: vi.fn(() => task),
		canAcceptTaskInput: vi.fn(() => true),
		getState: vi.fn(async () => ({})),
		postMessageToWebview: vi.fn(async () => {}),
		log: vi.fn(),
	} as unknown as AlphaProvider
	Object.assign(task, { providerRef: { deref: () => provider } })
	const message = {
		type: "askResponse" as const,
		taskId: task.taskId,
		askMessageTs: 10,
		askResponse: "messageResponse" as const,
		text: "Use this answer",
		requestId: "ask-receipt",
	}
	return { task, queue, provider, message }
}

describe("published ask response admission", () => {
	afterEach(() => vi.useRealTimers())

	it.each<AlphaAsk>(["followup", "completion_result", "resume_task", "resume_completed_task"])(
		"accepts a reply to %s before delayed attention status is populated",
		async (askType) => {
			vi.useFakeTimers()
			const task = Object.assign(Object.create(Task.prototype), {
				taskId: "published-ask-task",
				instanceId: "published-ask-instance",
				taskKind: "primary",
				workspacePath: "F:/roo-fork/Alpha-Code",
				abort: false,
				clineMessages: [] as AlphaMessage[],
				messageQueueService: new MessageQueueService(),
				providerRef: { deref: () => undefined },
				addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.clineMessages.push(message)),
				saveAlphaMessages: vi.fn(async () => undefined),
				updateAlphaMessage: vi.fn(async () => undefined),
				cancelAutoApprovalTimeout: vi.fn(),
				checkpointSave: vi.fn(async () => undefined),
				emit: vi.fn(),
			}) as Task
			const provider = {
				getLiveTask: vi.fn(() => task),
				canAcceptTaskInput: vi.fn(() => true),
				getState: vi.fn(async () => ({})),
				log: vi.fn(),
			} as unknown as AlphaProvider
			const pending = task.ask(askType, "Ready for a reply", false)
			void pending.catch(() => undefined)
			try {
				await vi.waitFor(() => expect(task["activeAsk"]?.type).toBe(askType))
				const publishedAsk = task.clineMessages.at(-1)!
				expect(task.taskAsk).toBeUndefined()
				await webviewMessageHandler(provider, {
					type: "askResponse",
					taskId: task.taskId,
					askMessageTs: publishedAsk.ts,
					askResponse: "messageResponse",
					text: "Continue with this answer",
					images: [],
				})
				expect(task["askResponseText"]).toBe("Continue with this answer")
				await vi.advanceTimersByTimeAsync(100)
				await expect(pending).resolves.toMatchObject({
					response: "messageResponse",
					text: "Continue with this answer",
				})
			} finally {
				task.abort = true
				await vi.advanceTimersByTimeAsync(100)
				await pending.catch(() => undefined)
			}
		},
	)

	it("acknowledges a correlated ask reply only after durable admission and deduplicates retry", async () => {
		const started = deferred()
		const saved = deferred()
		const { task, queue, provider, message } = correlatedFixture(async () => {
			started.resolve()
			await saved.promise
		})
		const handling = webviewMessageHandler(provider, message)
		await Promise.race([
			started.promise,
			handling.then(() => {
				throw new Error("Handler settled before durable admission")
			}),
		])
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(task["askResponse"]).toBeUndefined()
		saved.resolve()
		await handling
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					requestId: "ask-receipt",
					command: "askResponse",
					status: "accepted",
				}),
			}),
		)
		expect(task["askResponseText"]).toBe("Use this answer")
		await webviewMessageHandler(provider, message)
		expect(queue.getClaimedMessageIds()).toEqual(["ask-receipt"])
	})

	it("rejects a correlated ask reply when durable admission fails and preserves the ask slot", async () => {
		const { task, queue, provider, message } = correlatedFixture(async () => {
			throw new Error("queue write failed")
		})
		await webviewMessageHandler(provider, message)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "askResponse", status: "rejected" }),
			}),
		)
		expect(task["askResponse"]).toBeUndefined()
		expect(queue.getMessage("ask-receipt")).toBeUndefined()
	})

	it("durably admits an untargeted correlated reply during the turn-to-ask gap", async () => {
		const { task, queue, provider, message } = correlatedFixture(async () => {})
		Reflect.set(task, "activeAsk", undefined)
		await webviewMessageHandler(provider, { ...message, askMessageTs: undefined })
		expect(queue.messages.map((entry) => entry.id)).toEqual(["ask-receipt"])
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "askResponse", status: "accepted" }),
			}),
		)
	})

	it("keeps durable acceptance when async-card annotation fails", async () => {
		const { task, provider, message } = correlatedFixture(async () => {})
		vi.spyOn(task, "markAsyncUserInputAnswered").mockRejectedValueOnce(new Error("annotation write failed"))
		await webviewMessageHandler(provider, { ...message, asyncUserInputMessageTs: 20 })
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "askResponse", status: "accepted" }),
			}),
		)
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ status: "rejected" }),
			}),
		)
	})

	it("uses a durable stable receipt for completed-task follow-up retries", async () => {
		const { task, provider, message } = correlatedFixture(async () => {})
		task.markCompleted()
		const resume = vi.spyOn(task, "resumeCompletedTaskFollowup").mockResolvedValue(undefined)
		const followup = { ...message, type: "resumeCompletedTask" as const }
		await webviewMessageHandler(provider, followup)
		await webviewMessageHandler(provider, followup)
		expect(resume).toHaveBeenCalledOnce()
		expect(resume).toHaveBeenCalledWith("Use this answer", [], "human", ["ask-receipt"])
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ command: "resumeCompletedTask", status: "accepted" }),
			}),
		)
	})
})
