import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentLifecycleEvent, AgentLifecycleSnapshot } from "@alpha-code/types"

import { createAgentResponse } from "../../agent/AgentResponse"
import { readCompletionHookConfig, runCompletionHooks, type CompletionHookTarget } from "../../agent/CompletionHooks"
import type { AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../../agent/lifecycle/reducer"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
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
		clineMessages: [],
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
		const { task, events } = fixture()
		vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })
		await task["initiateTaskLoop"]([{ type: "text", text: "First request." }])
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

	it("admits an active-goal continuation before running Stop hooks on its terminal candidate", async () => {
		const { task, events, trace } = fixture()
		const goal = { goalId: "active-goal", controlVersion: 1, status: "active", objective: "Finish the goal." }
		let sample = 0
		Object.assign(task, {
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
			if (sample === 2) {
				goal.status = "complete"
				task["goalTurnCompletionText"] = "The goal is complete."
			}
			return {
				status: "completed",
				response: createAgentResponse([{ type: "text", text: sample === 1 ? "Progress." : "Final answer." }]),
			}
		})
		vi.mocked(runCompletionHooks).mockImplementation(async (_config, request) => {
			trace.push("hook")
			expect(sample).toBe(2)
			expect(request.last_assistant_message).toBe("The goal is complete.")
			return { warnings: [] }
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }])

		expect(task.isCompleted()).toBe(true)
		expect(task["runAgentRequests"]).toHaveBeenCalledTimes(2)
		expect(runCompletionHooks).toHaveBeenCalledOnce()
		expect(trace.indexOf("hook")).toBeGreaterThan(trace.indexOf("sample:2"))
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
