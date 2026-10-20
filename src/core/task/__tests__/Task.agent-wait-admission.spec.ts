import { Task } from "../Task"

function runningTask() {
	const request = new AbortController()
	const lifetime = new AbortController()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "agent-wait-admission",
		taskKind: "primary",
		abort: false,
		abandoned: false,
		didComplete: false,
		isTaskLoopActive: true,
		currentRequestAbortController: request,
		taskCancellationController: lifetime,
		agentMessageAdmissions: new Set(),
		agentMessageInbox: { receive: vi.fn(async () => undefined) },
		invalidateGoalContinuation: vi.fn(),
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
	}) as Task
	return { task, request, lifetime }
}

describe("Task agent wait admission", () => {
	it.each(["human", "agent"] as const)("retains %s steering that arrives before a wait opens", async (origin) => {
		const { task, request, lifetime } = runningTask()
		if (origin === "human") await task.steerUserMessage("Use the new guidance.")
		else {
			await expect(
				task.steerAgentMessage({ id: "guidance", senderTaskId: "peer", text: "Use the new guidance." }),
			).resolves.toBe("steered")
		}
		expect(request.signal.aborted).toBe(true)
		const pendingSteer = task["pendingSteerMessage"]
		expect(pendingSteer?.inputOrigin).toBe(origin)

		const wait = task.beginAgentWait()
		try {
			expect(wait.signal.aborted).toBe(true)
			expect(wait.signal.reason).toMatchObject({ name: "SteerRequestInterruptError" })
			expect(task["pendingSteerMessage"]).toBe(pendingSteer)
			expect(task.hasPendingSteerMessage()).toBe(true)
			expect(lifetime.signal.aborted).toBe(false)
		} finally {
			wait.dispose()
		}
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})

	it("keeps a wait independent of a preceding provider response's cancellation", () => {
		const { task, request } = runningTask()
		request.abort(new Error("The preceding provider response ended"))
		const wait = task.beginAgentWait()
		try {
			expect(wait.signal.aborted).toBe(false)
		} finally {
			wait.dispose()
		}
	})

	it("preserves task cancellation when steering is also pending", async () => {
		const { task, lifetime } = runningTask()
		await task.steerUserMessage("Use the new guidance.")
		const reason = new Error("The task was stopped")
		lifetime.abort(reason)
		const wait = task.beginAgentWait()
		try {
			expect(wait.signal.aborted).toBe(true)
			expect(wait.signal.reason).toBe(reason)
		} finally {
			wait.dispose()
		}
	})

	it("does not let an older disposed wait release the current lease", () => {
		const { task, lifetime } = runningTask()
		const older = task.beginAgentWait()
		const current = task.beginAgentWait()
		expect(older.signal.aborted).toBe(true)
		older.dispose()
		const reason = new Error("The task was stopped")
		lifetime.abort(reason)
		expect(current.signal.aborted).toBe(true)
		expect(current.signal.reason).toBe(reason)
		current.dispose()
		expect(task["agentWaitAbortController"]).toBeUndefined()
	})
})
