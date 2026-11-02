import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentLifecycleEvent, AgentLifecycleSnapshot } from "@alpha-code/types"

import { createAgentResponse } from "../../agent/AgentResponse"
import { AsyncLifecycleHooks } from "../../agent/AsyncLifecycleHooks"
import { readCompletionHookConfig, runCompletionHooks, type CompletionHookTarget } from "../../agent/CompletionHooks"
import type { AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../../agent/lifecycle/reducer"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../agent/CompletionHooks", async (original) => ({
	...(await original<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(),
	runCompletionHooks: vi.fn(),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

function fixture(target: CompletionHookTarget = "Stop") {
	const controller = new AbortController()
	const events: AgentLifecycleEvent[] = []
	const trace: string[] = []
	let snapshot: AgentLifecycleSnapshot | undefined
	const provider = {
		getState: async () => ({}),
		isTaskOnScreen: () => true,
		getAgentLifecycleSnapshot: () => snapshot,
		replayAgentLifecycle: async () => snapshot,
		publishAgentLifecycleEvent: async (input: AgentLifecycleEventInput) => {
			if (!snapshot || input.runId !== snapshot.runId || input.turnId !== snapshot.turnId) {
				expect(input.type).toBe("turn_started")
				snapshot = createAgentLifecycleSnapshot(input)
			}
			const event = { ...input, sequence: snapshot.lastSequence + 1 } as AgentLifecycleEvent
			snapshot = reduceAgentLifecycleEvent(snapshot, event)
			events.push(event)
			trace.push(`lifecycle:${event.type}`)
			return { accepted: true, event, snapshot }
		},
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "hook-turn-task",
		instanceId: "hook-turn-instance",
		taskKind: target === "Stop" ? "primary" : "subagent",
		...(target === "SubagentStop" ? { parentTaskId: "parent-task", subagentGroupId: "group" } : {}),
		workspacePath: process.cwd(),
		_taskMode: "code",
		taskApprovalMode: "ask",
		abort: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		enableCheckpoints: false,
		completionHookActive: false,
		canonicalLifecycleQueue: Promise.resolve(),
		canonicalLifecycleStartedSteps: new Set<string>(),
		taskCancellationController: controller,
		alphaMessages: [],
		apiConversationHistory: [],
		userMessageContent: [],
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => provider },
		api: { getModel: () => ({ id: "hook-model" }) },
		getTaskMode: vi.fn(async () => "code"),
		completionHookTranscriptPath: vi.fn(async () => null),
		runAgentRequests: vi.fn<Task["runAgentRequests"]>(async () => ({
			status: "completed",
			response: createAgentResponse([{ type: "text", text: "Candidate answer." }]),
		})),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		flushAgentTurnEvents: vi.fn(async () => undefined),
		maybeCompactAfterTurn: vi.fn(async () => undefined),
		recordCompletionCandidate: vi.fn(),
		waitForCompletionGateDecision: vi.fn(async () => ({ allowed: true, modelCanResolveRejection: true })),
		recordCompletionRejection: vi.fn((decision) => decision),
		consecutiveMistakeCount: 0,
		presentCompletionResult: vi.fn(async () => trace.push("present")),
		finalizeTaskCompletion: vi.fn(async () => {
			trace.push("task:completed")
			task.markCompleted()
			return true
		}),
		resetMistakeRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		say: vi.fn(async () => undefined),
		publishLifecycleHookMessage: vi.fn(async () => undefined),
		ask: vi.fn(async () => {
			task.abort = true
			return { response: "noButtonClicked" }
		}),
		emit: vi.fn(),
	}) as Task
	vi.mocked(readCompletionHookConfig).mockReturnValue({
		stop: [{ command: process.execPath }],
		subagentStop: [{ command: process.execPath }],
	})
	return { task, controller, events, trace, snapshot: () => snapshot }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("completion hooks inside the canonical turn", () => {
	it.each(["Stop", "SubagentStop"] as const)(
		"honors %s stops before optional compaction and automatic goal continuation",
		async (target) => {
			for (const stopReason of [undefined, "Stop after this response."]) {
				const { task, events } = fixture(target)
				const admitGoalContinuation = vi.fn(async () => undefined)
				Object.assign(task, {
					isGoalIdleBoundary: () => true,
					admitGoalContinuation,
				})
				vi.mocked(runCompletionHooks).mockResolvedValue({ shouldStop: true, stopReason, warnings: [] })

				await task["initiateTaskLoop"]([{ type: "text", text: "Finish this response." }])

				expect(task.isCompleted()).toBe(true)
				expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
				expect(task["maybeCompactAfterTurn"]).not.toHaveBeenCalled()
				expect(admitGoalContinuation).not.toHaveBeenCalled()
				expect(task["finalizeTaskCompletion"]).toHaveBeenCalledOnce()
				expect(events.filter(({ type }) => type === "turn_terminal")).toHaveLength(1)
				vi.clearAllMocks()
			}
		},
	)

	it.each(["Stop", "SubagentStop"] as const)(
		"keeps repeated %s repairs in one open turn and publishes completion only after acceptance",
		async (target) => {
			const { task, events, trace, snapshot } = fixture(target)
			const observed: Array<{ runId?: string; turnId: string; status?: string; active: boolean }> = []
			vi.mocked(runCompletionHooks).mockImplementation(async (_config, request) => {
				const invocation = observed.length + 1
				trace.push(`hook:${invocation}`)
				observed.push({
					runId: snapshot()?.runId,
					turnId: request.turn_id,
					status: snapshot()?.status,
					active: request.stop_hook_active,
				})
				return invocation <= 4
					? {
							prompt: `Repair ${invocation}`,
							fragments: [{ hook_run_id: `hook-${invocation}`, text: `Repair ${invocation}` }],
							warnings: [],
						}
					: { warnings: [] }
			})

			await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

			expect(task.isCompleted()).toBe(true)
			expect(task["runAgentRequests"]).toHaveBeenCalledTimes(5)
			expect(observed).toHaveLength(5)
			expect(new Set(observed.map(({ runId }) => runId)).size).toBe(1)
			expect(new Set(observed.map(({ turnId }) => turnId)).size).toBe(1)
			expect(observed[0].turnId).not.toBe("")
			expect(observed.map(({ status }) => status)).toEqual(Array(5).fill("in_progress"))
			expect(observed.map(({ active }) => active)).toEqual([false, true, true, true, true])
			expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(1)
			expect(events.filter(({ type }) => type === "turn_terminal")).toEqual([
				expect.objectContaining({ payload: expect.objectContaining({ status: "completed" }) }),
			])
			expect(trace.indexOf("lifecycle:turn_terminal")).toBeGreaterThan(trace.indexOf("hook:5"))
			expect(trace.indexOf("task:completed")).toBeGreaterThan(trace.indexOf("hook:5"))
			for (let invocation = 1; invocation <= 4; invocation++) {
				expect(vi.mocked(task["runAgentRequests"]).mock.calls[invocation]).toMatchObject([
					[{ type: "text", text: `Repair ${invocation}` }],
					false,
					undefined,
					{
						inputOrigin: "agent",
						hookPrompt: {
							event: target,
							fragments: [{ hook_run_id: `hook-${invocation}`, text: `Repair ${invocation}` }],
						},
					},
				])
			}
			expect(task.ask).not.toHaveBeenCalled()
		},
	)

	it("keeps the canonical turn cancellable while a hook is held and discards its late prompt", async () => {
		const { task, controller, events, snapshot } = fixture()
		const entered = deferred()
		const release = deferred()
		vi.mocked(runCompletionHooks).mockImplementation(async (_config, _request, signal) => {
			expect(signal).toBe(controller.signal)
			entered.resolve()
			await release.promise
			return { prompt: "Late repair", fragments: [{ hook_run_id: "late", text: "Late repair" }], warnings: [] }
		})
		const running = task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
		await entered.promise
		try {
			expect(snapshot()?.status).toBe("in_progress")
			expect(events.some(({ type }) => type === "turn_terminal")).toBe(false)
		} finally {
			task.abort = true
			controller.abort(new Error("user cancelled"))
			release.resolve()
			await running
		}
		expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
		expect(task.isCompleted()).toBe(false)
		expect(task["presentCompletionResult"]).not.toHaveBeenCalled()
		expect(task["finalizeTaskCompletion"]).not.toHaveBeenCalled()
		expect(events.filter(({ type }) => type === "turn_terminal")).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ status: "interrupted" }) }),
		])
	})

	it("assigns a fresh identity to a subsequent human turn after hooks accepted the prior turn", async () => {
		const { task, events, trace } = fixture()
		const history: ApiMessage[] = []
		const context = { hook_run_id: "first-human-turn-background", text: "Evidence from the first turn." }
		Object.assign(task, {
			apiConversationHistory: history,
			asyncLifecycleHooks: {
				drain: vi
					.fn()
					.mockReturnValueOnce([
						{ event: "PostToolUse", outcome: { warnings: [], additionalContext: [context] } },
					])
					.mockReturnValue([]),
			},
			flushPendingToolResultsToHistory: vi.fn(async () => true),
			stageApiUserMessage: vi.fn((message: ApiMessage) => history.push(message)),
			saveApiConversationHistory: vi.fn(async () => {
				trace.push("save-async-context")
				return true
			}),
		})
		vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })
		await task["initiateTaskLoop"]([{ type: "text", text: "First request." }])
		expect(history).toEqual([
			expect.objectContaining({
				input_origin: "agent",
				hook_prompt: { event: "PostToolUse", fragments: [context] },
			}),
		])
		expect(trace.indexOf("save-async-context")).toBeLessThan(trace.indexOf("lifecycle:turn_terminal"))
		task["didComplete"] = false
		task["didEmitTaskCompleted"] = false
		await task["initiateTaskLoop"]([{ type: "text", text: "Second request." }])
		const starts = events.filter(({ type }) => type === "turn_started")
		expect(starts).toHaveLength(2)
		expect(starts[1].runId).not.toBe(starts[0].runId)
		expect(starts[1].turnId).not.toBe(starts[0].turnId)
		expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.stop_hook_active)).toEqual([
			false,
			false,
		])
		expect(task.isCompleted()).toBe(true)
		expect(history).toHaveLength(1)
	})

	it.each(["Stop", "SubagentStop"] as const)(
		"consumes ready asynchronous feedback before %s accepts the final answer",
		async (target) => {
			const { task, events, trace } = fixture(target)
			const history: ApiMessage[] = []
			const context = { hook_run_id: "ready-review", text: "The checker found an unresolved issue." }
			const sampledTurns: Array<string | undefined> = []
			Object.assign(task, {
				apiConversationHistory: history,
				asyncLifecycleHooks: {
					drain: vi
						.fn()
						.mockReturnValueOnce([
							{ event: "PostToolUse", outcome: { warnings: [], additionalContext: [context] } },
						])
						.mockReturnValue([]),
				},
				flushPendingToolResultsToHistory: vi.fn(async () => true),
				stageApiUserMessage: vi.fn((message: ApiMessage) => history.push(message)),
				saveApiConversationHistory: vi.fn(async () => {
					trace.push("save-async-context")
					return true
				}),
			})
			vi.mocked(task["runAgentRequests"]).mockImplementation(async () => {
				const invocation = sampledTurns.push(task["agentTurnId"])
				trace.push(`sample:${invocation}`)
				if (invocation === 2) {
					expect(history).toEqual([
						expect.objectContaining({
							input_origin: "agent",
							hook_prompt: { event: "PostToolUse", fragments: [context] },
						}),
					])
				}
				return {
					status: "completed",
					response: createAgentResponse([
						{ type: "text", text: invocation === 1 ? "Unchecked answer." : "Revised answer." },
					]),
				}
			})
			vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })

			await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

			expect(task.isCompleted()).toBe(true)
			expect(task["runAgentRequests"]).toHaveBeenCalledTimes(2)
			expect(vi.mocked(task["runAgentRequests"]).mock.calls[1][0]).toEqual([])
			expect(new Set(sampledTurns).size).toBe(1)
			expect(history).toHaveLength(1)
			expect(runCompletionHooks).toHaveBeenCalledOnce()
			expect(vi.mocked(runCompletionHooks).mock.calls[0][1].last_assistant_message).toBe("Revised answer.")
			expect(trace.indexOf("save-async-context")).toBeLessThan(trace.indexOf("sample:2"))
			expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(1)
			expect(events.filter(({ type }) => type === "turn_terminal")).toHaveLength(1)
			expect(task["finalizeTaskCompletion"]).toHaveBeenCalledOnce()
		},
	)

	it.each([false, true])(
		"does not resample for asynchronous warnings without context (empty array: %s)",
		async (empty) => {
			const { task } = fixture()
			Object.assign(task, {
				asyncLifecycleHooks: {
					drain: vi
						.fn()
						.mockReturnValueOnce([
							{
								event: "PostToolUse",
								outcome: {
									warnings: ["Advisory warning"],
									...(empty ? { additionalContext: [] } : {}),
								},
							},
						])
						.mockReturnValue([]),
				},
			})
			vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })

			await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

			expect(task.isCompleted()).toBe(true)
			expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
			expect(task["publishLifecycleHookMessage"]).toHaveBeenCalledWith(
				"Warning: Advisory warning",
				expect.anything(),
				expect.anything(),
			)
		},
	)

	it("does not wake an idle task when background context becomes ready after its final boundary", async () => {
		const { task, controller } = fixture()
		const hooks = new AsyncLifecycleHooks()
		const release = deferred()
		const outcome = { warnings: [], additionalContext: [{ hook_run_id: "idle", text: "For the next prompt" }] }
		hooks.schedule(
			"PostToolUse",
			async () => {
				await release.promise
				return outcome
			},
			controller.signal,
		)
		Object.assign(task, { asyncLifecycleHooks: hooks })
		vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })
		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
		expect(task.isCompleted()).toBe(true)
		expect(task.hasPendingAsyncLifecycleHookContext()).toBe(false)

		release.resolve()
		await Promise.all([...hooks["active"].values()])

		expect(task.hasPendingAsyncLifecycleHookContext()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual([])
		expect(hooks.drain()).toEqual([{ event: "PostToolUse", outcome }])
		await hooks.shutdown()
	})

	it("does not add a redundant step when ready context is consumed before the prompt", async () => {
		const { task } = fixture()
		const history: ApiMessage[] = []
		const context = { hook_run_id: "before-prompt", text: "Already available to the current model request." }
		Object.assign(task, {
			apiConversationHistory: history,
			inputBlockOrigins: new WeakMap(),
			asyncLifecycleHooks: {
				drain: vi
					.fn()
					.mockReturnValueOnce([
						{ event: "PostToolUse", outcome: { warnings: [], additionalContext: [context] } },
					])
					.mockReturnValue([]),
			},
			flushPendingToolResultsToHistory: vi.fn(async () => true),
			stageApiUserMessage: vi.fn((message: ApiMessage) => history.push(message)),
			saveApiConversationHistory: vi.fn(async () => true),
		})
		vi.mocked(task["runAgentRequests"]).mockImplementationOnce(async (content) => {
			await task["inspectLifecycleHookInput"](content, task.getTaskLifetimeCancellationSignal())
			expect(history[0].hook_prompt?.fragments).toEqual([context])
			return { status: "completed", response: createAgentResponse([{ type: "text", text: "Checked answer." }]) }
		})
		vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })

		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

		expect(task.isCompleted()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
		expect(runCompletionHooks).toHaveBeenCalledOnce()
		expect(history).toHaveLength(1)
	})

	it("defers a staged completion if hook feedback arrives during the final persistence gate", async () => {
		const { task } = fixture()
		const entered = deferred()
		const release = deferred()
		let readyContext = false
		const provider = task.providerRef.deref()!
		const rollback = vi.fn(async () => undefined)
		Object.assign(provider, {
			prepareTaskCompletionLifecycle: vi.fn(async () => undefined),
			rollbackTaskCompletionLifecycle: rollback,
		})
		Object.assign(task, {
			asyncLifecycleHooks: { hasPendingContext: () => readyContext },
			flushPendingToolResultsToHistory: vi.fn(async () => true),
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			getCompletionGateDecision: vi.fn(async () => {
				entered.resolve()
				await release.promise
				return { allowed: true, modelCanResolveRejection: true }
			}),
			rollbackPersistedToolResult: vi.fn(async () => true),
			retractCompletionResult: vi.fn(async () => undefined),
		})

		const finalizing = Task.prototype.finalizeTaskCompletion.call(task, "pending-completion")
		await entered.promise
		readyContext = true
		release.resolve()

		expect(await finalizing).toBe(false)
		expect(task.isCompleted()).toBe(false)
		expect(task["didEmitTaskCompleted"]).toBe(false)
		expect(task.rollbackPersistedToolResult).toHaveBeenCalledExactlyOnceWith("pending-completion")
		expect(rollback).toHaveBeenCalledExactlyOnceWith(task.taskId)
		expect(task["retractCompletionResult"]).toHaveBeenCalledOnce()
	})

	it.each(["Stop", "SubagentStop"] as const)(
		"resets %s repair state when queued human input starts another canonical turn",
		async (target) => {
			const { task, events } = fixture(target)
			const requests: Array<{ turnId: string; active: boolean }> = []
			vi.mocked(runCompletionHooks).mockImplementation(async (_config, request) => {
				requests.push({ turnId: request.turn_id, active: request.stop_hook_active })
				if (requests.length === 1)
					return {
						prompt: "Repair the first answer.",
						fragments: [{ hook_run_id: "first-repair", text: "Repair the first answer." }],
						warnings: [],
					}
				if (requests.length === 2) task.messageQueueService.addMessage("Next human request.")
				return { warnings: [] }
			})

			await task["initiateTaskLoop"]([{ type: "text", text: "First human request." }])

			expect(task.isCompleted()).toBe(true)
			expect(task["runAgentRequests"]).toHaveBeenCalledTimes(3)
			expect(requests.map(({ active }) => active)).toEqual([false, true, false])
			expect(requests[0].turnId).toBe(requests[1].turnId)
			expect(requests[2].turnId).not.toBe(requests[1].turnId)
			expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(2)
			expect(events.filter(({ type }) => type === "turn_terminal")).toHaveLength(2)
			expect(task["finalizeTaskCompletion"]).toHaveBeenCalledOnce()
		},
	)

	it("does not dispatch a configured hook after transcript lookup yields ownership to a replacement Task", async () => {
		const { task } = fixture()
		const entered = deferred()
		const release = deferred()
		let ownsTranscript = true
		Object.assign(task, { isCurrentApiConversationHistoryOwner: () => ownsTranscript })
		vi.mocked(task["completionHookTranscriptPath"]).mockImplementation(async () => {
			entered.resolve()
			await release.promise
			return null
		})
		vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })
		const running = task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
		} finally {
			ownsTranscript = false
			release.resolve()
			await running
		}
		expect(runCompletionHooks).not.toHaveBeenCalled()
		expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
		expect(task["presentCompletionResult"]).not.toHaveBeenCalled()
		expect(task.isCompleted()).toBe(false)
	})

	it.each([false, true])("runs goal Stop hooks before idle continuation (repair first: %s)", async (repairFirst) => {
		const { task, events, trace } = fixture()
		const goal = { goalId: "active-goal", controlVersion: 1, status: "active", objective: "Finish the goal." }
		const finalSample = repairFirst ? 3 : 2
		const lastSample = finalSample + 1
		let sample = 0
		const history: ApiMessage[] = []
		const context = { hook_run_id: "goal-progress-background", text: "Evidence from the completed goal step." }
		Object.assign(task, {
			apiConversationHistory: history,
			asyncLifecycleHooks: {
				drain: vi.fn(() =>
					sample === finalSample - 1
						? [{ event: "PostToolUse", outcome: { warnings: [], additionalContext: [context] } }]
						: [],
				),
			},
			flushPendingToolResultsToHistory: vi.fn(async () => true),
			stageApiUserMessage: vi.fn((message: ApiMessage) => history.push(message)),
			saveApiConversationHistory: vi.fn(async () => {
				trace.push("save-async-context")
				return true
			}),
			getGoal: vi.fn(async () => goal),
			beginGoalStep: vi.fn(async () => ({
				controller: { get: async () => goal },
				goalTaskId: task.taskId,
				goalId: goal.goalId,
				controlVersion: goal.controlVersion,
				requestGeneration: 1,
				eventId: `goal-step-${sample + 1}`,
				startedAt: Date.now(),
				accountElapsed: false,
				responseAccounted: true,
				finished: true,
			})),
			isGoalIdleBoundary: vi.fn(() => true),
			admitGoalContinuation: vi.fn().mockResolvedValueOnce(goal).mockResolvedValue(undefined),
			goalContinuationText: vi.fn(() => "Continue the active goal."),
			goalInputAdmission: vi.fn(() => ({ canWake: async () => true, isStillCurrent: () => true })),
		})
		vi.mocked(task["runAgentRequests"]).mockImplementation(async () => {
			sample++
			trace.push(`sample:${sample}`)
			if (sample === finalSample) {
				expect(history).toEqual([
					expect.objectContaining({
						input_origin: "agent",
						hook_prompt: { event: "PostToolUse", fragments: [context] },
					}),
				])
				expect(trace.indexOf("save-async-context")).toBeLessThan(trace.indexOf(`sample:${finalSample}`))
			}
			if (sample === lastSample) {
				goal.status = "complete"
				task["goalTurnCompletionText"] = "The goal is complete."
			}
			return {
				status: "completed",
				response: createAgentResponse([
					{ type: "text", text: sample === lastSample ? "Final answer." : "Progress." },
				]),
			}
		})
		vi.mocked(runCompletionHooks).mockImplementation(async (_config, request) => {
			trace.push("hook")
			expect(request.last_assistant_message).toBe(sample === lastSample ? "The goal is complete." : "Progress.")
			if (repairFirst && sample === 1) {
				return {
					prompt: "Repair the current goal step.",
					fragments: [{ hook_run_id: "goal-repair", text: "Repair the current goal step." }],
					warnings: [],
				}
			}
			return { warnings: [] }
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

		expect(task.isCompleted()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledTimes(lastSample)
		expect(runCompletionHooks).toHaveBeenCalledTimes(finalSample)
		expect(trace.indexOf("hook")).toBeLessThan(trace.indexOf(`sample:${lastSample}`))
		expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.stop_hook_active)).toEqual(
			repairFirst ? [false, true, false] : [false, false],
		)
		const starts = events.filter(({ type }) => type === "turn_started")
		expect(starts).toHaveLength(2)
		expect(starts[1].turnId).not.toBe(starts[0].turnId)
	})

	it("repairs a rejected completion gate before invoking hooks and publishing one terminal turn", async () => {
		const { task, events, trace } = fixture()
		vi.mocked(task["waitForCompletionGateDecision"])
			.mockResolvedValueOnce({
				allowed: false,
				modelCanResolveRejection: true,
				classification: "repairable",
				reasonCode: "verification_missing",
				message: "Verify the changed files before completion.",
			})
			.mockResolvedValue({ allowed: true, modelCanResolveRejection: true })
		vi.mocked(runCompletionHooks).mockImplementation(async () => {
			trace.push("hook")
			expect(task["runAgentRequests"]).toHaveBeenCalledTimes(2)
			return { warnings: [] }
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

		expect(task.isCompleted()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledTimes(2)
		expect(runCompletionHooks).toHaveBeenCalledOnce()
		expect(vi.mocked(task["runAgentRequests"]).mock.calls[1][0]).toEqual([
			{ type: "text", text: expect.stringContaining("Verify the changed files before completion.") },
		])
		expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(1)
		expect(events.filter(({ type }) => type === "turn_terminal")).toHaveLength(1)
		expect(trace.indexOf("lifecycle:turn_terminal")).toBeGreaterThan(trace.indexOf("hook"))
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("still completes ordinary visible text immediately when no hooks are configured", async () => {
		const { task, events } = fixture()
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [] })
		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])
		expect(task.isCompleted()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledOnce()
		expect(runCompletionHooks).not.toHaveBeenCalled()
		expect(events.filter(({ type }) => type === "turn_terminal")).toHaveLength(1)
		expect(task.ask).not.toHaveBeenCalled()
	})
})
