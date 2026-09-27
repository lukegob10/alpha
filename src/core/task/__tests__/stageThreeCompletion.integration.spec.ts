import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { Anthropic } from "@anthropic-ai/sdk"
import { AlphaCodeEventName, agentControlStateSchema, type TaskWorkPlan } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { AgentControlStore, FileAgentControlPersistence } from "../../agent/AgentControlStore"
import { createAgentResponse } from "../../agent/AgentResponse"
import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { getLegacyFileToolSchemas } from "../../prompts/tools/native-tools"
import { fingerprintContent } from "../../tools/contentVersion"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"
import { WorkspaceMutationGate } from "../WorkspaceMutationGate"

const TASK_ID = "stage-three-completion"
const CHANGE_SET_ID = "applied-worker-change"
const PRIMARY_CHANGE_SET_ID = `primary-change:${TASK_ID}`
const MAX_SCRIPTED_STEPS = 20
const MAX_UNVERIFIED_COMPLETION_ATTEMPTS = 3
const COMPLETION_TEXT = "The requested work is finished."

type ObligationKind = "worker" | "primary"
type UserContent = Anthropic.Messages.ContentBlockParam[]

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
		pendingWaitAgentResultClaims: new Map(),
		stagedWaitAgentNotifications: new Map(),
		pendingWaitAgentNotificationBlocks: new Set(),
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
		requireAlphaMessagesSaved: vi.fn(async () => undefined),
		emitFinalTokenUsageUpdate: vi.fn(),
		beginCanonicalLifecycleTurn: vi.fn(async () => undefined),
		finishCanonicalLifecycleTurn: vi.fn(async () => undefined),
		publishCanonicalLifecycleStepStatus: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async (event: AgentTurnEvent) => {
			events.push(event)
		}),
		flushAgentTurnEvents: vi.fn(async () => undefined),
	}) as Task
	// This integration fixture manually registers historical read calls to test
	// completion bookkeeping. Production Task registries do not register them.
	const builtIns = new ToolRegistry()
	const legacyFileSchemas = getLegacyFileToolSchemas()
	const legacyFileSchema = (name: string) => {
		const schema = legacyFileSchemas.find((schema) => schema.type === "function" && schema.function.name === name)
		if (!schema) throw new Error(`Missing historical ${name} schema fixture`)
		return schema
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "list_files",
		aliases: [],
		schema: legacyFileSchema("list_files"),
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		async execute({ callbacks }) {
			callbacks.pushToolResult("README.md")
		},
	})
	registry.register({
		name: "read_file",
		aliases: [],
		schema: legacyFileSchema("read_file"),
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
		...builtIns.resolve("shell")!,
		aliases: [],
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: false },
		async execute({ call, callbacks }) {
			const args = call.nativeArgs
			if (!call.id || !args || !("cmd" in args) || typeof args.cmd !== "string") {
				throw new Error("The command fixture requires canonical native command arguments and an ID")
			}
			const executionId = `fixture-${call.id}`
			task.beginCommandExecution(call.id, executionId, args.cmd)
			task.completeCommandExecution(call.id, { exitCode: 0 }, executionId)
			// A terminal command without captured, matching evidence cannot discharge the ledger debt.
			callbacks.pushToolResult(
				"Command exited with code 0; no current scoped verification evidence was credited.",
			)
		},
	})
	let guardTriggered = false
	const requestStep = vi.fn<Task["runAgentRequests"]>()
	task.runAgentRequests = requestStep

	const installCandidates = (
		beforeCandidate?: (step: number) => void | Promise<void>,
		interleaveReads: boolean | "repair-verification" | readonly string[] = false,
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
			const relevantPath = relevantFiles?.[requests.length - 1]
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
								name: isRepair ? "exec_command" : relevantPath ? "read_file" : "list_files",
								arguments: isRepair
									? {
											cmd: `pnpm${" ".repeat(requests.length)}check-types`,
											workdir: storagePath,
											yield_time_ms: 1000,
										}
									: { path: relevantPath ?? `unrelated-${requests.length}` },
							},
						]
					: [{ type: "text", text: COMPLETION_TEXT }],
			)
			if (isRead || isRepair) {
				const outcome = await new ToolScheduler({
					task,
					registry,
					mode: "code",
					signal: cancellation.signal,
					preserveAbortedResults: true,
					onEvent: (event) => {
						events.push(event)
					},
				}).run(response)
				expect(outcome.results.map((result) => result.status)).toEqual(["success"])
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
		expect(store.getParentCompletionDecision(TASK_ID, TASK_ID).allowed).toBe(true)
	}

	const run = () => {
		const initiateTaskLoop = Reflect.get(task, "initiateTaskLoop") as (input: UserContent) => Promise<void>
		return initiateTaskLoop.call(task, [{ type: "text", text: "Finish the requested work." }])
	}

	const assertNotCompleted = () => {
		expect(Reflect.get(task, "didComplete")).toBe(false)
		expect(emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(0)
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
		const managedProvider = Object.assign(Object.create(AlphaProvider.prototype), {
			agentControlStore: store,
			recordParentVerificationEvidence: vi.fn(async () => undefined),
			ensureAgentControlRoot: vi.fn(async () => store.getAgent(TASK_ID, TASK_ID)!),
		}) as AlphaProvider
		provider.getParentCompletionDecision.mockImplementation(() => managedProvider.getParentCompletionDecision(task))
	}

	const useRealManagedCompletionLifecycle = () => {
		const managedProvider = Object.assign(Object.create(AlphaProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			agentControlRootStatusWrites: new Map<string, Promise<void>>(),
		}) as AlphaProvider
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

	async function setup(advanceOwnerHeartbeat = false) {
		// Long runtime waits must advance the owner's real heartbeat along with
		// completion timers, so install the fake clock before acquiring its lease.
		if (advanceOwnerHeartbeat) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const harness = await createHarness()
		harnesses.push(harness)
		harness.installCandidates()
		return harness
	}

	it("runs a configured Stop hook once per completion candidate and feeds its continuation as the next model input", async () => {
		const harness = await setup()
		const configuredHook = {
			command: process.execPath,
			args: [
				"-e",
				"let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);process.stdout.write(JSON.stringify(request.stop_hook_active?{decision:'allow'}:{decision:'block',reason:'Check the final result again.'}))})",
			],
		}
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({ get: (key: string) => (key === "completionHooks" ? { stop: [configuredHook] } : undefined) }) as any,
		)
		await harness.run()
		expect(harness.requests).toHaveLength(2)
		expect(JSON.stringify(harness.requests[1])).toContain("Check the final result again.")
		expect(harness.presentCompletionResult).toHaveBeenCalledOnce()
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it("stops after three configured hook continuations without completing", async () => {
		const harness = await setup()
		const configuredHook = {
			command: process.execPath,
			args: ["-e", "process.stdout.write(JSON.stringify({decision:'block',reason:'More work is required.'}))"],
		}
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({ get: (key: string) => (key === "completionHooks" ? { stop: [configuredHook] } : undefined) }) as any,
		)
		await harness.run()
		expect(harness.requests).toHaveLength(4)
		expect(harness.ask).toHaveBeenCalledWith("resume_task")
		expect(harness.presentCompletionResult).not.toHaveBeenCalled()
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(0)
	})

	it("selects SubagentStop only for a managed child", async () => {
		const harness = await setup()
		const configuredHook = {
			command: process.execPath,
			args: [
				"-e",
				"let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);process.stdout.write(JSON.stringify({decision:'block',reason:request.hook_event_name+' '+request.agent_type}))})",
			],
		}
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({
					get: (key: string) => (key === "completionHooks" ? { subagentStop: [configuredHook] } : undefined),
				}) as any,
		)
		Object.assign(harness.task, { taskKind: "subagent", parentTaskId: "parent", subagentRole: "worker" })
		expect(await harness.task.evaluateCompletionHooks("done")).toEqual({})
		Object.assign(harness.task, { subagentGroupId: "managed-group" })
		expect(await harness.task.evaluateCompletionHooks("done")).toMatchObject({
			prompt: "SubagentStop worker",
			hookPrompt: {
				event: "SubagentStop",
				fragments: [{ hook_run_id: expect.any(String), text: "SubagentStop worker" }],
			},
		})
	})

	it("runs SubagentStop through a managed child's completion loop", async () => {
		const harness = await setup()
		Object.assign(harness.task, {
			taskId: "completion-worker",
			taskKind: "subagent",
			parentTaskId: TASK_ID,
			subagentGroupId: "completion-group",
			subagentRole: "worker",
		})
		const configuredHook = {
			command: process.execPath,
			args: [
				"-e",
				"let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);if(request.hook_event_name!=='SubagentStop'||request.session_id!=='stage-three-completion'||request.agent_id!=='completion-worker'||request.agent_transcript_path!==null)process.exit(3);process.stdout.write(JSON.stringify(request.stop_hook_active?{decision:'allow'}:{decision:'block',reason:'Child needs another pass.'}))})",
			],
		}
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({
					get: (key: string) => (key === "completionHooks" ? { subagentStop: [configuredHook] } : undefined),
				}) as any,
		)
		await harness.run()
		expect(harness.requests).toHaveLength(2)
		expect(JSON.stringify(harness.requests[1])).toContain("Child needs another pass.")
		expect(harness.presentCompletionResult).toHaveBeenCalledOnce()
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it("resets the hook continuation window when new user guidance is delivered", async () => {
		const harness = await setup()
		Reflect.set(harness.task, "completionHookContinuationCount", 0)
		const configuredHook = {
			command: process.execPath,
			args: ["-e", "process.stdout.write(JSON.stringify({decision:'block',reason:'Check again.'}))"],
		}
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({ get: (key: string) => (key === "completionHooks" ? { stop: [configuredHook] } : undefined) }) as any,
		)
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await harness.task.evaluateCompletionHooks("done")).toMatchObject({ prompt: "Check again." })
		}
		expect(await harness.task.evaluateCompletionHooks("done")).toEqual({ limitReached: true })
		const buildUserMessageContent = Reflect.get(harness.task, "buildUserMessageContent") as (
			text: string,
		) => unknown
		buildUserMessageContent.call(harness.task, "Please revisit the task.")
		expect(await harness.task.evaluateCompletionHooks("done")).toMatchObject({ prompt: "Check again." })
	})

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

	it("reaches text completion after sixteen distinct successful commands without semantic progress metadata", async () => {
		const harness = await setup()
		const { task } = harness
		const completeStep = task.runAgentRequests
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			...new ToolRegistry().resolve("shell")!,
			capabilities: {
				concurrency: "serial",
				sideEffects: "workspace",
				controlFlow: false,
				requiresApproval: false,
			},
			async execute({ call, callbacks }) {
				const command = call.nativeArgs && "cmd" in call.nativeArgs ? call.nativeArgs.cmd : undefined
				if (!call.id || typeof command !== "string") throw new Error("Missing fixture command")
				task.beginCommandExecution(call.id, call.id, command)
				task.completeCommandExecution(call.id, { exitCode: 0 }, call.id)
				// Match ExecuteCommandTool's successful process receipt, without claiming
				// a supported Git/rg inspection or crediting any acceptance check.
				callbacks.setResultMetadata?.({ status: "success", exitCode: 0 })
				callbacks.pushToolResult("Command exited with code 0.")
			},
		})
		task.runAgentRequests = vi.fn<Task["runAgentRequests"]>(async (input, includeFileDetails, onPersisted) => {
			if (harness.requests.length === 16) return completeStep(input, includeFileDetails, onPersisted)
			harness.requests.push(structuredClone(input))
			task.userMessageContent = []
			const response = createAgentResponse([
				{
					type: "tool_call",
					id: `inspection-${harness.requests.length}`,
					name: "exec_command",
					arguments: {
						cmd: `git status --short # inspection ${harness.requests.length}`,
						workdir: harness.storagePath,
						yield_time_ms: 1000,
					},
				},
			])
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				onEvent: (event) => {
					harness.events.push(event)
				},
			}).run(response)
			expect(outcome.results.map((result) => result.status)).toEqual(["success"])
			return { status: "completed", response }
		})

		await harness.run()
		expect(harness.requests).toHaveLength(17)
		expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "exec_command"),
		).toHaveLength(16)
		expect(harness.presentCompletionResult).toHaveBeenCalledOnce()
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(Reflect.get(task, "didComplete")).toBe(true)
	})

	it("completes a settled primary edit in one text response", async () => {
		const harness = await setup()
		await harness.addAppliedObligation("primary", ["README.md"])
		await harness.run()
		expect(harness.requests).toHaveLength(1)
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "exec_command"),
		).toHaveLength(0)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.store.getParentCompletionDecision(TASK_ID).allowed).toBe(true)
	})

	it("finishes text once after a passing acceptance check is reworded without rerunning it", async () => {
		const harness = await setup()
		await fs.writeFile(path.join(harness.storagePath, "check.js"), "process.exit(0)")
		const plan: TaskWorkPlan = {
			objective: "Verify the requested change",
			constraints: [],
			notes: [],
			checks: [
				{
					id: "behavior",
					description: "Run the check",
					command: "node check.js",
					cwd: null,
					paths: ["check.js"],
					reusable: true,
				},
			],
		}
		await harness.task.updateWorkPlan(plan)
		await harness.task.admitCommandExecution("check", "physical-check", "node check.js", harness.storagePath)
		harness.task.completeCommandExecution("check", { exitCode: 0 }, "physical-check")
		await harness.task.getWorkContext()
		await harness.task.updateWorkPlan({
			...plan,
			checks: [{ ...plan.checks[0], description: "Confirm the completed behavior", cwd: "." }],
		})

		await harness.run()

		expect(harness.requests).toHaveLength(1)
		expect(harness.task.workContext?.receipts[0].status).toBe("passed")
		expect(harness.task.getCompletionStageMetrics()).toMatchObject({ candidateCount: 1, rejectionCount: 0 })
		expect(harness.ask).not.toHaveBeenCalledWith("resume_task")
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it("allows text completion with a real durable advisory Worker receipt", async () => {
		const obligationKind: ObligationKind = "worker"
		const harness = await setup()
		await harness.addAppliedObligation(obligationKind)
		await harness.assertDurableObligationPending(obligationKind)

		await harness.run()

		expect(harness.requests).toHaveLength(1)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		await harness.assertDurableObligationPending(obligationKind)
	})

	it("retains text completion when an advisory Worker receipt arrives during the persistence await", async () => {
		const obligationKind: ObligationKind = "worker"
		const harness = await setup()
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

		expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).toBe("completed")
		await harness.assertDurableObligationPending(obligationKind)
	})

	it("retains one text completion candidate until a running command and its verification publication settle", async () => {
		const harness = await setup()
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
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
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
	})

	it("retains one text candidate until a delayed mutation receipt is durably released", async () => {
		const harness = await setup()
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
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
	})

	it("rechecks command activity admitted during the text durable completion read", async () => {
		const harness = await setup()
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
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it("keeps a healthy command running past 60 seconds during text completion without a model retry", async () => {
		const harness = await setup(true)
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
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.requests).toHaveLength(1)
	})

	it("bounds an orphan mutation receipt wait during text completion without a model retry", async () => {
		const harness = await setup()
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
	})

	it("bounds a stuck verification publisher during text completion without another model request", async () => {
		const harness = await setup()
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
			await vi.advanceTimersByTimeAsync(31_000)
			expect(settled, "Completion must not wait forever on a finished command's publisher").toBe(true)
			harness.assertRecoverableStop()
			expect(harness.requests).toHaveLength(1)
			expect(harness.task.consecutiveMistakeCount).toBe(0)
		} finally {
			harness.cancel()
			publication.resolve()
			await vi.advanceTimersByTimeAsync(1_000)
			await running
		}
	})

	it("cancels a text completion wait while verification publication remains unresolved", async () => {
		const harness = await setup()
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
	})

	it("consumes real steering during a text completion wait without Resume or losing its persistence receipt", async () => {
		const harness = await setup()
		const onPersisted = vi.fn(async () => undefined)
		const guidance = "Check the new requirement before finishing."
		harness.task.beginCommandExecution("running-check", "physical-running-check", "pnpm exec vitest run")
		harness.installCandidates((step) => {
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
			expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(
				1,
			)
		} finally {
			harness.cancel()
			harness.task.completeCommandExecution("running-check", { exitCode: 0 }, "physical-running-check")
			await vi.advanceTimersByTimeAsync(1_000)
			await running
		}
	})

	it("allows a queued receipt publisher to acquire the workspace mutation gate during text completion settlement", async () => {
		const harness = await setup()
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
			expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(
				1,
			)
			expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
		} finally {
			release.resolve()
			harness.cancel()
			await heldMutation
			await running
		}
	})

	it("completes text with advisory Worker evidence without requesting repair commands", async () => {
		const harness = await setup()
		await harness.addAppliedObligation("worker")
		harness.installCandidates(async () => {
			for (let read = 0; read < 5; read++) await harness.task.getCompletionGateDecision()
		}, "repair-verification")
		await harness.run()
		expect(harness.requests).toHaveLength(1)
		expect(harness.task.getCompletionStageMetrics()).toMatchObject({
			candidateCount: 1,
			rejectionCount: 0,
			repairToolCount: 0,
		})
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "exec_command"),
		).toHaveLength(0)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		await harness.assertDurableObligationPending("worker")
	})

	it("allows text completion after the objective's independent reads without inventing a check", async () => {
		const harness = await setup()
		const files = Array.from({ length: 10 }, (_, index) => `src/changed-${index}.ts`)
		await harness.addAppliedObligation("worker", files)
		harness.installCandidates(undefined, files)
		await harness.run()
		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(files.length + 1)
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "read_file"),
		).toHaveLength(files.length)
		for (const event of harness.events) {
			if (event.type === "tool_result" && event.name === "read_file") expect(event.status).toBe("success")
		}
		expect(
			harness.events.filter((event) => event.type === "tool_result" && event.name === "exec_command"),
		).toHaveLength(0)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it.each(["active descendant", "unconsumed result"] as const)(
		"handles text completion blocked by an %s without file-verification debt",
		async (blocker) => {
			const harness = await setup(blocker === "active descendant")
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
					harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted),
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

	it("preserves the durably completed root through real provider text completion gates and reload", async () => {
		const harness = await setup()
		const managedProvider = harness.useRealManagedCompletionLifecycle()

		await harness.run()

		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(1)
		expect(Reflect.get(harness.task, "didComplete")).toBe(true)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
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
			expect(reloaded.listAgents({ rootTaskId: TASK_ID }).filter((agent) => agent.role === "root")).toHaveLength(
				1,
			)
		} finally {
			await reloaded.shutdown()
		}
	})

	it("allows ordinary text completion without applicable changes", async () => {
		const harness = await setup()

		await harness.run()

		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(1)
		expect(Reflect.get(harness.task, "didComplete")).toBe(true)
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
		expect(harness.store.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
		expect(harness.store.getAgent(TASK_ID, TASK_ID)?.status).toBe("completed")
	})

	it("preserves queued guidance arriving while text completion is being persisted", async () => {
		const harness = await setup()
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
		expect(harness.emit.mock.calls.filter(([name]) => name === AlphaCodeEventName.TaskCompleted)).toHaveLength(1)
	})

	it("does not complete a cancelled text candidate", async () => {
		const harness = await setup()
		harness.installCandidates(() => harness.cancel())

		await harness.run()

		harness.assertNotCompleted()
		expect(harness.guardTriggered()).toBe(false)
		expect(harness.requests).toHaveLength(1)
		expect(harness.provider.prepareTaskCompletionLifecycle).not.toHaveBeenCalled()
		expect(harness.events).toContainEqual(expect.objectContaining({ type: "task_completed", status: "aborted" }))
	})
})
