import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AlphaMessage, ApprovalMode, RequestUserInputQuestion } from "@alpha-code/types"

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
		isTaskOnScreen: vi.fn(() => selected),
		postMessageToWebview,
	}
	Object.defineProperty(task, "cwd", { value: "F:/workspace" })
	Object.assign(task, {
		taskId: "background-question-root",
		instanceId: "question-instance",
		taskKind: "primary",
		_taskMode: mode,
		taskApprovalMode: approvalMode,
		abort: false,
		clineMessages: [],
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => provider },
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => {
			task.clineMessages.push(message)
		}),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
		say,
	})
	return { task, state, say, postMessageToWebview, select: (value: boolean) => (selected = value) }
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
			expect(task.clineMessages).toHaveLength(1)
			expect(task.clineMessages[0]).toMatchObject({ type: "ask", ask: "followup" })
			expect(task.clineMessages[0]?.isAnswered).not.toBe(true)
			expect(JSON.parse(task.clineMessages[0]?.text ?? "{}")).toMatchObject({
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
			expect(task.clineMessages[0]?.isAnswered).toBe(true)
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
		const { task, state, say } = createQuestionTask("code", "bypass", onScreen)
		state.followupAutoApproveTimeoutMs = 0
		const request = requestQuestion(task)
		try {
			await vi.advanceTimersByTimeAsync(120_000)
			expect(request.isSettled()).toBe(false)
			expect(say).not.toHaveBeenCalled()
			expect(task.clineMessages[0]?.isAnswered).not.toBe(true)

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
			expect(task.clineMessages[0]?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			await cancelRequest(request)
		}
	})

	it("honors the captured Full Access question timeout while offscreen", async () => {
		const { task, say } = createQuestionTask("code", "bypass")
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
			expect(task.clineMessages[0]?.isAnswered).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			await cancelRequest(request)
		}
	})
})
