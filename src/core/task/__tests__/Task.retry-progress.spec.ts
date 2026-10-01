import { Task } from "../Task"
import { SearchLoopRecoveryPolicy } from "../../agent/SearchLoopRecoveryPolicy"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"

function retryTask() {
	const waits: number[] = []
	const task = Object.assign(Object.create(Task.prototype), {
		abort: false,
		taskCancellationController: new AbortController(),
		taskId: "retry-deadline",
		providerRef: { deref: () => ({ getState: async () => ({ requestDelaySeconds: 5 }) }) },
		appendAgentTurnEvent: vi.fn(async () => {}),
		say: vi.fn(async () => {}),
		getProviderRateLimitRemainingSeconds: vi.fn(async () => 0),
		waitForProviderPacingDelay: vi.fn(async (delay: number) => {
			waits.push(delay)
			vi.setSystemTime(Date.now() + delay)
		}),
	}) as Task
	return { task, waits }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

it("counts retry notification latency against the selected provider deadline", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const { task, waits } = retryTask()
	vi.mocked(task.say).mockImplementationOnce(async () => {
		vi.setSystemTime(10_000)
	})
	await Reflect.get(task, "waitForRetryDecision").call(
		task,
		{
			shouldRetry: true,
			attempt: 1,
			delayMs: 60_000,
			retryAt: 60_000,
		},
		new Error("Rate limited"),
	)
	expect(waits).toEqual([50_000])
	expect(Date.now()).toBe(60_000)
})

it("retains a selected sixty-second minimum in the compatibility countdown", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const { task, waits } = retryTask()
	vi.mocked(task.say).mockImplementationOnce(async () => {
		vi.setSystemTime(10_000)
	})
	await Reflect.get(task, "backoffAndAnnounce").call(
		task,
		0,
		{ status: 429, message: "Rate limited", retryAfterMs: 60_000 },
		undefined,
		undefined,
		60_000,
		60_000,
	)
	expect(waits.reduce((total, delay) => total + delay, 0)).toBe(50_000)
	expect(Date.now()).toBe(60_000)
})

it.each(["policy", "compatibility"] as const)(
	"resumes %s retries immediately when prior recovery or notification consumes the backoff",
	async (path) => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { task } = retryTask()
		// Exercise the real pacing boundary, where a zero remainder differs from an unspecified request timeout.
		Reflect.deleteProperty(task, "waitForProviderPacingDelay")
		vi.mocked(task.say).mockImplementationOnce(async () => {
			vi.setSystemTime(250)
		})
		const controller = new AbortController()
		const error = new Error("Context overflow")
		const operation =
			path === "policy"
				? Reflect.get(task, "waitForRetryDecision").call(
						task,
						{ shouldRetry: true, attempt: 1, delayMs: 200, retryAt: 200 },
						error,
						controller.signal,
						90_000,
					)
				: Reflect.get(task, "backoffAndAnnounce").call(task, 0, error, 90_000, controller.signal, 200, 200)
		let completed = false
		let failure: unknown
		const settled = operation.then(
			() => {
				completed = true
			},
			(error: unknown) => {
				failure = error
			},
		)
		try {
			await vi.advanceTimersByTimeAsync(0)
			expect(completed).toBe(true)
			expect(failure).toBeUndefined()
			expect(Date.now()).toBe(250)
			expect(task.say).toHaveBeenLastCalledWith("api_req_retry_delayed", "Context overflow\n", undefined, false)
		} finally {
			controller.abort(new Error("test cleanup"))
			await settled
		}
	},
)

it("waits only the remaining positive backoff at the real pacing boundary", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const { task } = retryTask()
	Reflect.deleteProperty(task, "waitForProviderPacingDelay")
	vi.mocked(task.say).mockImplementationOnce(async () => {
		vi.setSystemTime(100)
	})
	let completed = false
	const pending = Reflect.get(task, "waitForRetryDecision")
		.call(
			task,
			{ shouldRetry: true, attempt: 1, delayMs: 200, retryAt: 200 },
			new Error("Rate limited"),
			undefined,
			90_000,
		)
		.then(() => {
			completed = true
		})
	await vi.advanceTimersByTimeAsync(99)
	expect(completed).toBe(false)
	await vi.advanceTimersByTimeAsync(1)
	await pending
	expect(Date.now()).toBe(200)
	expect(task.say).toHaveBeenLastCalledWith("api_req_retry_delayed", "Rate limited\n", undefined, false)
})

it("still honors cancellation when the retry backoff is already consumed", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(250)
	const { task } = retryTask()
	Reflect.deleteProperty(task, "waitForProviderPacingDelay")
	const controller = new AbortController()
	const reason = new Error("cancelled after recovery")
	controller.abort(reason)
	await expect(Reflect.get(task, "waitForProviderPacingDelay").call(task, 0, controller.signal, 90_000)).rejects.toBe(
		reason,
	)
	expect(vi.getTimerCount()).toBe(0)
})

it("still exhausts an expired automatic budget when the retry backoff is already consumed", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(90_000)
	const { task } = retryTask()
	Reflect.deleteProperty(task, "waitForProviderPacingDelay")
	await expect(Reflect.get(task, "waitForProviderPacingDelay").call(task, 0, undefined, 90_000)).rejects.toThrow(
		"Automatic retry deadline exceeded",
	)
	expect(vi.getTimerCount()).toBe(0)
})

function searchTask() {
	return Object.assign(Object.create(Task.prototype), {
		toolRepetitionDetector: new ToolRepetitionDetector(),
		searchLoopRecoveryPolicy: new SearchLoopRecoveryPolicy(),
		lastSearchProgressVersion: 0,
		userMessageContent: [],
		suspendAfterCurrentTurn: vi.fn(),
	}) as Task
}

it("propagates a failed retry notification instead of returning early to another provider attempt", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const { task, waits } = retryTask()
	vi.mocked(task.say).mockRejectedValueOnce(new Error("retry notification write failed"))
	await expect(
		Reflect.get(task, "backoffAndAnnounce").call(
			task,
			0,
			{ status: 429, message: "Rate limited" },
			undefined,
			undefined,
			60_000,
			60_000,
		),
	).rejects.toThrow("retry notification write failed")
	expect(waits).toEqual([])
	expect(Date.now()).toBe(0)
})

function searchStep(task: Task, scope: string) {
	Reflect.get(task, "toolRepetitionDetector").recordOutcome({
		toolName: "search_files",
		kind: "read",
		status: "success",
		trustedProgress: { kind: "read", scope, stateFingerprint: "returned lines" },
	})
	Reflect.get(task, "observeSearchLoopStep").call(
		task,
		createAgentResponse([{ type: "tool_call", id: scope, name: "search_files", arguments: { regex: scope } }]),
	)
}

it("allows more than nine search steps when host-admitted read receipts keep progressing", () => {
	const task = searchTask()
	for (let step = 0; step < 24; step++) searchStep(task, `/workspace/file-${step}.ts`)
	expect(task.userMessageContent).toEqual([])
	expect(task.suspendAfterCurrentTurn).not.toHaveBeenCalled()
})

it("still pauses after nine searches without renewed admitted progress", () => {
	const task = searchTask()
	searchStep(task, "/workspace/same-file.ts")
	for (let step = 0; step < 9; step++) searchStep(task, "/workspace/same-file.ts")
	expect(task.userMessageContent).toHaveLength(2)
	expect(task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
})
