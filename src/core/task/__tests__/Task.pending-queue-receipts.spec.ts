import type { Anthropic } from "@anthropic-ai/sdk"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))

type Content = Anthropic.Messages.ContentBlockParam[]
const stopBeforeProvider = new Error("fixture: stop before provider request")

function harness() {
	const queue = new MessageQueueService()
	const persisted: ApiMessage[][] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "queue-task",
		instanceId: "queue-instance",
		taskKind: "primary",
		abort: false,
		// Object.create bypasses Task's field initializers, including lifetime cancellation ownership.
		taskCancellationController: new AbortController(),
		didComplete: false,
		clineMessages: [],
		apiConversationHistory: [],
		isTaskLoopActive: false,
		requestPacingWaitCount: 0,
		apiConfiguration: { apiProvider: "openai" },
		messageQueueService: queue,
		providerRef: { deref: () => undefined },
		getTaskMode: vi.fn(async () => "code"),
		mergePendingToolResultsIntoUserContent: vi.fn((content: Content) => content),
		getPendingSpawnedSubagentResults: vi.fn(() => []),
		buildUserContentWithPendingSpawnedSubagentResults: vi.fn((content: Content) => ({
			content,
			pendingResults: [],
		})),
		retryPendingAutomaticResultClaimSettlement: vi.fn(async () => undefined),
		markSpawnedSubagentResultsDelivered: vi.fn(async () => undefined),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw stopBeforeProvider
		}),
		retrySaveApiConversationHistory: vi.fn(async () => false),
		addToApiConversationHistory: vi.fn((message: ApiMessage, _reasoning: unknown, onPersisted?: () => void) => {
			task.apiConversationHistory.push(message)
			persisted.push(structuredClone(task.apiConversationHistory))
			onPersisted?.()
			return Promise.resolve(true)
		}),
	}) as Task
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({
		details: "<environment_details>baseline</environment_details>",
		commit: vi.fn(),
		release: vi.fn(),
	} as any)
	return { task, queue, persisted }
}

afterEach(() => vi.restoreAllMocks())

it("consumes a selected instruction after mention transformation replaces its block identities", async () => {
	const { task, queue, persisted } = harness()
	const message = queue.addMessage("TRANSFORMED_INPUT")!
	queue.claimMessage(message.id)
	const content = task["buildUserMessageContent"](message.text, message.images, [message.id])
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({
		content: structuredClone(userContent),
	}))
	await expect(task.runAgentRequests(content, false)).rejects.toBe(stopBeforeProvider)
	expect(persisted[0].at(-1)?.queued_message_ids).toEqual([message.id])
	expect(queue.getClaimedMessageIds()).toEqual([])
})

it("does not consume a tool reply until its actual call ID appears in the committed input", async () => {
	const { task, queue, persisted } = harness()
	const message = queue.addMessage("TOOL_REPLY")!
	queue.claimMessage(message.id)
	task.retainQueuedMessageToolReply("approval-call", message)
	await expect(
		task.runAgentRequests([{ type: "tool_result", tool_use_id: "other-call", content: "other output" }], false),
	).rejects.toBe(stopBeforeProvider)
	expect(persisted[0].at(-1)?.queued_message_ids).toBeUndefined()
	expect(queue.getClaimedMessageIds()).toEqual([message.id])
	await expect(
		task.runAgentRequests(
			[{ type: "tool_result", tool_use_id: "approval-call", content: "denied", is_error: true }],
			false,
		),
	).rejects.toBe(stopBeforeProvider)
	expect(persisted[1].at(-1)?.queued_message_ids).toEqual([message.id])
	expect(JSON.stringify(persisted[1].at(-1)?.content)).toContain(message.text)
	expect(queue.getClaimedMessageIds()).toEqual([])
})

it("merges durable steering accepted while mention transformation is pending before consuming it", async () => {
	const { task, queue, persisted } = harness()
	let entered!: () => void
	const transforming = new Promise<void>((resolve) => {
		entered = resolve
	})
	let finish!: () => void
	const barrier = new Promise<void>((resolve) => {
		finish = resolve
	})
	vi.mocked(processUserContentMentions).mockImplementationOnce(async ({ userContent }) => {
		entered()
		await barrier
		return { content: structuredClone(userContent) }
	})
	const running = task.runAgentRequests([{ type: "text", text: "INITIAL" }], false)
	const stopped = running.then(
		() => ({ status: "fulfilled" as const }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	)
	try {
		await Promise.race([
			transforming,
			stopped.then((result) => {
				if (result.status === "rejected") throw result.error
				throw new Error("Agent request completed before entering the mention barrier")
			}),
		])
		await task.steerUserMessageDurably("STEER_DURING_TRANSFORM", [], "steer-transform")
		expect(queue.getClaimedMessageIds()).toEqual(["steer-transform"])
	} finally {
		finish()
	}
	const result = await stopped
	if (result.status === "fulfilled") throw new Error("Agent request did not reject at the fixture provider boundary")
	expect(result.error).toBe(stopBeforeProvider)
	expect(persisted).toHaveLength(1)
	expect(persisted[0].at(-1)?.queued_message_ids).toEqual(["steer-transform"])
	expect(JSON.stringify(persisted[0].at(-1)?.content)).toContain("STEER_DURING_TRANSFORM")
	expect(queue.getClaimedMessageIds()).toEqual([])
})

it("returns accepted steering retries without interrupting or admitting another copy", async () => {
	const { task, queue } = harness()
	Object.assign(task, { taskKind: "subagent", isInitialized: false, emit: vi.fn() })
	await task.steerUserMessageDurably("ONCE", [], "accepted-request")
	expect(task.canAcceptSteerMessage()).toBe(false)
	await task.steerUserMessageDurably("ONCE", [], "accepted-request")
	expect(queue.getClaimedMessageIds()).toEqual(["accepted-request"])
	expect(task["emit"]).toHaveBeenCalledOnce()
})

it("releases a selected steer if queue persistence fails before handoff", async () => {
	const { task, queue } = harness()
	const message = queue.addMessage("RECOVERABLE_STEER")!
	vi.spyOn(queue, "flush").mockRejectedValueOnce(new Error("queue admission failed"))
	const steer = vi.spyOn(task, "steerUserMessage")
	await expect(task.steerQueuedUserMessage(message.id)).rejects.toThrow("queue admission failed")
	expect(steer).not.toHaveBeenCalled()
	expect(queue.messages).toEqual([message])
	expect(queue.getClaimedMessageIds()).toEqual([])
})

it("reactivates the retained queue and releases only uncommitted selections", async () => {
	const { task, queue } = harness()
	const consumed = queue.addMessage("CONSUMED")!
	const pending = queue.addMessage("PENDING")!
	queue.claimMessage(consumed.id)
	queue.claimMessage(pending.id)
	task.apiConversationHistory.push({ role: "user", content: consumed.text, queued_message_ids: [consumed.id] })
	queue.dispose()
	await task["prepareForRetainedLifecycle"]()
	expect(queue.messages).toEqual([pending])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(queue.addMessage("FOLLOWUP")).toBeDefined()
})

it("persists host agent origin alongside queued receipt metadata", async () => {
	const { task, persisted } = harness()
	await expect(
		task.runAgentRequests([{ type: "text", text: "SYNTHETIC_AGENT_FOLLOWUP" }], false, undefined, {
			inputOrigin: "agent",
		}),
	).rejects.toBe(stopBeforeProvider)
	expect(persisted[0].at(-1)?.input_origin).toBe("agent")
})

it("keeps passive host sends durable while a live turn owns the input boundary", async () => {
	const { task, queue } = harness()
	Object.assign(task, { providerRef: { deref: () => ({}) }, isTaskLoopActive: true, isStreaming: true })
	const interrupt = new AbortController()
	task["currentRequestAbortController"] = interrupt
	await task.submitUserMessage("PASSIVE_HOST_INPUT")
	expect(queue.messages).toMatchObject([{ text: "PASSIVE_HOST_INPUT" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(interrupt.signal.aborted).toBe(false)
	expect(task["askResponse"]).toBeUndefined()
})

it("queues host input during a typed approval without approving the tool", async () => {
	const { task, queue } = harness()
	Object.assign(task, {
		providerRef: { deref: () => ({}) },
		activeAsk: { type: "tool", ts: 101 },
		activeToolApprovalRequest: { requestId: "approval" },
	})
	await task.submitUserMessage("GUIDANCE_WITHOUT_APPROVAL")
	expect(queue.messages).toMatchObject([{ text: "GUIDANCE_WITHOUT_APPROVAL" }])
	expect(task["askResponse"]).toBeUndefined()
})

it("queues a second host reply rather than replacing an accepted first reply", async () => {
	const { task, queue } = harness()
	Object.assign(task, {
		providerRef: { deref: () => ({}) },
		activeAsk: { type: "followup", ts: 101 },
		askResponse: "messageResponse",
		askResponseText: "FIRST",
	})
	await task.submitUserMessage("SECOND")
	expect(queue.messages).toMatchObject([{ text: "SECOND" }])
	expect(task["askResponseText"]).toBe("FIRST")
})

it("does not answer a replacement ask that opens while durable admission is pending", async () => {
	const { task } = harness()
	let entered!: () => void
	const admissionStarted = new Promise<void>((resolve) => {
		entered = resolve
	})
	let finish!: () => void
	const admissionBarrier = new Promise<void>((resolve) => {
		finish = resolve
	})
	const queue = new MessageQueueService({
		load: async () => [],
		save: async () => {
			entered()
			await admissionBarrier
		},
	})
	Object.assign(task, {
		messageQueueService: queue,
		providerRef: { deref: () => ({}) },
		activeAsk: { type: "followup", ts: 101 },
	})
	const response = vi.spyOn(task, "handleWebviewAskResponse")
	const admission = task.submitUserMessage("INPUT_FOR_FIRST_ASK")
	await admissionStarted
	task["activeAsk"] = { type: "followup", ts: 102 }
	finish()
	await admission
	expect(response).not.toHaveBeenCalled()
	expect(queue.messages).toMatchObject([{ text: "INPUT_FOR_FIRST_ASK" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
})

it("releases ask selection to the durable FIFO when the claim snapshot fails", async () => {
	const { task } = harness()
	let writes = 0
	const snapshots: unknown[] = []
	const queue = new MessageQueueService({
		load: async () => [],
		save: async (messages) => {
			if (++writes === 2) throw new Error("claim snapshot failed")
			snapshots.push(structuredClone(messages))
		},
	})
	Object.assign(task, {
		messageQueueService: queue,
		providerRef: { deref: () => ({}) },
		activeAsk: { type: "followup", ts: 101 },
	})
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
	const response = vi.spyOn(task, "handleWebviewAskResponse")
	await expect(task.submitUserMessage("DURABLE_QUEUE_FALLBACK")).resolves.toBeUndefined()
	expect(response).not.toHaveBeenCalled()
	expect(queue.messages).toMatchObject([{ text: "DURABLE_QUEUE_FALLBACK" }])
	expect(queue.getClaimedMessageIds()).toEqual([])
	expect(snapshots.at(-1)).toEqual(queue.messages)
	expect(warning).toHaveBeenCalledWith(expect.stringContaining("reply selection failed"))
})

it("preserves the original transcript until a consumed wait receipt settles before replacement", async () => {
	const { task } = harness()
	const original: ApiMessage[] = [
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "wait-call",
					content: JSON.stringify({ completion_receipt_id: "wait-receipt" }),
				},
			],
		},
	]
	task.apiConversationHistory = original
	let saveEntered!: () => void
	const saving = new Promise<void>((resolve) => {
		saveEntered = resolve
	})
	let releaseSave!: () => void
	const saveBarrier = new Promise<void>((resolve) => {
		releaseSave = resolve
	})
	const pendingSave = task["enqueueApiConversationHistoryPersistence"](async () => {
		saveEntered()
		await saveBarrier
	})
	await saving
	let entered!: () => void
	const settling = new Promise<void>((resolve) => {
		entered = resolve
	})
	let fail!: (error: Error) => void
	const barrier = new Promise<void>((_resolve, reject) => {
		fail = reject
	})
	const settle = vi.fn(async () => {
		entered()
		await barrier
	})
	Object.assign(task, {
		providerRef: { deref: () => ({ settleIndependentTaskWaitReceiptsForParent: settle }) },
		environmentContext: { reset: vi.fn() },
		saveApiConversationHistory: vi.fn(async () => true),
	})
	const summary: ApiMessage[] = [{ role: "user", content: "summary", isSummary: true }]
	const replacing = task.overwriteApiConversationHistory(summary)
	const rejected = expect(replacing).rejects.toThrow("wait receipt commit failed")
	await Promise.resolve()
	expect(settle).not.toHaveBeenCalled()
	expect(task.apiConversationHistory).toBe(original)
	releaseSave()
	await pendingSave
	await settling
	expect(task.apiConversationHistory).toBe(original)
	expect(task["saveApiConversationHistory"]).not.toHaveBeenCalled()
	fail(new Error("wait receipt commit failed"))
	await rejected
	expect(task.apiConversationHistory).toBe(original)
	expect(task["environmentContext"].reset).not.toHaveBeenCalled()
	expect(task["saveApiConversationHistory"]).not.toHaveBeenCalled()
	settle.mockImplementation(async () => {})
	await expect(task.overwriteApiConversationHistory(summary)).resolves.toBe(true)
	expect(settle).toHaveBeenCalledWith(task.taskId)
	expect(task.apiConversationHistory).toEqual([{ ...summary[0], input_origin: "agent" }])
	expect(task["saveApiConversationHistory"]).toHaveBeenCalledOnce()
})

it("does not consume another boundary's claimed instruction when committing unrelated input", async () => {
	const { task, queue, persisted } = harness()
	const queued = queue.addMessage("QUEUED_INSTRUCTION_NOT_IN_THIS_INPUT")!
	queue.claimMessage(queued.id)
	await expect(task.runAgentRequests([{ type: "text", text: "CURRENT_INPUT" }], false)).rejects.toBe(
		stopBeforeProvider,
	)
	expect(persisted).toHaveLength(1)
	expect(JSON.stringify(persisted[0])).not.toContain(queued.text)
	expect(persisted[0].flatMap((message) => message.queued_message_ids ?? [])).not.toContain(queued.id)
	expect(queue.getClaimedMessageIds()).toEqual([queued.id])
})

it("acknowledges only explicitly containing queued IDs after the transcript commit", async () => {
	const { task, queue, persisted } = harness()
	const first = queue.addMessage("FIRST_QUEUED_INSTRUCTION")!
	const second = queue.addMessage("SECOND_QUEUED_INSTRUCTION")!
	queue.claimMessage(first.id)
	queue.claimMessage(second.id)
	const acknowledge = vi.spyOn(queue, "acknowledgeMessages")
	await task["persistUserContentWithEnvironment"](
		[{ type: "text", text: first.text }],
		undefined,
		undefined,
		undefined,
		undefined,
		[first.id],
	)
	expect(persisted[0].at(-1)).toMatchObject({
		role: "user",
		content: [{ type: "text", text: first.text }],
		queued_message_ids: [first.id],
	})
	expect(acknowledge).toHaveBeenCalledExactlyOnceWith([first.id])
	expect(queue.getClaimedMessageIds()).toEqual([second.id])
})

it("keeps a selected instruction recoverable when user transcript persistence fails", async () => {
	const { task, queue } = harness()
	const queued = queue.addMessage("RETAIN_ME")!
	queue.claimMessage(queued.id)
	vi.mocked(task["addToApiConversationHistory"]).mockImplementationOnce(async (message) => {
		task.apiConversationHistory.push(message)
		return false
	})
	await expect(
		task["persistUserContentWithEnvironment"](
			[{ type: "text", text: queued.text }],
			undefined,
			undefined,
			undefined,
			undefined,
			[queued.id],
		),
	).rejects.toThrow("Failed to persist the user turn")
	expect(task.apiConversationHistory).toEqual([])
	expect(queue.getClaimedMessageIds()).toEqual([queued.id])
})

it("keeps the committed receipt after queue deletion fails, allowing reload deduplication", async () => {
	const { task, queue, persisted } = harness()
	const queued = queue.addMessage("SAVE_BEFORE_ACK")!
	queue.claimMessage(queued.id)
	vi.spyOn(queue, "flush").mockRejectedValueOnce(new Error("queue snapshot failed"))
	await expect(
		task["persistUserContentWithEnvironment"](
			[{ type: "text", text: queued.text }],
			undefined,
			undefined,
			undefined,
			undefined,
			[queued.id],
		),
	).rejects.toThrow("queue snapshot failed")
	expect(task.apiConversationHistory).toEqual(persisted[0])
	expect(task.apiConversationHistory.at(-1)?.queued_message_ids).toEqual([queued.id])
})
