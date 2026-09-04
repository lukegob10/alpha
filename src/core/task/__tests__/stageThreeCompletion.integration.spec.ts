import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"
import { RooCodeEventName, agentControlStateSchema } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { AgentControlStore, FileAgentControlPersistence } from "../../agent/AgentControlStore"
import { createAgentResponse } from "../../agent/AgentResponse"
import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { fingerprintContent } from "../../tools/contentVersion"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { ClineProvider } from "../../webview/ClineProvider"
import { Task } from "../Task"

const TASK_ID = "stage-three-completion"
const CHANGE_SET_ID = "applied-worker-change"
const PRIMARY_CHANGE_SET_ID = `primary-change:${TASK_ID}`
const MAX_SCRIPTED_STEPS = 20
const MAX_UNVERIFIED_COMPLETION_ATTEMPTS = 3
const COMPLETION_TEXT = "The requested work is finished."

type CompletionKind = "text" | "explicit"
type ObligationKind = "worker" | "primary"
type UserContent = Anthropic.Messages.ContentBlockParam[]

const COMPLETION_OBLIGATIONS = [
	["text", "worker"],
	["explicit", "worker"],
	["text", "primary"],
	["explicit", "primary"],
] as const

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

async function createHarness() {
	const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "stage-three-completion-"))
	const persistence = new FileAgentControlPersistence(storagePath)
	const store = new AgentControlStore(persistence)
	await store.initialize()
	await store.ensureRoot({ taskId: TASK_ID, objective: "Verify task completion", status: "running" })
	await store.createAgent({
		taskId: "completion-worker",
		parentTaskId: TASK_ID,
		rootTaskId: TASK_ID,
		nickname: "Completion Worker",
		role: "worker",
		objective: "Produce a change requiring parent validation",
		status: "completed",
	})
	const events: AgentTurnEvent[] = []
	const requests: UserContent[] = []
	const emit = vi.fn()
	const say = vi.fn<Task["say"]>(async () => undefined)
	const ask = vi.fn<Task["ask"]>(async () => ({ response: "yesButtonClicked", text: "", images: [] }))
	const presentCompletionResult = vi.fn<Task["presentCompletionResult"]>(async () => undefined)
	const retractCompletionResult = vi.fn<Task["retractCompletionResult"]>(async () => undefined)
	const flush = vi.fn<Task["flushPendingToolResultsToHistory"]>(async () => true)
	const cancellation = new AbortController()
	const provider = {
		getParentCompletionDecision: vi.fn(async () => store.getParentCompletionDecision(TASK_ID, TASK_ID)),
		prepareTaskCompletionLifecycle: vi.fn(async () => {
			await store.updateAgentStatus(TASK_ID, "completed", {}, TASK_ID)
		}),
		rollbackTaskCompletionLifecycle: vi.fn(async () => {
			await store.updateAgentStatus(TASK_ID, "pending", {}, TASK_ID)
			await store.updateAgentStatus(TASK_ID, "running", {}, TASK_ID)
		}),
	}

	// Keep the Task loop, engine, completion gate, completion tool, scheduler, and
	// finalizer real. The substituted adapters isolate provider/UI I/O and expose
	// the persistence await without introducing timers or a second completion loop.
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: TASK_ID,
		instanceId: "completion-fixture",
		taskKind: "primary",
		workspacePath: storagePath,
		globalStoragePath: storagePath,
		enableCheckpoints: false,
		abort: false,
		didComplete: false,
		didEmitTaskCompleted: false,
		didToolFailInCurrentTurn: false,
		userMessageContent: [],
		userMessageContentReady: false,
		apiConversationHistory: [],
		persistedToolResultIds: new Set<string>(),
		clineMessages: [],
		messageQueueService: new MessageQueueService(),
		taskCancellationController: cancellation,
		commandExecutionEvidence: new Map(),
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 3,
		consecutiveNoToolUseCount: 0,
		consecutiveNoAssistantMessagesCount: 0,
		automaticMistakeRecoveryCount: 0,
		toolRepetitionDetector: new ToolRepetitionDetector(3),
		toolUsage: {},
		providerRef: { deref: () => provider },
		emit,
		say,
		ask,
		presentCompletionResult,
		retractCompletionResult,
		flushPendingToolResultsToHistory: flush,
		emitFinalTokenUsageUpdate: vi.fn(),
		beginCanonicalLifecycleTurn: vi.fn(async () => undefined),
		finishCanonicalLifecycleTurn: vi.fn(async () => undefined),
		publishCanonicalLifecycleStepStatus: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async (event: AgentTurnEvent) => {
			events.push(event)
		}),
		flushAgentTurnEvents: vi.fn(async () => undefined),
	}) as Task
	const registry = new ToolRegistry()
	let guardTriggered = false
	const requestStep = vi.fn<Task["recursivelyMakeClineRequests"]>()
	task.recursivelyMakeClineRequests = requestStep

	const installCandidates = (kind: CompletionKind, beforeCandidate?: (step: number) => void) => {
		requestStep.mockImplementation(async (input) => {
			requests.push(structuredClone(input))
			// This is only a test safety net. A production bounded handoff must occur
			// before this guard; throwing here becomes a failed turn, not incomplete.
			if (requests.length > MAX_SCRIPTED_STEPS) {
				guardTriggered = true
				throw new Error("Completion safety guard reached: the task requested more than 20 stagnant steps")
			}
			task.userMessageContent = []
			task.didToolFailInCurrentTurn = false
			beforeCandidate?.(requests.length)
			const response = createAgentResponse(
				kind === "text"
					? [{ type: "text", text: COMPLETION_TEXT }]
					: [
							{
								type: "tool_call",
								id: `completion-${requests.length}`,
								name: "attempt_completion",
								arguments: { result: COMPLETION_TEXT },
							},
						],
			)
			if (kind === "explicit") {
				await new ToolScheduler({
					task,
					registry,
					mode: "code",
					signal: cancellation.signal,
					preserveAbortedResults: true,
					onEvent: (event) => {
						events.push(event)
					},
				}).run(response)
			}
			return { status: "completed", response }
		})
	}

	const addAppliedObligation = async (kind: ObligationKind) => {
		if (kind === "primary") {
			const content = "export const changed = true\n"
			await fs.mkdir(path.join(storagePath, "src"), { recursive: true })
			await fs.writeFile(path.join(storagePath, "src", "changed.ts"), content)
			await store.recordPrimaryMutation({
				rootTaskId: TASK_ID,
				parentTaskId: TASK_ID,
				workspacePath: storagePath,
				fileVersions: { "src/changed.ts": fingerprintContent(content) },
				at: 2_000,
			})
			return
		}
		await store.recordWorkerChangeSet({
			rootTaskId: TASK_ID,
			parentTaskId: TASK_ID,
			workerTaskId: "completion-worker",
			workerPath: "/root/completion_worker",
			workerNickname: "Completion Worker",
			groupId: "completion-group",
			changeSet: {
				id: CHANGE_SET_ID,
				status: "applied",
				changedFiles: ["src/changed.ts"],
				createdAt: 1_000,
				updatedAt: 2_000,
			},
			reviewSource: "apply",
			at: 2_000,
		})
	}

	const assertDurableObligationPending = async (kind: ObligationKind) => {
		const persisted = agentControlStateSchema.parse(await persistence.read())
		expect(persisted.verificationObligations).toContainEqual(
			expect.objectContaining({
				changeSetId: kind === "primary" ? PRIMARY_CHANGE_SET_ID : CHANGE_SET_ID,
				parentTaskId: TASK_ID,
				status: "pending",
				...(kind === "primary" ? { origin: "primary", contentVersion: 1, workspacePath: storagePath } : {}),
			}),
		)
		expect(store.getParentCompletionDecision(TASK_ID, TASK_ID).allowed).toBe(false)
	}

	const run = () => {
		const initiateTaskLoop = Reflect.get(task, "initiateTaskLoop") as (input: UserContent) => Promise<void>
		return initiateTaskLoop.call(task, [{ type: "text", text: "Finish the requested work." }])
	}

	const assertNotCompleted = () => {
		expect(Reflect.get(task, "didComplete")).toBe(false)
		expect(emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(0)
		expect(events.filter((event) => event.type === "task_completed" && event.status === "completed")).toHaveLength(
			0,
		)
	}

	const assertIncomplete = () => {
		expect(guardTriggered, "Production must stop before the test's 20-step safety guard").toBe(false)
		expect(requests.length).toBeLessThanOrEqual(MAX_SCRIPTED_STEPS)
		assertNotCompleted()
		expect(events.filter((event) => event.type === "task_incomplete")).toHaveLength(1)
		expect(events.filter((event) => event.type === "task_failed")).toHaveLength(0)
	}

	const useManagedCompletionDecision = () => {
		// Exercise the production descendant/mailbox decision, not an invented
		// rejection shape. These cases have no command or file-change evidence.
		const managedProvider = Object.assign(Object.create(ClineProvider.prototype), {
			agentControlStore: store,
			recordParentVerificationEvidence: vi.fn(async () => undefined),
			ensureAgentControlRoot: vi.fn(async () => store.getAgent(TASK_ID, TASK_ID)!),
		}) as ClineProvider
		provider.getParentCompletionDecision.mockImplementation(() => managedProvider.getParentCompletionDecision(task))
	}

	return {
		task,
		store,
		persistence,
		events,
		requests,
		emit,
		ask,
		flush,
		provider,
		presentCompletionResult,
		installCandidates,
		addAppliedObligation,
		assertDurableObligationPending,
		assertNotCompleted,
		assertIncomplete,
		useManagedCompletionDecision,
		guardTriggered: () => guardTriggered,
		cancel: () => {
			task.abort = true
			cancellation.abort(new Error("Fixture user cancellation"))
		},
		run,
		async dispose() {
			task.messageQueueService.removeAllListeners()
			await store.shutdown()
			await fs.rm(storagePath, { recursive: true, force: true })
		},
	}
}

describe("Stage Three durable completion integration", () => {
	const harnesses: Awaited<ReturnType<typeof createHarness>>[] = []

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	})

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()))
		vi.restoreAllMocks()
	})

	async function setup(kind: CompletionKind) {
		const harness = await createHarness()
		harnesses.push(harness)
		harness.installCandidates(kind)
		return harness
	}

	it.each(COMPLETION_OBLIGATIONS)(
		"bounds repeated %s completion candidates against a real durable %s verification obligation",
		async (kind, obligationKind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation(obligationKind)
			await harness.assertDurableObligationPending(obligationKind)

			await harness.run()

			harness.assertIncomplete()
			expect(harness.presentCompletionResult).not.toHaveBeenCalled()
			await harness.assertDurableObligationPending(obligationKind)
		},
	)

	it.each(COMPLETION_OBLIGATIONS)(
		"revalidates %s completion when a durable %s obligation arrives during the persistence await",
		async (kind, obligationKind) => {
			const harness = await setup(kind)
			const entered = deferred()
			const release = deferred()
			harness.flush.mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
				return true
			})
			const running = harness.run()
			try {
				await Promise.race([
					entered.promise,
					running.then(() => {
						throw new Error("Task ended before reaching the completion persistence barrier")
					}),
				])
				expect(harness.provider.getParentCompletionDecision).toHaveBeenCalled()
				await harness.addAppliedObligation(obligationKind)
				await harness.assertDurableObligationPending(obligationKind)
			} finally {
				release.resolve()
				await running
			}

			harness.assertIncomplete()
			expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).not.toBe("completed")
			await harness.assertDurableObligationPending(obligationKind)
		},
	)

	it.each(["text", "explicit"] as const)(
		"bounds repeated %s completion candidates while a command is still running",
		async (kind) => {
			const harness = await setup(kind)
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			expect(harness.task.hasActiveCommandExecutions()).toBe(true)
			expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])

			await harness.run()

			harness.assertIncomplete()
			expect(harness.requests.length).toBeLessThanOrEqual(MAX_UNVERIFIED_COMPLETION_ATTEMPTS)
			expect(harness.presentCompletionResult).not.toHaveBeenCalled()
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({
					toolCallId: "running-check",
					executionId: "physical-running-check",
					status: "running",
				}),
			])
		},
	)

	it.each(["active descendant", "unconsumed result"] as const)(
		"bounds repeated text completion claims blocked by an %s without file-verification debt",
		async (blocker) => {
			const harness = await setup("text")
			harness.useManagedCompletionDecision()
			if (blocker === "active descendant") {
				await harness.store.createAgent({
					taskId: "active-managed-child",
					parentTaskId: TASK_ID,
					rootTaskId: TASK_ID,
					nickname: "Active Managed Child",
					role: "explore",
					objective: "Continue the requested exploration",
					status: "running",
				})
			} else {
				await harness.store.appendEvent({
					eventId: "unconsumed-managed-result",
					rootTaskId: TASK_ID,
					sender: "completion-worker",
					recipient: TASK_ID,
					kind: "result",
					name: "worker_result",
					payload: { taskId: "completion-worker", summary: "Review this result before finishing." },
				})
			}
			expect(await harness.provider.getParentCompletionDecision()).toMatchObject({
				allowed: false,
				blockingObligations: [],
				message: expect.stringContaining(blocker === "active descendant" ? "still active" : "unconsumed"),
			})

			await harness.run()

			harness.assertIncomplete()
			expect(harness.requests.length).toBeLessThanOrEqual(MAX_UNVERIFIED_COMPLETION_ATTEMPTS)
			expect(harness.presentCompletionResult).not.toHaveBeenCalled()
			expect(harness.provider.prepareTaskCompletionLifecycle).not.toHaveBeenCalled()
			expect(
				harness.events.filter((event) => event.type === "tool_result" || event.type === "tool_batch_started"),
			).toHaveLength(0)
			const persisted = agentControlStateSchema.parse(await harness.persistence.read())
			expect(persisted.verificationObligations).toEqual([])
			if (blocker === "active descendant") {
				expect(persisted.agents).toContainEqual(
					expect.objectContaining({ taskId: "active-managed-child", status: "running" }),
				)
			} else {
				const result = persisted.mailbox.find((entry) => entry.eventId === "unconsumed-managed-result")
				expect(result).toBeDefined()
				expect(result?.acknowledgedAt).toBeUndefined()
			}
		},
	)

	it.each(["text", "explicit"] as const)("allows ordinary %s completion without applicable changes", async (kind) => {
		const harness = await setup(kind)

		await harness.run()

		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(1)
		expect(Reflect.get(harness.task, "didComplete")).toBe(true)
		expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
		expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).toBe("completed")
	})

	it.each(["text", "explicit"] as const)(
		"preserves queued guidance arriving while %s completion is being persisted",
		async (kind) => {
			const harness = await setup(kind)
			const guidance = "Include the missing explanation before finishing."
			harness.flush.mockImplementationOnce(async () => {
				harness.task.messageQueueService.addMessage(guidance)
				return true
			})

			await harness.run()

			expect(harness.guardTriggered()).toBe(false)
			expect(harness.requests).toHaveLength(2)
			expect(JSON.stringify(harness.requests[1])).toContain(guidance)
			expect(harness.provider.rollbackTaskCompletionLifecycle).toHaveBeenCalledOnce()
			expect(harness.task.messageQueueService.isEmpty()).toBe(true)
			expect(Reflect.get(harness.task, "didComplete")).toBe(true)
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
		},
	)

	it.each(["text", "explicit"] as const)("does not complete a cancelled %s candidate", async (kind) => {
		const harness = await setup(kind)
		harness.installCandidates(kind, () => harness.cancel())

		await harness.run()

		harness.assertNotCompleted()
		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(1)
		expect(harness.provider.prepareTaskCompletionLifecycle).not.toHaveBeenCalled()
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "task_completed", status: "aborted" }))
	})
})
