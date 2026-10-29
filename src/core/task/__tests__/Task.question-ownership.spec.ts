import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	AlphaCodeEventName,
	TaskStatus,
	type AlphaMessage,
	type ApprovalMode,
	type RequestUserInputQuestion,
} from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { RequestUserInputTool } from "../../tools/RequestUserInputTool"
import { Task } from "../Task"

const questions: RequestUserInputQuestion[] = [
	{
		id: "storage",
		header: "Storage",
		question: "Where should the project store its records?",
		options: [
			{ label: "Local (Recommended)", description: "Keep the data in the workspace." },
			{ label: "Hosted", description: "Use the configured external database." },
		],
	},
	{
		id: "retention",
		header: "Retention",
		question: "How long should records remain available?",
		options: [
			{ label: "Thirty days", description: "Remove expired records after thirty days." },
			{ label: "Until removed", description: "Keep records until the user removes them." },
		],
	},
]

const submittedAnswers = {
	storage: { answers: ["Hosted"] },
	retention: { answers: ["Until removed"] },
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((accept) => {
		resolve = accept
	})
	return { promise, resolve }
}

function createQuestionTask(mode: "code" | "architect", approvalMode: ApprovalMode, onScreen = false) {
	const task = Object.create(Task.prototype) as Task
	let selected = onScreen
	const postMessageToWebview = vi.fn()
	const say = vi.fn(async () => {})
	const state = {
		approvalMode,
		autoApprovalEnabled: true,
		alwaysAllowFollowupQuestions: approvalMode === "bypass",
		followupAutoApproveTimeoutMs: 5_000,
	}
	const provider = {
		getState: vi.fn(async () => state),
		contextProxy: {
			getValue: vi.fn((key: "followupAutoApproveTimeoutMs") => state[key]),
		},
		isTaskOnScreen: vi.fn(() => selected),
		postMessageToWebview,
		log: vi.fn(),
	}
	Object.defineProperty(task, "cwd", { value: "F:/workspace" })
	Object.assign(task, {
		taskId: "background-question-root",
		instanceId: "question-instance",
		taskKind: "primary",
		_taskMode: mode,
		taskApprovalMode: approvalMode,
		abort: false,
		alphaMessages: [],
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => provider },
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => {
			task.alphaMessages.push(message)
		}),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
		say,
	})
	return { task, state, provider, say, postMessageToWebview, select: (value: boolean) => (selected = value) }
}

function expectQuestionWaiting(task: Task, postMessageToWebview: ReturnType<typeof vi.fn>) {
	expect(task.taskStatus).toBe(TaskStatus.Interactive)
	expect(task.interactiveAsk?.ts).toBe(task.getActiveAskTimestamp())
	expect(task.emit).toHaveBeenCalledExactlyOnceWith(AlphaCodeEventName.TaskInteractive, task.taskId)
	expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith({ type: "interactionRequired", taskId: task.taskId })
}

function requestQuestion(task: Task) {
	const controller = new AbortController()
	const callbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		signal: controller.signal,
	} satisfies ToolCallbacks
	let settled = false
	const pending = new RequestUserInputTool().execute({ questions }, task, callbacks).then(() => {
		settled = true
	})
	return { controller, callbacks, pending, isSettled: () => settled }
}

async function cancelRequest(request: ReturnType<typeof requestQuestion>) {
	request.controller.abort()
	await vi.advanceTimersByTimeAsync(100)
	await request.pending
}

describe("primary question ownership", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it.each([
		["code", "ask"],
		["code", "auto"],
		["architect", "ask"],
		["architect", "auto"],
	] as const)("keeps an offscreen %s/%s question pending for its matching user reply", async (mode, approvalMode) => {
		const { task, say, postMessageToWebview } = createQuestionTask(mode, approvalMode)
		task.messageQueueService.addMessage("Keep this guidance for the next turn")
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(2_100)
			expect(request.isSettled()).toBe(false)
			expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalled()
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "interactionRequired",
				taskId: task.taskId,
			})
			expect(task.alphaMessages).toHaveLength(1)
			expect(task.alphaMessages[0]).toMatchObject({ type: "ask", ask: "followup" })
			expect(task.alphaMessages[0]?.isAnswered).not.toBe(true)
			expect(JSON.parse(task.alphaMessages[0]?.text ?? "{}")).toMatchObject({
				requestUserInput: { questions },
			})
			expect(task.messageQueueService.messages[0]?.text).toBe("Keep this guidance for the next turn")

			const timestamp = task.getActiveAskTimestamp()
			expect(timestamp).toEqual(expect.any(Number))
			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					JSON.stringify({ answers: submittedAnswers }),
					undefined,
					undefined,
					timestamp! - 1,
				),
			).toBe(false)
			await vi.advanceTimersByTimeAsync(100)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()

			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					JSON.stringify({ answers: submittedAnswers }),
					undefined,
					undefined,
					timestamp,
				),
			).toBe(true)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending

			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({ answers: submittedAnswers }),
			)
			expect(request.callbacks.handleError).not.toHaveBeenCalled()
			expect(request.callbacks.setResultMetadata).not.toHaveBeenCalled()
			expect(say).toHaveBeenCalledExactlyOnceWith(
				"user_feedback",
				"Where should the project store its records?\nHosted\n\n" +
					"How long should records remain available?\nUntil removed",
				undefined,
				undefined,
				undefined,
				undefined,
				{
					userInputResponse: {
						questions: [
							{ header: "Storage", question: questions[0]!.question, answers: ["Hosted"] },
							{ header: "Retention", question: questions[1]!.question, answers: ["Until removed"] },
						],
					},
				},
			)
			expect(task.alphaMessages[0]?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
			expect(task.messageQueueService.messages).toHaveLength(1)
		} finally {
			await cancelRequest(request)
		}
	})

	it("keeps a foreground question owned by the user after task selection changes", async () => {
		const { task, say, select } = createQuestionTask("architect", "auto", true)
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(0)
			select(false)
			await vi.advanceTimersByTimeAsync(10_000)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()
			expect(task.getActiveAskTimestamp()).toEqual(expect.any(Number))
		} finally {
			await cancelRequest(request)
		}
	})

	it.each([
		["ask", "scheduler"],
		["ask", "task"],
		["bypass", "scheduler"],
		["bypass", "task"],
	] as const)("cancels an indefinite offscreen %s question through %s", async (approvalMode, source) => {
		const { task, state, say } = createQuestionTask("architect", approvalMode)
		state.followupAutoApproveTimeoutMs = 0
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(2_100)
			expect(request.isSettled()).toBe(false)
			if (source === "scheduler") request.controller.abort()
			else task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expect(request.callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
			expect(request.callbacks.handleError).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalled()
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			await cancelRequest(request)
		}
	})

	it.each([false, true])("keeps a Full Access question pending indefinitely with onScreen=%s", async (onScreen) => {
		const { task, state, say, postMessageToWebview } = createQuestionTask("code", "bypass", onScreen)
		state.followupAutoApproveTimeoutMs = 0
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(120_000)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()
			expect(task.alphaMessages[0]?.isAnswered).not.toBe(true)
			task.cancelAutoApprovalTimeout(true)
			task.cancelAutoApprovalTimeout(true)
			expectQuestionWaiting(task, postMessageToWebview)

			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					JSON.stringify({ answers: submittedAnswers }),
					undefined,
					undefined,
					task.getActiveAskTimestamp(),
				),
			).toBe(true)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({ answers: submittedAnswers }),
			)
			expect(task.alphaMessages[0]?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			await cancelRequest(request)
		}
	})

	it.each([false, true])("honors an unchanged Full Access question timeout with onScreen=%s", async (onScreen) => {
		const { task, say, postMessageToWebview } = createQuestionTask("code", "bypass", onScreen)
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(4_999)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(101)
			await request.pending
			expect(request.callbacks.handleError).not.toHaveBeenCalled()
			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({
					answers: {
						storage: { answers: ["Local (Recommended)"] },
						retention: { answers: ["Thirty days"] },
					},
				}),
			)
			expect(say).toHaveBeenCalledOnce()
			expect(task.getTaskApprovalMode()).toBe("bypass")
			expect(postMessageToWebview).not.toHaveBeenCalled()
		} finally {
			await cancelRequest(request)
		}
	})

	it.each([false, true])(
		"revokes an existing automatic answer when Wait indefinitely is saved with onScreen=%s",
		async (onScreen) => {
			const { task, state, say, postMessageToWebview } = createQuestionTask("code", "bypass", onScreen)
			const request = requestQuestion(task)
			try {
				await vi.advanceTimersByTimeAsync(1_000)
				state.followupAutoApproveTimeoutMs = 0
				await vi.advanceTimersByTimeAsync(10_000)
				expect(request.isSettled()).toBe(false)
				expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(say).not.toHaveBeenCalled()
				expect(task.alphaMessages[0]?.isAnswered).not.toBe(true)
				expectQuestionWaiting(task, postMessageToWebview)
			} finally {
				await cancelRequest(request)
			}
		},
	)

	it.each([false, true])(
		"revokes a timer before its initial settings snapshot returns with onScreen=%s",
		async (onScreen) => {
			const { task, state, provider, say, postMessageToWebview } = createQuestionTask("code", "bypass", onScreen)
			const settings = deferred<typeof state>()
			const capturedSettings = { ...state }
			provider.getState.mockImplementationOnce(() => settings.promise)
			const request = requestQuestion(task)
			try {
				await vi.advanceTimersByTimeAsync(0)
				expect(task.alphaMessages).toHaveLength(0)
				task.cancelAutoApprovalTimeout(true)
				state.followupAutoApproveTimeoutMs = 0
				expect(postMessageToWebview).not.toHaveBeenCalled()
				settings.resolve(capturedSettings)
				await vi.advanceTimersByTimeAsync(12_000)
				expect(provider.getState).toHaveBeenCalledOnce()
				expect(request.isSettled()).toBe(false)
				expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(say).not.toHaveBeenCalled()
				expectQuestionWaiting(task, postMessageToWebview)
			} finally {
				settings.resolve(state)
				await cancelRequest(request)
			}
		},
	)

	it.each([false, true])("publishes settings revocation attention once with onScreen=%s", async (onScreen) => {
		const { task, state, say, postMessageToWebview } = createQuestionTask("code", "bypass", onScreen)
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(1_000)
			state.followupAutoApproveTimeoutMs = 0
			task.cancelAutoApprovalTimeout(true)
			task.cancelAutoApprovalTimeout(true)
			expectQuestionWaiting(task, postMessageToWebview)
			await vi.advanceTimersByTimeAsync(10_000)
			expect(request.isSettled()).toBe(false)
			expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalled()
			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					JSON.stringify({ answers: submittedAnswers }),
					undefined,
					undefined,
					task.getActiveAskTimestamp(),
				),
			).toBe(true)
			task.cancelAutoApprovalTimeout(true)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			task.cancelAutoApprovalTimeout(true)
			expect(postMessageToWebview).toHaveBeenCalledOnce()
			expect(task.taskStatus).toBe(TaskStatus.Running)
			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({ answers: submittedAnswers }),
			)
		} finally {
			await cancelRequest(request)
		}
	})

	it("does not publish attention for a superseded question", async () => {
		const { task, postMessageToWebview } = createQuestionTask("code", "bypass")
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(0)
			task.supersedePendingAsk()
			task.cancelAutoApprovalTimeout(true)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expect(postMessageToWebview).not.toHaveBeenCalled()
			expect(task.interactiveAsk).toBeUndefined()
			expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
		} finally {
			await cancelRequest(request)
		}
	})

	it("does not answer at the old deadline after a longer question timeout is saved", async () => {
		const { task, state, say, postMessageToWebview } = createQuestionTask("code", "bypass")
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(1_000)
			state.followupAutoApproveTimeoutMs = 60_000
			await vi.advanceTimersByTimeAsync(10_000)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()
			expectQuestionWaiting(task, postMessageToWebview)
		} finally {
			await cancelRequest(request)
		}
	})

	it.each(["interaction", "settings", "reply", "scheduler", "task"] as const)(
		"revokes an automatic answer through %s while its settings check is pending",
		async (source) => {
			const { task, state, provider, say, postMessageToWebview } = createQuestionTask("code", "bypass")
			const request = requestQuestion(task)
			const settings = deferred<typeof state>()
			const capturedSettings = { ...state }
			try {
				await vi.advanceTimersByTimeAsync(0)
				provider.getState.mockImplementationOnce(() => settings.promise)
				await vi.advanceTimersByTimeAsync(5_000)
				expect(provider.getState).toHaveBeenCalledTimes(2)
				expect(request.isSettled()).toBe(false)
				if (source === "interaction") task.cancelAutoApprovalTimeout()
				else if (source === "settings") {
					state.followupAutoApproveTimeoutMs = 0
					// The settings host revokes pending timers before saving. Its earlier read may finish later.
					task.cancelAutoApprovalTimeout(true)
				} else if (source === "reply") {
					expect(
						task.handleWebviewAskResponse(
							"messageResponse",
							JSON.stringify({ answers: submittedAnswers }),
							undefined,
							undefined,
							task.getActiveAskTimestamp(),
						),
					).toBe(true)
				} else if (source === "scheduler") request.controller.abort()
				else task.abort = true
				await vi.advanceTimersByTimeAsync(100)
				if (source !== "interaction" && source !== "settings") await request.pending
				settings.resolve(capturedSettings)
				await vi.advanceTimersByTimeAsync(100)
				if (source === "reply") {
					expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
						JSON.stringify({ answers: submittedAnswers }),
					)
					expect(say).toHaveBeenCalledOnce()
				} else {
					expect(say).not.toHaveBeenCalled()
					if (source === "interaction" || source === "settings") {
						expect(request.isSettled()).toBe(false)
						expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
						if (source === "settings") expectQuestionWaiting(task, postMessageToWebview)
						else expect(postMessageToWebview).not.toHaveBeenCalled()
					} else {
						expect(request.callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({
							status: "cancelled",
						})
						expect(request.callbacks.pushToolResult).toHaveBeenCalledOnce()
					}
				}
			} finally {
				settings.resolve(state)
				await cancelRequest(request)
			}
		},
	)

	it.each([0, 15_000])(
		"honors an imported timeout of %s after a stale settings snapshot without UI revocation",
		async (followupAutoApproveTimeoutMs) => {
			const { task, state, provider, say, postMessageToWebview } = createQuestionTask("code", "bypass")
			const request = requestQuestion(task)
			const settings = deferred<typeof state>()
			const capturedSettings = { ...state }
			try {
				await vi.advanceTimersByTimeAsync(0)
				provider.getState.mockImplementationOnce(() => settings.promise)
				await vi.advanceTimersByTimeAsync(5_000)
				expect(provider.getState).toHaveBeenCalledTimes(2)
				// Import/API writes change ContextProxy without the webview's revocation hook.
				state.followupAutoApproveTimeoutMs = followupAutoApproveTimeoutMs
				settings.resolve(capturedSettings)
				await vi.advanceTimersByTimeAsync(100)
				expect(request.isSettled()).toBe(false)
				expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(say).not.toHaveBeenCalled()
				expectQuestionWaiting(task, postMessageToWebview)
				expect(
					task.handleWebviewAskResponse(
						"messageResponse",
						JSON.stringify({ answers: submittedAnswers }),
						undefined,
						undefined,
						task.getActiveAskTimestamp(),
					),
				).toBe(true)
				await vi.advanceTimersByTimeAsync(100)
				await request.pending
				expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
					JSON.stringify({ answers: submittedAnswers }),
				)
			} finally {
				settings.resolve(capturedSettings)
				await cancelRequest(request)
			}
		},
	)

	it("never lets an old automatic answer claim a replacement question during settings revalidation", async () => {
		const { task, state, provider, say, postMessageToWebview } = createQuestionTask("code", "bypass")
		const request = requestQuestion(task)
		const settings = deferred<typeof state>()
		let replacement: ReturnType<typeof requestQuestion> | undefined
		try {
			await vi.advanceTimersByTimeAsync(0)
			provider.getState.mockImplementationOnce(() => settings.promise)
			await vi.advanceTimersByTimeAsync(5_000)
			expect(provider.getState).toHaveBeenCalledTimes(2)
			expect(request.isSettled()).toBe(false)
			state.followupAutoApproveTimeoutMs = 0
			replacement = requestQuestion(task)
			await vi.advanceTimersByTimeAsync(0)
			const replacementTs = task.getActiveAskTimestamp()
			expect(replacementTs).toBe(task.alphaMessages[1]?.ts)
			settings.resolve({ ...state, followupAutoApproveTimeoutMs: 5_000 })
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expect(replacement.isSettled()).toBe(false)
			expect(replacement.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalled()
			expect(task.getActiveAskTimestamp()).toBe(replacementTs)
			expect(postMessageToWebview).not.toHaveBeenCalled()
			expect(task.interactiveAsk).toBeUndefined()
		} finally {
			settings.resolve(state)
			await cancelRequest(request)
			if (replacement) await cancelRequest(replacement)
		}
	})

	it("leaves the question user-owned when its automatic answer cannot revalidate settings", async () => {
		const { task, provider, say, postMessageToWebview } = createQuestionTask("code", "bypass")
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(0)
			provider.getState.mockRejectedValueOnce(new Error("Settings are unavailable"))
			await vi.advanceTimersByTimeAsync(10_000)
			expect(request.isSettled()).toBe(false)
			expect(request.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(say).not.toHaveBeenCalled()
			expect(provider.log).toHaveBeenCalledExactlyOnceWith(
				"Skipping automatic question answer because settings could not be revalidated.",
			)
			expectQuestionWaiting(task, postMessageToWebview)
		} finally {
			await cancelRequest(request)
		}
	})

	it("lets a human cancel a configured automatic question before its timeout", async () => {
		const { task, say } = createQuestionTask("code", "bypass")
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(1_000)
			expect(request.isSettled()).toBe(false)
			expect(
				task.handleWebviewAskResponse(
					"noButtonClicked",
					undefined,
					undefined,
					undefined,
					task.getActiveAskTimestamp(),
				),
			).toBe(true)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			await vi.advanceTimersByTimeAsync(10_000)
			expect(request.callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
			expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
			expect(say).not.toHaveBeenCalled()
			expect(task.alphaMessages[0]?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			await cancelRequest(request)
		}
	})
})
