import { Task } from "../Task"
import {
	readCompletionHookConfig,
	runCompletionHooks,
	HookCommandCleanupError,
	type CompletionHookTarget,
} from "../../agent/CompletionHooks"

vi.mock("../../agent/CompletionHooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/CompletionHooks")>()),
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
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "hook-task",
		taskKind: target === "Stop" ? "primary" : "subagent",
		...(target === "SubagentStop" ? { parentTaskId: "parent-task", subagentGroupId: "group" } : {}),
		workspacePath: process.cwd(),
		abort: false,
		didComplete: false,
		completionHookActive: false,
		agentRunId: "hook-run",
		agentTurnId: "same-turn",
		providerRef: { deref: () => undefined },
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		currentAgentStep: {
			turnId: "same-turn",
			stepId: "original-step",
			snapshot: { context: { provider: { modelId: "fixture-model" } } },
		},
		completionHookTranscriptPath: vi.fn(async () => null),
		getStepApprovalMode: vi.fn(() => "ask"),
		getTaskLifetimeCancellationSignal: () => controller.signal,
		say: vi.fn(async () => undefined),
		publishLifecycleHookMessage: vi.fn(async (text: string) => task.say("text", text)),
	}) as Task
	vi.mocked(readCompletionHookConfig).mockReturnValue({
		stop: [{ command: process.execPath }],
		subagentStop: [{ command: process.execPath }],
	})
	return { task, controller }
}

beforeEach(() => vi.resetAllMocks())

describe("configured completion hook continuations", () => {
	it.each(["Stop", "SubagentStop"] as const)(
		"preserves more than three ordered %s blocks until the hook allows completion",
		async (target) => {
			const { task } = fixture(target)
			let invocation = 0
			vi.mocked(runCompletionHooks).mockImplementation(async () => {
				const number = ++invocation
				return number <= 4
					? {
							prompt: `Repair ${number}`,
							fragments: [{ hook_run_id: `hook-${number}`, text: `Repair ${number}` }],
							warnings: [],
						}
					: { warnings: [] }
			})
			const prompts = []
			for (let number = 1; number <= 4; number++) {
				const outcome = await task.evaluateCompletionHooks(`Candidate ${number}`)
				expect(outcome.prompt).toBe(`Repair ${number}`)
				expect(outcome.hookPrompt).toEqual({
					event: target,
					fragments: [{ hook_run_id: `hook-${number}`, text: `Repair ${number}` }],
				})
				prompts.push(outcome.prompt)
				expect(task.isCompleted()).toBe(false)
			}
			expect(await task.evaluateCompletionHooks("Final candidate")).toEqual({})
			expect(prompts).toEqual(["Repair 1", "Repair 2", "Repair 3", "Repair 4"])
			expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.stop_hook_active)).toEqual([
				false,
				true,
				true,
				true,
				true,
			])
			expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.turn_id)).toEqual(
				Array(5).fill("same-turn"),
			)
			expect(task.say).not.toHaveBeenCalled()
		},
	)

	it("discards a late blocking result when the user cancels its hook window", async () => {
		const { task, controller } = fixture()
		let entered!: () => void
		let finish!: () => void
		const started = new Promise<void>((resolve) => (entered = resolve))
		const barrier = new Promise<void>((resolve) => (finish = resolve))
		vi.mocked(runCompletionHooks).mockImplementation(async (_config, _request, signal) => {
			expect(signal).toBe(controller.signal)
			entered()
			await barrier
			return { prompt: "Late repair", fragments: [{ hook_run_id: "late", text: "Late repair" }], warnings: [] }
		})
		const evaluation = task.evaluateCompletionHooks("Candidate")
		await started
		controller.abort(new Error("user cancelled"))
		finish()
		expect(await evaluation).toEqual({})
		expect(task.isCompleted()).toBe(false)
		expect(task.say).not.toHaveBeenCalled()
	})

	it("retains a cancelled hook's failed cleanup and joins that owner before another hook admission", async () => {
		const { task, controller } = fixture()
		const entered = deferred()
		const fail = deferred()
		const physicalClose = deferred()
		const retry = vi.fn(async () => physicalClose.promise)
		const failure = new HookCommandCleanupError("Stop", retry, new Error("tree kill failed"))
		vi.mocked(runCompletionHooks).mockImplementation(async () => {
			entered.resolve()
			await fail.promise
			throw failure
		})
		const evaluation = task.evaluateCompletionHooks("Candidate")
		const rejected = expect(evaluation).rejects.toBe(failure)
		await entered.promise
		controller.abort()
		fail.resolve()
		await rejected
		expect(task["pendingHookCleanupFailures"]?.has(failure)).toBe(true)
		const settled = vi.fn()
		const retrying = task.evaluateCompletionHooks("Must not run another hook").then(settled)
		expect(retry).toHaveBeenCalledOnce()
		expect(settled).not.toHaveBeenCalled()
		physicalClose.resolve()
		await retrying
		expect(settled).toHaveBeenCalledExactlyOnceWith({})
		expect(runCompletionHooks).toHaveBeenCalledOnce()
		expect(task["pendingHookCleanupFailures"]?.size).toBe(0)
	})

	it("does not suppress typed cleanup owners inside a mixed aggregate after interruption", async () => {
		const { task, controller } = fixture()
		const failure = new HookCommandCleanupError(
			"Stop",
			vi.fn(async () => undefined),
			new Error("tree kill failed"),
		)
		const aggregate = new AggregateError([failure, new Error("other hook failure")], "hook failures")
		vi.mocked(runCompletionHooks).mockImplementation(async () => {
			controller.abort()
			throw aggregate
		})
		await expect(task.evaluateCompletionHooks("Candidate")).rejects.toBe(aggregate)
		expect(task["pendingHookCleanupFailures"]?.has(failure)).toBe(true)
	})

	it("retries physical cleanup during explicit Stop finalization without replaying a rejected hook producer", async () => {
		const { task, controller } = fixture()
		const physicalClose = deferred()
		const retryEntered = deferred()
		const retry = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("original process still lives"))
			.mockImplementationOnce(async () => {
				retryEntered.resolve()
				await physicalClose.promise
			})
		const failure = new HookCommandCleanupError("Stop", retry, new Error("tree kill failed"))
		Object.assign(task, {
			clineMessages: [],
			apiConversationHistory: [],
			taskCancellationController: controller,
			subagentRuntimeUnloadStarted: false,
			userMessageContent: [],
			canonicalLifecycleQueue: Promise.resolve(),
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			finishCanonicalLifecycleCancellation: vi.fn(async () => undefined),
			runTerminationLifecycleHooks: vi.fn(async () => undefined),
			finalizeAgentStopMessage: vi.fn(async () => undefined),
		})
		const lifecycle = Promise.reject(failure)
		const cancellation = {
			...task["captureTaskCancellationBoundary"](),
			lifecycle,
			guard: () => true,
		}
		await expect(task["finalizeTerminationAfterAbort"](Promise.resolve(), cancellation)).rejects.toBe(failure)
		expect(task["pendingHookCleanupFailures"]?.has(failure)).toBe(true)
		expect(task["runTerminationLifecycleHooks"]).not.toHaveBeenCalled()
		expect(task["finalizeAgentStopMessage"]).not.toHaveBeenCalled()
		const retrying = task["finalizeTerminationAfterAbort"](Promise.resolve(), cancellation)
		await retryEntered.promise
		expect(task["runTerminationLifecycleHooks"]).not.toHaveBeenCalled()
		physicalClose.resolve()
		await retrying
		expect(retry).toHaveBeenCalledTimes(2)
		expect(task["pendingHookCleanupFailures"]?.size).toBe(0)
		expect(task["runTerminationLifecycleHooks"]).toHaveBeenCalledOnce()
		expect(task["finalizeAgentStopMessage"]).toHaveBeenCalledOnce()
		expect(runCompletionHooks).not.toHaveBeenCalled()
	})

	it.each(["Stop", "SubagentStop"] as const)(
		"captures %s metadata before transcript preparation suspends",
		async (target) => {
			const { task } = fixture(target)
			const entered = deferred()
			const release = deferred()
			const originalCwd = task.cwd
			vi.mocked(task["completionHookTranscriptPath"]).mockImplementation(async () => {
				entered.resolve()
				await release.promise
				return null
			})
			vi.mocked(runCompletionHooks).mockResolvedValue({ warnings: [] })
			const evaluation = task.evaluateCompletionHooks("Original candidate")
			await entered.promise
			Object.assign(task, { workspacePath: `${originalCwd}-changed`, subagentRole: "review" })
			Object.assign(task["currentAgentStep"]!.snapshot.context.provider, { modelId: "changed-model" })
			vi.mocked(task.getStepApprovalMode).mockReturnValue("auto")
			release.resolve()

			expect(await evaluation).toEqual({})
			expect(runCompletionHooks).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				expect.objectContaining({
					hook_event_name: target,
					turn_id: "same-turn",
					cwd: originalCwd,
					model: "fixture-model",
					permission_mode: "ask",
					last_assistant_message: "Original candidate",
					...(target === "SubagentStop" ? { agent_type: "worker" } : {}),
				}),
				expect.any(AbortSignal),
			)
		},
	)

	it.each(["Stop", "SubagentStop"] as const)(
		"keeps %s transcript preparation cancellable without waiting for the filesystem",
		async (target) => {
			for (const cancellation of ["task", "steering"] as const) {
				const { task, controller } = fixture(target)
				const stepInterruption = new AbortController()
				if (cancellation === "steering") Object.assign(task, { stepInterruptionController: stepInterruption })
				const entered = deferred()
				const release = deferred()
				const waitForControl = vi.fn(task["waitForRequestControl"].bind(task))
				Object.assign(task, { waitForRequestControl: waitForControl })
				vi.mocked(task["completionHookTranscriptPath"]).mockImplementation(async (taskId) => {
					if (taskId !== task.taskId) return null
					entered.resolve()
					await release.promise
					return null
				})
				const evaluation = task.evaluateCompletionHooks("Candidate")
				await entered.promise
				try {
					// Assert the controlled boundary before cancellation so a regression
					// cannot leave this test waiting on its deliberately held filesystem.
					expect(waitForControl).toHaveBeenCalled()
					if (cancellation === "steering") {
						Object.assign(task, { pendingSteerMessage: { text: "New request", inputOrigin: "human" } })
						stepInterruption.abort(new Error("Steered by user"))
					} else controller.abort(new Error("Cancelled by user"))
					expect(await evaluation).toEqual({})
					expect(runCompletionHooks).not.toHaveBeenCalled()
					expect(task.say).not.toHaveBeenCalled()
					expect(task["pendingCompletionHookPrompt"]).toBeUndefined()
					expect(task["completionHookActive"]).toBe(false)
					if (cancellation === "steering") expect(task.hasPendingSteerMessage()).toBe(true)
				} finally {
					release.resolve()
					await evaluation.catch(() => undefined)
				}
			}
		},
	)

	it.each(["transcript", "hook", "warning"] as const)(
		"discards completion-hook work after step ownership changes during %s",
		async (boundary) => {
			for (const target of ["Stop", "SubagentStop"] as const) {
				const { task } = fixture(target)
				const entered = deferred()
				const release = deferred()
				const hold = async () => {
					entered.resolve()
					await release.promise
				}
				vi.mocked(task["completionHookTranscriptPath"]).mockImplementation(async () => {
					if (boundary === "transcript") await hold()
					return null
				})
				vi.mocked(runCompletionHooks).mockImplementation(async () => {
					if (boundary === "hook") await hold()
					return {
						warnings: ["First warning", "Second warning"],
						prompt: "Stale repair",
						fragments: [{ hook_run_id: "stale", text: "Stale repair" }],
					}
				})
				vi.mocked(task.say).mockImplementation(async () => {
					if (boundary === "warning") await hold()
				})
				const evaluation = task.evaluateCompletionHooks("Candidate")
				await entered.promise
				task["currentAgentStep"] = { ...task["currentAgentStep"]!, stepId: "replacement-step" }
				const rejected = expect(evaluation).rejects.toMatchObject({ name: "AbortError" })
				release.resolve()
				await rejected

				expect(task["completionHookActive"]).toBe(false)
				expect(task["pendingCompletionHookPrompt"]).toBeUndefined()
				if (boundary === "transcript") expect(runCompletionHooks).not.toHaveBeenCalled()
				if (boundary === "warning")
					expect(task.say).toHaveBeenCalledExactlyOnceWith("text", "Warning: First warning")
				else expect(task.say).not.toHaveBeenCalled()
			}
		},
	)
})
