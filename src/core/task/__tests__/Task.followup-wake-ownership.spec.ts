import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

function deferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((finish, fail) => {
		resolve = finish
		reject = fail
	})
	return { promise, resolve, reject }
}

function createIdleTask() {
	const queue = new MessageQueueService()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "followup-wake-owner",
		taskKind: "primary",
		isInitialized: true,
		_started: true,
		abort: false,
		abandoned: false,
		didComplete: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		alphaMessages: [],
		apiConversationHistory: [],
		messageQueueService: queue,
		providerRef: { deref: () => ({}) },
		resetMistakeRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
	}) as Task
	queue.on("stateChanged", () => {
		void task["wakeQueuedInputWhenIdle"]().catch(() => undefined)
	})
	return { task, queue }
}

afterEach(() => vi.restoreAllMocks())

it.each(["resolved", "rejected"] as const)(
	"starts already accepted follow-up input after the preceding lifecycle %s",
	async (settlement) => {
		const { task, queue } = createIdleTask()
		const ending = deferred()
		const resumed = vi.fn(
			async (
				_text: string,
				persisted?: () => void,
				_images?: string[],
				options?: { queuedMessageIds?: string[] },
			) => {
				queue.acknowledgeMessages(options?.queuedMessageIds ?? [])
				persisted?.()
			},
		)
		Object.assign(task, { resumeTaskFromHistory: resumed })
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		task["ownBackgroundLifecycle"]("resume", ending.promise)
		await task.submitUserMessage("Follow up on this task.", [], undefined, undefined, undefined, "next-input")
		expect(resumed).not.toHaveBeenCalled()
		expect(queue.messages.map((message) => message.id)).toEqual(["next-input"])
		if (settlement === "rejected") ending.reject(new Error("preceding lifecycle failed"))
		else ending.resolve()
		await ending.promise.catch(() => undefined)
		await task["queuedInputWakePromise"]?.catch(() => undefined)
		expect(resumed).toHaveBeenCalledOnce()
		expect(queue.hasUnconsumedInput()).toBe(false)
	},
)

it.each(["resolved", "rejected"] as const)(
	"leaves a replacement lifecycle in control when an older lifecycle %s",
	async (settlement) => {
		const { task, queue } = createIdleTask()
		const older = deferred()
		const current = deferred()
		const resume = vi.fn()
		Object.assign(task, { resumeTaskFromHistory: resume })
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		task["ownBackgroundLifecycle"]("resume", older.promise)
		task["ownBackgroundLifecycle"]("resume", current.promise)
		await task.submitUserMessage("Preserve the current owner.")
		const wake = vi.spyOn(
			task as unknown as { wakeQueuedInputWhenIdle(): Promise<void> },
			"wakeQueuedInputWhenIdle",
		)
		if (settlement === "rejected") older.reject(new Error("older lifecycle failed"))
		else older.resolve()
		await older.promise.catch(() => undefined)
		expect(wake).not.toHaveBeenCalled()
		expect(task["ownedLifecyclePromise"]).toBe(current.promise)
		expect(resume).not.toHaveBeenCalled()
		expect(queue.messages).toHaveLength(1)
		// Release the fixture without admitting its pending input.
		task.abort = true
		current.resolve()
		await current.promise
	},
)

it.each(["abort", "abandoned", "isAgentTurnEngineActive"] as const)(
	"retains queued input when %s blocks admission after a failed lifecycle",
	async (blockingFlag) => {
		const { task, queue } = createIdleTask()
		const ending = deferred()
		const resume = vi.fn()
		Object.assign(task, { resumeTaskFromHistory: resume })
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		task["ownBackgroundLifecycle"]("resume", ending.promise)
		await task.submitUserMessage("Keep this input available.")
		Object.assign(task, { [blockingFlag]: true })
		ending.reject(new Error("preceding lifecycle failed"))
		await ending.promise.catch(() => undefined)
		await task["queuedInputWakePromise"]?.catch(() => undefined)
		expect(resume).not.toHaveBeenCalled()
		expect(queue.messages).toHaveLength(1)
		expect(queue.getClaimedMessageIds()).toEqual([])
	},
)

it("preserves the original failure for joiners and does not repeatedly retry a failing queued consumer", async () => {
	const { task, queue } = createIdleTask()
	const ending = deferred()
	const originalFailure = new Error("preceding lifecycle failed")
	const resume = vi.fn(async () => {
		throw new Error("follow-up persistence failed")
	})
	Object.assign(task, { resumeTaskFromHistory: resume })
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	vi.spyOn(console, "warn").mockImplementation(() => undefined)
	const lifecycle = task["ownBackgroundLifecycle"]("resume", ending.promise)
	const joined = task.waitForTermination().catch((error: unknown) => error)
	await task.submitUserMessage("Keep the failed follow-up available.")
	ending.reject(originalFailure)
	await lifecycle.catch(() => undefined)
	await task["queuedInputWakePromise"]?.catch(() => undefined)
	expect(await joined).toBe(originalFailure)
	expect(resume).toHaveBeenCalledOnce()
	expect(task["ownedLifecyclePromise"]).toBeUndefined()
	expect(task["queuedInputWakePromise"]).toBeUndefined()
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages).toHaveLength(1)
})

it("does not create a continuation when a failed lifecycle has no pending input", async () => {
	const { task, queue } = createIdleTask()
	const ending = deferred()
	const resume = vi.fn()
	Object.assign(task, { resumeTaskFromHistory: resume })
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	task["ownBackgroundLifecycle"]("resume", ending.promise)
	ending.reject(new Error("preceding lifecycle failed"))
	await ending.promise.catch(() => undefined)
	expect(resume).not.toHaveBeenCalled()
	expect(task["queuedInputWakePromise"]).toBeUndefined()
	expect(queue.hasUnconsumedInput()).toBe(false)
})
