import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => {
		resolve = finish
	})
	return { promise, resolve }
}

function createCompactionBoundary() {
	const entered = deferred()
	const release = deferred()
	const lifetime = new AbortController()
	let capturedSignal: AbortSignal | undefined
	const condense = vi.fn(async (signal: AbortSignal) => {
		capturedSignal = signal
		entered.resolve()
		await release.promise
	})
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "post-turn-followup-investigation",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		isTaskLoopActive: true,
		isAgentTurnEngineActive: true,
		isStreaming: false,
		taskCancellationController: lifetime,
		currentRequestAbortController: new AbortController(),
		stepInterruptionController: new AbortController(),
		messageQueueService: new MessageQueueService(),
		providerRef: {
			deref: () => ({
				getState: async () => ({ autoCondenseContext: true, postTurnCondenseContextPercent: 80 }),
			}),
		},
		api: {},
		apiConfiguration: {},
		reasoningHandlerUsers: new Map(),
		prepareCapturedReasoning: vi.fn(async () => undefined),
		retireReasoningHandler: vi.fn(),
		condenseContextWithSignal: condense,
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
	}) as Task
	const boundary = task as unknown as { maybeCompactAfterTurn(): Promise<void> }
	return { task, boundary, entered, release, lifetime, condense, signal: () => capturedSignal }
}

afterEach(() => vi.restoreAllMocks())

it("accepts steering without interrupting an already started post-turn compaction", async () => {
	const fixture = createCompactionBoundary()
	const compacting = fixture.boundary.maybeCompactAfterTurn()
	await fixture.entered.promise
	await fixture.task.steerUserMessage("Follow up on the launched site in this chat.")
	const interrupted = fixture.signal()!.aborted
	fixture.release.resolve()
	await compacting
	expect(interrupted).toBe(false)
	expect(fixture.task.hasPendingSteerMessage()).toBe(true)
})

it("propagates task cancellation to post-turn compaction", async () => {
	const fixture = createCompactionBoundary()
	const compacting = fixture.boundary.maybeCompactAfterTurn()
	await fixture.entered.promise
	fixture.lifetime.abort(new Error("User stopped the task"))
	expect(fixture.signal()!.aborted).toBe(true)
	fixture.release.resolve()
	await compacting
})

it("skips optional post-turn compaction when follow-up input is already pending", async () => {
	const fixture = createCompactionBoundary()
	fixture.task.messageQueueService.addMessage("Continue with the next change.")
	await fixture.boundary.maybeCompactAfterTurn()
	expect(fixture.condense).not.toHaveBeenCalled()
})
