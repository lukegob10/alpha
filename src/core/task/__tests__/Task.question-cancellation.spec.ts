import { getEventListeners } from "node:events"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AlphaMessage, RequestUserInputQuestion } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { RequestUserInputTool } from "../../tools/RequestUserInputTool"
import { Task } from "../Task"

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept
		reject = fail
	})
	return { promise, resolve, reject }
}

const questions: RequestUserInputQuestion[] = [
	{
		id: "storage",
		header: "Storage",
		question: "Where should records be stored?",
		options: [
			{ label: "Local", description: "Use the project folder." },
			{ label: "Hosted", description: "Use the external database." },
		],
	},
]

function createTask(
	options: {
		getState?: () => Promise<undefined>
		beforePublish?: (message: AlphaMessage) => Promise<void>
	} = {},
) {
	const task = Object.create(Task.prototype) as Task
	Object.defineProperty(task, "cwd", { value: "F:/workspace" })
	const say = vi.fn(async () => {})
	const addToAlphaMessages = vi.fn(async (message: AlphaMessage) => {
		await options.beforePublish?.(message)
		task.alphaMessages.push(message)
	})
	Object.assign(task, {
		taskId: "question-cancellation-root",
		instanceId: "question-cancellation-instance",
		taskKind: "primary",
		_taskMode: "architect",
		taskApprovalMode: "ask",
		abort: false,
		alphaMessages: [],
		apiConversationHistory: [],
		messageQueueService: new MessageQueueService(),
		providerRef: {
			deref: () => ({
				getState: options.getState ?? (async () => undefined),
				isTaskOnScreen: () => true,
				postMessageToWebview: vi.fn(),
			}),
		},
		addToAlphaMessages,
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
		say,
	})
	return { task, say, addToAlphaMessages }
}

function runQuestion(task: Task) {
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

function expectCancelled(request: ReturnType<typeof runQuestion>) {
	expect(request.callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
	expect(request.callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ answers: {} }))
	expect(request.callbacks.handleError).not.toHaveBeenCalled()
	expect(getEventListeners(request.controller.signal, "abort")).toHaveLength(0)
}

async function releaseAsk(task: Task) {
	await vi.advanceTimersByTimeAsync(0)
	const timestamp = task.getActiveAskTimestamp()
	if (timestamp !== undefined) {
		task.handleWebviewAskResponse("noButtonClicked", undefined, undefined, undefined, timestamp)
	}
	await vi.advanceTimersByTimeAsync(100)
}

describe("question cancellation owns its Task ask", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it.each(["resolve", "reject"] as const)(
		"cancels before provider state returns, including a late %s",
		async (late) => {
			const entered = deferred<void>()
			const state = deferred<undefined>()
			const { task, say, addToAlphaMessages } = createTask({
				getState: () => {
					entered.resolve()
					return state.promise
				},
			})
			const request = runQuestion(task)
			try {
				await entered.promise
				request.controller.abort()
				await vi.advanceTimersByTimeAsync(0)

				expect(request.isSettled()).toBe(true)
				await request.pending
				expectCancelled(request)
				expect(task.abort).toBe(false)
				expect(task.getActiveAskTimestamp()).toBeUndefined()
				expect(addToAlphaMessages).not.toHaveBeenCalled()
				expect(say).not.toHaveBeenCalled()

				if (late === "resolve") state.resolve(undefined)
				else state.reject(new Error("late provider read failed"))
				await vi.advanceTimersByTimeAsync(100)
				expect(task.alphaMessages).toEqual([])
				expect(request.callbacks.pushToolResult).toHaveBeenCalledOnce()
			} finally {
				state.resolve(undefined)
				await releaseAsk(task)
				await request.pending
			}
		},
	)

	it("settles cancellation after the owned question publication completes", async () => {
		const entered = deferred<void>()
		const publication = deferred<void>()
		const { task, say } = createTask({
			beforePublish: async () => {
				entered.resolve()
				await publication.promise
			},
		})
		const request = runQuestion(task)
		try {
			await entered.promise
			request.controller.abort()
			expect(say).not.toHaveBeenCalled()
			publication.resolve()
			await vi.advanceTimersByTimeAsync(100)
			await request.pending

			expectCancelled(request)
			expect(task.abort).toBe(false)
			expect(say).not.toHaveBeenCalled()
			expect(task.getActiveAskTimestamp()).toBeUndefined()
			expect(task.alphaMessages).toEqual([
				expect.objectContaining({ type: "ask", ask: "followup", isAnswered: true }),
			])
		} finally {
			publication.resolve()
			await releaseAsk(task)
			await request.pending
		}
	})

	it.each(["pending", "accepted-response"] as const)(
		"does not change another ask's %s slot when cancellation wins during preflight",
		async (kind) => {
			const entered = deferred<void>()
			const state = deferred<undefined>()
			let stateReads = 0
			const { task, say } = createTask({
				getState: () => {
					if (++stateReads === 1) {
						entered.resolve()
						return state.promise
					}
					return Promise.resolve(undefined)
				},
			})
			const request = runQuestion(task)
			let otherAsk: ReturnType<Task["ask"]> | undefined
			let otherOutcome: Promise<unknown> | undefined
			try {
				await entered.promise
				otherAsk = task.ask("followup", "Another user-owned question", false)
				otherOutcome = otherAsk.then(
					(answer) => ({ answer }),
					(error: unknown) => ({ error }),
				)
				await vi.advanceTimersByTimeAsync(0)
				const timestamp = task.getActiveAskTimestamp()
				expect(timestamp).toEqual(expect.any(Number))
				if (kind === "accepted-response") {
					expect(
						task.handleWebviewAskResponse(
							"messageResponse",
							"The user's accepted answer",
							undefined,
							undefined,
							timestamp,
						),
					).toBe(true)
				}
				request.controller.abort()
				// Keep the other ask's 100 ms poll suspended while checking its accepted reply slot.
				await vi.advanceTimersByTimeAsync(0)
				expect(request.isSettled()).toBe(true)
				await request.pending
				expectCancelled(request)
				expect(task.abort).toBe(false)
				expect(task.getActiveAskTimestamp()).toBe(timestamp)
				expect(task.lastMessageTs).toBe(timestamp)
				expect(Reflect.get(task, "askResponse")).toBe(
					kind === "accepted-response" ? "messageResponse" : undefined,
				)

				state.resolve(undefined)
				await vi.advanceTimersByTimeAsync(0)
				expect(task.getActiveAskTimestamp()).toBe(timestamp)
				expect(task.alphaMessages).toHaveLength(1)
				if (kind === "accepted-response") {
					expect(Reflect.get(task, "askResponseText")).toBe("The user's accepted answer")
				} else {
					expect(
						task.handleWebviewAskResponse(
							"messageResponse",
							"The user's accepted answer",
							undefined,
							undefined,
							timestamp,
						),
					).toBe(true)
				}
				await vi.advanceTimersByTimeAsync(100)
				await expect(otherAsk).resolves.toMatchObject({
					response: "messageResponse",
					text: "The user's accepted answer",
				})
				expect(task.abort).toBe(false)
				expect(say).not.toHaveBeenCalled()
			} finally {
				state.resolve(undefined)
				await releaseAsk(task)
				await Promise.all([request.pending, otherOutcome])
			}
		},
	)

	it("does not apply an old tool cancellation to a replacement ask", async () => {
		const entered = deferred<void>()
		const publication = deferred<void>()
		let publications = 0
		const { task, say } = createTask({
			beforePublish: async () => {
				if (++publications === 1) {
					entered.resolve()
					await publication.promise
				}
			},
		})
		const request = runQuestion(task)
		let replacement: ReturnType<Task["ask"]> | undefined
		try {
			await entered.promise
			const oldTimestamp = task.getActiveAskTimestamp()
			let replacementSettled = false
			replacement = task.ask("followup", "Replacement question", false).then((answer) => {
				replacementSettled = true
				return answer
			})
			await vi.advanceTimersByTimeAsync(0)
			const replacementTimestamp = task.getActiveAskTimestamp()
			expect(replacementTimestamp).toEqual(expect.any(Number))
			expect(replacementTimestamp).not.toBe(oldTimestamp)

			request.controller.abort()
			await vi.advanceTimersByTimeAsync(100)
			expect(replacementSettled).toBe(false)
			expect(task.getActiveAskTimestamp()).toBe(replacementTimestamp)
			publication.resolve()
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expectCancelled(request)
			expect(task.abort).toBe(false)
			expect(task.getActiveAskTimestamp()).toBe(replacementTimestamp)
			expect(say).not.toHaveBeenCalled()

			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					"Keep the replacement choice pending for me",
					undefined,
					undefined,
					replacementTimestamp,
				),
			).toBe(true)
			await vi.advanceTimersByTimeAsync(100)
			await expect(replacement).resolves.toMatchObject({
				response: "messageResponse",
				text: "Keep the replacement choice pending for me",
			})
		} finally {
			publication.resolve()
			await releaseAsk(task)
			await Promise.all([request.pending, replacement])
		}
	})

	it("removes the completed question's signal listener before a later ask starts", async () => {
		const { task, say } = createTask()
		const request = runQuestion(task)
		let replacement: ReturnType<Task["ask"]> | undefined
		try {
			await vi.advanceTimersByTimeAsync(0)
			task.handleWebviewAskResponse(
				"messageResponse",
				JSON.stringify({ answers: { storage: { answers: ["Hosted"] } } }),
				undefined,
				undefined,
				task.getActiveAskTimestamp(),
			)
			await vi.advanceTimersByTimeAsync(100)
			await request.pending
			expect(say).toHaveBeenCalledOnce()
			expect(request.callbacks.setResultMetadata).not.toHaveBeenCalled()
			expect(getEventListeners(request.controller.signal, "abort")).toHaveLength(0)

			let replacementSettled = false
			replacement = task.ask("followup", "A later question", false).then((answer) => {
				replacementSettled = true
				return answer
			})
			await vi.advanceTimersByTimeAsync(0)
			const replacementTimestamp = task.getActiveAskTimestamp()
			request.controller.abort()
			await vi.advanceTimersByTimeAsync(100)

			expect(replacementSettled).toBe(false)
			expect(task.getActiveAskTimestamp()).toBe(replacementTimestamp)
			expect(request.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(say).toHaveBeenCalledOnce()
		} finally {
			await releaseAsk(task)
			await Promise.all([request.pending, replacement])
		}
	})

	it.each(["without-signal", "with-signal"] as const)(
		"preserves the eighth-slot command observer and reserved row identity %s",
		async (kind) => {
			const { task } = createTask()
			const controller = new AbortController()
			const hydratedTimestamp = Date.now() + 10_000
			task.alphaMessages.push({ ts: hydratedTimestamp, type: "say", say: "text", text: "Hydrated history" })
			const observer = vi.fn((_id: string) => {
				expect(task.getActiveAskTimestamp()).toBeUndefined()
			})
			const pending =
				kind === "with-signal"
					? task.ask(
							"command",
							"rg proof src",
							false,
							undefined,
							false,
							true,
							undefined,
							observer,
							controller.signal,
						)
					: task.ask("command", "rg proof src", false, undefined, false, true, undefined, observer)
			try {
				await vi.advanceTimersByTimeAsync(0)
				const timestamp = task.getActiveAskTimestamp()
				expect(timestamp).toBe(hydratedTimestamp + 1)
				expect(observer).not.toHaveBeenCalled()
				expect(
					task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, timestamp),
				).toBe(true)
				await vi.advanceTimersByTimeAsync(100)
				await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
				expect(observer).toHaveBeenCalledExactlyOnceWith(timestamp!.toString())
				expect(task.alphaMessages.at(-1)).toMatchObject({ ts: timestamp, type: "ask", ask: "command" })
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
				controller.abort()
				expect(task.abort).toBe(false)
				expect(observer).toHaveBeenCalledOnce()
			} finally {
				await releaseAsk(task)
				await pending
			}
		},
	)

	it.each(["denied", "cancelled"] as const)(
		"does not issue a command observer receipt when %s before approval",
		async (kind) => {
			const { task } = createTask()
			const controller = new AbortController()
			const observer = vi.fn()
			const pending = task.ask(
				"command",
				"rg proof src",
				false,
				undefined,
				false,
				true,
				undefined,
				observer,
				controller.signal,
			)
			let settled = false
			const outcome = pending.then(
				(answer) => {
					settled = true
					return { answer }
				},
				(error: unknown) => {
					settled = true
					return { error }
				},
			)
			try {
				await vi.advanceTimersByTimeAsync(0)
				const timestamp = task.getActiveAskTimestamp()
				expect(timestamp).toEqual(expect.any(Number))
				if (kind === "cancelled") controller.abort()
				else task.handleWebviewAskResponse("noButtonClicked", undefined, undefined, undefined, timestamp)
				await vi.advanceTimersByTimeAsync(100)
				expect(settled).toBe(true)
				await expect(pending).resolves.toMatchObject({ response: "noButtonClicked" })
				expect(task.abort).toBe(false)
				expect(observer).not.toHaveBeenCalled()
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
			} finally {
				await releaseAsk(task)
				await outcome
			}
		},
	)

	it("preserves an accepted own reply when its signal aborts before polling consumes it", async () => {
		const { task } = createTask()
		const controller = new AbortController()
		const pending = task.ask(
			"followup",
			"A user-owned question",
			false,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			controller.signal,
		)
		const outcome = pending.then(
			(answer) => ({ answer }),
			(error: unknown) => ({ error }),
		)
		try {
			await vi.advanceTimersByTimeAsync(0)
			const timestamp = task.getActiveAskTimestamp()
			expect(timestamp).toEqual(expect.any(Number))
			expect(
				task.handleWebviewAskResponse(
					"messageResponse",
					"Accepted human choice",
					undefined,
					undefined,
					timestamp,
				),
			).toBe(true)
			controller.abort()
			expect(Reflect.get(task, "askResponse")).toBe("messageResponse")
			expect(Reflect.get(task, "askResponseText")).toBe("Accepted human choice")
			expect(task.getActiveAskTimestamp()).toBe(timestamp)
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).resolves.toMatchObject({
				response: "messageResponse",
				text: "Accepted human choice",
			})
			expect(task.abort).toBe(false)
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
		} finally {
			await releaseAsk(task)
			await outcome
		}
	})

	it("retains lifetime Task.abort cancellation when no per-ask signal was supplied", async () => {
		const { task } = createTask()
		const pending = task.ask("followup", "A lifetime-owned question", false)
		const outcome = pending.then(
			(answer) => ({ answer }),
			(error: unknown) => ({ error }),
		)
		try {
			await vi.advanceTimersByTimeAsync(0)
			expect(task.getActiveAskTimestamp()).toEqual(expect.any(Number))
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await expect(pending).rejects.toThrow("aborted")
			expect(task.abort).toBe(true)
			expect(task.getActiveAskTimestamp()).toBeUndefined()
		} finally {
			task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await outcome
		}
	})
})
