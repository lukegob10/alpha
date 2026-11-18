import type Anthropic from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readCompletionHookConfig, runLifecycleHooks, type CompletionHookConfig } from "../../agent/CompletionHooks"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../agent/CompletionHooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(),
	runLifecycleHooks: vi.fn(),
}))
vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))

type Content = Anthropic.Messages.ContentBlockParam[]
const providerBoundary = new Error("fixture: accepted inputs reached the provider boundary")
const command = { command: process.execPath }

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

function fixture() {
	const history: ApiMessage[] = []
	const queue = new MessageQueueService()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "pre-sampling-steering",
		instanceId: "pre-sampling-steering-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		didComplete: false,
		isInitialized: true,
		isTaskLoopActive: false,
		taskCancellationController: new AbortController(),
		alphaMessages: [],
		apiConversationHistory: history,
		userMessageContent: [],
		apiConfiguration: { apiProvider: "openai" },
		api: { getModel: () => ({ id: "fixture-model" }) },
		providerRef: { deref: () => undefined },
		messageQueueService: queue,
		consecutiveMistakeLimit: 0,
		requestPacingWaitCount: 0,
		getTaskMode: vi.fn(async () => "code"),
		getStepApprovalMode: vi.fn(() => "ask"),
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		completionHookTranscriptPath: vi.fn(async () => null),
		mergePendingToolResultsIntoUserContent: vi.fn((content: Content) => content),
		includeQueuedToolReplyContent: vi.fn((content: Content) => content),
		stageApiUserMessage: vi.fn((message: ApiMessage) => {
			history.push(message)
			return message
		}),
		addToApiConversationHistory: vi.fn(
			async (message: ApiMessage, _reasoning: unknown, onPersisted?: () => void) => {
				history.push(message)
				onPersisted?.()
				return true
			},
		),
		retrySaveApiConversationHistory: vi.fn(async () => false),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		invalidateGoalContinuation: vi.fn(),
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		emit: vi.fn(),
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw providerBoundary
		}),
	}) as Task
	return { task, queue, history }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(runLifecycleHooks).mockResolvedValue({ warnings: [] })
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit: vi.fn(), release: vi.fn() })
})

afterEach(() => vi.restoreAllMocks())

describe("steering before a provider request", () => {
	it("delivers queued steering that arrives after the original input commits, before provider admission", async () => {
		const { task, queue, history } = fixture()
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [] })
		const onPersisted = vi.fn()
		vi.mocked(task["deliverAgentMessages"]).mockImplementationOnce(async () => {
			expect(onPersisted).toHaveBeenCalledOnce()
			await queue.addMessageDurably("Use the revised instructions", [], "steer")
			await task.steerQueuedUserMessage("steer")
		})

		await expect(
			task.runAgentRequests(task["buildUserMessageContent"]("Original instructions"), false, onPersisted, {
				inputOrigin: "human",
			}),
		).rejects.toBe(providerBoundary)

		expect(history.map(({ content }) => content)).toEqual([
			[{ type: "text", text: "<user_message>\nOriginal instructions\n</user_message>" }],
			[{ type: "text", text: "<user_message>\nUse the revised instructions\n</user_message>" }],
		])
		expect(history[1]?.queued_message_ids).toEqual(["steer"])
		expect(onPersisted).toHaveBeenCalledOnce()
		expect(queue.hasUnconsumedInput()).toBe(false)
	})

	it("retains the steer and surfaces a real preparation failure before the next request", async () => {
		const { task, queue, history } = fixture()
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [] })
		const failure = new Error("Unable to persist the tool receipt")
		vi.mocked(task["waitForPendingSubagentChangeSetReviews"]).mockImplementationOnce(async () => {
			await queue.addMessageDurably("Revised instructions", [], "steer")
			await task.steerQueuedUserMessage("steer")
			throw failure
		})

		await expect(
			task.runAgentRequests(task["buildUserMessageContent"]("Original instructions"), false),
		).rejects.toBe(failure)
		expect(history).toHaveLength(1)
		expect(task.hasPendingSteerMessage()).toBe(true)
		expect(queue.getClaimedMessageIds()).toEqual(["steer"])
	})

	it.each(["SessionStart", "UserPromptSubmit"] as const)(
		"keeps the original input and consumes steering once when %s admission is interrupted",
		async (event) => {
			const { task, queue, history } = fixture()
			const config: CompletionHookConfig = {
				stop: [],
				subagentStop: [],
				sessionStart: event === "SessionStart" ? [command] : [],
				userPromptSubmit: event === "UserPromptSubmit" ? [command] : [],
			}
			vi.mocked(readCompletionHookConfig).mockReturnValue(config)
			const entered = barrier()
			const release = barrier()
			vi.mocked(runLifecycleHooks).mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
				return { warnings: [] }
			})
			const original = queue.addMessage("ORIGINAL_INPUT", undefined, "original")!
			queue.claimMessage(original.id)
			const onOriginalPersisted = vi.fn(async () => undefined)
			const running = task
				.runAgentRequests(
					task["buildUserMessageContent"](original.text, undefined, [original.id]),
					false,
					onOriginalPersisted,
					{ inputOrigin: "human", queuedMessageIds: [original.id] },
				)
				.then(
					(result) => ({ result }),
					(error: unknown) => ({ error }),
				)
			try {
				await Promise.race([
					entered.promise,
					running.then(() => {
						throw new Error("The request ended before lifecycle hook admission")
					}),
				])
				expect(history).toEqual([])
				expect(onOriginalPersisted).not.toHaveBeenCalled()
				const steer = queue.addMessage("STEERING_INPUT", undefined, "steer")!
				queue.claimMessage(steer.id)
				await task.steerUserMessage(steer.text, undefined, undefined, [steer.id])
				expect(task["stepInterruptionController"]?.signal.aborted).toBe(true)
			} finally {
				release.resolve()
			}

			expect(await running).toEqual({ error: providerBoundary })
			expect(
				history.map(({ role, input_origin, content, queued_message_ids }) => ({
					role,
					input_origin,
					content,
					queued_message_ids,
				})),
			).toEqual([
				{
					role: "user",
					input_origin: "human",
					content: [{ type: "text", text: "<user_message>\nORIGINAL_INPUT\n</user_message>" }],
					queued_message_ids: ["original"],
				},
				{
					role: "user",
					input_origin: "human",
					content: [{ type: "text", text: "<user_message>\nSTEERING_INPUT\n</user_message>" }],
					queued_message_ids: ["steer"],
				},
			])
			expect(onOriginalPersisted).toHaveBeenCalledOnce()
			expect(task.hasPendingSteerMessage()).toBe(false)
			expect(queue.hasUnconsumedInput()).toBe(false)
			expect(task["isTaskLoopActive"]).toBe(false)
		},
	)
})
