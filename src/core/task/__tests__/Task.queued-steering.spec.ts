import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../Task"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function harness() {
	const queue = new MessageQueueService()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "queued-steering-task",
		instanceId: "queued-steering-instance",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		isInitialized: true,
		isTaskLoopActive: true,
		clineMessages: [],
		apiConversationHistory: [],
		messageQueueService: queue,
		providerRef: { deref: () => ({ getState: async () => ({}), isTaskOnScreen: () => true }) },
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		addToAlphaMessages: vi.fn(async () => undefined),
		saveAlphaMessages: vi.fn(async () => undefined),
		updateAlphaMessage: vi.fn(async () => undefined),
		checkpointSave: vi.fn(async () => undefined),
		emit: vi.fn(),
	}) as Task
	return { task, queue }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

it("retains queued input when steering is unavailable at a command approval", async () => {
	const { task, queue } = harness()
	task["activeAsk"] = { type: "command", ts: 100 }
	const message = queue.addMessage("INPUT_WHILE_APPROVAL_PENDING")!
	await expect(task.steerQueuedUserMessage(message.id)).rejects.toThrow("cannot accept a steering message")
	expect(queue.messages).toEqual([message])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(task["askResponse"]).toBeUndefined()
})

it.each(["command", "tool", "followup"] as const)(
	"does not inject queued steering into a %s ask opened while its claim persists",
	async (type) => {
		const { task, queue } = harness()
		task["activeAsk"] = { type: "command_output", ts: 100 }
		const message = queue.addMessage("QUEUED_BEFORE_ASK_REPLACEMENT")!
		const entered = deferred()
		const persistence = deferred()
		vi.spyOn(queue, "flush").mockImplementationOnce(async () => {
			entered.resolve()
			await persistence.promise
		})
		const steering = task.steerQueuedUserMessage(message.id)
		const rejected = expect(steering).rejects.toThrow("cannot accept a steering message")
		await entered.promise
		task["activeAsk"] = { type, ts: 101 }
		persistence.resolve()
		await rejected
		expect(queue.messages).toMatchObject([{ id: message.id, text: message.text }])
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(task["askResponse"]).toBeUndefined()
	},
)

it("retains newly admitted steering as queued input when its later handoff fails", async () => {
	const { task, queue } = harness()
	vi.spyOn(task, "steerUserMessage").mockRejectedValueOnce(new Error("handoff became unavailable"))
	await expect(task.steerUserMessageDurably("DURABLE_INPUT", ["image.png"], "steer-receipt")).rejects.toThrow(
		"handoff became unavailable",
	)
	expect(queue.messages).toMatchObject([{ id: "steer-receipt", text: "DURABLE_INPUT", images: ["image.png"] }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(await task.hasAcceptedQueuedUserMessage("steer-receipt")).toBe(true)
})

it("does not interrupt generation before the human input's durable admission", async () => {
	const { task } = harness()
	const saving = deferred()
	const saved = deferred()
	const queue = new MessageQueueService({
		load: async () => [],
		save: async () => {
			saving.resolve()
			await saved.promise
		},
	})
	Object.assign(task, { messageQueueService: queue })
	const request = new AbortController()
	task.currentRequestAbortController = request
	Object.assign(task, {
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
	})
	const steering = task.steerUserMessageDurably("DURABLE_BEFORE_INTERRUPT", [], "durable-steer")
	await saving.promise
	expect(request.signal.aborted).toBe(false)
	saved.resolve()
	await steering
	expect(request.signal.aborted).toBe(true)
	expect(task.abort).toBe(false)
	expect(task["pendingSteerMessage"]).toMatchObject({ queuedMessageIds: ["durable-steer"] })
	expect(queue.visibleMessages).toMatchObject([{ id: "durable-steer", deliveryState: "delivering" }])
})

it("durably queues rapid additional steering without replacing input awaiting its transcript receipt", async () => {
	const { task, queue } = harness()
	task["pendingSteerMessage"] = { text: "FIRST_INPUT", images: [], queuedMessageIds: ["first-steer"] }
	task["steerMessageAwaitingPersistence"] = true
	const handoff = vi.spyOn(task, "steerUserMessage")
	await task.steerUserMessageDurably("SECOND_INPUT", [], "second-steer")
	await task.steerUserMessageDurably("SECOND_INPUT", [], "second-steer")
	expect(handoff).not.toHaveBeenCalled()
	expect(queue.messages).toMatchObject([{ id: "second-steer", text: "SECOND_INPUT" }])
	expect(queue.messages).toHaveLength(1)
	expect(task["pendingSteerMessage"]).toMatchObject({ text: "FIRST_INPUT", queuedMessageIds: ["first-steer"] })
})

it.each(["abort", "abandoned", "didComplete"] as const)(
	"rejects new steering when %s wins with an older input still pending",
	async (state) => {
		const { task, queue } = harness()
		task["steerMessageAwaitingPersistence"] = true
		task[state] = true
		await expect(task.steerUserMessageDurably("AFTER_STOP", [], "stopped-steer")).rejects.toThrow("cannot accept")
		expect(queue.visibleMessages).toEqual([])
	},
)

it("returns accepted steering input to the queue if a command timeout supersedes its ask", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(1_000)
	const { task, queue } = harness()
	const publishing = deferred()
	const publication = deferred()
	vi.mocked(task["addToAlphaMessages"]).mockImplementationOnce(async () => {
		publishing.resolve()
		await publication.promise
	})
	const pending = task.withToolInputContext("command-call", () => task.ask("command_output", "Running", false))
	const rejected = expect(pending).rejects.toThrow("superseded")
	void rejected.catch(() => undefined)
	await publishing.promise
	expect(task["activeAsk"]?.type).toBe("command_output")
	const message = queue.addMessage("STEER_BEFORE_COMMAND_TIMEOUT")!
	await task.steerQueuedUserMessage(message.id)
	vi.setSystemTime(1_001)
	task.supersedePendingAsk()
	publication.resolve()
	await vi.advanceTimersByTimeAsync(100)
	await rejected
	expect(queue.messages).toEqual([message])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(task["queuedToolResultReceipts"]?.size ?? 0).toBe(0)
	expect(task["askResponse"]).toBeUndefined()
})

it("returns an old ask's selected input when a replacement ask resets the response slot", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(1_000)
	const { task, queue } = harness()
	const publishing = deferred()
	const publication = deferred()
	vi.mocked(task["addToAlphaMessages"]).mockImplementationOnce(async () => {
		publishing.resolve()
		await publication.promise
	})
	const first = task.ask("followup", "First question", false)
	const rejected = expect(first).rejects.toThrow("superseded")
	void rejected.catch(() => undefined)
	await publishing.promise
	await task.submitUserMessage("FIRST_ASK_INPUT", [], undefined, undefined, undefined, "first-ask-input")
	const message = queue.visibleMessages[0]
	const replacement = task.ask("followup", "Replacement question", false)
	try {
		await vi.advanceTimersByTimeAsync(0)
		publication.resolve()
		await vi.advanceTimersByTimeAsync(100)
		await rejected
		expect(queue.messages).toMatchObject([{ id: message.id, text: message.text }])
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(task["askResponse"]).toBeUndefined()
	} finally {
		task.handleWebviewAskResponse("noButtonClicked")
		await vi.advanceTimersByTimeAsync(100)
		await replacement
	}
})

it("releases an accepted ask's queued input when cancellation wins before the reply is consumed", async () => {
	vi.useFakeTimers()
	const { task, queue } = harness()
	const publishing = deferred()
	const publication = deferred()
	vi.mocked(task["addToAlphaMessages"]).mockImplementationOnce(async () => {
		publishing.resolve()
		await publication.promise
	})
	const pending = task.ask("followup", "Question", false)
	const rejected = expect(pending).rejects.toThrow("aborted")
	await publishing.promise
	await task.submitUserMessage("INPUT_BEFORE_CANCELLATION", [], undefined, undefined, undefined, "cancel-input")
	task.abort = true
	publication.resolve()
	await vi.advanceTimersByTimeAsync(100)
	await rejected
	expect(queue.messages).toMatchObject([{ id: "cancel-input", text: "INPUT_BEFORE_CANCELLATION" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(task["askResponse"]).toBeUndefined()
})

it("supersedes a pending ask even within the same clock millisecond", () => {
	vi.useFakeTimers()
	vi.setSystemTime(1_000)
	const { task } = harness()
	task.lastMessageTs = 1_000
	task.supersedePendingAsk()
	expect(task.lastMessageTs).toBeGreaterThan(1_000)
})

it("keeps selected input visible until its transcript receipt is acknowledged", () => {
	const { task, queue } = harness()
	const message = queue.addMessage("SELECTED_INPUT")!
	queue.claimMessage(message.id)
	expect(queue.messages).toEqual([])
	expect(task.queuedMessages).toMatchObject([{ id: message.id, deliveryState: "delivering" }])
	queue.acknowledgeMessages([message.id])
	expect(task.queuedMessages).toEqual([])
})

it.each(["accepted", "deferred"] as const)("does not offer steering while an ask response is %s", (state) => {
	const { task } = harness()
	if (state === "accepted") task["askResponse"] = "messageResponse"
	else task["deferredAskResponse"] = { kind: "legacy", askResponse: "messageResponse", text: "INPUT" }
	expect(task.canAcceptSteerMessage()).toBe(false)
})
