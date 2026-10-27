import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaMessage, ProviderSettings } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import type { ApiHandler } from "../../../api"
import i18n from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { createAgentResponse } from "../../agent/AgentResponse"
import { digestValue } from "../../agent/StepContext"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { runLifecycleHooks, type LifecycleHookOutcome } from "../../agent/CompletionHooks"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { executeCommandTool } from "../../tools/ExecuteCommandTool"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { readApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"
import { WorkspaceMutationGate } from "../WorkspaceMutationGate"

// The public Task loop, native ownership predicate, transcript queue and stores remain real.
vi.mock("../../agent/CompletionHooks", async (original) => ({
	...(await original<typeof import("../../agent/CompletionHooks")>()),
	runLifecycleHooks: vi.fn(),
}))
vi.mock("../../ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		dispose() {}
	},
}))
vi.mock("../../protect/AlphaProtectedController", () => ({ AlphaProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose() {}
	},
}))
vi.mock("../../../integrations/editor/DiffViewProvider", () => ({
	DiffViewProvider: class {
		isEditing = false
		async reset() {}
		async revertChanges() {}
	},
}))
vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(async ({ userContent }) => ({ content: userContent })),
}))
vi.mock("../../environment/getEnvironmentDetails", async (original) => ({
	...(await original<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(async () => ({ details: "", commit() {}, release() {} })),
}))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: () => undefined },
}))

const warningText = "OWNER_A_WARNING"
const contextText = "OWNER_A_CONTEXT"
const stopText = "OWNER_A_REJECTED_INPUT"
const inputText = "OWNER_A_HUMAN_BODY"
const replacementText = "OWNER_B_HISTORY"
const command = { command: process.execPath, args: ["mocked-lifecycle-owner-hook"] }
const readCommand = "git --no-pager diff --no-ext-diff --no-textconv -- before.ts"
const identities = ["step", "run", "turn", "surface"] as const
type Identity = (typeof identities)[number]
const boundaries = ["transcript lookup", "hook result", "warning save", "context save admission"] as const
type Boundary = (typeof boundaries)[number]
const schedulerEvents = ["PreToolUse", "PostToolUse", "PermissionRequest"] as const
type SchedulerEvent = (typeof schedulerEvents)[number]
const requestCases = boundaries.flatMap((boundary) =>
	identities.flatMap((identity) => [false, true].map((replaced) => ({ boundary, identity, replaced }))),
)
const cleanupCases = (["transcript lookup", "hook result"] as const).flatMap((boundary) =>
	identities.flatMap((identity) => [false, true].map((replaced) => ({ boundary, identity, replaced }))),
)
const schedulerCases = schedulerEvents.flatMap((event) =>
	identities.flatMap((identity) => [false, true].map((replaced) => ({ event, identity, replaced }))),
)

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function stopOutcome(): LifecycleHookOutcome {
	return {
		warnings: [warningText],
		additionalContext: [{ hook_run_id: "owner-a-context-run", text: contextText }],
		shouldStop: true,
		stopReason: stopText,
		stopProvenance: {
			event: "UserPromptSubmit",
			fragments: [{ hook_run_id: "owner-a-stop-run", text: stopText }],
		},
	}
}

function warningMessages(messages: readonly AlphaMessage[]) {
	return messages.filter((message) => message.text?.includes(warningText))
}

type TaskHost = {
	completionHookTranscriptPath: Task["completionHookTranscriptPath"]
	enqueueAlphaMessagesSave: Task["enqueueAlphaMessagesSave"]
	enqueueApiConversationHistoryPersistence: Task["enqueueApiConversationHistoryPersistence"]
	getSystemPrompt: Task["getSystemPrompt"]
	updateAlphaMessage: Task["updateAlphaMessage"]
	scheduleStreamingPreview: Task["scheduleStreamingPreview"]
	deliverAgentMessages: Task["deliverAgentMessages"]
	maybeWaitForProviderRateLimit: Task["maybeWaitForProviderRateLimit"]
}

const fixtures: Array<{
	task: Task
	provider: object
	journal: AgentLifecycleJournal
	storage: string
	release: () => void
}> = []

async function harness(
	options: {
		boundary?: Boundary
		preStep?: boolean
		cleanup?: boolean
		handoff?: boolean
		schedulerEvent?: SchedulerEvent
	} = {},
) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const storage = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-lifecycle-owner-"))
	const workspace = path.join(storage, "workspace")
	await fs.mkdir(workspace)
	await fs.writeFile(path.join(workspace, "before.ts"), "fixture read")
	const taskId = "lifecycle-owner-task"
	const journal = await AgentLifecycleJournal.open(taskId, storage)
	const workspaceMutationGate = new WorkspaceMutationGate()
	const state = {
		mode: "code",
		autoApprovalEnabled: false,
		alwaysAllowReadOnly: false,
		customModes: [],
		mcpEnabled: false,
	}
	const provider = {
		context: { globalStorageUri: { fsPath: storage } },
		async runWorkspaceMutation<T>(
			mutationTask: Task,
			label: string,
			run: () => Promise<T>,
			options: { allowStoppedTask?: boolean } = {},
		): Promise<T> {
			return workspaceMutationGate.run(
				mutationTask.taskId,
				label,
				run,
				() => !options.allowStoppedTask && mutationTask.abort,
				options.allowStoppedTask ? undefined : mutationTask.getTaskLifetimeCancellationSignal(),
			)
		},
		getState: async () => state,
		getValues: () => state,
		getSkillsManager: async () => undefined,
		getMcpHub: () => undefined,
		getParentCompletionDecision: async () => ({ allowed: true }),
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		replayAgentLifecycle: () => journal.replay(),
		publishAgentLifecycleEvent: async (event: AgentLifecycleEventInput, eventOptions?: { durable?: boolean }) => ({
			accepted: true,
			...(await journal.append(event, eventOptions)),
		}),
		settleIndependentTaskWaitReceiptsForParent: vi.fn(async () => undefined),
		getVerificationProgressState: () => ({ stateFingerprint: "owner-boundary" }),
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		postTaskQueueToWebview: vi.fn(async () => undefined),
		updateTaskHistory: vi.fn(async () => []),
		log: vi.fn(),
	}
	const configuration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "gpt-6.1-sol",
		openAiApiKey: "synthetic-test-key",
	}
	const task = new Task({
		provider: provider as unknown as AlphaProvider,
		apiConfiguration: configuration,
		taskId,
		task: "Lifecycle owner boundary",
		taskMode: "code",
		taskApiConfigName: "owner-fixture",
		taskApprovalMode: "ask",
		workspacePath: workspace,
		startTask: false,
		enableCheckpoints: false,
	})
	const host = task as unknown as TaskHost
	const entered = barrier()
	const release = barrier()
	const releases = [release.resolve]
	// Task keeps a WeakRef; retain the provider for the full fixture lifetime.
	fixtures.push({ task, provider, journal, storage, release: () => releases.forEach((finish) => finish()) })
	vi.spyOn(host, "getSystemPrompt").mockResolvedValue("Owner boundary fixture")
	vi.spyOn(host, "updateAlphaMessage").mockResolvedValue(undefined)
	vi.spyOn(host, "scheduleStreamingPreview").mockImplementation(() => undefined)
	vi.spyOn(host, "deliverAgentMessages").mockImplementation(async () => {
		if (options.handoff) {
			entered.resolve()
			await release.promise
		}
	})
	vi.spyOn(host, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
	vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
	const approval = vi.spyOn(task, "requestToolApproval")
	const effects: string[] = []
	const executor = vi.spyOn(executeCommandTool, "execute").mockImplementation(async (params, _task, callbacks) => {
		const askCommandApproval = callbacks.askCommandApproval
		if (!askCommandApproval) throw new Error("Task scheduler did not supply native command approval")
		if (!(await askCommandApproval("command", params.command)).approved) return
		effects.push(params.command)
		callbacks.setResultMetadata?.({ status: "success", executionStatus: "success" })
		callbacks.pushToolResult("OWNER_BOUNDARY_READ_RESULT")
	})
	let requests = 0
	const dispatch = vi.fn<ApiHandler["createMessage"]>(async function* () {
		if (requests++ === 0) {
			const surface = task["currentTaskToolSurface"]
			expect(
				surface?.schemas.some((tool) => tool.type === "function" && tool.function.name === "exec_command"),
			).toBe(true)
			expect(surface?.allowedFunctionNames).toContain("exec_command")
			expect(surface?.registry.resolve("exec_command")).toBeDefined()
			expect(surface?.registry.resolve("read_file")).toBeUndefined()
			yield {
				type: "tool_call",
				id: "owner-read-call",
				name: "exec_command",
				arguments: JSON.stringify({ cmd: readCommand }),
			} as const
		} else {
			yield { type: "text", text: "The read completed." } as const
		}
	})
	const api: ApiHandler = {
		getModel: () => ({
			id: "owner-model-a",
			info: { contextWindow: 128_000, maxTokens: 4_096, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async () => 0),
		createMessage: dispatch,
		streamCapabilities: { cancellation: true },
	}
	task.api = api
	await task["messageQueueService"].ready
	await task["taskApiConfigReady"]
	await task["alphaMessagesSaveQueue"]
	if (!options.preStep) await task["beginCanonicalLifecycleTurn"]()
	const createSurface = () =>
		createTaskToolSurface({
			registry: new ToolRegistry({ includeBuiltIns: false }),
			mode: "code",
			applyProfile: false,
			approvalMode: "ask",
			autoApprovalEnabled: false,
			readGrant: { enabled: false, workspaceRoot: workspace, showIgnoredFiles: false },
			execution: { workspaceRoots: [workspace] },
		})
	const surface = createSurface()
	const snapshot = new AgentStepContextBuilder<ApiHandler>().build({
		kind: "agent",
		retryAttempt: 0,
		task: { taskId, cwd: workspace },
		mode: { slug: "code" },
		provider: {
			apiProvider: "openai",
			apiProtocol: "openai",
			modelId: "owner-model-a",
			modelInfo: api.getModel().info,
			options: {},
		},
		instructions: { systemPrompt: "Owner boundary fixture", sources: [] },
		environment: { roots: [workspace], capabilities: [] },
		transcript: {
			messages: [],
			boundary: { startIndex: 0, endIndex: 0, messageCount: 0, digest: digestValue([]) },
		},
		tools: { schemas: [], allowedFunctionNames: [], parallelToolCalls: false, digest: digestValue([]) },
		policy: surface.policy,
		budget: { contextWindow: 128_000, maxOutputTokens: 4_096, compaction: { action: "none", attempted: false } },
		request: { metadata: { taskId, mode: "code", tools: [] } },
		handler: api,
	})
	const step = {
		snapshot,
		surface,
		turnId: task["agentTurnId"] ?? "empty-owner-turn",
		stepId: "owner-step-a",
		requestId: "owner-request-a",
		attemptId: "owner-attempt-a",
		createReasoningSummaryHandler: () => api,
		getRequest: () => ({
			systemPrompt: "Owner boundary fixture",
			messages: [],
			metadata: { taskId, mode: "code", tools: [] },
		}),
		releaseRequest() {},
	}
	if (!options.preStep) {
		task["currentAgentStep"] = step
		task["currentTaskToolSurface"] = surface
		await task["ensureCanonicalLifecycleStepStarted"](step)
	}
	task["lifecycleHookStartConsumed"] = !options.preStep
	const transcript = vi.spyOn(host, "completionHookTranscriptPath").mockImplementation(async () => {
		if (options.boundary === "transcript lookup") {
			entered.resolve()
			await release.promise
		}
		return null
	})
	let hookReturned = false
	vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
		if (options.boundary === "hook result" || request.hook_event_name === options.schedulerEvent) {
			entered.resolve()
			await release.promise
		}
		hookReturned = true
		return options.cleanup
			? { warnings: [] }
			: options.handoff || options.schedulerEvent
				? {
						warnings: [warningText],
						additionalContext: [{ hook_run_id: "owner-a-handoff", text: contextText }],
					}
				: request.hook_event_name === "SessionStart"
					? { warnings: [], additionalContext: [{ hook_run_id: "startup-run", text: "PRE_STEP_CONTEXT" }] }
					: stopOutcome()
	})
	if (options.boundary === "warning save") {
		task["alphaMessagesSaveQueue"] = release.promise
		const enqueue = host.enqueueAlphaMessagesSave.bind(task)
		vi.spyOn(host, "enqueueAlphaMessagesSave").mockImplementation((...args) => {
			if (hookReturned) entered.resolve()
			return enqueue(...args)
		})
	}
	if (options.boundary === "context save admission") {
		const occupied = barrier()
		void host.enqueueApiConversationHistoryPersistence(async () => {
			occupied.resolve()
			await release.promise
		})
		await occupied.promise
		const enqueue = host.enqueueApiConversationHistoryPersistence.bind(task)
		vi.spyOn(host, "enqueueApiConversationHistoryPersistence").mockImplementation((operation) => {
			if (hookReturned) entered.resolve()
			return enqueue(operation)
		})
	}
	const captureCurrentOwner = () => {
		const owns = task["captureAgentStepOwnership"]()
		expect(owns()).toBe(true)
		const ownerGeneration = task["apiConversationHistoryOwnerGeneration"]
		const instanceId = task.instanceId
		const originalStep = task["currentAgentStep"]
		const originalRun = task["agentRunId"]
		const originalTurn = task["agentTurnId"]
		const originalSurface = task["currentTaskToolSurface"]
		const originalInterruption = task["stepInterruptionController"]
		const originalResponse = task["currentAgentResponse"]
		const originalContentReady = task.userMessageContentReady
		const originalToolFailure = task.didToolFailInCurrentTurn
		let replacementInterruption: AbortController | undefined
		return {
			owns,
			replace: (identity: Identity) => {
				if (identity === "step")
					task["currentAgentStep"] = {
						...(originalStep ?? step),
						stepId: "owner-step-b",
						requestId: "owner-request-b",
					}
				else if (identity === "run") task["agentRunId"] = "owner-run-b"
				else if (identity === "turn") task["agentTurnId"] = "owner-turn-b"
				else task["currentTaskToolSurface"] = createSurface()
				expect(task["apiConversationHistoryOwnerGeneration"]).toBe(ownerGeneration)
				expect(task.instanceId).toBe(instanceId)
				expect(task["isCurrentApiConversationHistoryOwner"]()).toBe(true)
				expect(owns()).toBe(false)
				// Represent replacement state without changing Task instance or history-owner generation.
				const replacementHistory: ApiMessage[] = [
					{ role: "user", content: [{ type: "text", text: replacementText }], ts: 2 },
				]
				task.apiConversationHistory = replacementHistory
				task["lifecycleHookStoppedThisTurn"] = false
				task["currentAgentResponse"] = createAgentResponse([{ type: "text", text: "OWNER_B_RESPONSE" }])
				task.userMessageContentReady = false
				task.didToolFailInCurrentTurn = false
				replacementInterruption = new AbortController()
				task["stepInterruptionController"] = replacementInterruption
			},
			restoreIdentity: () => {
				task["currentAgentStep"] = originalStep
				task["agentRunId"] = originalRun
				task["agentTurnId"] = originalTurn
				task["currentTaskToolSurface"] = originalSurface
				task["stepInterruptionController"] = originalInterruption
				task["currentAgentResponse"] = originalResponse
				task.userMessageContentReady = originalContentReady
				task.didToolFailInCurrentTurn = originalToolFailure
			},
			assertReplacementAlive: () => {
				expect(task.abort).toBe(false)
				expect(task["getTaskLifetimeCancellationSignal"]().aborted).toBe(false)
				expect(replacementInterruption).toBeDefined()
				expect(task["stepInterruptionController"]).toBe(replacementInterruption)
				expect(replacementInterruption?.signal.aborted).toBe(false)
				expect(task.userMessageContentReady).toBe(false)
				expect(task.didToolFailInCurrentTurn).toBe(false)
			},
		}
	}
	return {
		task,
		host,
		storage,
		taskId,
		journal,
		entered: entered.promise,
		release: release.resolve,
		...captureCurrentOwner(),
		captureCurrentOwner,
		transcript,
		approval,
		executor,
		effects,
		dispatch,
	}
}

beforeEach(() => {
	i18n.addResourceBundle("en", "common", common, true, true)
	vi.mocked(runLifecycleHooks).mockReset()
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
		inspect: (key: string) =>
			key === "completionHooks"
				? {
						globalValue: {
							stop: [],
							subagentStop: [],
							userPromptSubmit: [command],
							sessionStart: [command],
						},
					}
				: undefined,
	} as unknown as vscode.WorkspaceConfiguration)
})

afterEach(async () => {
	const owned = fixtures.splice(0)
	for (const fixture of owned) fixture.release()
	const failures: unknown[] = []
	for (const fixture of owned) {
		try {
			await fixture.task.abortTask(true)
			await fixture.task.waitForTermination()
		} catch (error) {
			failures.push(error)
		}
	}
	for (const fixture of owned) await fixture.journal.close()
	for (const fixture of owned) {
		const target = path.resolve(fixture.storage)
		const temporaryRoot = path.resolve(await fs.realpath(os.tmpdir()))
		if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith("alpha-lifecycle-owner-")) {
			throw new Error("Lifecycle owner fixture cleanup escaped its owned temporary directory")
		}
		await fs.rm(target, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
	if (failures.length) throw new AggregateError(failures, "Lifecycle owner fixture cleanup failed")
})

type Fixture = Awaited<ReturnType<typeof harness>>

function request(fixture: Fixture) {
	const queue = fixture.task["messageQueueService"]
	const queued = queue.addMessage(inputText)!
	expect(queue.claimMessage(queued.id)).toBeDefined()
	const onPersisted = vi.fn(async () => undefined)
	const input = fixture.task["buildUserMessageContent"](queued.text, queued.images, [queued.id])
	const running = fixture.task.runAgentRequests(input, false, onPersisted, {
		queuedMessageIds: [queued.id],
		inputOrigin: "human",
	})
	const settled = running.then(
		(outcome) => ({ kind: "returned" as const, outcome }),
		(error: unknown) => ({ kind: "threw" as const, error }),
	)
	return { running, settled, queued, onPersisted }
}

async function reachBoundary(fixture: Fixture, operation: ReturnType<typeof request>) {
	await Promise.race([
		fixture.entered,
		operation.settled.then((result) => {
			if (result.kind === "threw") throw result.error
			const outcome = result.outcome
			const detail =
				typeof outcome === "boolean"
					? `legacy=${outcome}`
					: `status=${outcome.status}, reason=${(outcome.reason ?? "none").slice(0, 160)}`
			throw new Error(`Public Task request settled before the controlled lifecycle boundary (${detail})`)
		}),
	])
}

async function savedHistory(fixture: Fixture) {
	await fixture.task.flushApiConversationHistoryPersistence()
	return readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })
}

describe("public Task lifecycle-hook ownership through asynchronous barriers", () => {
	it.each(requestCases)("keeps $boundary bound to $identity (replacement=$replaced)", async (testCase) => {
		const { boundary, identity, replaced } = testCase
		const fixture = await harness({ boundary })
		const operation = request(fixture)
		try {
			await reachBoundary(fixture, operation)
			expect(fixture.owns()).toBe(true)
			const originalSignal = vi.mocked(runLifecycleHooks).mock.calls[0]?.[2]
			if (replaced) {
				fixture.replace(identity)
				// The finding changes owner identity without using request cancellation as the fence.
				expect(originalSignal?.aborted ?? false).toBe(false)
			}
			fixture.release()
			const result = await operation.settled
			if (result.kind === "threw") throw result.error
			expect(result.outcome).toMatchObject({ status: replaced ? "aborted" : "awaiting-user" })
			expect(fixture.dispatch).not.toHaveBeenCalled()
			expect(fixture.approval).not.toHaveBeenCalled()
			expect(fixture.executor).not.toHaveBeenCalled()
			expect(fixture.effects).toEqual([])
			const history = await savedHistory(fixture)
			const ui = await readTaskMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })
			expect(JSON.stringify(history)).not.toContain(inputText)
			if (replaced) {
				expect(result.outcome).not.toHaveProperty("response")
				expect(fixture.task["currentAgentResponse"]?.text).toBe("OWNER_B_RESPONSE")
				expect(fixture.task.apiConversationHistory).toEqual([
					{ role: "user", content: [{ type: "text", text: replacementText }], ts: 2 },
				])
				expect(JSON.stringify(history)).not.toContain(contextText)
				expect(JSON.stringify(history)).not.toContain(stopText)
				expect(history.some((message) => message.queued_message_ids?.includes(operation.queued.id))).toBe(false)
				// Context saving follows the already committed warning; that admission remains legitimate.
				const admittedWarnings = boundary === "context save admission" ? 1 : 0
				expect(warningMessages(ui)).toHaveLength(admittedWarnings)
				expect(warningMessages(fixture.task.alphaMessages)).toHaveLength(admittedWarnings)
				expect(fixture.task["lifecycleHookStoppedThisTurn"]).toBe(false)
				expect(operation.onPersisted).not.toHaveBeenCalled()
				expect(fixture.task["messageQueueService"].getClaimedMessageIds()).toContain(operation.queued.id)
				fixture.assertReplacementAlive()
				expect(runLifecycleHooks).toHaveBeenCalledTimes(boundary === "transcript lookup" ? 0 : 1)
			} else {
				expect(
					history.some(
						(message) =>
							message.input_origin === "agent" && JSON.stringify(message.content).includes(contextText),
					),
				).toBe(true)
				const rejection = history.filter((message) => message.queued_message_ids?.includes(operation.queued.id))
				expect(rejection).toHaveLength(1)
				expect(rejection[0]).toMatchObject({
					input_origin: "agent",
					hook_prompt: { event: "UserPromptSubmit" },
				})
				expect(JSON.stringify(rejection[0].content)).toContain(stopText)
				expect(warningMessages(ui)).toHaveLength(1)
				expect(fixture.task["lifecycleHookStoppedThisTurn"]).toBe(true)
				expect(operation.onPersisted).toHaveBeenCalledTimes(1)
				expect(fixture.task["messageQueueService"].getClaimedMessageIds()).toEqual([])
				expect(runLifecycleHooks).toHaveBeenCalledTimes(1)
			}
		} finally {
			fixture.release()
			await operation.settled
			fixture.restoreIdentity()
		}
	})

	it("admits SessionStart with no current step through the public input path", async () => {
		const fixture = await harness({ preStep: true })
		expect(fixture.task["currentAgentStep"]).toBeUndefined()
		expect(fixture.task["currentTaskToolSurface"]).toBeUndefined()
		const operation = request(fixture)
		const result = await operation.settled
		if (result.kind === "threw") throw result.error

		expect(result.outcome).toMatchObject({ status: "awaiting-user" })
		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, payload]) => payload.hook_event_name)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
		])
		expect(JSON.stringify(await savedHistory(fixture))).toContain("PRE_STEP_CONTEXT")
		expect(operation.onPersisted).toHaveBeenCalledTimes(1)
		expect(fixture.dispatch).not.toHaveBeenCalled()
	})

	it("retains the pre-step SessionStart model and permission envelope across transcript lookup", async () => {
		const fixture = await harness({ preStep: true, boundary: "transcript lookup" })
		const operation = request(fixture)
		try {
			await reachBoundary(fixture, operation)
			const oldApi = fixture.task.api
			fixture.task.api = { ...oldApi, getModel: () => ({ ...oldApi.getModel(), id: "owner-model-b" }) }
			expect(fixture.task.setTaskApprovalMode("auto")).toBe(true)
			expect(fixture.owns()).toBe(true)
			fixture.release()
			const result = await operation.settled
			if (result.kind === "threw") throw result.error

			expect(result.outcome).toMatchObject({ status: "awaiting-user" })
			expect(vi.mocked(runLifecycleHooks).mock.calls[0][1]).toMatchObject({
				hook_event_name: "SessionStart",
				model: "owner-model-a",
				permission_mode: "ask",
				turn_id: "",
			})
			expect(fixture.dispatch).not.toHaveBeenCalled()
		} finally {
			fixture.release()
			await operation.settled
			await fixture.task["taskApprovalModePersistence"]
		}
	})

	it("keeps unchanged-owner nonblocking hooks connected to the native provider, approval and executor", async () => {
		const fixture = await harness()
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			warnings: [warningText],
			additionalContext: [{ hook_run_id: "owner-a-nonblocking", text: contextText }],
		})
		const operation = request(fixture)
		const result = await operation.settled
		if (result.kind === "threw") throw result.error

		expect(result.outcome).toMatchObject({ status: "completed" })
		expect(runLifecycleHooks).toHaveBeenCalledTimes(1)
		expect(fixture.dispatch).toHaveBeenCalledTimes(1)
		expect(fixture.approval).toHaveBeenCalledTimes(1)
		expect(fixture.executor).toHaveBeenCalledTimes(1)
		expect(fixture.effects).toEqual([readCommand])
		expect(operation.onPersisted).toHaveBeenCalledTimes(1)
		expect(fixture.task["messageQueueService"].getClaimedMessageIds()).toEqual([])
		const history = await savedHistory(fixture)
		expect(JSON.stringify(history)).toContain(contextText)
		expect(history.filter((message) => message.queued_message_ids?.includes(operation.queued.id))).toHaveLength(1)
	})

	it.each(identities.flatMap((identity) => [false, true].map((replaced) => ({ identity, replaced }))))(
		"retains queued context origin across message delivery for $identity (replacement=$replaced)",
		async ({ identity, replaced }) => {
			const fixture = await harness({ handoff: true })
			const queue = fixture.task["messageQueueService"]
			const acknowledge = vi.spyOn(queue, "acknowledgeMessages")
			const operation = request(fixture)
			try {
				await reachBoundary(fixture, operation)
				expect(fixture.owns()).toBe(true)
				expect(operation.onPersisted).toHaveBeenCalledTimes(1)
				expect(queue.getClaimedMessageIds()).toEqual([])
				const admittedHistory = await savedHistory(fixture)
				expect(JSON.stringify(admittedHistory)).toContain(inputText)
				expect(JSON.stringify(admittedHistory)).not.toContain(contextText)
				const admittedAcknowledgments = acknowledge.mock.calls.length
				let replacementQueueId: string | undefined
				if (replaced) {
					fixture.replace(identity)
					const replacement = queue.addMessage("OWNER_B_PENDING_INPUT")!
					queue.claimMessage(replacement.id)
					replacementQueueId = replacement.id
					await queue.flush()
				}
				fixture.release()
				const result = await operation.settled
				if (result.kind === "threw") throw result.error
				if (replaced) {
					expect(result.outcome).toMatchObject({ status: "aborted" })
					expect(result.outcome).not.toHaveProperty("response")
					expect(fixture.task.apiConversationHistory).toEqual([
						{ role: "user", content: [{ type: "text", text: replacementText }], ts: 2 },
					])
					expect(await savedHistory(fixture)).toEqual(admittedHistory)
					expect(acknowledge).toHaveBeenCalledTimes(admittedAcknowledgments)
					expect(queue.getClaimedMessageIds()).toContain(replacementQueueId)
					expect(fixture.dispatch).not.toHaveBeenCalled()
					expect(fixture.approval).not.toHaveBeenCalled()
					expect(fixture.executor).not.toHaveBeenCalled()
					expect(fixture.task["lifecycleHookStoppedThisTurn"]).not.toBe(true)
					fixture.assertReplacementAlive()
				} else {
					expect(result.outcome).toMatchObject({ status: "completed" })
					expect(JSON.stringify(await savedHistory(fixture))).toContain(contextText)
					expect(fixture.dispatch).toHaveBeenCalledTimes(1)
					expect(fixture.approval).toHaveBeenCalledTimes(1)
					expect(fixture.executor).toHaveBeenCalledTimes(1)
					expect(fixture.effects).toEqual([readCommand])
				}
				expect(operation.onPersisted).toHaveBeenCalledTimes(1)
				expect(warningMessages(fixture.task.alphaMessages)).toHaveLength(1)
			} finally {
				fixture.release()
				await operation.settled
				if (replaced) fixture.restoreIdentity()
			}
		},
	)
})

function installSchedulerHook(event: SchedulerEvent) {
	const settings = {
		PreToolUse: "preToolUse",
		PostToolUse: "postToolUse",
		PermissionRequest: "permissionRequest",
	} as const
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
		inspect: (key: string) =>
			key === "completionHooks"
				? {
						globalValue: { stop: [], subagentStop: [], [settings[event]]: [command] },
					}
				: undefined,
	} as unknown as vscode.WorkspaceConfiguration)
}

describe("public Task-built scheduler lifecycle-hook ownership", () => {
	it.each(schedulerCases)("fences $event result for $identity (replacement=$replaced)", async (testCase) => {
		const { event, identity, replaced } = testCase
		installSchedulerHook(event)
		const schedulerRuns = vi.spyOn(ToolScheduler.prototype, "run")
		const fixture = await harness({ schedulerEvent: event })
		const queue = fixture.task["messageQueueService"]
		const acknowledge = vi.spyOn(queue, "acknowledgeMessages")
		const operation = request(fixture)
		let owner: ReturnType<Fixture["captureCurrentOwner"]> | undefined
		try {
			await reachBoundary(fixture, operation)
			// Provider capture legitimately replaces the input-time step; bind the actual scheduler owner here.
			owner = fixture.captureCurrentOwner()
			expect(fixture.task["currentAgentStep"]).toBeDefined()
			expect(fixture.task["currentTaskToolSurface"]).toBe(fixture.task["currentAgentStep"]?.surface)
			expect(fixture.dispatch).toHaveBeenCalledTimes(1)
			expect(schedulerRuns).toHaveBeenCalledTimes(1)
			expect(runLifecycleHooks).toHaveBeenCalledTimes(1)
			const [, payload, hookSignal] = vi.mocked(runLifecycleHooks).mock.calls[0]
			expect(payload).toMatchObject({
				hook_event_name: event,
				tool_name: "exec_command",
				tool_input: { cmd: readCommand, command: readCommand },
			})
			expect(hookSignal.aborted).toBe(false)
			expect(fixture.approval).toHaveBeenCalledTimes(event === "PostToolUse" ? 1 : 0)
			expect(fixture.executor).toHaveBeenCalledTimes(event === "PreToolUse" ? 0 : 1)
			expect(fixture.effects).toEqual(event === "PostToolUse" ? [readCommand] : [])
			if (payload.hook_event_name === "PostToolUse") {
				expect(payload.tool_response).toMatchObject({ status: "success", execution_status: "success" })
				expect(JSON.stringify(payload.tool_response)).toContain("OWNER_BOUNDARY_READ_RESULT")
			}
			expect(operation.onPersisted).toHaveBeenCalledTimes(1)
			expect(queue.getClaimedMessageIds()).toEqual([])
			const admittedHistory = await savedHistory(fixture)
			expect(JSON.stringify(admittedHistory)).toContain(inputText)
			expect(JSON.stringify(admittedHistory)).toContain("owner-read-call")
			const admittedLifecycle = await fixture.journal.replay()
			const capturedResponse = fixture.task["currentAgentResponse"]
			expect(capturedResponse?.toolCalls).toEqual([
				expect.objectContaining({ id: "owner-read-call", name: "exec_command" }),
			])
			const admittedContent = structuredClone(fixture.task.userMessageContent)
			const admittedContexts = [...(fixture.task["pendingLifecycleHookContexts"] ?? [])]
			const admittedAcknowledgments = acknowledge.mock.calls.length
			let replacementQueueId: string | undefined
			if (replaced) {
				owner.replace(identity)
				const pending = queue.addMessage("OWNER_B_SCHEDULER_INPUT")!
				queue.claimMessage(pending.id)
				replacementQueueId = pending.id
				await queue.flush()
				expect(hookSignal.aborted).toBe(false)
			}
			fixture.release()
			const result = await operation.settled
			if (result.kind === "threw") throw result.error
			const batch: Awaited<ReturnType<ToolScheduler["run"]>> = await schedulerRuns.mock.results[0].value
			if (replaced) {
				expect(result.outcome).toMatchObject({ status: "aborted" })
				if (typeof result.outcome === "object" && result.outcome.response !== undefined) {
					expect(result.outcome.response).toEqual(capturedResponse)
				}
				expect(JSON.stringify(result.outcome)).not.toContain("OWNER_B_RESPONSE")
				expect(hookSignal.aborted).toBe(true)
				expect(batch.status).toBe("aborted")
				expect(fixture.task["currentAgentResponse"]?.text).toBe("OWNER_B_RESPONSE")
				expect(fixture.task.apiConversationHistory).toEqual([
					{ role: "user", content: [{ type: "text", text: replacementText }], ts: 2 },
				])
				expect(await savedHistory(fixture)).toEqual(admittedHistory)
				expect(await fixture.journal.replay()).toEqual(admittedLifecycle)
				expect(fixture.task.userMessageContent).toEqual(admittedContent)
				expect(fixture.task["pendingLifecycleHookContexts"] ?? []).toEqual(admittedContexts)
				expect(fixture.task["lifecycleHookStoppedThisTurn"]).toBe(false)
				expect(warningMessages(fixture.task.alphaMessages)).toEqual([])
				const savedMessages = await readTaskMessages({
					taskId: fixture.taskId,
					globalStoragePath: fixture.storage,
				})
				expect(warningMessages(savedMessages)).toEqual([])
				expect(acknowledge).toHaveBeenCalledTimes(admittedAcknowledgments)
				expect(queue.getClaimedMessageIds()).toContain(replacementQueueId)
				expect(fixture.dispatch).toHaveBeenCalledTimes(1)
				expect(fixture.approval).toHaveBeenCalledTimes(event === "PostToolUse" ? 1 : 0)
				expect(fixture.effects).toEqual(event === "PostToolUse" ? [readCommand] : [])
				if (event === "PostToolUse") {
					// Keep A's observed terminal truth in the old batch; never repeat or publish it into B.
					const completed = batch.results.find((receipt) => receipt.callId === "owner-read-call")
					expect(completed).toMatchObject({ status: "success", executionStatus: "success" })
					expect(JSON.stringify(completed?.content)).toContain("OWNER_BOUNDARY_READ_RESULT")
				}
				owner.assertReplacementAlive()
			} else {
				expect(result.outcome).toMatchObject({ status: "completed" })
				expect(batch.status).toBe("completed")
				expect(fixture.dispatch).toHaveBeenCalledTimes(1)
				expect(fixture.task["pendingLifecycleHookContexts"]).toHaveLength(1)
				expect(owner.owns()).toBe(true)
				// One public request owns one model/tool step; the next explicit request consumes its receipts/context.
				const continuation = await fixture.task.runAgentRequests([], false, undefined, { inputOrigin: "agent" })
				expect(continuation).toMatchObject({ status: "completed" })
				expect(fixture.dispatch).toHaveBeenCalledTimes(2)
				expect(fixture.approval).toHaveBeenCalledTimes(1)
				expect(fixture.executor).toHaveBeenCalledTimes(1)
				expect(fixture.effects).toEqual([readCommand])
				expect(JSON.stringify(await savedHistory(fixture))).toContain(contextText)
				expect(warningMessages(fixture.task.alphaMessages)).toHaveLength(1)
			}
			expect(operation.onPersisted).toHaveBeenCalledTimes(1)
			expect(runLifecycleHooks).toHaveBeenCalledTimes(1)
		} finally {
			fixture.release()
			await operation.settled
			if (replaced) owner?.restoreIdentity()
		}
	})
})

function installCleanupHooks() {
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
		inspect: (key: string) =>
			key === "completionHooks"
				? {
						globalValue: { stop: [], subagentStop: [], interrupt: [command], sessionEnd: [command] },
					}
				: undefined,
	} as unknown as vscode.WorkspaceConfiguration)
	const deadlines: Array<{ milliseconds: number; controller: AbortController }> = []
	vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		const controller = new AbortController()
		deadlines.push({ milliseconds, controller })
		return controller.signal
	})
	return deadlines
}

function terminate(fixture: Fixture) {
	fixture.task["interruptHookPending"] = true
	const aborting = fixture.task.abortTask(true)
	const joined = Promise.all([aborting, fixture.task.waitForTermination()])
	const settled = joined.then(
		() => ({ kind: "returned" as const }),
		(error: unknown) => ({ kind: "threw" as const, error }),
	)
	return { joined, settled }
}

describe("public Task termination hook identity and independent deadline", () => {
	it.each(cleanupCases)("fences cleanup at $boundary for $identity (replacement=$replaced)", async (testCase) => {
		const { boundary, identity, replaced } = testCase
		const deadlines = installCleanupHooks()
		const fixture = await harness({ boundary, preStep: true, cleanup: true })
		expect(fixture.task["currentAgentStep"]).toBeUndefined()
		expect(fixture.task["agentRunId"]).toBeUndefined()
		expect(fixture.task["agentTurnId"]).toBeUndefined()
		const operation = terminate(fixture)
		try {
			await Promise.race([
				fixture.entered,
				operation.settled.then((result) => {
					if (result.kind === "threw") throw result.error
					throw new Error("Termination settled before the controlled cleanup boundary")
				}),
			])
			expect(fixture.task["getTaskLifetimeCancellationSignal"]().aborted).toBe(true)
			expect(deadlines.some(({ milliseconds }) => milliseconds === 3_000)).toBe(true)
			if (replaced) fixture.replace(identity)
			fixture.release()
			const result = await operation.settled
			if (result.kind === "threw") throw result.error
			const calls = vi.mocked(runLifecycleHooks).mock.calls
			expect(calls.map(([, payload]) => payload.hook_event_name)).toEqual(
				replaced ? (boundary === "transcript lookup" ? [] : ["Interrupt"]) : ["Interrupt", "SessionEnd"],
			)
			for (const [, , cleanupSignal] of calls) {
				expect(cleanupSignal).not.toBe(fixture.task["getTaskLifetimeCancellationSignal"]())
				expect(cleanupSignal.aborted).toBe(false)
			}
			expect(fixture.dispatch).not.toHaveBeenCalled()
			expect(fixture.approval).not.toHaveBeenCalled()
			expect(fixture.executor).not.toHaveBeenCalled()
			expect(fixture.task["lifecycleHookStoppedThisTurn"]).not.toBe(true)
			expect(fixture.task.apiConversationHistory.some((message) => message.hook_prompt)).toBe(false)
			expect(warningMessages(fixture.task.alphaMessages)).toEqual([])
			if (replaced) expect(fixture.owns()).toBe(false)
			else expect(deadlines.some(({ milliseconds }) => milliseconds === 1_000)).toBe(true)
		} finally {
			fixture.release()
			await operation.settled
			fixture.restoreIdentity()
		}
	})

	it("bounds a never-settled cleanup lookup with its independent signal after lifetime cancellation", async () => {
		const deadlines = installCleanupHooks()
		const fixture = await harness({ boundary: "transcript lookup", preStep: true, cleanup: true })
		const operation = terminate(fixture)
		try {
			await Promise.race([
				fixture.entered,
				operation.settled.then((result) => {
					if (result.kind === "threw") throw result.error
					throw new Error("Termination settled before its cleanup lookup")
				}),
			])
			expect(fixture.task["getTaskLifetimeCancellationSignal"]().aborted).toBe(true)
			const deadline = deadlines.find(({ milliseconds }) => milliseconds === 3_000)
			expect(deadline).toBeDefined()
			deadline!.controller.abort(new Error("Controlled cleanup deadline"))
			const result = await operation.settled
			if (result.kind === "threw") throw result.error
			expect(runLifecycleHooks).not.toHaveBeenCalled()
			fixture.release()
			await fixture.transcript.mock.results[0].value
			expect(runLifecycleHooks).not.toHaveBeenCalled()
		} finally {
			fixture.release()
			await operation.settled
		}
	})
})
