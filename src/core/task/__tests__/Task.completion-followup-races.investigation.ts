import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { AlphaMessage } from "@alpha-code/types"
import { createAgentResponse } from "../../agent/AgentResponse"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => {
		resolve = finish
	})
	return { promise, resolve }
}

function createTask(onScreen = true) {
	const queue = new MessageQueueService()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "completion-race-task",
		instanceId: "completion-race-instance",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		clineMessages: [],
		apiConversationHistory: [],
		messageQueueService: queue,
		providerRef: {
			deref: () => ({ getState: async () => ({}), isTaskOnScreen: () => onScreen }),
		},
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => {
			task.clineMessages.push(message)
		}),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		checkpointSave: vi.fn(async () => undefined),
		resetMistakeRecoveryState: vi.fn(),
		emit: vi.fn(),
	}) as Task
	return { task, queue }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

it("keeps late guidance available when a completion response already owns the ask slot", async () => {
	vi.useFakeTimers()
	const { task, queue } = createTask()
	const opened = deferred()
	let activeAsk: Task["activeAsk"]
	Object.defineProperty(task, "activeAsk", {
		get: () => activeAsk,
		set: (value: Task["activeAsk"]) => {
			activeAsk = value
			if (value) opened.resolve()
		},
	})
	const pending = task.ask("completion_result", "", false)
	await opened.promise
	expect(task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, activeAsk!.ts)).toBe(true)
	const guidance = queue.addMessage("Include the missing cancellation case.")!
	await vi.advanceTimersByTimeAsync(100)
	const response = await pending
	expect(response.response).toBe("yesButtonClicked")
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages).toEqual([guidance])
})

it("does not orphan queued guidance when off-screen completion auto-accepts its ask", async () => {
	const { task, queue } = createTask(false)
	const guidance = queue.addMessage("A queued follow-up still needs a model request.")!
	const response = await task.ask("completion_result", "", false)
	// Every selected entry must belong to the result that will persist it. An
	// auto-accepted slot may instead leave guidance pending for the next consumer.
	expect(queue.getClaimedMessageIds()).toEqual(response.queuedMessageIds ?? [])
	expect(queue.messages.map((message) => message.id).concat(response.queuedMessageIds ?? [])).toContain(guidance.id)
})

it("starts a same-task follow-up if completion wins before durable input is staged", async () => {
	const { task, queue } = createTask()
	const enteringAdmission = deferred()
	const releaseAdmission = deferred()
	const add = queue.addMessageDurably.bind(queue)
	vi.spyOn(queue, "addMessageDurably").mockImplementation(async (...args) => {
		enteringAdmission.resolve()
		await releaseAdmission.promise
		return add(...args)
	})
	const resume = vi.spyOn(task, "resumeCompletedTaskFollowup").mockResolvedValue(undefined)
	const accepted = task.submitUserMessage("Do the next task in this conversation.")
	await enteringAdmission.promise
	task.markCompleted()
	releaseAdmission.resolve()
	await accepted
	expect(resume).toHaveBeenCalledOnce()
})

it("allows a completed follow-up to retry after its first durable write fails", async () => {
	const { task } = createTask()
	task.markCompleted()
	const resume = vi.fn(async (_text: string, persisted?: () => void | Promise<void>) => persisted?.())
	resume.mockRejectedValueOnce(new Error("first continuation write failed"))
	Object.assign(task, { resumeTaskFromHistory: resume })
	await expect(task.resumeCompletedTaskFollowup("Keep my continuation draft.")).rejects.toThrow(
		"first continuation write failed",
	)
	expect(task.isCompleted()).toBe(true)
	await expect(task.resumeCompletedTaskFollowup("Keep my continuation draft.")).resolves.toBeUndefined()
	expect(resume).toHaveBeenCalledTimes(2)
})

it("joins a successful preceding terminal lifecycle before resuming the same task", async () => {
	const { task } = createTask()
	task.markCompleted()
	const ending = deferred()
	Object.assign(task, { ownedLifecyclePromise: ending.promise })
	const resume = vi.fn(async (_text: string, persisted?: () => void | Promise<void>) => persisted?.())
	Object.assign(task, { resumeTaskFromHistory: resume })
	const accepted = task.resumeCompletedTaskFollowup("The following question.")
	await Promise.resolve()
	expect(resume).not.toHaveBeenCalled()
	ending.resolve()
	await accepted
	expect(resume).toHaveBeenCalledOnce()
})

function createCompletionTask() {
	const { task } = createTask()
	Object.assign(task, {
		taskCancellationController: new AbortController(),
		userMessageContent: [],
		enableCheckpoints: false,
		runAgentRequests: vi.fn(async () => ({
			status: "completed",
			response: createAgentResponse([{ type: "text", text: "The requested work is done." }]),
		})),
		beginCanonicalLifecycleTurn: vi.fn(async () => undefined),
		getCanonicalLifecycleSnapshot: vi.fn(() => undefined),
		publishCanonicalLifecycleStepStatus: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		finishCanonicalLifecycleTurn: vi.fn(async () => undefined),
		flushAgentTurnEvents: vi.fn(async () => undefined),
		maybeCompactAfterTurn: vi.fn(async () => undefined),
		recordCompletionCandidate: vi.fn(),
		waitForCompletionGateDecision: vi.fn(async () => ({ allowed: true })),
		evaluateCompletionHooks: vi.fn(async () => ({})),
		presentCompletionResult: vi.fn(async () => undefined),
		finalizeTaskCompletion: vi.fn(async () => {
			task.markCompleted()
			return true
		}),
		say: vi.fn(async () => undefined),
		ask: vi.fn(async (type: string) => {
			if (type === "resume_task") task.abort = true
			return { response: "yesButtonClicked" }
		}),
	})
	return task
}

it("completes the unfailed ordinary-text control through the real turn engine", async () => {
	const task = createCompletionTask()
	await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
	expect(task.isCompleted()).toBe(true)
	expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
})

it.each(["finishCanonicalLifecycleTurn", "presentCompletionResult", "finalizeTaskCompletion"] as const)(
	"offers a visible recovery boundary when late %s fails",
	async (operation) => {
		const task = createCompletionTask()
		const failure = new Error(`late ${operation} write failed`)
		vi.mocked(task[operation]).mockRejectedValueOnce(failure)
		const outcome = task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }]).catch(
			(error: unknown) => error,
		)
		expect(await outcome).toBe(failure)
		expect(task[operation]).toHaveBeenCalledOnce()
		expect(task.ask).toHaveBeenCalledWith("resume_task")
		expect(task.isCompleted()).toBe(false)
	},
)
