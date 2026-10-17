import type { Anthropic } from "@anthropic-ai/sdk"
import type { QueuedMessage } from "@alpha-code/types"

import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))

const stopBeforeProvider = new Error("fixture: provider boundary reached")
const queueDeletionFailure = new Error("fixture: queued input deletion failed after transcript commit")

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

async function harness(failDeletion = true) {
	let storedQueue: QueuedMessage[] = []
	let failNextDeletion = failDeletion
	const queue = new MessageQueueService({
		load: async () => [],
		save: async (messages) => {
			if (messages.length === 0 && failNextDeletion) {
				failNextDeletion = false
				throw queueDeletionFailure
			}
			storedQueue = structuredClone([...messages])
		},
	})
	await queue.ready
	const message = (await queue.addMessageDurably("Keep the failing case in the report.", [], "human-reply"))!
	queue.claimMessage(message.id)
	await queue.flush()
	const persisted: ApiMessage[][] = []
	const result: Anthropic.ToolResultBlockParam = {
		type: "tool_result",
		tool_use_id: "cancelled-call",
		content: "Tool execution was cancelled before completion.",
		is_error: true,
	}
	const saveApiConversationHistory = vi.fn(async () => {
		persisted.push(structuredClone(task.apiConversationHistory))
		return true
	})
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "result-ack-durability",
		instanceId: "result-ack-instance",
		taskKind: "primary",
		abort: false,
		didComplete: false,
		isTaskLoopActive: false,
		requestPacingWaitCount: 0,
		taskCancellationController: new AbortController(),
		assistantMessageSavedToHistory: true,
		persistedToolResultIds: new Set<string>(),
		pendingWaitAgentNotificationBlocks: new Set(),
		pendingWaitAgentResultClaims: new Map(),
		userMessageContent: [result],
		clineMessages: [],
		apiConfiguration: { apiProvider: "openai" },
		apiConversationHistory: [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: result.tool_use_id, name: "exec_command", input: {} }],
			},
		] as ApiMessage[],
		messageQueueService: queue,
		providerRef: { deref: () => undefined },
		getTaskMode: vi.fn(async () => "code"),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw stopBeforeProvider
		}),
		retrySaveApiConversationHistory: vi.fn(async () => false),
		saveApiConversationHistory,
		addToApiConversationHistory: vi.fn(async (entry: ApiMessage, _reasoning: unknown, onPersisted?: () => void) => {
			task.apiConversationHistory.push(entry)
			const saved = await saveApiConversationHistory()
			if (saved) onPersisted?.()
			return saved
		}),
		// Resource adapters are inert; abortTask and its termination/receipt sequencing remain real.
		failActiveCommandExecutions: vi.fn(),
		cancelCurrentRequest: vi.fn(),
		flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
		invalidateStreamingPreviewEpoch: vi.fn(),
		drainStreamingPreviews: vi.fn(async () => undefined),
		releaseSubagentReviewBarrierIfSettled: vi.fn(),
		stopActiveTaskCommands: vi.fn(async () => undefined),
		emitFinalTokenUsageUpdate: vi.fn(),
		emit: vi.fn(),
		dispose: vi.fn(),
		saveAlphaMessages: vi.fn(async () => true),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		flushAgentTurnEvents: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
		finishCanonicalLifecycleCancellation: vi.fn(async () => undefined),
	}) as Task
	task.retainQueuedMessageToolResult(result.tool_use_id, [message.id], [{ type: "text", text: message.text }])
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit: vi.fn(), release: vi.fn() })
	return { task, queue, message, result, persisted, saveApiConversationHistory, storedQueue: () => storedQueue }
}

function toolResults(history: ApiMessage[]) {
	return history
		.flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
		.filter((block) => block.type === "tool_result")
}

function guidanceOccurrences(history: ApiMessage[], text: string) {
	return history
		.flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
		.filter((block) => block.type === "text" && block.text === text).length
}

afterEach(() => vi.restoreAllMocks())

it("does not duplicate a durable cancelled result when abort finalization retries after queue ACK failure", async () => {
	const fixture = await harness()
	await expect(fixture.task.flushPendingToolResultsToHistory({ allowAborted: true })).rejects.toBe(
		queueDeletionFailure,
	)
	expect(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
	expect(fixture.persisted.at(-1)!.at(-1)?.queued_message_ids).toEqual([fixture.message.id])
	await fixture.task.abortTask()
	await fixture.task.waitForTermination()
	await fixture.queue.flush()
	expect(fixture.storedQueue()).toEqual([])
	expect.soft(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
	expect.soft(guidanceOccurrences(fixture.persisted.at(-1)!, fixture.message.text)).toBe(1)
})

it("does not replay a durable tool reply into the next recovery request after queue ACK failure", async () => {
	const fixture = await harness()
	await expect(fixture.task.flushPendingToolResultsToHistory()).rejects.toBe(queueDeletionFailure)
	await fixture.queue.flush()
	await expect(
		fixture.task.runAgentRequests([{ type: "text", text: "Continue after the save recovered." }]),
	).rejects.toBe(stopBeforeProvider)
	expect.soft(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
	expect.soft(guidanceOccurrences(fixture.persisted.at(-1)!, fixture.message.text)).toBe(1)
	expect(fixture.storedQueue()).toEqual([])
})

it("acknowledges a durable follow-up before its queue deletion can fail", async () => {
	const fixture = await harness()
	fixture.task.userMessageContent = []
	const acknowledging = deferred()
	const finishAcknowledgment = deferred()
	const onPersisted = vi.fn(async () => {
		acknowledging.resolve()
		await finishAcknowledgment.promise
	})
	const running = expect(
		fixture.task.runAgentRequests([{ type: "text", text: fixture.message.text }], false, onPersisted, {
			queuedMessageIds: [fixture.message.id],
			inputOrigin: "human",
		}),
	).rejects.toBe(queueDeletionFailure)
	await acknowledging.promise
	expect(fixture.storedQueue()).toEqual([fixture.message])
	finishAcknowledgment.resolve()
	await running

	expect(fixture.persisted.at(-1)?.at(-1)?.queued_message_ids).toEqual([fixture.message.id])
	expect(onPersisted).toHaveBeenCalledOnce()
	await fixture.queue.flush()
	expect(fixture.storedQueue()).toEqual([])
})

it("retains unsaved follow-up input without acknowledging admission", async () => {
	const fixture = await harness(false)
	fixture.task.userMessageContent = []
	fixture.saveApiConversationHistory.mockResolvedValueOnce(false)
	const onPersisted = vi.fn()
	await expect(
		fixture.task.runAgentRequests([{ type: "text", text: fixture.message.text }], false, onPersisted, {
			queuedMessageIds: [fixture.message.id],
			inputOrigin: "human",
		}),
	).rejects.toThrow("Failed to persist the user turn")

	expect(onPersisted).not.toHaveBeenCalled()
	expect(fixture.queue.getClaimedMessageIds()).toEqual([fixture.message.id])
	expect(fixture.storedQueue()).toEqual([fixture.message])
	expect(fixture.task.apiConversationHistory).toHaveLength(1)
	expect(fixture.persisted).toEqual([])
})

it("reports a rejected admission acknowledgment while keeping the durable input receipt", async () => {
	const fixture = await harness(false)
	fixture.task.userMessageContent = []
	const acknowledgmentFailure = new Error("fixture: follow-up admission acknowledgment failed")
	await expect(
		fixture.task.runAgentRequests(
			[{ type: "text", text: fixture.message.text }],
			false,
			async () => {
				throw acknowledgmentFailure
			},
			{ queuedMessageIds: [fixture.message.id], inputOrigin: "human" },
		),
	).rejects.toBe(acknowledgmentFailure)

	expect(fixture.persisted.at(-1)?.at(-1)?.queued_message_ids).toEqual([fixture.message.id])
	expect(fixture.queue.getClaimedMessageIds()).toEqual([fixture.message.id])
	expect(fixture.storedQueue()).toEqual([fixture.message])
})

it("does not replay pending tool results saved by a normal request when queue deletion fails", async () => {
	const fixture = await harness()
	await expect(fixture.task.runAgentRequests([{ type: "text", text: "Continue." }])).rejects.toBe(
		queueDeletionFailure,
	)
	expect(fixture.task.userMessageContent).toEqual([])
	await fixture.queue.flush()
	await expect(fixture.task.runAgentRequests([{ type: "text", text: "Try again." }])).rejects.toBe(stopBeforeProvider)
	expect(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
	expect(guidanceOccurrences(fixture.persisted.at(-1)!, fixture.message.text)).toBe(1)
})

it.each(["append", "prepend"] as const)(
	"retires only the saved snapshot before queue ACK fails with concurrent %s content",
	async (position) => {
		const fixture = await harness()
		const saving = deferred()
		const finishSave = deferred()
		const savedNotification: Anthropic.Messages.TextBlockParam = { type: "text", text: "Saved notification" }
		const laterNotification: Anthropic.Messages.TextBlockParam = { type: "text", text: "Later notification" }
		const laterResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "later-call",
			content: "Later result",
		}
		const pendingNotifications = new Set([savedNotification])
		Object.assign(fixture.task, { pendingWaitAgentNotificationBlocks: pendingNotifications })
		fixture.task.userMessageContent.push(savedNotification)
		const save = fixture.saveApiConversationHistory.getMockImplementation()!
		fixture.saveApiConversationHistory.mockImplementationOnce(async () => {
			const saved = await save()
			saving.resolve()
			await finishSave.promise
			return saved
		})
		const flushing = expect(fixture.task.flushPendingToolResultsToHistory()).rejects.toBe(queueDeletionFailure)
		await saving.promise
		pendingNotifications.add(laterNotification)
		const laterContent = [laterResult, laterNotification]
		fixture.task.userMessageContent =
			position === "append"
				? [...fixture.task.userMessageContent, ...laterContent]
				: [...laterContent, ...fixture.task.userMessageContent]
		finishSave.resolve()
		await flushing

		expect(fixture.task.userMessageContent).toEqual(laterContent)
		expect(pendingNotifications).toEqual(new Set([laterNotification]))
		expect(fixture.task.pushToolResultToUserContent(structuredClone(fixture.result))).toBe(false)
		expect(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
		await fixture.queue.flush()
		expect(fixture.storedQueue()).toEqual([])
	},
)

it("retains an unsaved result and queued reply until a transcript save actually succeeds", async () => {
	const fixture = await harness(false)
	fixture.saveApiConversationHistory.mockResolvedValueOnce(false)
	expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(false)
	expect(fixture.task.userMessageContent).toEqual([fixture.result])
	expect(fixture.queue.getClaimedMessageIds()).toEqual([fixture.message.id])
	expect(toolResults(fixture.task.apiConversationHistory)).toEqual([])
	expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
	expect(toolResults(fixture.persisted.at(-1)!)).toEqual([fixture.result])
	expect(guidanceOccurrences(fixture.persisted.at(-1)!, fixture.message.text)).toBe(1)
	expect(fixture.storedQueue()).toEqual([])
})
