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
		enqueueAlphaMessagesSave: vi.fn(async (snapshot: () => AlphaMessage[], onPersisted?: () => void) => {
			snapshot()
			onPersisted?.()
			return true
		}),
		updateAlphaMessage: vi.fn(async () => undefined),
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

it("selects a completed-task follow-up for immediate delivery while the previous lifecycle drains", async () => {
	const { task, queue } = createTask()
	task.markCompleted()
	const guidance = queue.addMessage("The following question.")!
	const ending = deferred()
	Object.assign(task, { ownedLifecyclePromise: ending.promise })
	const resume = vi.fn(async (_text: string, persisted?: () => void | Promise<void>) => {
		expect(queue.getClaimedMessageIds()).toEqual([guidance.id])
		queue.acknowledgeMessages([guidance.id])
		await persisted?.()
	})
	Object.assign(task, { resumeTaskFromHistory: resume })
	const accepted = task.resumeCompletedTaskFollowup(guidance.text, [], "human", [guidance.id])
	try {
		expect(queue.getClaimedMessageIds()).toEqual([guidance.id])
		expect(queue.messages).toEqual([])
		expect(queue.visibleMessages).toEqual([{ ...guidance, deliveryState: "delivering" }])
		expect(resume).not.toHaveBeenCalled()
	} finally {
		ending.resolve()
		await accepted
	}
	expect(resume).toHaveBeenCalledOnce()
	expect(queue.hasUnconsumedInput()).toBe(false)
})

it("releases an immediate follow-up receipt when the previous terminal lifecycle cannot be joined", async () => {
	const { task, queue } = createTask()
	task.markCompleted()
	const guidance = queue.addMessage("Keep this question available.")!
	Object.assign(task, { ownedLifecyclePromise: Promise.reject(new Error("terminal journal failed")) })
	const resume = vi.fn()
	Object.assign(task, { resumeTaskFromHistory: resume })

	await expect(task.resumeCompletedTaskFollowup(guidance.text, [], "human", [guidance.id])).rejects.toThrow(
		"terminal journal failed",
	)

	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages).toEqual([guidance])
	expect(task.isCompleted()).toBe(true)
	expect(resume).not.toHaveBeenCalled()
})

it("keeps a follow-up recoverable when cancellation wins while the preceding terminal lifecycle drains", async () => {
	const { task, queue } = createTask()
	task.markCompleted()
	const guidance = queue.addMessage("Keep my cancelled follow-up available.")!
	const ending = deferred()
	Object.assign(task, { ownedLifecyclePromise: ending.promise })
	const resume = vi.fn(async (_text: string, persisted?: () => void) => persisted?.())
	Object.assign(task, { resumeTaskFromHistory: resume })
	const accepted = task.resumeCompletedTaskFollowup(guidance.text, [], "human", [guidance.id])
	task.abort = true
	ending.resolve()

	await expect(accepted).rejects.toThrow("cancelled")
	expect(resume).not.toHaveBeenCalled()
	expect(task.abort).toBe(true)
	expect(task.isCompleted()).toBe(true)
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages).toEqual([guidance])
})

it.each([undefined, false, true] as const)(
	"copies exact admission IDs into a canonical feedback row with partial=%s",
	async (partial) => {
		const { task } = createTask()
		const queuedMessageIds = ["follow-up-request"]
		await task.say("user_feedback", "The following question.", [], partial, undefined, undefined, {
			queuedMessageIds,
		})
		queuedMessageIds.push("another-request")

		expect(task.clineMessages).toHaveLength(1)
		expect(task.clineMessages[0]).toMatchObject({
			type: "say",
			say: "user_feedback",
			text: "The following question.",
			queuedMessageIds: ["follow-up-request"],
		})
	},
)

it("retains the exact admission identity when partial feedback is finalized", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "The following", [], true, undefined, undefined, {
		queuedMessageIds: ["follow-up-request"],
	})
	await task.say("user_feedback", "The following question.", [], false)

	expect(task.clineMessages).toHaveLength(1)
	expect(task.clineMessages[0]).toMatchObject({
		type: "say",
		say: "user_feedback",
		partial: false,
		text: "The following question.",
		queuedMessageIds: ["follow-up-request"],
	})
})

it("keeps already-consumed feedback immutable when its receipt is retried", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "Accepted question.", ["accepted.png"], undefined, undefined, undefined, {
		queuedMessageIds: ["accepted-request"],
	})
	const accepted = structuredClone(task.clineMessages[0])
	task.apiConversationHistory.push({
		role: "user",
		content: "Accepted question.",
		queued_message_ids: ["accepted-request"],
	})
	const resetProgress = vi.fn()
	const resetSearch = vi.fn()
	const resetCompletion = vi.spyOn(task, "resetCompletionRecoveryState")
	const evidence = vi.fn()
	Object.assign(task, {
		toolRepetitionDetector: { resetProgress },
		searchLoopRecoveryPolicy: { reset: resetSearch },
		completionRuntimeRevision: 7,
		workContext: { protected: true },
		enqueueCommandEvidence: evidence,
	})

	await task.say("user_feedback", "Stale edited question.", ["stale.png"], undefined, undefined, undefined, {
		queuedMessageIds: ["accepted-request"],
	})

	expect(task.clineMessages).toEqual([accepted])
	expect(task["updateAlphaMessage"]).not.toHaveBeenCalled()
	expect(task["enqueueAlphaMessagesSave"]).not.toHaveBeenCalled()
	expect(resetProgress).not.toHaveBeenCalled()
	expect(resetSearch).not.toHaveBeenCalled()
	expect(resetCompletion).not.toHaveBeenCalled()
	expect(evidence).not.toHaveBeenCalled()
	expect(task["completionRuntimeRevision"]).toBe(7)
})

it("keeps matching text with different admission IDs as distinct feedback", async () => {
	const { task } = createTask()
	for (const id of ["first-request", "second-request"]) {
		await task.say("user_feedback", "The same question.", [], undefined, undefined, undefined, {
			queuedMessageIds: [id],
		})
	}

	expect(task.clineMessages.map((message) => message.queuedMessageIds)).toEqual([
		["first-request"],
		["second-request"],
	])
})

it("does not merge an overlapping batch of admission IDs into earlier feedback", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "First batch.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["first-request", "second-request"],
	})
	await task.say("user_feedback", "Overlapping batch.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["second-request"],
	})

	expect(task.clineMessages.map((message) => message.text)).toEqual(["First batch.", "Overlapping batch."])
})

it("keeps automatic feedback separate from retried human admission", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "Pending question.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})
	const feedbackTs = task.clineMessages[0].ts
	await task.say("user_feedback", "Automatic retry guidance.", [], undefined, undefined, undefined, {
		feedbackSource: "automatic",
		queuedMessageIds: ["pending-request"],
	})
	await task.say("user_feedback", "Edited question.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})

	expect(task.clineMessages).toEqual([
		expect.objectContaining({ ts: feedbackTs, text: "Edited question.", queuedMessageIds: ["pending-request"] }),
		expect.objectContaining({ text: "Automatic retry guidance." }),
	])
	expect(task.clineMessages[1].queuedMessageIds).toBeUndefined()
})

it("matches receipt identity when unrelated transcript rows share its timestamp", async () => {
	const { task } = createTask()
	task.clineMessages = [
		{ ts: 1, type: "say", say: "text", text: "An unrelated row." },
		{ ts: 1, type: "say", say: "user_feedback", text: "Pending question.", queuedMessageIds: ["pending-request"] },
	]
	await task.say("user_feedback", "Edited question.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})

	expect(task.clineMessages.map((message) => message.text)).toEqual(["An unrelated row.", "Edited question."])
})

it("leaves an unconsumed feedback row unchanged when its retry update cannot be saved", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "Keep this pending question.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})
	const pending = structuredClone(task.clineMessages[0])
	vi.mocked(task["enqueueAlphaMessagesSave"]).mockResolvedValue(false)

	await expect(
		task.say("user_feedback", "Edited pending question.", [], undefined, undefined, undefined, {
			queuedMessageIds: ["pending-request"],
		}),
	).rejects.toThrow("Unable to persist the retried user feedback")
	expect(task.clineMessages).toEqual([pending])
	expect(task["updateAlphaMessage"]).not.toHaveBeenCalled()
})

it("preserves a pending partial feedback update instead of reusing an earlier complete row", async () => {
	const { task } = createTask()
	await task.say("user_feedback", "Earlier question.", [], undefined, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})
	await task.say("user_feedback", "Partial question.", [], true, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})
	await task.say("user_feedback", "Final partial question.", [], false, undefined, undefined, {
		queuedMessageIds: ["pending-request"],
	})

	expect(task.clineMessages.map((message) => message.text)).toEqual(["Earlier question.", "Final partial question."])
	expect(task.clineMessages[1].partial).toBe(false)
	expect(task["enqueueAlphaMessagesSave"]).not.toHaveBeenCalled()
})

it("starts one idle queued follow-up and carries its selected receipt to the history consumer", async () => {
	const { task, queue } = createTask()
	Object.assign(task, { isInitialized: true, _started: true })
	const admission = deferred()
	const release = deferred()
	const resume = vi.fn(
		async (
			_text: string,
			persisted?: () => void,
			_images?: string[],
			options?: { queuedMessageIds?: string[] },
		) => {
			admission.resolve()
			await release.promise
			persisted?.()
			queue.acknowledgeMessages(options?.queuedMessageIds ?? [])
		},
	)
	Object.assign(task, { resumeTaskFromHistory: resume })
	const accepted = task.submitUserMessage("Follow up after the previous loop returned.")
	await admission.promise
	const selected = queue.getClaimedMessageIds()
	expect(selected).toHaveLength(1)
	expect(resume).toHaveBeenCalledWith(
		"Follow up after the previous loop returned.",
		expect.any(Function),
		[],
		expect.objectContaining({ queuedMessageIds: selected, inputOrigin: "human", reuseRetainedHistory: true }),
	)
	const secondWake = task["wakeQueuedInputWhenIdle"]()
	release.resolve()
	await Promise.all([accepted, secondWake])
	expect(resume).toHaveBeenCalledOnce()
	expect(queue.hasUnconsumedInput()).toBe(false)
})

it("keeps idle admission recoverable when selection persistence fails", async () => {
	const { task, queue } = createTask()
	Object.assign(task, { isInitialized: true, _started: true })
	const resume = vi.fn()
	Object.assign(task, { resumeTaskFromHistory: resume })
	const flush = queue.flush.bind(queue)
	vi.spyOn(queue, "flush").mockImplementation(async () => {
		if (queue.getClaimedMessageIds().length) throw new Error("selection write failed")
		await flush()
	})
	await expect(task.submitUserMessage("Keep this accepted guidance.")).resolves.toBeUndefined()
	expect(resume).not.toHaveBeenCalled()
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages.map((entry) => entry.text)).toEqual(["Keep this accepted guidance."])
})

it("retains accepted completed-task input in FIFO when retained preparation and its wake cannot proceed", async () => {
	const { task, queue } = createTask()
	Object.assign(task, { isInitialized: true, _started: true })
	task.markCompleted()
	const prepare = vi.fn(async () => {
		throw new Error("retained preparation failed")
	})
	const resume = vi.fn()
	Object.assign(task, { prepareForRetainedLifecycle: prepare, resumeTaskFromHistory: resume })
	// Use the production wake ownership rule: a failed wake's release event
	// cannot recursively restart that same owner indefinitely.
	queue.on("stateChanged", () => {
		void task["wakeQueuedInputWhenIdle"]().catch(() => undefined)
	})

	await expect(
		task.submitUserMessage(
			"Keep this accepted follow-up available.",
			[],
			undefined,
			undefined,
			undefined,
			"request-1",
		),
	).resolves.toBeUndefined()
	await task["queuedInputWakePromise"]?.catch(() => undefined)

	expect(prepare).toHaveBeenCalled()
	expect(resume).not.toHaveBeenCalled()
	expect(task.isCompleted()).toBe(true)
	expect(task["queuedInputWakePromise"]).toBeUndefined()
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.messages).toEqual([
		expect.objectContaining({ id: "request-1", text: "Keep this accepted follow-up available." }),
	])
	expect(task.apiConversationHistory.some((message) => message.queued_message_ids?.includes("request-1"))).toBe(false)
	expect(task.clineMessages.some((message) => message.queuedMessageIds?.includes("request-1"))).toBe(false)
})

it("does not clear a newer lifecycle owner when an older lifecycle settles", async () => {
	const { task } = createTask()
	const old = deferred()
	const current = deferred()
	task["ownBackgroundLifecycle"]("resume", old.promise)
	task["ownBackgroundLifecycle"]("resume", current.promise)
	old.resolve()
	await old.promise
	expect(task["ownedLifecyclePromise"]).toBe(current.promise)
	current.resolve()
	await current.promise
	expect(task["ownedLifecyclePromise"]).toBeUndefined()
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

it("completes ordinary text through the real turn engine without waiting for acknowledgement", async () => {
	const task = createCompletionTask()
	await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
	expect(task.isCompleted()).toBe(true)
	expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
	expect(task.ask).not.toHaveBeenCalled()
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
		expect(await outcome).toBeUndefined()
		expect(task[operation]).toHaveBeenCalledOnce()
		expect(task.ask).toHaveBeenCalledWith("resume_task")
		expect(task.isCompleted()).toBe(false)
	},
)
