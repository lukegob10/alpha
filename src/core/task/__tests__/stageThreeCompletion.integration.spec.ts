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
import { WorkspaceMutationGate } from "../WorkspaceMutationGate"

const TASK_ID = "stage-three-completion"
const CHANGE_SET_ID = "applied-worker-change"
const PRIMARY_CHANGE_SET_ID = `primary-change:${TASK_ID}`
const MAX_SCRIPTED_STEPS = 20
const MAX_UNVERIFIED_COMPLETION_ATTEMPTS = 3
const MAX_UNCHANGED_REPAIR_TOOLS = 8
const COMPLETION_TEXT = "The requested work is finished."

type CompletionKind = "text" | "explicit"
type ObligationKind = "worker" | "primary"
type UserContent = Anthropic.Messages.ContentBlockParam[]

const COMPLETION_OBLIGATIONS = [
	["text", "worker"],
	["explicit", "worker"],
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
	const cancellation = new AbortController()
	let task!: Task
	const ask = vi.fn<Task["ask"]>(async (type) => {
		if (type === "resume_task") {
			// Bounded-completion cases now remain live at a resume boundary. End the
			// fixture there so the test can inspect that boundary without hanging.
			task.abort = true
			cancellation.abort(new Error("Fixture ended after observing the resume boundary"))
		}
		return { response: "yesButtonClicked", text: "", images: [] }
	})
	const presentCompletionResult = vi.fn<Task["presentCompletionResult"]>(async () => undefined)
	const retractCompletionResult = vi.fn<Task["retractCompletionResult"]>(async () => undefined)
	const flush = vi.fn<Task["flushPendingToolResultsToHistory"]>(async () => true)
	const mutationGate = new WorkspaceMutationGate()
	const provider = {
		getParentCompletionDecision: vi.fn(async () => store.getParentCompletionDecision(TASK_ID, TASK_ID)),
		recordParentVerificationEvidence: vi.fn<() => Promise<void>>(async () => undefined),
		runWorkspaceMutation<T>(owner: Task, label: string, operation: () => Promise<T>) {
			return mutationGate.run(owner.taskId, label, operation, () => owner.abort)
		},
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
	task = Object.assign(Object.create(Task.prototype), {
		taskId: TASK_ID,
		instanceId: "completion-fixture",
		taskKind: "primary",
		workspacePath: storagePath,
		globalStoragePath: storagePath,
		enableCheckpoints: false,
		abort: false,
		isTaskLoopActive: true,
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
	const builtIns = new ToolRegistry()
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register(builtIns.resolve("attempt_completion")!)
	registry.register({
		name: "list_files",
		aliases: [],
		schema: builtIns.resolve("list_files")!.schema,
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		async execute({ callbacks }) {
			callbacks.pushToolResult("README.md")
		},
	})
	registry.register({
		name: "read_file",
		aliases: [],
		schema: builtIns.resolve("read_file")!.schema,
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		async execute({ call, callbacks }) {
			const args = call.nativeArgs
			if (!args || !("path" in args) || typeof args.path !== "string") {
				throw new Error("The read fixture requires the canonical native path argument")
			}
			callbacks.pushToolResult(await fs.readFile(path.join(storagePath, args.path), "utf8"))
		},
	})
	registry.register({
		name: "execute_command",
		aliases: [],
		schema: builtIns.resolve("execute_command")!.schema,
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: false },
		async execute({ call, callbacks }) {
			const args = call.nativeArgs
			if (!call.id || !args || !("command" in args) || typeof args.command !== "string") {
				throw new Error("The command fixture requires canonical native command arguments and an ID")
			}
			const executionId = `fixture-${call.id}`
			const verification = "verification" in args ? args.verification : undefined
			task.beginCommandExecution(call.id, executionId, args.command, verification?.change_set_ids)
			task.completeCommandExecution(call.id, { exitCode: 0 }, executionId)
			// A terminal command without captured, matching evidence cannot discharge the ledger debt.
			callbacks.pushToolResult(
				"Command exited with code 0; no current scoped verification evidence was credited.",
			)
		},
	})
	let guardTriggered = false
	const requestStep = vi.fn<Task["recursivelyMakeClineRequests"]>()
	task.recursivelyMakeClineRequests = requestStep

	const installCandidates = (
		kind: CompletionKind,
		beforeCandidate?: (step: number) => void | Promise<void>,
		interleaveReads: boolean | "repair-verification" | readonly string[] = false,
		repairChangeSetId = CHANGE_SET_ID,
	) => {
		requestStep.mockImplementation(async (input) => {
			// Model the request adapter's durable steering consumption; the real
			// steerUserMessage admission and completion-wait interruption remain intact.
			const pendingSteer = Reflect.get(task, "pendingSteerMessage") as
				| { text: string; onPersisted?: () => Promise<void> | void }
				| undefined
			if (pendingSteer) {
				Reflect.set(task, "pendingSteerMessage", undefined)
				input = [...input, { type: "text", text: pendingSteer.text }]
				await pendingSteer.onPersisted?.()
				Reflect.set(task, "steerMessageAwaitingPersistence", false)
			}
			requests.push(structuredClone(input))
			// This is only a test safety net. A production bounded handoff must occur
			// before this guard; throwing here becomes a failed turn, not incomplete.
			if (requests.length > MAX_SCRIPTED_STEPS) {
				guardTriggered = true
				throw new Error("Completion safety guard reached: the task requested more than 20 stagnant steps")
			}
			task.userMessageContent = []
			task.didToolFailInCurrentTurn = false
			const relevantFiles = typeof interleaveReads === "object" ? interleaveReads : undefined
			const relevantPath = relevantFiles?.[requests.length - 2]
			const isRead = relevantFiles
				? relevantPath !== undefined
				: interleaveReads === true && requests.length % 2 === 0
			const isRepair = interleaveReads === "repair-verification" && requests.length > 1
			await beforeCandidate?.(requests.length)
			const response = createAgentResponse(
				isRead || isRepair
					? [
							{
								type: "tool_call",
								id: `${isRepair ? "check" : "read"}-${requests.length}`,
								name: isRepair ? "execute_command" : relevantPath ? "read_file" : "list_files",
								arguments: isRepair
									? {
											command: `pnpm${" ".repeat(requests.length)}check-types`,
											cwd: storagePath,
											timeout: null,
											verification: { change_set_ids: [repairChangeSetId] },
										}
									: { path: relevantPath ?? `unrelated-${requests.length}` },
							},
						]
					: kind === "text"
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
			if (isRead || isRepair || kind === "explicit") {
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

	const addAppliedObligation = async (kind: ObligationKind, files = ["src/changed.ts"]) => {
		const content = "export const changed = true\n"
		for (const file of files) {
			await fs.mkdir(path.dirname(path.join(storagePath, file)), { recursive: true })
			await fs.writeFile(path.join(storagePath, file), content)
		}
		if (kind === "primary") {
			await store.recordPrimaryMutation({
				rootTaskId: TASK_ID,
				parentTaskId: TASK_ID,
				workspacePath: storagePath,
				fileVersions: Object.fromEntries(files.map((file) => [file, fingerprintContent(content)])),
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
				changedFiles: files,
				createdAt: 1_000,
				updatedAt: 2_000,
			},
			reviewSource: "apply",
			at: 2_000,
		})
		await store.reconcileVerificationContent(
			TASK_ID,
			CHANGE_SET_ID,
			storagePath,
			Object.fromEntries(files.map((file) => [file, fingerprintContent(content)])),
			TASK_ID,
		)
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

	const assertRecoverableStop = () => {
		expect(guardTriggered, "Production must stop before the test's 20-step safety guard").toBe(false)
		expect(requests.length).toBeLessThanOrEqual(MAX_SCRIPTED_STEPS)
		assertNotCompleted()
		expect(ask).toHaveBeenCalledWith("resume_task")
		expect(events.filter((event) => event.type === "task_incomplete")).toHaveLength(0)
		expect(events.filter((event) => event.type === "task_failed")).toHaveLength(0)
		expect(events).toContainEqual(expect.objectContaining({ type: "task_completed", status: "aborted" }))
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

	const useRealManagedCompletionLifecycle = () => {
		const managedProvider = Object.assign(Object.create(ClineProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			agentControlRootStatusWrites: new Map<string, Promise<void>>(),
		}) as ClineProvider
		provider.getParentCompletionDecision.mockImplementation(() => managedProvider.getParentCompletionDecision(task))
		provider.recordParentVerificationEvidence.mockImplementation(() =>
			managedProvider.recordParentVerificationEvidence(task),
		)
		provider.prepareTaskCompletionLifecycle.mockImplementation(() =>
			managedProvider.prepareTaskCompletionLifecycle(TASK_ID),
		)
		provider.rollbackTaskCompletionLifecycle.mockImplementation(() =>
			managedProvider.rollbackTaskCompletionLifecycle(TASK_ID),
		)
		return managedProvider
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
		mutationGate,
		storagePath,
		presentCompletionResult,
		installCandidates,
		addAppliedObligation,
		assertDurableObligationPending,
		assertNotCompleted,
		assertRecoverableStop,
		useManagedCompletionDecision,
		useRealManagedCompletionLifecycle,
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
		vi.useRealTimers()
	})

	async function setup(kind: CompletionKind, advanceOwnerHeartbeat = false) {
		// Long runtime waits must advance the owner's real heartbeat along with
		// completion timers, so install the fake clock before acquiring its lease.
		if (advanceOwnerHeartbeat) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const harness = await createHarness()
		harnesses.push(harness)
		harness.installCandidates(kind)
		return harness
	}

	async function observePendingCandidate(harness: Awaited<ReturnType<typeof createHarness>>, useFakeClock = true) {
		if (useFakeClock && !vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const entered = deferred()
		const gate = harness.task.getCompletionGateDecision.bind(harness.task)
		vi.spyOn(harness.task, "getCompletionGateDecision").mockImplementation(async () => {
			entered.resolve()
			return gate()
		})
		const running = harness.run()
		await Promise.race([
			entered.promise,
			running.then(() => {
				throw new Error("Task ended before evaluating the completion candidate")
			}),
		])
		return { running }
	}

	it.each(["text", "explicit"] as const)("completes a settled primary edit in one %s response", async (kind) => {
		const harness = await setup(kind)
		await harness.addAppliedObligation("primary", ["README.md"])
		await harness.run()
		expect(harness.requests).toHaveLength(1)
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "execute_command"),
		).toHaveLength(0)
		expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.store.getParentCompletionDecision(TASK_ID).allowed).toBe(true)
	})

	it.each(COMPLETION_OBLIGATIONS)(
		"bounds repeated %s completion candidates against a real durable %s verification obligation",
		async (kind, obligationKind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation(obligationKind)
			await harness.assertDurableObligationPending(obligationKind)

			await harness.run()

			harness.assertRecoverableStop()
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

			harness.assertRecoverableStop()
			expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).not.toBe("completed")
			await harness.assertDurableObligationPending(obligationKind)
		},
	)

	it.each(["text", "explicit"] as const)(
		"retains one %s completion candidate until a running command and its verification publication settle",
		async (kind) => {
			const harness = await setup(kind)
			const firstCandidateUsage = harness.task.getTokenUsage()
			const publication = deferred()
			harness.provider.recordParentVerificationEvidence.mockImplementationOnce(() => publication.promise)
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			expect(harness.task.hasActiveCommandExecutions()).toBe(true)
			expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])

			const { running } = await observePendingCandidate(harness)
			try {
				await vi.advanceTimersByTimeAsync(1_000)
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(harness.task.consecutiveMistakeCount).toBe(0)
				harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
				await vi.advanceTimersByTimeAsync(1_000)
				expect(harness.provider.recordParentVerificationEvidence).toHaveBeenCalledOnce()
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
			} finally {
				publication.resolve()
				harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
			expect(harness.requests).toHaveLength(1)
			expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
			expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).toBe("completed")
			const metrics = harness.task.getCompletionStageMetrics()
			expect(metrics).toMatchObject({
				candidateCount: 1,
				rejectionCount: 0,
				repairToolCount: 0,
				firstCandidateAt: expect.any(Number),
				persistenceSettledAt: expect.any(Number),
				completedAt: expect.any(Number),
				firstCandidateUsage,
				settledUsage: harness.task.getTokenUsage(),
			})
			expect(metrics.firstCandidateAt).toBeLessThanOrEqual(metrics.persistenceSettledAt!)
			expect(metrics.persistenceSettledAt).toBeLessThanOrEqual(metrics.completedAt!)
			expect(metrics.runtimeWaitMs).toBeGreaterThanOrEqual(2_000)
		},
	)

	it.each(["text", "explicit"] as const)(
		"retains one %s candidate until a delayed mutation receipt is durably released",
		async (kind) => {
			const harness = await setup(kind)
			const token = "delayed-no-op-receipt"
			await harness.store.reservePrimaryMutation(TASK_ID, TASK_ID, harness.storagePath, token)
			const { running } = await observePendingCandidate(harness)
			try {
				await vi.advanceTimersByTimeAsync(1_000)
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(harness.task.consecutiveMistakeCount).toBe(0)
				const persisted = agentControlStateSchema.parse(await harness.persistence.read())
				expect(persisted.verificationObligations).toContainEqual(
					expect.objectContaining({ mutationReservations: [token], status: "pending" }),
				)
			} finally {
				// A proven no-op has no changed-file debt after its final receipt lands.
				await harness.store.releasePrimaryMutation(TASK_ID, TASK_ID, token)
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
			expect(harness.requests).toHaveLength(1)
			expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
			expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
		},
	)

	it.each(["text", "explicit"] as const)(
		"rechecks command activity admitted during the %s durable completion read",
		async (kind) => {
			const harness = await setup(kind)
			const entered = deferred()
			const release = deferred()
			harness.provider.getParentCompletionDecision.mockImplementationOnce(async () => {
				const decision = harness.store.getParentCompletionDecision(TASK_ID, TASK_ID)
				entered.resolve()
				await release.promise
				return decision
			})
			const { running } = await observePendingCandidate(harness)
			try {
				await entered.promise
				harness.task.beginCommandExecution("late-check", "physical-late-check", "pnpm exec vitest run")
				release.resolve()
				await vi.advanceTimersByTimeAsync(1_000)
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
			} finally {
				release.resolve()
				harness.task.completeCommandExecution("late-check", { exitCode: 0 }, "physical-late-check")
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
			expect(harness.requests).toHaveLength(1)
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
		},
	)

	it.each(["text", "explicit"] as const)(
		"keeps a healthy command running past 60 seconds during %s completion without a model retry",
		async (kind) => {
			const harness = await setup(kind, true)
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			const { running } = await observePendingCandidate(harness)
			try {
				await vi.advanceTimersByTimeAsync(60_000)
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(harness.task.consecutiveMistakeCount).toBe(0)
				expect(harness.task.hasActiveCommandExecutions()).toBe(true)
			} finally {
				harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
			expect(harness.requests).toHaveLength(1)
		},
	)

	it.each(["text", "explicit"] as const)(
		"bounds an orphan mutation receipt wait during %s completion without a model retry",
		async (kind) => {
			const harness = await setup(kind)
			await harness.store.reservePrimaryMutation(TASK_ID, TASK_ID, harness.storagePath, "orphan-receipt")
			const { running } = await observePendingCandidate(harness)
			try {
				await vi.advanceTimersByTimeAsync(31_000)
				await running
				harness.assertRecoverableStop()
				expect(harness.requests).toHaveLength(1)
				expect(harness.task.consecutiveMistakeCount).toBe(0)
			} finally {
				harness.cancel()
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
		},
	)

	it.each(["text", "explicit"] as const)(
		"cancels a %s completion wait while verification publication remains unresolved",
		async (kind) => {
			const harness = await setup(kind)
			const publication = deferred()
			harness.provider.recordParentVerificationEvidence.mockImplementationOnce(() => publication.promise)
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
			const { running } = await observePendingCandidate(harness)
			let settled = false
			void running.then(() => {
				settled = true
			})
			try {
				await vi.advanceTimersByTimeAsync(1_000)
				harness.cancel()
				await vi.advanceTimersByTimeAsync(1_000)
				expect(settled, "Cancellation must settle without waiting for the verification publisher").toBe(true)
				harness.assertNotCompleted()
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(harness.events).toContainEqual(
					expect.objectContaining({ type: "task_completed", status: "aborted" }),
				)
			} finally {
				publication.resolve()
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
		},
	)

	it.each(["text", "explicit"] as const)(
		"consumes real steering during a %s completion wait without Resume or losing its persistence receipt",
		async (kind) => {
			const harness = await setup(kind)
			const onPersisted = vi.fn(async () => undefined)
			const guidance = "Check the new requirement before finishing."
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			harness.installCandidates(kind, (step) => {
				if (step === 2)
					harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
			})
			const { running } = await observePendingCandidate(harness)
			try {
				await vi.advanceTimersByTimeAsync(1_000)
				expect(harness.requests).toHaveLength(1)
				await harness.task.steerUserMessage(guidance, [], onPersisted)
				await vi.advanceTimersByTimeAsync(1_000)
				await running
				expect(harness.requests).toHaveLength(2)
				expect(JSON.stringify(harness.requests[1])).toContain(guidance)
				expect(onPersisted).toHaveBeenCalledOnce()
				expect(Reflect.get(harness.task, "pendingSteerMessage")).toBeUndefined()
				expect(Reflect.get(harness.task, "steerMessageAwaitingPersistence")).toBe(false)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(
					harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted),
				).toHaveLength(1)
			} finally {
				harness.cancel()
				harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
				await vi.advanceTimersByTimeAsync(1_000)
				await running
			}
		},
	)

	it.each(["text", "explicit"] as const)(
		"allows a queued receipt publisher to acquire the workspace mutation gate during %s completion settlement",
		async (kind) => {
			const harness = await setup(kind)
			const token = "queued-receipt"
			await harness.store.reservePrimaryMutation(TASK_ID, TASK_ID, harness.storagePath, token)
			const entered = deferred()
			const release = deferred()
			const heldMutation = harness.mutationGate.run(TASK_ID, "earlier mutation", async () => {
				entered.resolve()
				await release.promise
			})
			await entered.promise
			const publisherQueued = deferred()
			let publication: Promise<void> | undefined
			harness.provider.recordParentVerificationEvidence.mockImplementationOnce(() => {
				publication = harness.provider.runWorkspaceMutation(harness.task, "publish receipt", () =>
					harness.store.releasePrimaryMutation(TASK_ID, TASK_ID, token),
				)
				publisherQueued.resolve()
				return publication
			})
			harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
			let running: Promise<void> | undefined
			try {
				// Gate ordering is controlled by promises. Leave persistence and runtime
				// timers live so filesystem completion cannot strand a frozen follow-up poll.
				const candidate = await observePendingCandidate(harness, false)
				running = candidate.running
				harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
				await publisherQueued.promise
				harness.assertNotCompleted()
				expect(harness.provider.recordParentVerificationEvidence).toHaveBeenCalledOnce()
				expect(harness.provider.prepareTaskCompletionLifecycle).not.toHaveBeenCalled()
				release.resolve()
				await heldMutation
				await publication
				await running
				expect(harness.requests).toHaveLength(1)
				expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				expect(
					harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted),
				).toHaveLength(1)
				expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
			} finally {
				release.resolve()
				harness.cancel()
				await heldMutation
				await running
			}
		},
	)

	it.each(["text", "explicit"] as const)(
		"does not charge internal completion gate reads against the %s candidate rejection budget",
		async (kind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation("worker")
			harness.installCandidates(kind, async () => {
				for (let read = 0; read < 5; read++) await harness.task.getCompletionGateDecision()
			})

			await harness.run()

			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(MAX_UNVERIFIED_COMPLETION_ATTEMPTS)
			expect(harness.task.getCompletionStageMetrics()).toMatchObject({
				candidateCount: MAX_UNVERIFIED_COMPLETION_ATTEMPTS,
				rejectionCount: MAX_UNVERIFIED_COMPLETION_ATTEMPTS,
				runtimeWaitMs: 0,
			})
			await harness.assertDurableObligationPending("worker")
		},
	)

	it.each(["text", "explicit"] as const)(
		"gives fresh user guidance a new %s rejection budget within the same task loop",
		async (kind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation("worker")
			const guidance = "Use the documented verification procedure, then reassess the result."
			harness.ask.mockImplementationOnce(async (type) => {
				expect(type).toBe("resume_task")
				return { response: "messageResponse", text: guidance, images: [] }
			})

			await harness.run()

			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(MAX_UNVERIFIED_COMPLETION_ATTEMPTS * 2)
			expect(JSON.stringify(harness.requests[MAX_UNVERIFIED_COMPLETION_ATTEMPTS])).toContain(guidance)
			expect(harness.ask).toHaveBeenCalledTimes(2)
			await harness.assertDurableObligationPending("worker")
		},
	)

	it.each(["text", "explicit"] as const)(
		"bounds %s completion candidates despite interleaved unrelated successful reads",
		async (kind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation("worker")
			harness.installCandidates(kind, undefined, true)

			await harness.run()

			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(MAX_UNVERIFIED_COMPLETION_ATTEMPTS * 2 - 1)
			expect(
				harness.events.filter((event) => event.type === "tool_result" && event.name === "list_files"),
			).toHaveLength(2)
			await harness.assertDurableObligationPending("worker")
		},
	)

	it.each(["text", "explicit"] as const)(
		"bounds explicitly scoped verification attempts that leave a rejected %s completion candidate unverified",
		async (kind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation("worker")
			harness.installCandidates(kind, undefined, "repair-verification")

			await harness.run()

			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(1 + MAX_UNCHANGED_REPAIR_TOOLS)
			expect(harness.task.getCompletionStageMetrics()).toMatchObject({
				candidateCount: 1,
				rejectionCount: 1,
				repairToolCount: MAX_UNCHANGED_REPAIR_TOOLS,
				blockedAt: expect.any(Number),
				settledUsage: harness.task.getTokenUsage(),
				lastReasonCode: "repair_limit",
			})
			expect(
				harness.events.filter(
					(event) =>
						event.type === "tool_result" && event.name === "execute_command" && event.status === "success",
				),
			).toHaveLength(MAX_UNCHANGED_REPAIR_TOOLS)
			await harness.assertDurableObligationPending("worker")
		},
	)

	it.each(["text", "explicit"] as const)(
		"keeps the unchanged worker repair budget through unrelated concurrent edits after %s rejection",
		async (kind) => {
			const harness = await setup(kind)
			await harness.addAppliedObligation("worker")
			harness.installCandidates(
				kind,
				async (step) => {
					if (step > 1) await harness.addAppliedObligation("primary", [`src/unrelated-${step}.ts`])
				},
				"repair-verification",
				CHANGE_SET_ID,
			)

			await harness.run()

			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(1 + MAX_UNCHANGED_REPAIR_TOOLS)
			await harness.assertDurableObligationPending("worker")
			expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toContainEqual(
				expect.objectContaining({ changeSetId: PRIMARY_CHANGE_SET_ID, changedFiles: expect.any(Array) }),
			)
		},
	)

	it.each([
		["text", "changed"],
		["explicit", "changed"],
		["text", "discovered caller/dependency"],
		["explicit", "discovered caller/dependency"],
	] as const)("allows %s completion after more than eight distinct %s reads", async (kind, scope) => {
		const harness = await setup(kind)
		const files = Array.from({ length: 10 }, (_, index) =>
			scope === "changed" ? `src/changed-${index}.ts` : `callers/dependency-${index}.ts`,
		)
		const changedFiles = scope === "changed" ? files : ["src/changed.ts"]
		await harness.addAppliedObligation("worker", changedFiles)
		const obligation = harness.store.getVerificationObligations({ parentTaskId: TASK_ID })[0]
		expect(Object.keys(obligation.fileVersions ?? {})).toEqual(changedFiles)
		harness.installCandidates(
			kind,
			async (step) => {
				if (scope !== "changed" && step === 2) {
					// Newly discovered callers are outside the mutation receipt's initial scope.
					await fs.mkdir(path.join(harness.storagePath, "callers"), { recursive: true })
					for (const file of files)
						await fs.writeFile(
							path.join(harness.storagePath, file),
							'import { changed } from "../src/changed"\nexport const caller = () => changed\n',
						)
				}
				if (step !== files.length + 2) return
				await harness.store.recordParentVerificationEvidence(
					TASK_ID,
					[
						{
							toolCallId: "scoped-verification",
							executionId: "scoped-verification-execution",
							status: "succeeded",
							command: "pnpm check-types",
							cwd: harness.storagePath,
							verificationChangeSetIds: [CHANGE_SET_ID],
							verificationVersions: {
								[CHANGE_SET_ID]: {
									contentVersion: obligation.contentVersion!,
									contentFingerprint: obligation.contentFingerprint!,
									scopePath: harness.storagePath,
									matchedFiles: changedFiles,
									commandDigest: fingerprintContent("pnpm check-types"),
									repositoryDigest: fingerprintContent(changedFiles.join("\n")),
									kind: "types",
								},
							},
							startedAt: obligation.appliedAt! + 1,
							completedAt: obligation.appliedAt! + 2,
							exitCode: 0,
						},
					],
					TASK_ID,
				)
			},
			files,
		)

		await harness.run()

		expect(harness.guardTriggered()).toBe(false)
		for (const event of harness.events) {
			if (event.type === "tool_result" && event.name === "read_file") {
				expect(event, "Each relevant read must succeed before it can count as repair progress").toMatchObject({
					status: "success",
				})
			}
		}
		expect(harness.requests).toHaveLength(files.length + 2)
		expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "read_file"),
		).toHaveLength(files.length)
		expect(harness.store.getParentCompletionDecision(TASK_ID, TASK_ID).allowed).toBe(true)
		expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it.each(["active descendant", "unconsumed result"] as const)(
		"handles text completion blocked by an %s without file-verification debt",
		async (blocker) => {
			const harness = await setup("text", blocker === "active descendant")
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

			if (blocker === "active descendant") {
				const { running } = await observePendingCandidate(harness)
				try {
					await vi.advanceTimersByTimeAsync(60_000)
					harness.assertNotCompleted()
					expect(harness.requests).toHaveLength(1)
					expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
				} finally {
					await harness.store.updateAgentStatus("active-managed-child", "completed", {}, TASK_ID)
					await vi.advanceTimersByTimeAsync(1_000)
					await running
				}
				expect(harness.requests).toHaveLength(1)
				expect(
					harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted),
				).toHaveLength(1)
				return
			} else {
				await harness.run()
			}

			harness.assertRecoverableStop()
			expect(harness.requests.length).toBeLessThanOrEqual(MAX_UNVERIFIED_COMPLETION_ATTEMPTS)
			expect(harness.presentCompletionResult).not.toHaveBeenCalled()
			expect(harness.provider.prepareTaskCompletionLifecycle).not.toHaveBeenCalled()
			expect(
				harness.events.filter((event) => event.type === "tool_result" || event.type === "tool_batch_started"),
			).toHaveLength(0)
			const persisted = agentControlStateSchema.parse(await harness.persistence.read())
			expect(persisted.verificationObligations).toEqual([])
			const result = persisted.mailbox.find((entry) => entry.eventId === "unconsumed-managed-result")
			expect(result).toBeDefined()
			expect(result?.acknowledgedAt).toBeUndefined()
		},
	)

	it.each(["text", "explicit"] as const)(
		"preserves the durably completed root through real provider %s completion gates and reload",
		async (kind) => {
			const harness = await setup(kind)
			const managedProvider = harness.useRealManagedCompletionLifecycle()

			await harness.run()

			expect(harness.guardTriggered()).toBe(false)
			expect(harness.requests).toHaveLength(1)
			expect(Reflect.get(harness.task, "didComplete")).toBe(true)
			expect(harness.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskCompleted)).toHaveLength(1)
			expect(
				harness.events.filter((event) => event.type === "task_completed" && event.status === "completed"),
			).toHaveLength(1)
			const completed = harness.store.getAgent(TASK_ID, TASK_ID)
			expect(completed).toMatchObject({ role: "root", status: "completed" })
			const persisted = agentControlStateSchema.parse(await harness.persistence.read())
			expect(persisted.agents.filter((agent) => agent.taskId === TASK_ID)).toEqual([completed])

			await managedProvider.recordParentVerificationEvidence(harness.task)
			expect(await managedProvider.getParentCompletionDecision(harness.task)).toMatchObject({ allowed: true })
			expect(harness.store.getAgent(TASK_ID, TASK_ID)).toEqual(completed)

			const reloaded = new AgentControlStore(new FileAgentControlPersistence(harness.storagePath))
			try {
				await reloaded.initialize()
				expect(reloaded.getAgent(TASK_ID, TASK_ID)).toEqual(completed)
				expect(
					reloaded.listAgents({ rootTaskId: TASK_ID }).filter((agent) => agent.role === "root"),
				).toHaveLength(1)
			} finally {
				await reloaded.shutdown()
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
			harness.useRealManagedCompletionLifecycle()
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
			expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).toBe("completed")
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
