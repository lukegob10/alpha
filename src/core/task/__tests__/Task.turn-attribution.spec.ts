import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentLifecycleEvent, AgentLifecycleSnapshot, AlphaMessage, AlphaMessageTurn } from "@alpha-code/types"

import { createAgentResponse } from "../../agent/AgentResponse"
import type { AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../../agent/lifecycle/reducer"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"
import { Task } from "../Task"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

function completedResponse(text: string) {
	return { status: "completed" as const, response: createAgentResponse([{ type: "text", text }]) }
}

function fixture(options: { messages?: AlphaMessage[]; snapshot?: AgentLifecycleSnapshot } = {}) {
	const events: AgentLifecycleEvent[] = []
	const persisted: AlphaMessage[][] = []
	let snapshot = options.snapshot && structuredClone(options.snapshot)
	const provider = {
		getState: async () => ({}),
		getAgentLifecycleSnapshot: () => snapshot,
		replayAgentLifecycle: vi.fn(async () => snapshot),
		postTaskMessageToWebview: vi.fn(async () => undefined),
		publishAgentLifecycleEvent: async (input: AgentLifecycleEventInput) => {
			if (!snapshot || input.runId !== snapshot.runId || input.turnId !== snapshot.turnId) {
				expect(input.type).toBe("turn_started")
				snapshot = createAgentLifecycleSnapshot(input)
			}
			const event = { ...input, sequence: snapshot.lastSequence + 1 } as AgentLifecycleEvent
			snapshot = reduceAgentLifecycleEvent(snapshot, event)
			events.push(event)
			return { accepted: true, event, snapshot }
		},
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "turn-attribution-task",
		instanceId: "turn-attribution-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		_taskMode: "code",
		taskApprovalMode: "ask",
		abort: false,
		abandoned: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		enableCheckpoints: false,
		canonicalLifecycleQueue: Promise.resolve(),
		canonicalLifecycleStartedSteps: new Set<string>(),
		taskCancellationController: new AbortController(),
		alphaMessages: structuredClone(options.messages ?? []),
		apiConversationHistory: [],
		userMessageContent: [],
		messageQueueService: new MessageQueueService(),
		providerRef: new WeakRef(provider),
		api: { getModel: () => ({ id: "turn-attribution-model" }) },
		getTaskMode: vi.fn(async () => "code"),
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		flushAgentTurnEvents: vi.fn(async () => undefined),
		maybeCompactAfterTurn: vi.fn(async () => undefined),
		recordCompletionCandidate: vi.fn(),
		waitForCompletionGateDecision: vi.fn(async () => ({ allowed: true, modelCanResolveRejection: true })),
		evaluateCompletionHooks: vi.fn(async () => ({})),
		finalizeTaskCompletion: vi.fn(async () => {
			task.markCompleted()
			return true
		}),
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		cancelAutoApprovalTimeout: vi.fn(),
		ask: vi.fn(async () => {
			task.abort = true
			return { response: "noButtonClicked" }
		}),
		emit: vi.fn(),
		saveAlphaMessages: vi.fn(async () => {
			persisted.push(structuredClone(task.alphaMessages))
			return true
		}),
		enqueueAlphaMessagesSave: vi.fn(async (createSnapshot: () => AlphaMessage[], onPersisted?: () => void) => {
			persisted.push(structuredClone(createSnapshot()))
			onPersisted?.()
			return true
		}),
	}) as Task
	Object.assign(task, {
		runAgentRequests: vi.fn<Task["runAgentRequests"]>(async () => {
			await task.say("text", "The work is complete.", undefined, false)
			return completedResponse("The work is complete.")
		}),
	})
	return { task, provider, events, persisted, snapshot: () => snapshot }
}

function membership(turn: AlphaMessageTurn | undefined) {
	expect(turn).toBeDefined()
	return { runId: turn!.runId, turnId: turn!.turnId }
}

afterEach(() => vi.restoreAllMocks())

describe("Task transcript turn attribution", () => {
	it("binds the exact opening input after lifecycle recovery allocates its turn", async () => {
		const { task, provider, persisted, events } = fixture()
		const openingMessageTs = await task["sayOpeningInput"]("text", "Inspect the parser.")
		expect(openingMessageTs).toEqual(expect.any(Number))
		expect(task.captureMessageTurn()).toBeUndefined()
		expect(task.alphaMessages[0].turn).toBeUndefined()
		const entered = deferred()
		const release = deferred()
		provider.replayAgentLifecycle.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return undefined
		})
		const running = task["initiateTaskLoop"]([{ type: "text", text: "Inspect the parser." }], undefined, {
			openingMessageTs,
		})
		await entered.promise
		try {
			await task.say(
				"command_output",
				"An earlier command finished.",
				undefined,
				undefined,
				undefined,
				undefined,
				{
					turn: { runId: "earlier-run", turnId: "earlier-turn" },
					isNonInteractive: true,
				},
			)
			expect(task.alphaMessages.find(({ ts }) => ts === openingMessageTs)?.turn).toBeUndefined()
		} finally {
			release.resolve()
			await running
		}

		const start = events.find(({ type }) => type === "turn_started")!
		const opening = task.alphaMessages.find(({ ts }) => ts === openingMessageTs)!
		expect(opening.turn).toEqual({ runId: start.runId, turnId: start.turnId, inputKind: "start" })
		expect(persisted.at(-1)?.find(({ ts }) => ts === openingMessageTs)).toEqual(opening)
		expect(task.alphaMessages.find(({ say }) => say === "command_output")?.turn).toEqual({
			runId: "earlier-run",
			turnId: "earlier-turn",
		})
	})

	it("keeps consumed steering and automatic recovery inside the open turn", async () => {
		const { task, events } = fixture()
		const openingMessageTs = await task["sayOpeningInput"]("text", "Inspect the parser.")
		vi.mocked(task["runAgentRequests"]).mockImplementation(async () => {
			await task.say("text", "Checking the parser.", undefined, false)
			await task["presentSteeringInput"]({ text: "Also check cancellation.", images: [] })
			await task.say("user_feedback", "Retry the request.", undefined, undefined, undefined, undefined, {
				feedbackSource: "automatic",
			})
			await task.say("text", "Both paths are covered.", undefined, false)
			return completedResponse("Both paths are covered.")
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "Inspect the parser." }], undefined, {
			openingMessageTs,
		})

		expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(1)
		const openingTurn = membership(task.alphaMessages[0].turn)
		expect(task.alphaMessages.map((message) => membership(message.turn))).toEqual(
			Array(task.alphaMessages.length).fill(openingTurn),
		)
		expect(task.alphaMessages.find(({ text }) => text === "Also check cancellation.")?.turn).toEqual({
			...openingTurn,
			inputKind: "steer",
		})
		expect(task.alphaMessages.find(({ text }) => text === "Retry the request.")?.turn).toEqual(openingTurn)
	})

	it("retains the exact plain-text final when queued input opens a successor turn", async () => {
		const { task, events, persisted } = fixture()
		const openingMessageTs = await task["sayOpeningInput"]("text", "First request.")
		let firstFinalTs: number | undefined
		let firstTurn: AlphaMessageTurn | undefined
		let samples = 0
		vi.mocked(task["runAgentRequests"]).mockImplementation(async () => {
			samples++
			if (samples === 1) {
				await task.say("text", "The first request is done.", undefined, false)
				firstFinalTs = task.alphaMessages.at(-1)!.ts
				firstTurn = task.captureMessageTurn()
				return completedResponse("The first request is done.")
			}
			expect(samples).toBe(2)
			expect(task.alphaMessages.find(({ ts }) => ts === firstFinalTs)).toMatchObject({
				say: "text",
				turn: { ...firstTurn, terminalStatus: "completed" },
			})
			const successor = task.alphaMessages.find(({ text }) => text === "Second request.")!
			expect(successor.turn?.inputKind).toBe("start")
			expect(successor.turn?.turnId).not.toBe(firstTurn?.turnId)
			await task.say("text", "The second request is done.", undefined, false)
			return completedResponse("The second request is done.")
		})
		vi.mocked(task["maybeCompactAfterTurn"]).mockImplementationOnce(async () => {
			task.messageQueueService.addMessage("Second request.")
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "First request." }], undefined, { openingMessageTs })

		expect(samples).toBe(2)
		expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(2)
		expect(persisted.at(-1)?.find(({ ts }) => ts === firstFinalTs)).toMatchObject({
			say: "text",
			text: "The first request is done.",
			turn: { ...firstTurn, terminalStatus: "completed" },
		})
		expect(task.alphaMessages.filter(({ turn }) => turn?.terminalStatus === "completed")).toHaveLength(2)
	})

	it("resumes an open identity without replacing its original opening input", async () => {
		const snapshot = createAgentLifecycleSnapshot({
			taskId: "turn-attribution-task",
			runId: "saved-run",
			turnId: "saved-turn",
		})
		const original: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "text",
			text: "Original request.",
			turn: { runId: snapshot.runId, turnId: snapshot.turnId, inputKind: "start" },
		}
		const { task, events } = fixture({ messages: [original], snapshot })
		const openingMessageTs = await task["sayOpeningInput"]("user_feedback", "Continue with this detail.")

		await task["initiateTaskLoop"]([{ type: "text", text: "Continue with this detail." }], undefined, {
			openingMessageTs,
		})

		expect(events.filter(({ type }) => type === "turn_started")).toEqual([])
		expect(task.alphaMessages[0]).toEqual(original)
		expect(task.alphaMessages.find(({ ts }) => ts === openingMessageTs)?.turn).toEqual({
			runId: snapshot.runId,
			turnId: snapshot.turnId,
			inputKind: "steer",
		})
		expect(task.alphaMessages.at(-1)?.turn).toEqual({
			runId: snapshot.runId,
			turnId: snapshot.turnId,
			terminalStatus: "completed",
		})
	})

	it.each(["explicit", "tool-context"] as const)(
		"keeps a late command producer in its captured turn (%s)",
		async (capture) => {
			const { task, persisted } = fixture()
			await task["beginCanonicalLifecycleTurn"]()
			const producerTurn = task.captureMessageTurn()!
			const entered = deferred()
			const release = deferred()
			const publish = async () => {
				await task.say("command_output", "Still running.", undefined, true, undefined, undefined, {
					commandExecutionId: "earlier-command",
					...(capture === "explicit" ? { turn: producerTurn } : {}),
				})
				entered.resolve()
				await release.promise
				await task.say("command_output", "Earlier command finished.", undefined, false, undefined, undefined, {
					commandExecutionId: "earlier-command",
					...(capture === "explicit" ? { turn: producerTurn } : {}),
				})
			}
			const pending = capture === "explicit" ? publish() : task.withToolInputContext("earlier-call", publish)
			await entered.promise
			try {
				await task["finishCanonicalLifecycleTurn"]({
					...completedResponse("Earlier turn done."),
					steps: 1,
					completionReason: "assistant",
				})
				await task["beginCanonicalLifecycleTurn"]()
				const successorTurn = task.captureMessageTurn()!
				expect(successorTurn.turnId).not.toBe(producerTurn.turnId)
				await task.say("command_output", "Successor output.", undefined, false, undefined, undefined, {
					commandExecutionId: "successor-command",
				})
			} finally {
				release.resolve()
				await pending
			}

			const earlier = task.alphaMessages.find(
				({ commandExecutionId }) => commandExecutionId === "earlier-command",
			)!
			const successor = task.alphaMessages.find(
				({ commandExecutionId }) => commandExecutionId === "successor-command",
			)!
			expect(earlier).toMatchObject({ text: "Earlier command finished.", partial: false, turn: producerTurn })
			expect(successor.turn).toEqual(task.captureMessageTurn())
			expect(persisted.at(-1)).toEqual(task.alphaMessages)
		},
	)

	it("attributes the sampled answer instead of a later completion-hook warning", async () => {
		const { task } = fixture()
		const openingMessageTs = await task["sayOpeningInput"]("text", "Finish the work.")
		vi.mocked(task["evaluateCompletionHooks"]).mockImplementationOnce(async () => {
			await task.say("text", "Warning: optional hook diagnostic.", undefined, false)
			return {}
		})

		await task["initiateTaskLoop"]([{ type: "text", text: "Finish the work." }], undefined, { openingMessageTs })

		const final = task.alphaMessages.find(({ text }) => text === "The work is complete.")!
		expect(final).toMatchObject({ say: "completion_result", turn: { terminalStatus: "completed" } })
		expect(task.alphaMessages.find(({ text }) => text === "Warning: optional hook diagnostic.")).toMatchObject({
			say: "text",
			turn: membership(final.turn),
		})
		expect(task.alphaMessages.filter(({ turn }) => turn?.terminalStatus)).toEqual([final])
	})

	it("attributes a completion-tool final created during effects instead of retained commentary", async () => {
		const turn = { runId: "retained-run", turnId: "retained-turn" }
		const { task } = fixture({
			snapshot: createAgentLifecycleSnapshot({ taskId: "turn-attribution-task", ...turn }),
			messages: [
				{ ts: 1, type: "say", say: "text", text: "Finish the work.", turn: { ...turn, inputKind: "start" } },
				{ ts: 2, type: "say", say: "text", text: "I am checking the last result.", turn },
			],
		})
		const response = createAgentResponse([
			{
				type: "tool_call",
				id: "complete-1",
				name: "attempt_completion",
				arguments: { result: "The verified result." },
			},
		])
		vi.mocked(task["runAgentRequests"]).mockResolvedValue({
			status: "completed",
			response,
			transaction: {
				commitResponse: async () => ({ status: "completed", response }),
				executeEffects: async () => {
					await task.presentCompletionResult("The verified result.")
					task.markCompleted()
					return { status: "completed", response }
				},
				release: vi.fn(),
			},
		})

		await task["initiateTaskLoop"]([])

		const final = task.alphaMessages.find(({ say }) => say === "completion_result")!
		expect(final).toMatchObject({ text: "The verified result.", turn: { ...turn, terminalStatus: "completed" } })
		expect(task.alphaMessages.find(({ ts }) => ts === 2)?.turn).toEqual(turn)
		expect(task.alphaMessages.filter(({ turn: attribution }) => attribution?.terminalStatus)).toEqual([final])
	})

	it.each(["text", "completion_result"] as const)(
		"retracts rejected %s finality while retaining membership",
		async (say) => {
			const { task, persisted } = fixture()
			await task["beginCanonicalLifecycleTurn"]()
			await task.say("text", "Candidate answer.", undefined, false)
			const timestamp = task.alphaMessages.at(-1)!.ts
			await task["finishCanonicalLifecycleTurn"](
				{ ...completedResponse("Candidate answer."), steps: 1, completionReason: "assistant" },
				undefined,
				undefined,
				timestamp,
			)
			if (say === "completion_result") await task.presentCompletionResult("Candidate answer.")
			const turn = membership(task.alphaMessages[0].turn)

			await task.retractCompletionResult()

			expect(task.alphaMessages).toEqual([
				expect.objectContaining({
					ts: timestamp,
					say: "text",
					text: "Candidate answer.",
					partial: false,
					turn,
				}),
			])
			expect(persisted.at(-1)?.[0].turn).toEqual(turn)
			expect(task.apiConversationHistory).toEqual([])
		},
	)

	it("round-trips completed and legacy memberships through task-message storage", async ({ onTestFinished }) => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-turn-attribution-"))
		onTestFinished(async () => fs.rm(globalStoragePath, { recursive: true, force: true }))
		const legacy: AlphaMessage = { ts: 1, type: "say", say: "text", text: "Legacy transcript row." }
		const { task, persisted } = fixture({ messages: [legacy] })
		const openingMessageTs = await task["sayOpeningInput"]("user_feedback", "New request.")
		await task["initiateTaskLoop"]([{ type: "text", text: "New request." }], undefined, { openingMessageTs })
		await saveTaskMessages({ messages: persisted.at(-1)!, taskId: task.taskId, globalStoragePath })

		const reloaded = await readTaskMessages({ taskId: task.taskId, globalStoragePath, requireExisting: true })

		expect(reloaded).toEqual(task.alphaMessages)
		expect(reloaded[0]).toEqual(legacy)
		expect(reloaded.find(({ ts }) => ts === openingMessageTs)?.turn?.inputKind).toBe("start")
		expect(reloaded.at(-1)?.turn?.terminalStatus).toBe("completed")
	})
})
