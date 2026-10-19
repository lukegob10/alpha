import { Task } from "../Task"
import { AlphaCodeEventName } from "@alpha-code/types"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { createAgentResponse } from "../../agent/AgentResponse"
import { GoalController } from "../../agent/goals/GoalController"
import { GoalAccountingBindingStore } from "../../agent/goals/GoalAccountingBindingStore"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"

vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureTaskCompleted: vi.fn() } } }))

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

class MemoryStore implements GoalStateStore {
	state: TaskGoalEnvelope = { schemaVersion: 1, taskId: "root", usageReceipts: [] }
	beforeTransaction?: () => Promise<void>
	async read() {
		return structuredClone(this.state)
	}
	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const before = this.beforeTransaction
		this.beforeTransaction = undefined
		await before?.()
		const working = structuredClone(this.state)
		const result = operation(working)
		this.state = working
		return structuredClone(result)
	}
}

function fixture(store = new MemoryStore()) {
	const queue = new MessageQueueService()
	let id = 0
	const controller = new GoalController({ taskId: "root", store, newId: () => `goal-${++id}` })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "root",
		instanceId: "root-instance",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		isPaused: false,
		clineMessages: [],
		// These fixtures own their in-memory transcript storage; rewind I/O has dedicated coverage.
		recoverConversationRewind: vi.fn(async () => undefined),
		apiConversationHistory: [],
		userMessageContent: [],
		messageQueueService: queue,
		goalController: controller,
		goalSteeringGeneration: 0,
		taskCancellationController: new AbortController(),
		taskModeReady: Promise.resolve(),
		_taskMode: "code",
		providerRef: { deref: () => ({ getState: async () => ({}), isTaskOnScreen: () => true }) },
		enableCheckpoints: false,
		runAgentRequests: vi.fn(async () => ({
			status: "completed",
			response: createAgentResponse([{ type: "text", text: "Progress." }]),
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
		ask: vi.fn(async () => {
			task.abort = true
			return { response: "yesButtonClicked" }
		}),
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		saveAlphaMessages: vi.fn(async () => true),
		saveApiConversationHistory: vi.fn(async () => true),
		checkpointSave: vi.fn(async () => undefined),
		emit: vi.fn(),
		prepareForRetainedLifecycle: vi.fn(async () => undefined),
		hasPendingAgentMessages: vi.fn(() => false),
		flushPendingToolResultsToHistory: vi.fn(async () => true),
	}) as Task
	return { task, controller, store, queue }
}

afterEach(() => vi.restoreAllMocks())

describe("Task goal controls at the existing completion gate", () => {
	function completingTask() {
		const base = fixture()
		const provider = {
			prepareTaskCompletionLifecycle: vi.fn(async () => undefined),
			rollbackTaskCompletionLifecycle: vi.fn(async () => undefined),
		}
		const metrics = {}
		const emit = vi.fn<(event: string, ...args: unknown[]) => boolean>(() => true)
		Object.assign(base.task, {
			providerRef: { deref: () => provider },
			finalizeTaskCompletion: Task.prototype.finalizeTaskCompletion,
			getCompletionGateDecision: vi.fn(async () => ({ allowed: true })),
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			getMutableCompletionStageMetrics: () => metrics,
			getTokenUsage: vi.fn(() => ({ totalTokensIn: 0, totalTokensOut: 0 })),
			emitFinalTokenUsageUpdate: vi.fn(),
			retractCompletionResult: vi.fn(async () => undefined),
			wakeGoalFromHost: vi.fn(async () => undefined),
			emit,
		})
		return { ...base, provider, emit }
	}

	it("reserves concurrent completion exactly once after an awaited goal read", async () => {
		const { task, provider } = completingTask()
		const release = barrier()
		vi.spyOn(task, "getGoal").mockImplementation(async () => {
			await release.promise
			return undefined
		})
		const first = task.finalizeTaskCompletion()
		const second = task.finalizeTaskCompletion()
		expect(task.getGoal).toHaveBeenCalledTimes(2)
		release.resolve()
		expect(await Promise.all([first, second])).toEqual([true, false])
		expect(provider.prepareTaskCompletionLifecycle).toHaveBeenCalledOnce()
		expect(task.emit).toHaveBeenCalledOnce()
	})

	it.each(["create", "resume"] as const)(
		"lets a human goal %s win the final completion verification await",
		async (action) => {
			const { task, controller, provider } = completingTask()
			if (action === "resume") {
				await controller.create({ objective: "Finish." }, "user")
				await controller.pause()
			}
			const entered = barrier(),
				release = barrier()
			vi.mocked(task.getCompletionGateDecision).mockImplementation(async () => {
				entered.resolve()
				await release.promise
				return { allowed: true, modelCanResolveRejection: true }
			})
			const completing = task.finalizeTaskCompletion()
			await entered.promise
			if (action === "create")
				await task.createGoal({ objective: "New goal." }, { source: "user", approved: true })
			else await task.resumeGoal()
			release.resolve()
			expect(await completing).toBe(false)
			expect(task.isCompleted()).toBe(false)
			expect(task["didEmitTaskCompleted"]).toBe(false)
			expect(task.emit).not.toHaveBeenCalled()
			expect(provider.rollbackTaskCompletionLifecycle).toHaveBeenCalledOnce()
			expect(await controller.get()).toMatchObject({ status: "active" })
		},
	)

	it("enters a new explicit goal in the same loop after it supersedes final completion", async () => {
		const { task, controller, emit } = completingTask()
		const entered = barrier(),
			release = barrier()
		vi.mocked(task.getCompletionGateDecision).mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return { allowed: true, modelCanResolveRejection: true }
		})
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			if (vi.mocked(task.runAgentRequests).mock.calls.length === 2)
				await task.updateGoalStatus("complete", { source: "tool" })
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done." }]) }
		})
		const run = task["initiateTaskLoop"]([{ type: "text", text: "Original request." }])
		await entered.promise
		await task.createGoal({ objective: "New goal." }, { source: "user", approved: true })
		release.resolve()
		await run
		expect(task.runAgentRequests).toHaveBeenCalledTimes(2)
		expect(task.runAgentRequests).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("New goal.") })]),
			false,
			undefined,
			expect.objectContaining({ inputOrigin: "agent" }),
		)
		expect(emit.mock.calls.filter(([event]) => event === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(task.ask).not.toHaveBeenCalled()
		expect(await controller.get()).toMatchObject({ status: "complete", continuationCount: 0 })
	})

	it.each(["legacy", "canonical"] as const)(
		"continues %s goal completion progress and publishes TaskCompleted only after the goal completes",
		async (resultKind) => {
			const { task, controller, emit, queue } = completingTask()
			await controller.create({ objective: "Finish the objective." }, "user")
			const completeGoalTurn = vi.spyOn(task, "completeGoalTurn")
			vi.mocked(task.runAgentRequests)
				.mockImplementationOnce(async () => {
					expect(await task.completeGoalTurn("The first part is done.")).toBe(true)
					const progress = createAgentResponse([{ type: "text", text: "The first part is done." }])
					Object.assign(task, { currentAgentResponse: progress })
					return resultKind === "legacy" ? true : { status: "completed", response: progress }
				})
				.mockImplementationOnce(async () => {
					await task.updateGoalStatus("complete", { source: "tool" })
					return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done." }]) }
				})
			try {
				await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
				expect(completeGoalTurn).toHaveBeenCalledOnce()
				expect(task.runAgentRequests).toHaveBeenCalledTimes(2)
				expect(task.runAgentRequests).toHaveBeenNthCalledWith(
					2,
					expect.arrayContaining([
						expect.objectContaining({ text: expect.stringContaining("Finish the objective.") }),
					]),
					false,
					undefined,
					expect.objectContaining({ inputOrigin: "agent" }),
				)
				expect(emit.mock.calls.filter(([event]) => event === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
				expect(task.ask).not.toHaveBeenCalled()
				expect(await controller.get()).toMatchObject({ status: "complete", continuationCount: 1 })
			} finally {
				queue.dispose()
			}
		},
	)
})

describe("Task idle continuation completion authority", () => {
	function holdIdleReservation(controller: GoalController, store: MemoryStore) {
		const entered = barrier(),
			release = barrier()
		const reserve = controller.reserveContinuation.bind(controller)
		vi.spyOn(controller, "reserveContinuation").mockImplementationOnce((boundary) => {
			store.beforeTransaction = async () => {
				entered.resolve()
				await release.promise
			}
			return reserve(boundary)
		})
		return { entered, release }
	}

	it.each(["absent", "active", "late"] as const)(
		"preserves queued guidance after authoritative host completion with a %s goal",
		async (goalState) => {
			const { task, controller, queue } = fixture()
			if (goalState === "active") await controller.create({ objective: "Finish." }, "user")
			const queued = queue.addMessage("Save this guidance for a later turn.")
			const reserve = vi.spyOn(controller, "reserveContinuation")
			vi.mocked(task.runAgentRequests)
				.mockImplementationOnce(async () => {
					if (goalState === "late")
						await task.createGoal({ objective: "Finish." }, { source: "user", approved: true })
					Object.assign(task, {
						currentAgentResponse: createAgentResponse([{ type: "text", text: "Host completion." }]),
					})
					return true
				})
				.mockResolvedValue({ status: "aborted" })
			try {
				await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
				expect(task.runAgentRequests).toHaveBeenCalledOnce()
				expect(queue.messages).toEqual([queued])
				expect(queue.getClaimedMessageIds()).toEqual([])
				expect(vi.mocked(task.say).mock.calls.filter(([type]) => type === "user_feedback")).toEqual([])
				expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
				expect(reserve).not.toHaveBeenCalled()
				if (goalState !== "absent")
					expect(await controller.get()).toMatchObject({ status: "active", continuationCount: 0 })
			} finally {
				queue.dispose()
			}
		},
	)

	it.each(["active", "late"] as const)(
		"does not admit a %s goal after authoritative host completion without pending input",
		async (goalState) => {
			const { task, controller, queue } = fixture()
			if (goalState === "active") await controller.create({ objective: "Finish." }, "user")
			const reserve = vi.spyOn(controller, "reserveContinuation")
			vi.mocked(task.runAgentRequests)
				.mockImplementationOnce(async () => {
					if (goalState === "late")
						await task.createGoal({ objective: "Finish." }, { source: "user", approved: true })
					Object.assign(task, {
						currentAgentResponse: createAgentResponse([{ type: "text", text: "Host completion." }]),
					})
					return true
				})
				.mockResolvedValue({ status: "aborted" })
			try {
				await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
				expect(task.runAgentRequests).toHaveBeenCalledOnce()
				expect(reserve).not.toHaveBeenCalled()
				expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
				expect(await controller.get()).toMatchObject({ status: "active", continuationCount: 0 })
			} finally {
				queue.dispose()
			}
		},
	)

	it("promotes human guidance arriving during goal storage admission ahead of synthetic input", async () => {
		const { task, controller, store, queue } = fixture()
		await controller.create({ objective: "Finish." }, "user")
		const { entered, release } = holdIdleReservation(controller, store)
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			if (vi.mocked(task.runAgentRequests).mock.calls.length === 2)
				await task.updateGoalStatus("complete", { source: "tool" })
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Progress." }]) }
		})
		const run = task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		try {
			await entered.promise
			queue.addMessage("Use the correction that arrived during admission.")
			release.resolve()
			await run
			expect(task.runAgentRequests).toHaveBeenCalledTimes(2)
			expect(task.runAgentRequests).toHaveBeenNthCalledWith(
				2,
				expect.arrayContaining([
					expect.objectContaining({
						text: expect.stringContaining("Use the correction that arrived during admission."),
					}),
				]),
				false,
				undefined,
				expect.objectContaining({ inputOrigin: "human" }),
			)
			expect(await controller.get()).toMatchObject({ status: "complete", continuationCount: 0 })
			expect(task.finalizeTaskCompletion).toHaveBeenCalledOnce()
		} finally {
			task.abort = true
			release.resolve()
			await run
			await task["stopGoalForTaskCancellation"]()
			queue.dispose()
		}
	})

	it("does not consume an automatic continuation after history ownership changes during goal admission", async () => {
		const { task, controller, store, queue } = fixture()
		await controller.create({ objective: "Finish." }, "user")
		const { entered, release } = holdIdleReservation(controller, store)
		const run = task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		try {
			await entered.promise
			Object.assign(task, { isCurrentApiConversationHistoryOwner: () => false })
			release.resolve()
			await run
			expect(await controller.get()).toMatchObject({ status: "active", continuationCount: 0 })
			expect(task.runAgentRequests).toHaveBeenCalledOnce()
			expect(task.ask).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
			expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
			expect(
				vi.mocked(task["appendAgentTurnEvent"]).mock.calls.filter(([event]) => event.type === "task_completed"),
			).toEqual([])
		} finally {
			task.abort = true
			task["taskCancellationController"].abort()
			release.resolve()
			await run
			await task["stopGoalForTaskCancellation"]()
			queue.dispose()
		}
	})

	it.each(["stop", "lifetime", "abandoned", "replaced", "completed", "stop-after-complete"] as const)(
		"leaves queued input unclaimed when %s wins an awaited goal admission",
		async (terminal) => {
			const { task, controller, store, queue } = fixture()
			await controller.create({ objective: "Finish." }, "user")
			const { entered, release } = holdIdleReservation(controller, store)
			const claim = vi.spyOn(queue, "claimMessage")
			vi.mocked(task.runAgentRequests)
				.mockResolvedValueOnce({
					status: "completed",
					response: createAgentResponse([{ type: "text", text: "Progress." }]),
				})
				.mockResolvedValue({ status: "aborted" })
			vi.mocked(task.say).mockImplementation(async () => {
				if (task.abort) throw new Error("Task was aborted")
			})
			const run = task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
			let stopped: Promise<void> | undefined
			try {
				await entered.promise
				const queued = queue.addMessage("Keep this queued after the terminal boundary.")
				if (terminal === "completed" || terminal === "stop-after-complete") task.markCompleted()
				if (terminal === "stop" || terminal === "stop-after-complete") task.abort = true
				if (terminal === "abandoned") Object.assign(task, { abandoned: true })
				if (terminal === "replaced") Object.assign(task, { isCurrentApiConversationHistoryOwner: () => false })
				if (terminal === "stop" || terminal === "stop-after-complete" || terminal === "lifetime")
					task["taskCancellationController"].abort()
				if (terminal !== "completed" && terminal !== "replaced") {
					stopped = task["stopGoalForTaskCancellation"]()
				}
				release.resolve()
				await run
				await stopped
				expect(task.runAgentRequests).toHaveBeenCalledOnce()
				expect(claim).not.toHaveBeenCalled()
				expect(queue.messages).toEqual([queued])
				expect(queue.getClaimedMessageIds()).toEqual([])
				expect(task.say).not.toHaveBeenCalled()
				expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
				const terminalEvents = vi
					.mocked(task["appendAgentTurnEvent"])
					.mock.calls.filter(([event]) => event.type === "task_completed")
				expect(terminalEvents).toEqual(
					terminal === "replaced"
						? []
						: [[expect.objectContaining({ status: terminal === "completed" ? "completed" : "aborted" })]],
				)
				expect(await controller.get()).toMatchObject({ continuationCount: 0 })
			} finally {
				task.abort = true
				task["taskCancellationController"].abort()
				release.resolve()
				await run
				await stopped
				await task["stopGoalForTaskCancellation"]()
				queue.dispose()
			}
		},
	)
})

describe("Task goal integration through the shared turn engine", () => {
	it("continues ordinary assistant progress until explicit goal completion, then completes once", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			if (vi.mocked(task.runAgentRequests).mock.calls.length === 2)
				await task.updateGoalStatus("complete", { source: "tool" })
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Progress." }]) }
		})
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(task.runAgentRequests).toHaveBeenCalledTimes(2)
		expect(task.finalizeTaskCompletion).toHaveBeenCalledOnce()
		expect(task.ask).not.toHaveBeenCalled()
		expect(await task.getGoal()).toMatchObject({ status: "complete", continuationCount: 1 })
	})

	it("bounds unbudgeted automatic continuations and leaves the task open for human recovery", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish the objective.", maxContinuations: 2 }, "user")
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(task.runAgentRequests).toHaveBeenCalledTimes(3)
		expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
		expect(task.ask).toHaveBeenCalledWith("resume_task")
		expect(await task.getGoal()).toMatchObject({ status: "usage_limited", continuationCount: 2 })
	})

	it("lets queued human guidance take the next model step ahead of the goal", async () => {
		const { task, controller, queue } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			if (vi.mocked(task.runAgentRequests).mock.calls.length === 1) queue.addMessage("Use the human correction.")
			else await task.updateGoalStatus("complete", { source: "tool" })
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Progress." }]) }
		})
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(task.runAgentRequests).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining("Use the human correction.") }),
			]),
			false,
			undefined,
			expect.any(Object),
		)
		expect(await task.getGoal()).toMatchObject({ continuationCount: 0 })
	})

	it.each(["failed", "incomplete", "exhausted"] as const)(
		"blocks an unfinished goal after a %s provider turn",
		async (status) => {
			const { task, controller } = fixture()
			await controller.create({ objective: "Finish the objective." }, "user")
			vi.mocked(task.runAgentRequests).mockResolvedValue({
				status,
				reason: "No usable response.",
				response: createAgentResponse([]),
			})
			await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
			expect(task.runAgentRequests).toHaveBeenCalledOnce()
			expect(await task.getGoal()).toMatchObject({ status: "blocked", continuationCount: 0 })
			expect(task.finalizeTaskCompletion).not.toHaveBeenCalled()
		},
	)

	it("distinguishes provider usage limits from ordinary retry exhaustion", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		vi.mocked(task.runAgentRequests).mockResolvedValue({
			status: "failed",
			response: createAgentResponse([{ type: "error", code: "usage_limit_exceeded", message: "Quota reached." }]),
		})
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(await task.getGoal()).toMatchObject({ status: "usage_limited" })
	})

	it.each(["replacement", "resume"] as const)(
		"does not let a failed old turn stop a %s during final journal drain",
		async (action) => {
			const { task, controller } = fixture()
			const original = await controller.create({ objective: "Finish the original." }, "user")
			const entered = barrier(),
				release = barrier()
			vi.mocked(task["finishCanonicalLifecycleTurn"]).mockImplementation(async () => {
				entered.resolve()
				await release.promise
			})
			vi.mocked(task.runAgentRequests).mockResolvedValue({
				status: "failed",
				reason: "Old request failed.",
				response: createAgentResponse([]),
			})
			const run = task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
			await entered.promise
			if (action === "replacement") {
				await controller.clear()
				await controller.create({ objective: "New objective." }, "user")
			} else {
				await controller.pause()
				await controller.resume()
			}
			release.resolve()
			await run
			expect(await controller.get()).toMatchObject({ status: "active" })
			if (action === "replacement") expect((await controller.get())?.goalId).not.toBe(original.goalId)
			else expect((await controller.get())?.controlVersion).toBeGreaterThan(original.controlVersion)
		},
	)

	it("consumes human steering after a superseded automatic input without blocking the goal", async () => {
		const { task, controller, queue } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		const admission = task["goalInputAdmission"](goal)
		vi.mocked(task["beginCanonicalLifecycleTurn"]).mockImplementationOnce(async () => {
			queue.addMessage("Use the new correction.")
			task["invalidateGoalContinuation"]()
		})
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			expect(await controller.get()).toMatchObject({ status: "active" })
			await task.updateGoalStatus("complete", { source: "tool" })
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done." }]) }
		})
		await task["initiateTaskLoop"]([{ type: "text", text: "Automatic input." }], undefined, {
			goalAdmission: admission,
			inputOrigin: "agent",
		})
		expect(task.runAgentRequests).toHaveBeenCalledOnce()
		expect(task.runAgentRequests).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining("Use the new correction.") }),
			]),
			false,
			undefined,
			expect.objectContaining({ inputOrigin: "human" }),
		)
		expect(await controller.get()).toMatchObject({ status: "complete" })
	})

	it("keeps a reloaded active objective deferred until explicit human resume", async () => {
		const { task, controller, store } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		Object.assign(task, { goalController: new GoalController({ taskId: "root", store }) })
		await task["initiateTaskLoop"]([{ type: "text", text: "A normal user request." }])
		expect(task.runAgentRequests).toHaveBeenCalledOnce()
		expect(await task.getGoal()).toMatchObject({ status: "active", recoveryDeferred: true, continuationCount: 0 })
	})

	it("rejects premature goal completion through the existing shared completion gate", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		vi.mocked(task.waitForCompletionGateDecision).mockResolvedValue({
			allowed: false,
			message: "Required child work is pending.",
			modelCanResolveRejection: false,
		})
		await expect(task.updateGoalStatus("complete", { source: "tool" })).rejects.toThrow("Required child work")
		expect(await task.getGoal()).toMatchObject({ status: "active" })
	})

	it("pauses the goal independently from task cancellation", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish the objective." }, "user")
		await task.pauseGoal(goal.goalId, goal.controlVersion)
		expect(task.abort).toBe(false)
		expect(await task.getGoal()).toMatchObject({ status: "paused" })
		expect(await task["admitGoalContinuation"]()).toBeUndefined()
	})

	it("synchronously revokes descendant requests on Stop and durably pauses before termination joins", async () => {
		const { task, controller, store } = fixture()
		const goal = await controller.create({ objective: "Finish the objective." }, "user")
		const generation = controller.getRequestGeneration()
		const entered = barrier(),
			release = barrier()
		store.beforeTransaction = async () => {
			entered.resolve()
			await release.promise
		}
		const stopped = task["stopGoalForTaskCancellation"]()
		expect(controller.isRequestCurrent(goal.goalId, generation)).toBe(false)
		await entered.promise
		const joined = task.waitForTermination()
		release.resolve()
		await Promise.all([stopped, joined])
		expect(await task.getGoal()).toMatchObject({ status: "paused" })
	})

	it.each([false, true])(
		"preserves synthetic goal admission through a primary recovery reply (pause=%s)",
		async (pause) => {
			const { task, controller } = fixture()
			await controller.create({ objective: "Finish." }, "user")
			const entered = barrier(),
				release = barrier()
			vi.mocked(task.ask).mockImplementation(async () => {
				if (vi.mocked(task.ask).mock.calls.length > 1) {
					task.abort = true
					return { response: "yesButtonClicked" as const }
				}
				Object.assign(task, { activeAsk: { type: "resume_task", ts: 1 } })
				entered.resolve()
				await release.promise
				const text = task["askResponseText"]
				Object.assign(task, { activeAsk: undefined, askResponse: undefined, askResponseText: undefined })
				return { response: "messageResponse" as const, text }
			})
			vi.mocked(task.runAgentRequests).mockImplementation(async () => {
				if (vi.mocked(task.runAgentRequests).mock.calls.length === 1)
					return { status: "failed", reason: "Try again.", response: createAgentResponse([]) }
				await task.updateGoalStatus("complete", { source: "tool" })
				return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done." }]) }
			})
			const run = task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
			await entered.promise
			await task.resumeGoal()
			if (pause) await task.pauseGoal()
			release.resolve()
			await run
			expect(task.runAgentRequests).toHaveBeenCalledTimes(pause ? 1 : 2)
			if (!pause)
				expect(task.runAgentRequests).toHaveBeenNthCalledWith(
					2,
					expect.any(Array),
					false,
					undefined,
					expect.objectContaining({ inputOrigin: "agent" }),
				)
			expect(await controller.get()).toMatchObject({ status: pause ? "paused" : "complete" })
		},
	)

	it("does not assign an old synthetic admission to an ordinary human reply with matching text", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		Object.assign(task, {
			goalAskAdmission: { text: "Same text.", admission: task["goalInputAdmission"](goal) },
			activeAsk: { type: "resume_task", ts: 1 },
		})
		expect(task.handleWebviewAskResponse("messageResponse", "Same text.")).toBe(true)
		expect(task["consumeGoalAskAdmission"]("Same text.")).toBeUndefined()
	})

	it("keeps a paused synthetic history-resume reply from entering the task loop", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish." }, "user")
		await controller.pause()
		const entered = barrier(),
			release = barrier(),
			loop = vi.fn(async () => undefined)
		Object.assign(task, {
			clineMessages: [{ type: "say", say: "text", text: "Earlier reply.", ts: 0 }],
			apiConversationHistory: [{ role: "user", content: "Existing request." }],
			getSavedAlphaMessages: vi.fn(async () => [{ type: "say", say: "text", text: "Earlier reply.", ts: 0 }]),
			getSavedApiConversationHistory: vi.fn(async () => [{ role: "user", content: "Existing request." }]),
			publishResumedUiPreview: vi.fn(async () => undefined),
			reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			invalidateBackgroundUsageDrain: vi.fn(),
			recoverIncompleteCanonicalToolCallsForResume: vi.fn(async () => undefined),
			initiateTaskLoop: loop,
		})
		vi.mocked(task.ask).mockImplementation(async () => {
			Object.assign(task, { activeAsk: { type: "resume_task", ts: 1 } })
			entered.resolve()
			await release.promise
			const text = task["askResponseText"]
			Object.assign(task, { activeAsk: undefined, askResponse: undefined, askResponseText: undefined })
			return { response: "messageResponse" as const, text }
		})
		const resumed = task["resumeTaskFromHistory"](undefined, undefined, undefined, { reuseRetainedHistory: true })
		await entered.promise
		await task.resumeGoal()
		await task.pauseGoal()
		release.resolve()
		await resumed
		expect(loop).not.toHaveBeenCalled()
	})

	it.each(["pause", "clear", "replacement", "steering"] as const)(
		"cannot wake a retained goal after %s wins awaited preparation",
		async (action) => {
			const { task, controller } = fixture()
			const goal = await controller.create({ objective: "Finish the objective." }, "user")
			Object.assign(task, {
				_started: true,
				isInitialized: true,
				apiConversationHistory: [{ role: "user", content: "Existing conversation." }],
			})
			const entered = barrier(),
				release = barrier()
			vi.mocked(task["prepareForRetainedLifecycle"]).mockImplementation(async () => {
				entered.resolve()
				await release.promise
			})
			const resume = vi.fn(async () => undefined)
			Object.assign(task, { resumeTaskFromHistory: resume })
			const wake = task["wakeGoalFromHost"](goal)
			await entered.promise
			if (action === "pause") await task.pauseGoal(goal.goalId)
			if (action === "clear") await task.clearGoal(goal.goalId)
			if (action === "replacement") {
				await controller.updateStatus("complete")
				await controller.create({ objective: "Replacement objective." }, "user")
			}
			if (action === "steering") task["invalidateGoalContinuation"]()
			release.resolve()
			await wake
			expect(resume).not.toHaveBeenCalled()
		},
	)

	it("does not start a completed-task followup after descendant billing exhausts its goal", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish the objective.", tokenBudget: 10 }, "user")
		task.markCompleted()
		const entered = barrier(),
			release = barrier()
		vi.mocked(task["prepareForRetainedLifecycle"]).mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		const resume = vi.fn(async () => undefined)
		Object.assign(task, { resumeTaskFromHistory: resume })
		const wake = task["wakeGoalFromHost"](goal)
		await entered.promise
		await controller.recordUsage("late-child", 10, 0, goal.goalId)
		release.resolve()
		await wake
		expect(resume).not.toHaveBeenCalled()
		expect(task.isCompleted()).toBe(true)
		expect(task["steerMessageAwaitingPersistence"]).toBe(false)
	})

	it("releases engine ownership when reading goal state fails before sampling", async () => {
		const { task } = fixture()
		vi.spyOn(task, "getGoal").mockRejectedValue(new Error("Invalid goal state."))
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(task["isAgentTurnEngineActive"]).toBe(false)
		expect(task.runAgentRequests).not.toHaveBeenCalled()
	})

	it("never lets a stopped captured child generation start a provider request", async () => {
		const { task: root, controller } = fixture()
		await controller.create({ objective: "Finish the objective." }, "user")
		const binding = await root.captureGoalAccountingBinding()
		await controller.pause()
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			taskKind: "subagent",
			parentTask: root,
			rootTask: root,
			parentTaskId: "root",
			inheritedGoalBinding: Promise.resolve(binding),
		})
		await child["initiateTaskLoop"]([{ type: "text", text: "Child work." }])
		expect(child.runAgentRequests).not.toHaveBeenCalled()
	})

	it("captures the invoking goal even when response billing exhausted it before spawning", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish the objective.", tokenBudget: 10 }, "user")
		const step = await task["beginGoalStep"]()
		Object.assign(task, { activeGoalStep: step })
		await controller.recordUsage("root-response", 10, 0, goal.goalId)
		expect(await task.captureGoalAccountingBinding()).toMatchObject({
			goalId: goal.goalId,
			requestGeneration: step!.requestGeneration,
		})
		const { task: child } = fixture()
		Object.assign(child, {
			taskKind: "subagent",
			parentTaskId: "root",
			inheritedGoalBinding: task.captureGoalAccountingBinding(),
		})
		await child["initiateTaskLoop"]([{ type: "text", text: "Child work." }])
		expect(child.runAgentRequests).not.toHaveBeenCalled()
	})

	it.each(["paused", "complete"] as const)(
		"creates goal-less children during an ordinary human followup after the goal is %s",
		async (status) => {
			const { task: root, controller } = fixture()
			await controller.create({ objective: "Earlier goal." }, "user")
			await controller.updateStatus(status)
			vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockResolvedValue(undefined)
			const save = vi.spyOn(GoalAccountingBindingStore.prototype, "save").mockResolvedValue(undefined)
			const { task: child } = fixture()
			Object.assign(child, {
				taskId: "child",
				taskKind: "subagent",
				parentTaskId: "root",
				rootTaskId: "root",
				rootTask: root,
				parentTask: root,
			})
			vi.mocked(root.runAgentRequests).mockImplementation(async () => {
				expect(root["activeGoalStep"]).toBeUndefined()
				const captured = root.captureGoalAccountingBinding()
				expect(await captured).toBeUndefined()
				const binding = await child["loadInheritedGoalBinding"](root, captured, false)
				Object.assign(child, { inheritedGoalBinding: Promise.resolve(binding) })
				await child["initiateTaskLoop"]([{ type: "text", text: "New human-owned child work." }])
				return { status: "completed", response: createAgentResponse([{ type: "text", text: "Done." }]) }
			})
			await root["initiateTaskLoop"]([{ type: "text", text: "Ordinary human followup." }], undefined, {
				inputOrigin: "human",
			})
			expect(child.runAgentRequests).toHaveBeenCalledOnce()
			expect(save).toHaveBeenCalledWith(undefined)
			expect(await controller.get()).toMatchObject({ status, tokensUsed: 0 })
		},
	)

	it("replays linked primary child receipts into the original owner and rejects replacement transfer", async () => {
		const { task: root, controller } = fixture()
		const goal = await controller.create({ objective: "Finish the objective." }, "user")
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			parentTask: root,
			rootTask: root,
			inheritedGoalBinding: root.captureGoalAccountingBinding(),
			apiConversationHistory: [
				{
					role: "assistant",
					content: "Work.",
					goal_usage_receipts: [
						{ goalTaskId: "root", goalId: goal.goalId, eventId: "child-receipt", tokens: 7, timeMs: 0 },
					],
				},
			],
		})
		await child["reconcileGoalUsageFromHistory"]()
		await child["reconcileGoalUsageFromHistory"]()
		expect(await root.getGoal()).toMatchObject({ tokensUsed: 7 })
		await controller.updateStatus("complete")
		await controller.create({ objective: "Replacement." }, "user")
		await child["reconcileGoalUsageFromHistory"]()
		expect(await root.getGoal()).toMatchObject({ tokensUsed: 0 })
	})

	it("cancels synthetic startup after pause wins inside startTask and labels admitted goal input as agent input", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		const entered = barrier(),
			release = barrier()
		const loop = vi.fn(async () => undefined)
		Object.assign(task, {
			invalidateBackgroundUsageDrain: vi.fn(),
			persistFrozenSubagentInstructions: vi.fn(async () => {
				entered.resolve()
				await release.promise
			}),
			getEnabledMcpToolsCount: vi.fn(async () => ({ enabledToolCount: 0, enabledServerCount: 0 })),
			initiateTaskLoop: loop,
		})
		const start = task["startTask"]("Goal input.", undefined, task["goalInputAdmission"](goal))
		await entered.promise
		await task.pauseGoal(goal.goalId)
		release.resolve()
		await start
		expect(loop).not.toHaveBeenCalled()
		const resumed = await controller.resume()
		await task["startTask"]("Goal input.", undefined, task["goalInputAdmission"](resumed))
		expect(loop).toHaveBeenCalledWith(
			expect.any(Array),
			undefined,
			expect.objectContaining({ inputOrigin: "agent" }),
		)
	})

	it("cancels synthetic retained resumption after pause wins inside resumeTaskFromHistory", async () => {
		const { task, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		const entered = barrier(),
			release = barrier()
		const loop = vi.fn(async () => undefined)
		Object.assign(task, {
			apiConversationHistory: [{ role: "user", content: "Existing request." }],
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			invalidateBackgroundUsageDrain: vi.fn(),
			recoverIncompleteCanonicalToolCallsForResume: vi.fn(async () => {
				entered.resolve()
				await release.promise
			}),
			initiateTaskLoop: loop,
		})
		const resume = task["resumeTaskFromHistory"]("Goal input.", undefined, undefined, {
			reuseRetainedHistory: true,
			inputOrigin: "agent",
			goalAdmission: task["goalInputAdmission"](goal),
		})
		await entered.promise
		await task.pauseGoal(goal.goalId)
		release.resolve()
		await resume
		expect(loop).not.toHaveBeenCalled()
	})

	it("clears and settles an early failed sample without retaining stale spawn ownership", async () => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish." }, "user")
		vi.mocked(task.runAgentRequests).mockRejectedValue(new Error("Failed before response."))
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(task["activeGoalStep"]).toBeUndefined()
		expect(task["isAgentTurnEngineActive"]).toBe(false)
		expect(await task.getGoal()).toMatchObject({ status: "blocked", tokensUsed: 0 })
	})

	it.each(["code", "architect"] as const)(
		"accounts early failed %s sampling using its admitted mode",
		async (mode) => {
			let now = 100
			vi.spyOn(Date, "now").mockImplementation(() => now)
			const { task, controller } = fixture()
			await controller.create({ objective: "Finish." }, "user")
			Object.assign(task, { _taskMode: mode })
			vi.mocked(task.runAgentRequests).mockImplementation(async () => {
				now = 150
				throw new Error("Failed before response.")
			})
			await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
			expect(await controller.get()).toMatchObject({ timeUsedMs: mode === "code" ? 50 : 0, tokensUsed: 0 })
		},
	)

	it.each(["code", "architect"])("accounts from the sampled %s mode after a live mode change", async (mode) => {
		const { task, controller } = fixture()
		await controller.create({ objective: "Finish." }, "user")
		Object.assign(task, { _taskMode: mode === "code" ? "architect" : "code" })
		vi.mocked(task.runAgentRequests).mockImplementation(async () => {
			Object.assign(task, { _taskMode: mode })
			await controller.updateStatus("complete")
			return {
				status: "completed",
				response: createAgentResponse([
					{ type: "text", text: "Done." },
					{ type: "usage", inputTokens: 10, outputTokens: 2 },
				]),
			}
		})
		await task["initiateTaskLoop"]([{ type: "text", text: "Start." }])
		expect(await controller.get()).toMatchObject({ tokensUsed: mode === "code" ? 12 : 0 })
	})
})

describe("Task saved child goal admission", () => {
	function savedOwner(goalId: string, drainOnly = false) {
		return {
			schemaVersion: 1 as const,
			taskId: "child",
			owner: { goalTaskId: "root", goalId, controlVersion: 1, drainOnly },
		}
	}

	it("allows an explicitly readmitted child for the same resumed goal and denies its original queued lease", async () => {
		const { task: root, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		const old = await root.captureGoalAccountingBinding()
		vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockResolvedValue(savedOwner(goal.goalId))
		await controller.pause()
		await controller.resume()
		const current = root.captureGoalAccountingBinding()
		const { task: child } = fixture()
		Object.assign(child, { taskId: "child", parentTaskId: "root", rootTaskId: "root" })
		const readmitted = await child["loadInheritedGoalBinding"](root, current, true, true)
		expect(readmitted?.controller.isRequestCurrent(readmitted.goalId, readmitted.requestGeneration)).toBe(true)
		const queued = await child["loadInheritedGoalBinding"](root, Promise.resolve(old), true, true)
		expect(queued?.controller.isRequestCurrent(queued.goalId, queued.requestGeneration)).toBe(false)
	})

	it("keeps receipt-only fallback drain-only across two reloads with an unchanged root goal", async () => {
		const { task: root, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		let persisted: Awaited<ReturnType<GoalAccountingBindingStore["read"]>>
		vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockImplementation(async () => persisted)
		const save = vi.spyOn(GoalAccountingBindingStore.prototype, "save").mockImplementation(async (owner) => {
			persisted = owner
				? { schemaVersion: 1, taskId: "child", owner: { ...owner, drainOnly: owner.drainOnly ?? false } }
				: { schemaVersion: 1, taskId: "child", owner: null }
		})
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			parentTaskId: "root",
			rootTaskId: "root",
			getSavedApiConversationHistory: vi.fn(async () => [
				{
					role: "assistant",
					content: "Work.",
					goal_usage_receipts: [
						{ goalTaskId: "root", goalId: goal.goalId, eventId: "legacy-step", tokens: 7, timeMs: 0 },
					],
				},
			]),
		})
		for (let reload = 0; reload < 2; reload++) {
			const binding = await child["loadInheritedGoalBinding"](
				root,
				root.captureGoalAccountingBinding(),
				true,
				true,
			)
			expect(binding?.requestGeneration).toBe(-1)
		}
		expect(save).toHaveBeenCalledOnce()
		expect(persisted?.owner).toMatchObject({ goalId: goal.goalId, drainOnly: true })
	})

	it("renews a retained live child only through explicit same-goal parent followup", async () => {
		const { task: root, controller } = fixture()
		const goal = await controller.create({ objective: "Finish." }, "user")
		vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockResolvedValue(savedOwner(goal.goalId))
		const original = await root.captureGoalAccountingBinding()
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			taskKind: "subagent",
			parentTaskId: "root",
			rootTaskId: "root",
			inheritedGoalBinding: Promise.resolve(original),
		})
		await controller.pause()
		await controller.resume()
		await child.readmitGoalAccountingBinding(root.captureGoalAccountingBinding(), root)
		const fresh = await child.captureGoalAccountingBinding()
		expect(fresh?.controller.isRequestCurrent(fresh.goalId, fresh.requestGeneration)).toBe(true)
		await expect(child.readmitGoalAccountingBinding(Promise.resolve(original), root)).rejects.toThrow(
			"admission stopped",
		)
		expect(await child.captureGoalAccountingBinding()).toBe(fresh)
		await controller.clear()
		await controller.create({ objective: "Replacement." }, "user")
		await expect(child.readmitGoalAccountingBinding(root.captureGoalAccountingBinding(), root)).rejects.toThrow(
			"admission stopped",
		)
	})

	it("preserves owner:null without consulting unrelated root state and refuses goal-owned followup", async () => {
		vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockResolvedValue({
			schemaVersion: 1,
			taskId: "child",
			owner: null,
		})
		const { task: child } = fixture()
		Object.assign(child, { taskId: "child", parentTaskId: "root", rootTaskId: "root" })
		await expect(
			child["loadInheritedGoalBinding"](undefined, Promise.reject(new Error("Unrelated root failure.")), true),
		).resolves.toBeUndefined()
		const { task: root, controller } = fixture()
		await controller.create({ objective: "Later goal." }, "user")
		await expect(
			child["loadInheritedGoalBinding"](root, root.captureGoalAccountingBinding(), true, true),
		).rejects.toThrow("without a goal")
	})

	it("rejects unexpected receipts for a child with no admitted goal owner", async () => {
		const { task: root, controller } = fixture()
		const goal = await controller.create({ objective: "Later goal." }, "user")
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			parentTask: root,
			parentTaskId: "root",
			inheritedGoalBinding: Promise.resolve(undefined),
			apiConversationHistory: [
				{
					role: "assistant",
					content: "Forged.",
					goal_usage_receipts: [
						{ goalTaskId: "root", goalId: goal.goalId, eventId: "not-admitted", tokens: 100, timeMs: 0 },
					],
				},
			],
		})
		await expect(child["reconcileGoalUsageFromHistory"]()).rejects.toThrow("no admitted goal owner")
		expect(await controller.get()).toMatchObject({ tokensUsed: 0 })
	})

	it("opens a saved child without live parent objects for receipt drain only and never samples", async () => {
		vi.spyOn(GoalAccountingBindingStore.prototype, "read").mockResolvedValue(savedOwner("original-goal"))
		const { task: child } = fixture()
		Object.assign(child, {
			taskId: "child",
			taskKind: "subagent",
			parentTaskId: "root",
			rootTaskId: "root",
			globalStoragePath: process.cwd(),
			goalChildRequiresAdmission: true,
		})
		const binding = await child["loadInheritedGoalBinding"](undefined, Promise.resolve(undefined), true)
		expect(binding).toMatchObject({ goalTaskId: "root", goalId: "original-goal", requestGeneration: -1 })
		Object.assign(child, { inheritedGoalBinding: Promise.resolve(binding) })
		const record = vi.spyOn(binding!.controller, "recordUsage").mockResolvedValue(undefined)
		child.apiConversationHistory = [
			{
				role: "assistant",
				content: "Work.",
				goal_usage_receipts: [
					{
						goalTaskId: "root",
						goalId: "original-goal",
						eventId: "durable-child-usage",
						tokens: 7,
						timeMs: 0,
					},
				],
			},
		]
		await child["reconcileGoalUsageFromHistory"]()
		expect(record).toHaveBeenCalledWith("durable-child-usage", 7, 0, "original-goal")
		await child["initiateTaskLoop"]([{ type: "text", text: "Child work." }])
		expect(child.runAgentRequests).not.toHaveBeenCalled()
	})
})
