import type { Anthropic } from "@anthropic-ai/sdk"
import {
	getVscodeLlmContextWindow,
	type ModelInfo,
	type ProviderSettings,
	type TaskDesignHandoff,
} from "@alpha-code/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import * as requestTimeout from "../../../api/providers/utils/timeout-config"
import { BaseTerminal } from "../../../integrations/terminal/BaseTerminal"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import type { ToolSchedulerOutcome } from "../../agent/ToolScheduler"
import {
	getEffectiveApiHistory,
	summarizeConversation,
	type SummarizeResponse,
	type TokenCountContext,
} from "../../condense"
import { manageContext, willManageContext } from "../../context-management"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { SYSTEM_PROMPT_FRAGMENTS } from "../../prompts/system"
import { getDesignHandoffPrompt } from "../../prompts/sections/design-handoff"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { shouldCompactAfterTurn, Task } from "../Task"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

// Module mocks retain their last implementation under Vitest 4 unless explicitly reset.
beforeEach(() => vi.resetAllMocks())

vi.mock("../build-tools", async (importOriginal) => ({
	...(await importOriginal<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))
vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn(async () => "") }))
vi.mock("../../prompts/system", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../prompts/system")>()),
	SYSTEM_PROMPT_FRAGMENTS: vi.fn(async () => ({
		systemPrefix: "Captured provider prompt",
		userContext: "",
		systemSuffix: "",
		instructionParts: [{ role: "developer", origin: "built-in-mode", content: "Captured provider prompt" }],
	})),
}))
vi.mock("../../condense", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))
vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(() => true),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function compactedResult(messages: ApiMessage[]): SummarizeResponse {
	const summary: ApiMessage = {
		role: "user",
		content: "Earlier conversation",
		ts: 10,
		isSummary: true,
		input_origin: "agent",
		condenseId: "summary-1",
	}
	return {
		messages: [{ ...messages[0], condenseParent: "summary-1" }, summary, ...messages.slice(1)],
		summary: "Earlier conversation",
		cost: 0,
		newContextTokens: 20,
		condenseId: "summary-1",
	}
}

function harness() {
	const api = {
		getModel: () => ({ id: "test-model", info: { contextWindow: 128_000, maxTokens: 4096 } as ModelInfo }),
		countTokens: vi.fn<ApiHandler["countTokens"]>(async (blocks) =>
			JSON.stringify(blocks).includes("Original request") ? 100 : 10,
		),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {}),
	} satisfies ApiHandler
	const apiConfiguration: ProviderSettings = { apiProvider: "vertex" }
	const provider = {
		getState: vi.fn(async () => ({})),
		postMessageToWebview: vi.fn(async () => {}),
		context: {} as any,
		getMcpHub: vi.fn(() => undefined),
		getSkillsManager: vi.fn(() => undefined),
	}
	const history: ApiMessage[] = [
		{ role: "user", content: "Original request", ts: 1 },
		{ role: "assistant", content: "Recent answer", ts: 2 },
		{ role: "user", content: "Recent instruction", ts: 3 },
	]
	const save = vi.fn(async () => true)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "compaction-safety",
		taskKind: "primary",
		workspacePath: process.cwd(),
		_taskMode: "code",
		abort: false,
		abandoned: false,
		didComplete: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		commandExecutionEvidence: new Map(),
		pendingWaitAgentResultClaims: new Map<string, string>(),
		persistedToolResultIds: new Set<string>(),
		toolRepetitionDetector: new ToolRepetitionDetector(3),
		api,
		apiConfiguration,
		// Captured provider requests use the effective snapshot. Keep this fixture's
		// initial effective profile aligned with its base profile.
		effectiveApiConfiguration: { ...apiConfiguration },
		reasoningPreference: { kind: "default" },
		reasoningState: {
			requested: { kind: "default" },
			effective: { kind: "default" },
			capabilities: { kind: "unavailable", canDisable: false },
		},
		reasoningByHandler: new WeakMap(),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: history,
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		toolCatalogCache: new TaskToolCatalogCache(),
		userMessageContent: [],
		alphaMessages: [],
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "System prompt"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 100 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		getFilesReadByAlphaSafely: vi.fn(async () => undefined),
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => {}),
		environmentContext: { reset: vi.fn() },
		refreshEnvironmentContext: vi.fn(async () => {}),
		saveApiConversationHistory: save,
		saveAlphaMessages: vi.fn(async () => true),
		say: vi.fn(async () => undefined),
		emit: vi.fn(),
		messageQueueService: new MessageQueueService(),
		beginCanonicalLifecycleTurn: vi.fn(async () => {}),
		finishCanonicalLifecycleTurn: vi.fn(async () => {}),
		publishCanonicalLifecyclePhase: vi.fn(async () => {}),
		appendAgentTurnEvent: vi.fn(async () => {}),
		publishCanonicalLifecycleSchedulerEvent: vi.fn(async () => {}),
		publishCanonicalLifecycleToolResult: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		shouldStopRepeatedToolCall: () => false,
		pushToolResultToUserContent(result: Anthropic.ToolResultBlockParam) {
			task.userMessageContent.push(result)
			return true
		},
	}) as Task
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
		tools: [],
		surface: createTaskToolSurface({
			registry: new ToolRegistry({ includeBuiltIns: false }),
			applyProfile: false,
			approvalMode: "auto",
		}),
	})
	vi.mocked(summarizeConversation).mockImplementation(async ({ messages }) => compactedResult(messages))
	return { task, api, provider, save, history }
}

describe("post-turn compaction admission", () => {
	it.each([
		[{ status: "completed", completionReason: "assistant" }, true],
		[{ status: "completed", completionReason: "host" }, false],
		[{ status: "awaiting-user" }, true],
		[{ status: "incomplete" }, false],
		[{ status: "aborted" }, false],
	] as const)("returns %s", (outcome, expected) => {
		expect(shouldCompactAfterTurn(outcome)).toBe(expected)
	})
})

function holdSummary() {
	const started = deferred<void>()
	const finish = deferred<void>()
	vi.mocked(summarizeConversation).mockImplementationOnce(async ({ messages }) => {
		const result = compactedResult(messages)
		started.resolve()
		await finish.promise
		return result
	})
	return { started: started.promise, finish: () => finish.resolve() }
}

function runRecovery(task: Task, trigger: "manual" | "automatic" | "forced") {
	if (trigger === "manual") return task.condenseContext()
	if (trigger === "automatic") {
		return task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
	}
	return Reflect.get(task, "handleContextWindowExceededError").call(task) as Promise<void>
}

describe("forced compaction step ownership", () => {
	afterEach(() => vi.restoreAllMocks())

	async function holdFailedRequest(options: { compactionApiHandler?: ApiHandler; acceptMutation?: boolean } = {}) {
		const fixture = harness()
		const { task, api, provider, history } = fixture
		const started = deferred<void>()
		const fail = deferred<void>()
		const fragments = [{ role: "developer" as const, origin: "captured-rule", content: "Keep captured authority" }]
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const mutation = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
			callbacks.pushToolResult("Accepted edit was saved")
		})
		registry.register({
			name: "apply_patch",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "apply_patch",
					description: "Captured workspace mutation",
					parameters: {
						type: "object",
						properties: { password: { type: "string", const: "literal schema" } },
					},
				},
			},
			capabilities: {
				concurrency: "serial",
				sideEffects: "workspace",
				controlFlow: false,
				requiresApproval: false,
			},
			execute: mutation,
		})
		const surface = createTaskToolSurface({ registry, applyProfile: false, approvalMode: "ask" })
		const acceptedCall = {
			type: "tool_call" as const,
			id: "accepted-edit",
			name: "apply_patch",
			arguments: { patch: "*** Begin Patch\n*** Add File: accepted.txt\n+Saved edit\n*** End Patch" },
		}
		if (options.acceptMutation) {
			history[0].content = "Original request with earlier implementation context. ".repeat(4_000)
			history.push({
				role: "assistant",
				content: [
					{ type: "tool_use", id: acceptedCall.id, name: acceptedCall.name, input: acceptedCall.arguments },
				],
				ts: 4,
			})
			Object.assign(task, {
				agentRunId: "accepted-mutation-run",
				assistantMessageSavedToHistory: true,
				assertCurrentProviderTranscriptBeforeEffects: vi.fn(async () => {}),
				enqueueCanonicalLifecycleEvent: vi.fn(async () => {}),
				getCanonicalLifecycleSnapshot: () => ({
					runId: task["agentRunId"],
					turnId: task["agentTurnId"],
					effectStartedToolCallIds: [acceptedCall.id],
				}),
			})
			task["captureAgentStep"](
				0,
				"Prior mutation instructions",
				history,
				[...surface.schemas],
				["apply_patch"],
				{ taskId: task.taskId, mode: "code" },
				"code",
				api.getModel().info,
				surface,
			)
			task["currentTaskToolSurface"] = surface
			const outcome = await Reflect.apply(task["executeCanonicalToolCallsForTurn"], task, [
				{ items: [acceptedCall], text: "", reasoning: "", toolCalls: [acceptedCall] },
				surface,
				"code",
				undefined,
			])
			expect(outcome).toMatchObject({
				status: "completed",
				results: [{ callId: acceptedCall.id, status: "success", content: "Accepted edit was saved" }],
			})
			await task.flushPendingToolResultsToHistory()
		}
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
			tools: [...surface.schemas],
			allowedFunctionNames: ["apply_patch"],
			surface,
		})
		provider.getState.mockResolvedValue({ approvalMode: "ask", autoCondenseContext: false })
		vi.mocked(task["getSystemPrompt"]).mockImplementation(async (_state, _provider, _handoff, _mode, capture) => {
			capture?.(fragments)
			return "Captured system instructions"
		})
		vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 0 } as ReturnType<Task["getTokenUsage"]>)
		if (options.compactionApiHandler) task["previousCompactionHandler"] = options.compactionApiHandler
		api.createMessage.mockImplementationOnce(async function* () {
			started.resolve()
			await fail.promise
			yield* []
			throw Object.assign(new Error("Request exceeds the model context window"), { retryCategory: "context" })
		})
		const stream = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const failed = stream.next().catch((error: unknown) => error)
		await started.promise
		const step = task["currentAgentStep"]!
		return {
			...fixture,
			step,
			surface,
			mutation,
			acceptedCall,
			fragments,
			finishFailure: async () => {
				fail.resolve()
				expect(await failed).toMatchObject({ retryCategory: "context" })
				await stream.return(undefined)
				vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 100_000 } as ReturnType<
					Task["getTokenUsage"]
				>)
			},
			recover: () =>
				Reflect.apply(task["handleContextWindowExceededError"], task, [undefined, step]) as Promise<void>,
		}
	}

	it("uses the failed route, instructions, and tool authority after live settings change", async () => {
		const { task, api, provider, step, mutation, acceptedCall, fragments, finishFailure, recover } =
			await holdFailedRequest({ acceptMutation: true })
		const pairedHistory = structuredClone(task.apiConversationHistory)
		const replacement: ApiHandler = {
			getModel: () => ({
				id: "replacement-model",
				info: { contextWindow: 32_000, maxTokens: 1024, supportsPromptCache: false },
			}),
			countTokens: vi.fn(async () => 10),
			createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
				yield { type: "text", text: "New logical step" }
			}),
		}
		task.api = replacement
		task.apiConfiguration = { apiProvider: "openai", apiModelId: "replacement-model" }
		task["effectiveApiConfiguration"] = { ...task.apiConfiguration }
		vi.mocked(task.getTaskMode).mockResolvedValue("architect")
		vi.mocked(task["getSystemPrompt"]).mockResolvedValue("Changed live instructions")
		provider.getState.mockResolvedValue({ approvalMode: "auto", autoCondenseContext: false })
		task["taskApprovalModePersistence"] = Promise.resolve(true)
		expect(task.setTaskApprovalMode("auto")).toBe(true)
		await task["taskApprovalModePersistence"]
		const updatedSurface = createTaskToolSurface({
			registry: new ToolRegistry({ includeBuiltIns: false }),
			applyProfile: false,
			approvalMode: "auto",
		})
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({ tools: [], surface: updatedSurface })
		const buildsBeforeRecovery = vi.mocked(buildNativeToolsArrayWithRestrictions).mock.calls.length
		await finishFailure()
		vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => ({
			...compactedResult(messages),
			prevContextTokens: 100_000,
			targetContextTokens: 80_000,
			status: "reduced",
		}))

		await recover()

		const recovery = vi.mocked(manageContext).mock.calls[0][0]
		expect(recovery.apiHandler).toBe(api)
		expect(recovery.contextWindow).toBe(128_000)
		expect(recovery.systemPrompt).toBe("Captured system instructions")
		expect(recovery.metadata).toMatchObject({
			mode: "code",
			instructionFragments: fragments,
			tools: step.getRequest().metadata.tools,
			allowedFunctionNames: ["apply_patch"],
		})
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(buildsBeforeRecovery)
		expect(step.surface?.policy.approval.mode).toBe("ask")
		expect(replacement.countTokens).not.toHaveBeenCalled()
		expect(mutation).toHaveBeenCalledOnce()
		expect(
			task.apiConversationHistory
				.filter((message) => !message.isSummary)
				.map(({ condenseParent, ...message }) => message),
		).toEqual(pairedHistory)
		expect(
			task.apiConversationHistory.flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
		).toContainEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: acceptedCall.id, is_error: false }),
		)
		vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 0 } as ReturnType<Task["getTokenUsage"]>)
		const successor = task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "context",
		})
		await successor.next()
		await successor.next()
		expect(task["currentAgentStep"]?.snapshot.context.provider.modelId).toBe("replacement-model")
		expect(task["currentAgentStep"]?.snapshot.context.mode.slug).toBe("architect")
		expect(task["currentAgentStep"]?.snapshot.context.policy.approval.mode).toBe("auto")
		expect(mutation).toHaveBeenCalledOnce()
	})

	it("retains the captured larger-window compactor until the failed step is released", async () => {
		const compactionApiHandler = {
			getModel: () => ({
				id: "previous-model",
				info: { contextWindow: 256_000, maxTokens: 4096, supportsPromptCache: false },
			}),
			countTokens: vi.fn(async () => 10),
			createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {}),
			dispose: vi.fn(),
		} satisfies ApiHandler
		const { task, step, finishFailure, recover } = await holdFailedRequest({ compactionApiHandler })
		await finishFailure()
		expect(compactionApiHandler.dispose).not.toHaveBeenCalled()
		vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => ({
			...compactedResult(messages),
			prevContextTokens: 100_000,
			targetContextTokens: 80_000,
			status: "reduced",
		}))

		await recover()

		expect(vi.mocked(manageContext).mock.calls[0][0].compactionApiHandler).toBe(compactionApiHandler)
		expect(compactionApiHandler.dispose).not.toHaveBeenCalled()
		step.releaseRequest()
		step.releaseRequest()
		expect(compactionApiHandler.dispose).toHaveBeenCalledOnce()
		expect(task["reasoningHandlerUsers"].has(compactionApiHandler)).toBe(false)
	})

	it.each([
		{ transition: "Stop", configuredTimeoutMs: 1_000, retryAllowanceMs: undefined, timeoutScope: undefined },
		{
			transition: "task disposal",
			configuredTimeoutMs: 1_000,
			retryAllowanceMs: undefined,
			timeoutScope: undefined,
		},
		{
			transition: "the earlier compaction deadline",
			configuredTimeoutMs: 100,
			retryAllowanceMs: 1_000,
			timeoutScope: "compaction_deadline",
		},
		{
			transition: "the earlier retry deadline",
			configuredTimeoutMs: 1_000,
			retryAllowanceMs: 100,
			timeoutScope: "retry_deadline",
		},
		{
			transition: "a tied retry deadline",
			configuredTimeoutMs: 100,
			retryAllowanceMs: 100,
			timeoutScope: "retry_deadline",
		},
	])(
		"does not commit a prepared summary after $transition while receipt settlement is pending",
		async ({ transition, configuredTimeoutMs, retryAllowanceMs, timeoutScope }) => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000)
				vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(configuredTimeoutMs)
				const { task, provider, save, step, finishFailure } = await holdFailedRequest()
				await finishFailure()
				const historyBeforeCommit = task.apiConversationHistory
				const beforeCommit = deferred<void>()
				const releaseCommit = deferred<void>()
				Object.assign(provider, {
					settleIndependentTaskWaitReceiptsForParent: vi.fn(async () => {
						beforeCommit.resolve()
						await releaseCommit.promise
					}),
				})
				vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => ({
					...compactedResult(messages),
					prevContextTokens: 100_000,
					targetContextTokens: 80_000,
					status: "reduced",
				}))
				const controller = new AbortController()
				task["stepInterruptionController"] = controller
				const retryDeadline = retryAllowanceMs === undefined ? undefined : 1_000 + retryAllowanceMs
				const running = Reflect.apply(task["handleContextWindowExceededError"], task, [
					retryDeadline,
					step,
				]).catch((error: unknown) => error)
				await beforeCommit.promise
				if (transition === "Stop") task.cancelCurrentRequest()
				else if (transition === "task disposal") {
					task["taskCancellationController"].abort(new Error("Owning task was disposed"))
				} else {
					// Let the absolute deadline expire before its timer callback has run.
					vi.setSystemTime(1_000 + Math.min(configuredTimeoutMs, retryAllowanceMs!))
				}
				releaseCommit.resolve()
				const failure = await running

				expect(save).not.toHaveBeenCalled()
				expect(task.apiConversationHistory).toBe(historyBeforeCommit)
				expect(task["currentAgentStep"]).toBe(step)
				expect(task["refreshEnvironmentContext"]).not.toHaveBeenCalled()
				expect(task.say).not.toHaveBeenCalled()
				if (timeoutScope) {
					expect(failure).toMatchObject({ name: "ApiStreamDeadlineError", timeoutScope })
					expect(vi.mocked(manageContext).mock.calls[0][0].metadata?.deadlineScope).toBe(timeoutScope)
				} else {
					expect(failure).toBe(
						transition === "Stop"
							? controller.signal.reason
							: task.getTaskLifetimeCancellationSignal().reason,
					)
				}
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it.each(["stop", "superseded"] as const)("discards a late failed-step summary after %s", async (transition) => {
		const { task, api, save, finishFailure, recover } = await holdFailedRequest()
		await finishFailure()
		const started = deferred<void>()
		const finish = deferred<void>()
		const oldController = new AbortController()
		task["stepInterruptionController"] = oldController
		vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => {
			const result = {
				...compactedResult(messages),
				prevContextTokens: 100_000,
				targetContextTokens: 80_000,
				status: "reduced" as const,
			}
			started.resolve()
			await finish.promise
			return result
		})
		const running = recover().catch((error: unknown) => error)
		await started.promise
		if (transition === "stop") task.cancelCurrentRequest()
		task["stepInterruptionController"] = new AbortController()
		task.apiConversationHistory = [{ role: "user", content: "Successor input", ts: 20 }]
		vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 0 } as ReturnType<Task["getTokenUsage"]>)
		api.createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "Successor response" }
		})
		const successor = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		await successor.next()
		const successorStep = task["currentAgentStep"]
		const successorController = task.currentRequestAbortController
		const successorHistory = structuredClone(task.apiConversationHistory)
		const publishedBeforeLateSummary = vi.mocked(task.say).mock.calls.length
		finish.resolve()

		expect(await running).toBeInstanceOf(Error)
		expect(task.apiConversationHistory).toEqual(successorHistory)
		expect(task["currentAgentStep"]).toBe(successorStep)
		expect(task.currentRequestAbortController).toBe(successorController)
		expect(successorController?.signal.aborted).toBe(false)
		expect(task.say).toHaveBeenCalledTimes(publishedBeforeLateSummary)
		expect(save).not.toHaveBeenCalled()
		await successor.return(undefined)
	})
})

describe("Task small Copilot context exhaustion", () => {
	async function smallWindowFixture(automatic: boolean, irreducible = false) {
		const { TelemetryService } = await import("@alpha-code/telemetry")
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		const fixture = harness()
		const { task, api, provider, history } = fixture
		const contextWindow = getVscodeLlmContextWindow(
			{ vendor: "copilot", family: "claude-sonnet-4.6", maxInputTokens: 936_000 },
			200_000,
		)
		expect(contextWindow).toBe(200_000)
		api.getModel = () => ({
			id: "claude-sonnet-4.6",
			info: { contextWindow, maxTokens: -1, contextWindowIncludesOutput: false, supportsPromptCache: false },
		})
		Object.assign(task.apiConfiguration, { apiProvider: "vscode-lm", vsCodeLmContextSize: 200_000 })
		Object.assign(Reflect.get(task, "effectiveApiConfiguration"), task.apiConfiguration)
		history.splice(
			0,
			history.length,
			...(irreducible
				? [{ role: "user" as const, content: "data".repeat(220_000), ts: 1 }]
				: [
						...Array.from({ length: 8 }, (_, index): ApiMessage[] => [
							{ role: "user", content: `Instruction ${index}: retain answer=42.`, ts: index * 2 + 1 },
							{ role: "assistant", content: "data".repeat(27_500), ts: index * 2 + 2 },
						]).flat(),
						{ role: "user" as const, content: "Continue with answer=42.", ts: 17 },
					]),
		)
		provider.getState.mockResolvedValue({ autoCondenseContext: automatic, autoCondenseContextPercent: 100 })
		vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 220_000 } as ReturnType<Task["getTokenUsage"]>)
		api.countTokens.mockImplementation(async (blocks) => Math.ceil(JSON.stringify(blocks).length / 4))
		api.createMessage.mockImplementation(async function* (_systemPrompt, messages) {
			if (Math.ceil(JSON.stringify(messages).length / 4) > contextWindow) {
				throw new Error("Request input exceeds the model's maximum context length of 200000 tokens")
			}
			yield { type: "text", text: "The answer is 42; the task can continue." }
		})
		const actualContext =
			await vi.importActual<typeof import("../../context-management")>("../../context-management")
		const actualCondense = await vi.importActual<typeof import("../../condense")>("../../condense")
		vi.mocked(manageContext).mockImplementation(actualContext.manageContext)
		vi.mocked(willManageContext).mockImplementation(actualContext.willManageContext)
		vi.mocked(summarizeConversation).mockImplementation(actualCondense.summarizeConversation)
		return fixture
	}

	it.each([true, false])(
		"closes compaction UI and dispatches after overflow with automatic summary=%s",
		async (automatic) => {
			const { task, api, provider, history } = await smallWindowFixture(automatic)
			const original = structuredClone(history)
			const text: string[] = []
			for await (const chunk of task.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
			})) {
				if (chunk.type === "text") text.push(chunk.text)
			}
			expect(text.join("")).toContain("task can continue")
			expect(api.createMessage).toHaveBeenCalledTimes(automatic ? 3 : 1)
			if (automatic) {
				const requests = api.createMessage.mock.calls
				expect(JSON.stringify(requests[1][1]).length).toBeLessThan(JSON.stringify(requests[0][1]).length)
				expect(vi.mocked(task.say).mock.calls.map(([type]) => type)).not.toContain("sliding_window_truncation")
				expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
			} else
				expect(task.say).toHaveBeenCalledWith(
					"sliding_window_truncation",
					undefined,
					undefined,
					false,
					undefined,
					undefined,
					expect.any(Object),
					undefined,
					expect.objectContaining({ messagesRemoved: expect.any(Number) }),
				)
			expect(history).toEqual(original)
			expect(task.apiConversationHistory.some((message) => message.isTruncationMarker)).toBe(!automatic)
			if (automatic) {
				expect(provider.postMessageToWebview).toHaveBeenCalledTimes(2)
				expect(provider.postMessageToWebview).toHaveBeenNthCalledWith(1, {
					type: "condenseTaskContextStarted",
					text: task.taskId,
				})
				expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
					type: "condenseTaskContextResponse",
					text: task.taskId,
				})
			}
		},
	)

	it("retries smaller manual summary input and releases compaction admission on success", async () => {
		const { task, api, provider, history, save } = await smallWindowFixture(true)
		const original = structuredClone(history)
		await task.condenseContext()
		expect(vi.mocked(task.say).mock.calls.map(([type]) => type)).not.toContain("condense_context_error")
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		const requests = api.createMessage.mock.calls
		expect(JSON.stringify(requests[1][1]).length).toBeLessThan(JSON.stringify(requests[0][1]).length)
		expect(save).toHaveBeenCalledOnce()
		expect(history).toEqual(original)
		expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
		expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
		expect(Reflect.get(task, "manualContextCondenseSettlement")).toBeUndefined()
		// AlphaProvider owns the manual response notification; Task owns releasing its admission guard.
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each([true, false])(
		"closes the UI and stops irreducible overflow with automatic summary=%s",
		async (automatic) => {
			const { task, api, provider, history, save } = await smallWindowFixture(automatic, true)
			const running = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
			await expect(running).rejects.toMatchObject({ name: "ContextRecoveryExhaustedError", retryable: false })
			expect(api.createMessage).toHaveBeenCalledTimes(automatic ? 1 : 0)
			expect(save).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toBe(history)
			if (automatic) {
				expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
					type: "condenseTaskContextResponse",
					text: task.taskId,
				})
			}
		},
	)
})

describe("Task design handoff provenance", () => {
	function largeHandoff(taskId: string): TaskDesignHandoff {
		return {
			title: "Complete approved design",
			markdown: `${"Approved implementation detail.\n".repeat(2_000)}\nFINAL_APPROVED_REQUIREMENT`,
			sourceTaskId: taskId,
			digest: "c".repeat(64),
			updatedAt: 1,
		}
	}

	it("keeps the final approved requirement on small-window and reloaded Code steps", async () => {
		const { task, api } = harness()
		api.getModel = () => ({
			id: "small-model",
			info: { contextWindow: 8_000, maxTokens: 1024, supportsPromptCache: false },
		})
		const handoff = largeHandoff(task.taskId)
		for (const captured of [handoff, structuredClone(handoff)]) {
			const prompt = await Reflect.get(Task.prototype, "getSystemPrompt").call(
				task,
				{},
				{ apiHandler: api, apiConfiguration: task.apiConfiguration },
				captured,
				"code",
			)
			expect(prompt.includes(handoff.markdown)).toBe(true)
		}
	})

	it.each([true, false])("validates the complete approved handoff on the first request (fits: %s)", async (fits) => {
		const { task, api, history, save } = harness()
		const original = structuredClone(history)
		const handoff = largeHandoff(task.taskId)
		Reflect.set(task, "designHandoff", handoff)
		Reflect.set(task, "getTokenUsage", () => ({ contextTokens: 0 }))
		Reflect.set(task, "getSystemPrompt", Reflect.get(Task.prototype, "getSystemPrompt").bind(task))
		api.countTokens.mockImplementation(async (blocks) =>
			JSON.stringify(blocks).includes("FINAL_APPROVED_REQUIREMENT") ? (fits ? 20_000 : 200_000) : 10,
		)
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
		if (fits) {
			await request
			expect(api.createMessage).toHaveBeenCalledOnce()
			expect(api.createMessage.mock.calls[0][0].includes(handoff.markdown)).toBe(true)
			expect(api.createMessage.mock.calls[0][2]?.instructionFragments).toContainEqual(
				expect.objectContaining({
					origin: "design-handoff",
					content: expect.stringContaining(handoff.markdown),
				}),
			)
		} else {
			await expect(request).rejects.toMatchObject({ name: "ContextRecoveryExhaustedError", retryable: false })
			expect(api.createMessage).not.toHaveBeenCalled()
			expect(Reflect.get(task, "currentAgentStep")).toBeUndefined()
		}
		expect(
			api.countTokens.mock.calls.some(([blocks]) =>
				JSON.stringify(blocks).includes("FINAL_APPROVED_REQUIREMENT"),
			),
		).toBe(true)
		expect(task.designHandoff).toEqual(handoff)
		expect(task.apiConversationHistory).toEqual(original)
		expect(save).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
	})

	it("captures the Plan handoff on the Code step and retains it through compaction without transcript history", async () => {
		const { task, api } = harness()
		const handoff: TaskDesignHandoff = {
			title: "Persist the design",
			markdown: "# Persist the design\n\n## Implementation\n\n- Keep the host-owned handoff.",
			sourceTaskId: task.taskId,
			digest: "b".repeat(64),
			updatedAt: 1,
		}
		Object.assign(task, { designHandoff: handoff })
		const getSystemPrompt = Reflect.get(Task.prototype, "getSystemPrompt") as (
			state?: unknown,
			provider?: unknown,
			handoff?: TaskDesignHandoff | null,
			mode?: string,
		) => Promise<string>
		const codePrompt = await getSystemPrompt.call(
			task,
			{},
			{ apiHandler: api, apiConfiguration: task.apiConfiguration },
			handoff,
			"code",
		)
		const planPrompt = await getSystemPrompt.call(
			task,
			{},
			{ apiHandler: api, apiConfiguration: task.apiConfiguration },
			handoff,
			"architect",
		)
		expect(codePrompt).toContain(handoff.markdown)
		expect(planPrompt).not.toContain(handoff.markdown)

		const surface = createTaskToolSurface({
			registry: new ToolRegistry({ includeBuiltIns: false }),
			applyProfile: false,
		})
		const prompt = getDesignHandoffPrompt(handoff, { taskId: task.taskId })!
		const step = (task as any).captureAgentStep(
			0,
			prompt.text,
			[],
			surface.schemas,
			undefined,
			{ taskId: task.taskId, mode: "code" },
			"code",
			api.getModel().info,
			surface,
			undefined,
			{ apiHandler: api, apiConfiguration: task.apiConfiguration },
			handoff,
		)

		expect(step.snapshot.context.mode.slug).toBe("code")
		expect(step.snapshot.context.transcript.messages).toEqual([])
		expect(step.snapshot.context.instructions.systemPrompt).toContain(handoff.markdown)
		expect(step.snapshot.context.instructions.sources).toEqual([prompt.source])

		const compacted = (task as any).agentStepContextBuilder.compaction(step.snapshot, {
			action: "summary",
			compaction: { attempted: true, summaryId: "summary-1" },
		})
		expect(compacted.context.instructions.sources).toEqual([prompt.source])
		expect(compacted.context.instructions.systemPrompt).toContain(handoff.markdown)
		expect(compacted.context.transcript.messages).toEqual([])

		Object.assign(task, { designHandoff: undefined })
		const noPlanPrompt = await getSystemPrompt.call(
			task,
			{},
			{ apiHandler: api, apiConfiguration: task.apiConfiguration },
			null,
			"code",
		)
		expect(noPlanPrompt).not.toContain("CURRENT DESIGN HANDOFF")
		const noPlanStep = (task as any).captureAgentStep(
			0,
			noPlanPrompt,
			[],
			surface.schemas,
			undefined,
			{ taskId: task.taskId, mode: "code" },
			"code",
			api.getModel().info,
			surface,
			undefined,
			{ apiHandler: api, apiConfiguration: task.apiConfiguration },
			null,
		)
		expect(noPlanStep.snapshot.context.instructions.sources).toEqual([])
	})
})

describe("Task proportional context preflight", () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		const actual = await vi.importActual<typeof import("../../context-management")>("../../context-management")
		vi.mocked(manageContext).mockImplementation(actual.manageContext)
		vi.mocked(willManageContext).mockImplementation(actual.willManageContext)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.mocked(manageContext).mockReset()
		vi.mocked(willManageContext).mockReturnValue(true)
	})

	it.each([1, 2, 3])("builds only the dispatched catalog below the compaction threshold (sample %i)", async () => {
		const { task, api, history, save } = harness()
		const expectedHistory = structuredClone(history)

		await runRecovery(task, "automatic")

		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(api.createMessage.mock.calls[0].slice(0, 2)).toEqual([
			"System prompt",
			expectedHistory.map(({ role, content }) => ({ role, content })),
		])
		expect(api.createMessage.mock.calls[0][2]).not.toHaveProperty("tools")
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toEqual(expectedHistory)
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(1)
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledWith(
			expect.objectContaining({ readGrant: expect.objectContaining({ enabled: true }) }),
		)
	})

	it("rejects invalid authoritative counts even when the preview says compaction is unnecessary", async () => {
		const { task, api, save } = harness()
		api.countTokens.mockResolvedValue(Number.NaN)

		await expect(runRecovery(task, "automatic")).rejects.toMatchObject({
			name: "ContextRecoveryExhaustedError",
			retryable: false,
		})

		expect(willManageContext).toHaveReturnedWith(false)
		expect(buildNativeToolsArrayWithRestrictions).not.toHaveBeenCalled()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})

	it("prepares compaction metadata when an uncached recount overturns the preview", async () => {
		const { task, api, save } = harness()
		api.countTokens.mockResolvedValueOnce(Number.NaN).mockResolvedValueOnce(130_000)

		await runRecovery(task, "automatic")

		expect(willManageContext).toHaveReturnedWith(false)
		expect(summarizeConversation).toHaveBeenCalledOnce()
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(2)
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenLastCalledWith(
			expect.objectContaining({ readGrant: expect.objectContaining({ enabled: true }) }),
		)
		expect(save).toHaveBeenCalledOnce()
		expect(api.createMessage).toHaveBeenCalledOnce()
	})

	it("cancels deferred catalog preparation before compaction, persistence, or dispatch", async () => {
		const { task, api, save } = harness()
		Reflect.set(task, "getTokenUsage", () => ({ contextTokens: 120_000 }))
		const controller = new AbortController()
		const started = deferred<void>()
		const release = deferred<void>()
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementationOnce(async () => {
			started.resolve()
			await release.promise
			return { tools: [] }
		})
		const running = task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				interruptionSignal: controller.signal,
			})
			.next()
		await started.promise

		controller.abort(new Error("Cancelled during tool preparation"))
		await expect(running).rejects.toThrow("Cancelled during tool preparation")
		release.resolve()
		await Promise.resolve()

		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledOnce()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})
})

describe("Task manual compaction boundary", () => {
	it("retains a child's captured explicit-only catalog when provider history is compacted", async () => {
		const { task, history, save, provider } = harness()
		const capturedSkills = [
			{
				name: "explicit-review",
				path: "F:/workspace/.agents/skills/explicit-review/SKILL.md",
				digest: "a".repeat(64),
				allowImplicitInvocation: false,
			},
		]
		const manifest = { skills: structuredClone(capturedSkills) }
		Object.assign(task, { taskKind: "subagent", subagentContextManifest: manifest })

		await task.condenseContext()

		expect(save).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).not.toEqual(history)
		expect(task.subagentContextManifest).toBe(manifest)
		expect(task.subagentContextManifest?.skills).toEqual(capturedSkills)
		expect(task.getInheritedSubagentSkill("explicit-review")?.allowImplicitInvocation).toBe(false)
		expect(provider.getSkillsManager).not.toHaveBeenCalled()
	})

	it("uses the captured instruction roles and provenance for manual compaction", async () => {
		const { task } = harness()
		const fragments = [
			{ role: "developer" as const, origin: "built-in-mode", content: "Base instructions" },
			{ role: "user" as const, origin: "project-instructions", content: "\nProject instructions" },
		]
		Reflect.set(
			task,
			"getSystemPrompt",
			vi.fn(async (...args: unknown[]) => {
				;(args[4] as (value: typeof fragments) => void)(fragments)
				return fragments.map(({ content }) => content).join("")
			}),
		)

		await task.condenseContext()

		expect(vi.mocked(summarizeConversation).mock.calls[0][0].metadata?.instructionFragments).toEqual(fragments)
	})

	it("keeps useful exploration running across compaction and advises on repeated reads", async () => {
		const { task, save } = harness()
		const detector = task.toolRepetitionDetector
		const suspend = vi.spyOn(task, "suspendAfterCurrentTurn").mockImplementation(() => {})
		for (let index = 0; index < 200; index++) {
			await task.recordToolCallForStopping("read_file", { path: `file-${index}.ts` }, "success")
		}
		await task.condenseContext()
		expect(save).toHaveBeenCalledOnce()
		expect(task.toolRepetitionDetector).toBe(detector)
		for (let index = 200; index < 240; index++) {
			await task.recordToolCallForStopping("read_file", { path: `file-${index}.ts` }, "success")
		}
		expect(suspend).not.toHaveBeenCalled()
		for (let index = 0; index < 12; index++) {
			await task.recordToolCallForStopping("read_file", { path: "file-239.ts" }, "success")
		}
		expect(suspend).not.toHaveBeenCalled()
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})

	it("uses the global threshold and effective output reservation for manual compaction", async () => {
		const { task, provider } = harness()
		provider.getState.mockResolvedValue({ autoCondenseContextPercent: 5, profileThresholds: { default: 20 } })
		await task.condenseContext()
		// The legacy 20% profile value is ignored; 5% of 128k yields a 6.4k trigger and 1.6k target.
		expect(summarizeConversation).toHaveBeenCalledWith(expect.objectContaining({ maxContextTokens: 1607 }))
	})

	it("publishes an unchanged result without rewriting history or resetting its environment", async () => {
		const { task, history, save } = harness()
		vi.mocked(summarizeConversation).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0,
			status: "unchanged",
			newContextTokens: 130,
		})
		await task.condenseContext()
		expect(task.apiConversationHistory).toBe(history)
		expect(save).not.toHaveBeenCalled()
		expect(Reflect.get(task, "environmentContext").reset).not.toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledWith(
			"condense_context",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			expect.objectContaining({ outcome: "unchanged", prevContextTokens: 130, newContextTokens: 130 }),
		)
	})

	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it.each([
		["provider preflight", { isTaskLoopActive: true }],
		["between model steps", { isAgentTurnEngineActive: true }],
		["provider streaming", { isStreaming: true }],
		["first provider chunk", { isWaitingForFirstChunk: true }],
		["external workspace mutation", { externalMutationLease: { label: "applying changes", token: Symbol() } }],
	])("rejects manual compaction during %s without flushing or summarizing", async (_label, state) => {
		const { task, save, history } = harness()
		Object.assign(task, state)
		const flush = vi.spyOn(task, "flushPendingToolResultsToHistory")

		await expect(task.condenseContext()).rejects.toThrow("Task work is in progress")

		expect(flush).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
	})

	it("keeps a running tool transaction intact when manual compaction is requested", async () => {
		const { task, save, history } = harness()
		const started = deferred<void>()
		const finish = deferred<void>()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "read_file",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			},
			capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
			execute: async ({ callbacks }) => {
				started.resolve()
				await finish.promise
				callbacks.pushToolResult("Actual file content")
			},
		})
		const surface = createTaskToolSurface({ registry, applyProfile: false })
		const call = { type: "tool_call" as const, id: "running-call", name: "read_file", arguments: {} }
		const response: AgentResponse = { items: [call], text: "", reasoning: "", toolCalls: [call] }
		history.push({
			role: "assistant",
			content: [{ type: "tool_use", id: call.id, name: call.name, input: {} }],
			ts: 4,
		})
		Object.assign(task, { isTaskLoopActive: true, assistantMessageSavedToHistory: true })
		Reflect.set(
			task,
			"assertCurrentProviderTranscriptBeforeEffects",
			vi.fn(async () => {}),
		)
		const run = Reflect.get(task, "executeCanonicalToolCallsForTurn").call(
			task,
			response,
			surface,
			"code",
			undefined,
		) as Promise<ToolSchedulerOutcome>
		await started.promise

		try {
			await expect(task.condenseContext()).rejects.toThrow("Task work is in progress")
			expect(summarizeConversation).not.toHaveBeenCalled()
			expect(save).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toBe(history)
			expect(task.userMessageContent).toEqual([])
		} finally {
			finish.resolve()
		}
		const outcome = await run
		expect(outcome).toMatchObject({
			status: "completed",
			results: [{ callId: call.id, status: "success", content: "Actual file content" }],
		})
		expect(task.userMessageContent).toEqual([
			{ type: "tool_result", tool_use_id: call.id, content: "Actual file content", is_error: false },
		])
	})

	it("prevents model steps and external effects from starting while manual compaction owns history", async () => {
		const { task } = harness()
		const summary = holdSummary()
		const run = task.condenseContext()
		await summary.started

		try {
			await expect(task.runAgentRequests([])).rejects.toThrow("Context compaction is in progress")
			const runStep = vi.spyOn(task, "runAgentRequests").mockResolvedValue(true)
			await expect(Reflect.get(task, "initiateTaskLoop").call(task, [])).rejects.toThrow(
				"Context compaction is in progress",
			)
			expect(runStep).not.toHaveBeenCalled()
			expect(task.getExternalMutationCapability()).toMatchObject({ allowed: false, state: "busy" })
			await expect(task.condenseContext()).rejects.toThrow("Context compaction is already in progress")
		} finally {
			summary.finish()
			await run
		}
		expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
	})

	it.each(["append", "rewind", "replace", "edit"] as const)(
		"does not overwrite a concurrent history %s with a stale summary",
		async (change) => {
			const { task, save } = harness()
			const summary = holdSummary()
			const run = task.condenseContext()
			await summary.started
			if (change === "append") task.apiConversationHistory.push({ role: "user", content: "New message", ts: 4 })
			if (change === "rewind") task.apiConversationHistory = task.apiConversationHistory.slice(0, 1)
			if (change === "replace") task.apiConversationHistory = [{ role: "user", content: "Replacement", ts: 5 }]
			if (change === "edit") task.apiConversationHistory[0].content = "Edited original request"
			const changedHistory = structuredClone(task.apiConversationHistory)
			summary.finish()

			await expect(run).rejects.toThrow("Conversation history changed during context compaction")
			expect(save).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toEqual(changedHistory)
			expect(task.say).not.toHaveBeenCalled()
			expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
		},
	)

	it("does not call the summarizer when Stop interrupts manual preflight", async () => {
		const { task, provider, save, history } = harness()
		const started = deferred<void>()
		const finish = deferred<void>()
		provider.getState.mockImplementationOnce(async () => {
			started.resolve()
			await finish.promise
			return {}
		})
		const run = task.condenseContext()
		await started.promise
		task.cancelCurrentRequest()
		finish.resolve()

		await expect(run).rejects.toThrow("Current task request was cancelled")
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
	})

	it.each(["abort", "abandoned", "disposed"])("does not start manual compaction after %s", async (state) => {
		const { task, save } = harness()
		if (state === "disposed") Reflect.get(task, "taskCancellationController").abort(new Error("Task disposed"))
		else Reflect.set(task, state, true)
		const flush = vi.spyOn(task, "flushPendingToolResultsToHistory")

		await expect(task.condenseContext()).rejects.toThrow()

		expect(flush).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
	})

	it("discards a late summary after Stop without persisting or publishing success", async () => {
		const { task, save, history } = harness()
		const summary = holdSummary()
		const run = task.condenseContext()
		await summary.started
		task.cancelCurrentRequest()
		summary.finish()

		await expect(run).rejects.toThrow("Current task request was cancelled")
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
		expect(task.say).not.toHaveBeenCalled()
		expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
	})

	it("preserves queued guidance and releases compaction before the queue compatibility hook", async () => {
		const { task } = harness()
		const summary = holdSummary()
		const run = task.condenseContext()
		await summary.started
		const queued = task.messageQueueService.addMessage("Continue with this guidance")
		const processQueuedMessages = Task.prototype.processQueuedMessages
		const queueHook = vi.spyOn(task, "processQueuedMessages").mockImplementation(() => {
			expect(Reflect.get(task, "contextCondenseAbortController")).toBeUndefined()
			processQueuedMessages.call(task)
		})
		summary.finish()

		await run

		expect(queueHook).toHaveBeenCalledOnce()
		expect(task.messageQueueService.messages).toEqual([queued])
	})

	it("persists a stable compaction without changing the retained message objects", async () => {
		const { task, save, history } = harness()
		const retained = history.slice(1)

		await task.condenseContext()

		expect(save).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory.slice(-2)).toEqual(retained)
		expect(task.apiConversationHistory.at(-2)).toBe(retained[0])
		expect(task.apiConversationHistory.at(-1)).toBe(retained[1])
		expect(task.say).toHaveBeenCalledWith(
			"condense_context",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			expect.objectContaining({ condenseId: "summary-1" }),
		)
	})
})

describe("Task post-turn compaction", () => {
	it("restores the after-prefix baseline from a persisted compaction receipt", () => {
		const { task } = harness()
		task.alphaMessages = [
			{
				ts: 1,
				type: "say",
				say: "condense_context",
				contextCondense: {
					cost: 0,
					prevContextTokens: 700,
					newContextTokens: 125,
					summary: "Saved summary",
				},
			},
		]
		const { task: reloaded } = harness()
		reloaded.alphaMessages = structuredClone(task.alphaMessages)
		expect(Reflect.get(reloaded, "getCompactionWindowPrefillTokens").call(reloaded)).toBe(125)
		reloaded.alphaMessages = [
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 125, tokensOut: 50 }) },
		]
		expect(Reflect.get(reloaded, "getCompactionWindowPrefillTokens").call(reloaded)).toBe(125)
	})

	it("persists a reduced active history that reloads with its rewind archive", async () => {
		const { task, api, provider, save, history } = harness()
		api.getModel = () => ({
			id: "million-token-model",
			info: { contextWindow: 1_000_000, maxTokens: 4096, supportsPromptCache: false },
		})
		api.countTokens.mockImplementation(async (blocks) => {
			const text = JSON.stringify(blocks)
			if (text.includes("Original request")) return 400_000
			if (text.includes("Earlier conversation")) return 50_000
			return 1_000
		})
		provider.getState.mockResolvedValue({ autoCondenseContext: true, postTurnCondenseContextPercent: 15 })
		vi.mocked(summarizeConversation).mockResolvedValueOnce({
			...compactedResult(history),
			prevContextTokens: 403_000,
			status: "reduced",
			targetContextTokens: 67_000,
		})

		await Reflect.get(task, "maybeCompactAfterTurn").call(task)

		expect(summarizeConversation).toHaveBeenCalledWith(expect.objectContaining({ isAutomaticTrigger: true }))
		expect(vi.mocked(summarizeConversation).mock.calls[0][0].maxContextTokens).toBeLessThan(100_000)
		expect(save).toHaveBeenCalledOnce()
		const reloadedHistory = structuredClone(task.apiConversationHistory)
		expect(reloadedHistory[0].condenseParent).toBe("summary-1")
		expect(getEffectiveApiHistory(reloadedHistory)).toEqual(getEffectiveApiHistory(task.apiConversationHistory))
		expect(getEffectiveApiHistory(reloadedHistory)).not.toContainEqual(reloadedHistory[0])
	})

	it("keeps optional post-turn compaction disabled on a completed model turn by default", async () => {
		const { task, api, provider, history, save } = harness()
		api.getModel = () => ({
			id: "small-model",
			info: { contextWindow: 100_000, maxTokens: 4096, supportsPromptCache: false },
		})
		api.countTokens.mockImplementation(async (blocks) =>
			JSON.stringify(blocks).includes("Earlier conversation") ? 1_000 : 20_000,
		)
		provider.getState.mockResolvedValue({ autoCondenseContext: true })
		vi.mocked(summarizeConversation).mockClear()
		const requestStep = vi.spyOn(task, "runAgentRequests").mockResolvedValue({
			status: "completed",
			response: createAgentResponse([{ type: "text", text: "The task is complete." }]),
		})
		vi.spyOn(task, "recordCompletionCandidate").mockImplementation(() => {})
		vi.spyOn(task, "waitForCompletionGateDecision").mockResolvedValue({
			allowed: true,
			modelCanResolveRejection: true,
			classification: "ready",
			reasonCode: "ready",
		})
		vi.spyOn(task, "evaluateCompletionHooks").mockResolvedValue({})
		vi.spyOn(task, "presentCompletionResult").mockResolvedValue()
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		vi.spyOn(task, "finalizeTaskCompletion").mockImplementation(async () => {
			Reflect.set(task, "didComplete", true)
			return true
		})

		await Reflect.get(task, "initiateTaskLoop").call(task, [])

		expect(requestStep).toHaveBeenCalledOnce()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(Reflect.get(task, "didComplete")).toBe(true)
	})

	it("keeps a completed turn and its history when post-turn summarization fails", async () => {
		const { task, api, provider, history, save } = harness()
		api.getModel = () => ({
			id: "small-model",
			info: { contextWindow: 1000, maxTokens: 100, supportsPromptCache: false },
		})
		provider.getState.mockResolvedValue({ autoCondenseContext: true, postTurnCondenseContextPercent: 1 })
		vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error("summary provider failed"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			await expect(Reflect.get(task, "maybeCompactAfterTurn").call(task)).resolves.toBeUndefined()
			expect(task.apiConversationHistory).toEqual(history)
			expect(save).not.toHaveBeenCalled()
			expect(warning).toHaveBeenCalledOnce()
		} finally {
			warning.mockRestore()
		}
	})

	it("leaves queued follow-up input ahead of post-turn compaction", async () => {
		const { task, provider, save } = harness()
		vi.mocked(summarizeConversation).mockClear()
		provider.getState.mockResolvedValue({ autoCondenseContext: true, postTurnCondenseContextPercent: 80 })
		task.messageQueueService.addMessage("Follow up now")
		await Reflect.get(task, "maybeCompactAfterTurn").call(task)
		expect(provider.getState).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})

	it("skips post-turn compaction when follow-up input arrives while settings load", async () => {
		const { task, provider, save } = harness()
		const pendingState = deferred<{ autoCondenseContext: boolean; postTurnCondenseContextPercent: number }>()
		provider.getState.mockReturnValue(pendingState.promise)
		vi.mocked(summarizeConversation).mockClear()
		const run = Reflect.get(task, "maybeCompactAfterTurn").call(task)
		task.messageQueueService.addMessage("Use this follow-up")
		pendingState.resolve({ autoCondenseContext: true, postTurnCondenseContextPercent: 80 })
		await run
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})
})

describe("Task context recovery admission", () => {
	it.each([
		["manual", 30],
		["automatic", 30],
		["forced", 30],
		["manual", 35],
		["automatic", 35],
		["forced", 35],
	] as const)(
		"resumes %s compaction below a %i%% working limit after refreshing environment",
		async (trigger, threshold) => {
			const { task, api, provider, history, save } = harness()
			api.getModel = () => ({
				id: "million-token-model",
				info: { contextWindow: 1_000_000, maxTokens: 4096, supportsPromptCache: false },
			})
			provider.getState.mockResolvedValue({ autoCondenseContextPercent: threshold })
			api.countTokens.mockImplementation(async (blocks) => {
				const text = JSON.stringify(blocks)
				if (text.includes("Original request")) return 400_000
				if (text.includes("Earlier conversation")) return 70_000
				if (text.includes("Fresh environment")) return 20_000
				return 1_000
			})
			const result = {
				...compactedResult(history),
				prevContextTokens: 403_000,
				status: "reduced" as const,
				targetContextTokens: (threshold * 10_000) / 4,
			}
			vi.mocked(summarizeConversation).mockResolvedValueOnce(result)
			vi.mocked(manageContext).mockResolvedValueOnce(result)
			vi.mocked(Reflect.get(task, "refreshEnvironmentContext")).mockImplementation(async () => {
				task.apiConversationHistory.push({ role: "user", content: "Fresh environment", ts: 20 })
			})

			await runRecovery(task, trigger)

			expect(save).toHaveBeenCalledOnce()
			expect(task.say).toHaveBeenCalledWith(
				"condense_context",
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				{ isNonInteractive: true },
				expect.objectContaining({ newContextTokens: 93_000 }),
			)
			if (trigger === "automatic") expect(api.createMessage).toHaveBeenCalledOnce()
		},
	)

	it("reports successful automatic fallback without a contradictory compaction failure", async () => {
		const { task, api, history } = harness()
		vi.mocked(manageContext).mockResolvedValueOnce({
			...compactedResult(history),
			summary: "",
			prevContextTokens: 100,
			targetContextTokens: 80,
			status: "reduced",
			truncationId: "fallback-1",
			messagesRemoved: 1,
			error: "Summary provider failed",
		})

		await runRecovery(task, "automatic")

		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(vi.mocked(task.say).mock.calls.map(([type]) => type)).toContain("sliding_window_truncation")
		expect(vi.mocked(task.say).mock.calls.map(([type]) => type)).not.toContain("condense_context_error")
	})

	it.each(["manual", "automatic", "forced"] as const)(
		"continues %s recovery below the global limit despite a lower legacy profile value",
		async (trigger) => {
			const { task, api, provider, history, save } = harness()
			api.getModel = () => ({
				id: "million-token-model",
				info: { contextWindow: 1_000_000, maxTokens: 4096, supportsPromptCache: false },
			})
			provider.getState.mockResolvedValue({ autoCondenseContextPercent: 35, profileThresholds: { default: 30 } })
			api.countTokens.mockImplementation(async (blocks) => {
				const text = JSON.stringify(blocks)
				if (text.includes("Original request")) return 400_000
				if (text.includes("Fresh environment")) return 297_000
				return 1_000
			})
			const result = {
				...compactedResult(history),
				prevContextTokens: 403_000,
				targetContextTokens: 75_000,
				status: "reduced" as const,
			}
			vi.mocked(summarizeConversation).mockResolvedValueOnce(result)
			vi.mocked(manageContext).mockResolvedValueOnce(result)
			vi.mocked(Reflect.get(task, "refreshEnvironmentContext")).mockImplementation(async () => {
				task.apiConversationHistory.push({ role: "user", content: "Fresh environment", ts: 20 })
			})

			await runRecovery(task, trigger)

			const compactionReceipt = vi.mocked(task.say).mock.calls.find(([type]) => type === "condense_context")?.[7]
			expect(compactionReceipt?.newContextTokens).toBeGreaterThan(300_000)
			expect(compactionReceipt?.newContextTokens).toBeLessThan(350_000)
			expect(save).toHaveBeenCalledOnce()
			if (trigger === "automatic") expect(api.createMessage).toHaveBeenCalledOnce()
		},
	)

	it.each(["manual", "automatic", "forced"] as const)(
		"validates active context while preserving a large rewind archive during %s compaction",
		async (trigger) => {
			const { task, api, history, save } = harness()
			history[0].content = "ARCHIVED_ONLY_EVIDENCE".repeat(500)
			const originalContent = history[0].content
			api.countTokens.mockImplementation(async (blocks) =>
				JSON.stringify(blocks).includes("ARCHIVED_ONLY_EVIDENCE") ? 400 : 10,
			)
			const result = {
				...compactedResult(history),
				prevContextTokens: 500,
				status: "reduced" as const,
				targetContextTokens: 80,
			}
			vi.mocked(summarizeConversation).mockResolvedValueOnce(result)
			vi.mocked(manageContext).mockResolvedValueOnce(result)

			await runRecovery(task, trigger)

			expect(save).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory[0]).toMatchObject({
				content: originalContent,
				condenseParent: "summary-1",
			})
			expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
			if (trigger === "automatic") {
				expect(api.createMessage).toHaveBeenCalledOnce()
				expect(JSON.stringify(api.createMessage.mock.calls[0][1])).not.toContain("ARCHIVED_ONLY_EVIDENCE")
			} else expect(api.createMessage).not.toHaveBeenCalled()
		},
	)

	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it("reuses one operation context from newest-message estimation through final compaction measurement", async () => {
		const { task, api, history } = harness()
		const result = {
			...compactedResult(history),
			prevContextTokens: 100,
			targetContextTokens: 80,
			status: "reduced" as const,
		}
		let sharedCountContext: TokenCountContext | undefined
		let sharedCountCalls = 0
		vi.mocked(manageContext).mockImplementationOnce(async (options) => {
			sharedCountContext = options.countContext
			expect(sharedCountContext).toBeDefined()
			const countTokens = sharedCountContext!.countTokens.bind(sharedCountContext)
			vi.spyOn(sharedCountContext!, "countTokens").mockImplementation(async (...args) => {
				sharedCountCalls += 1
				return countTokens(...args)
			})
			const callsBeforeCacheProbe = api.countTokens.mock.calls.length
			await sharedCountContext!.countTokens([{ type: "text", text: "Recent instruction" }], api)
			expect(api.countTokens).toHaveBeenCalledTimes(callsBeforeCacheProbe)
			return result
		})
		const controller = new AbortController()

		await task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				interruptionSignal: controller.signal,
			})
			.next()

		expect(sharedCountContext).toBeDefined()
		expect(sharedCountCalls).toBeGreaterThan(1)
		expect(api.countTokens.mock.calls[0][1]).toMatchObject({
			signal: controller.signal,
			remoteDeadline: expect.any(Number),
		})
	})

	it("cancels a pending newest-message count without compaction or a late history commit", async () => {
		const { task, api, save, history } = harness()
		const countStarted = deferred<void>()
		const countFinished = deferred<number>()
		let countSignal: AbortSignal | undefined
		api.countTokens.mockImplementationOnce((_content, metadata) => {
			countSignal = metadata?.signal
			countStarted.resolve()
			return countFinished.promise
		})
		const controller = new AbortController()
		const running = task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				interruptionSignal: controller.signal,
			})
			.next()
		await countStarted.promise
		expect(countSignal).toBeDefined()
		expect(countSignal?.aborted).toBe(false)

		controller.abort(new Error("Context preparation cancelled"))
		await expect(running).rejects.toThrow("Context preparation cancelled")
		expect(countSignal?.aborted).toBe(true)
		expect(countSignal?.reason).toBe(controller.signal.reason)
		countFinished.resolve(10)
		await Promise.resolve()

		expect(api.countTokens).toHaveBeenCalledOnce()
		expect(manageContext).not.toHaveBeenCalled()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
	})

	it("bounds stalled forced recovery by its retry deadline and closes the started UI boundary", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(1_000)
			const { task, api, provider, save } = harness()
			const recoveryStarted = deferred<void>()
			vi.mocked(manageContext).mockImplementationOnce(async () => {
				recoveryStarted.resolve()
				await new Promise<void>(() => undefined)
				throw new Error("unreachable")
			})

			const running = Reflect.get(task, "handleContextWindowExceededError").call(task, 1_100) as Promise<void>
			const rejected = expect(running).rejects.toMatchObject({
				name: "ApiStreamDeadlineError",
				timeoutScope: "retry_deadline",
			})
			await recoveryStarted.promise
			await vi.advanceTimersByTimeAsync(100)
			await rejected

			expect(api.createMessage).not.toHaveBeenCalled()
			expect(save).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "condenseTaskContextResponse",
				text: task.taskId,
			})
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each(["automatic", "manual", "forced"] as const)(
		"bounds %s compaction by its configured deadline and cancels pending work",
		async (trigger) => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000)
				vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(100)
				const { task, api, provider, save, history } = harness()
				const started = deferred<void>()
				const released = deferred<void>()
				let summarySignal: AbortSignal | undefined
				const summary = async ({ metadata }: { metadata?: ApiHandlerCreateMessageMetadata }) => {
					summarySignal = metadata?.signal
					started.resolve()
					await released.promise
					return {
						...compactedResult(history),
						prevContextTokens: 100,
						targetContextTokens: 80,
						status: "reduced" as const,
					}
				}
				if (trigger === "manual") vi.mocked(summarizeConversation).mockImplementationOnce(summary)
				else vi.mocked(manageContext).mockImplementationOnce(summary)
				let outcome: "pending" | "completed" | "failed" = "pending"
				let failure: unknown
				const running = runRecovery(task, trigger).then(
					() => {
						outcome = "completed"
					},
					(error: unknown) => {
						outcome = "failed"
						failure = error
					},
				)
				await started.promise
				await vi.advanceTimersByTimeAsync(100)
				const outcomeAtDeadline = outcome
				const signalAbortedAtDeadline = summarySignal?.aborted
				released.resolve()
				await running

				expect(outcomeAtDeadline).toBe("failed")
				expect(failure).toMatchObject({ name: "ApiStreamDeadlineError", timeoutScope: "compaction_deadline" })
				expect(signalAbortedAtDeadline).toBe(true)
				expect(api.createMessage).not.toHaveBeenCalled()
				expect(save).not.toHaveBeenCalled()
				expect(task.apiConversationHistory).toBe(history)
				if (trigger !== "manual") {
					expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
						type: "condenseTaskContextResponse",
						text: task.taskId,
					})
				}
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it.each(["automatic", "manual", "forced"] as const)(
		"bounds stalled %s compaction catalog preparation by the same phase deadline",
		async (trigger) => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000)
				vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(100)
				const { task, api, save, history } = harness()
				Reflect.set(task, "getTokenUsage", () => ({ contextTokens: 120_000 }))
				api.countTokens.mockResolvedValue(130_000)
				const actual =
					await vi.importActual<typeof import("../../context-management")>("../../context-management")
				vi.mocked(manageContext).mockImplementationOnce(actual.manageContext)
				const started = deferred<void>()
				const released = deferred<void>()
				let catalogSignal: AbortSignal | undefined
				vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementationOnce(async ({ signal }) => {
					catalogSignal = signal
					started.resolve()
					await released.promise
					return { tools: [] }
				})
				let failure: unknown
				const running = runRecovery(task, trigger).catch((error: unknown) => {
					failure = error
				})
				await started.promise
				await vi.advanceTimersByTimeAsync(100)
				const failureAtDeadline = failure
				const signalAbortedAtDeadline = catalogSignal?.aborted
				released.resolve()
				await running

				expect(failureAtDeadline).toMatchObject({
					name: "ApiStreamDeadlineError",
					timeoutScope: "compaction_deadline",
				})
				expect(signalAbortedAtDeadline).toBe(true)
				expect(summarizeConversation).not.toHaveBeenCalled()
				expect(save).not.toHaveBeenCalled()
				expect(api.createMessage).not.toHaveBeenCalled()
				expect(task.apiConversationHistory).toBe(history)
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it.each(["automatic", "manual", "forced"] as const)(
		"keeps disabled %s timeouts cancellable by Stop without discarding admitted input",
		async (trigger) => {
			vi.useFakeTimers()
			try {
				vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(undefined)
				const { task, api, save, history } = harness()
				const started = deferred<void>()
				const released = deferred<void>()
				let summarySignal: AbortSignal | undefined
				const summary = async ({ metadata }: { metadata?: ApiHandlerCreateMessageMetadata }) => {
					summarySignal = metadata?.signal
					expect(metadata).not.toHaveProperty("deadline")
					started.resolve()
					await released.promise
					return {
						...compactedResult(history),
						prevContextTokens: 100,
						targetContextTokens: 80,
						status: "reduced" as const,
					}
				}
				if (trigger === "manual") vi.mocked(summarizeConversation).mockImplementationOnce(summary)
				else vi.mocked(manageContext).mockImplementationOnce(summary)
				let outcome: "pending" | "completed" | "failed" = "pending"
				let failure: unknown
				const running = runRecovery(task, trigger).then(
					() => {
						outcome = "completed"
					},
					(error: unknown) => {
						outcome = "failed"
						failure = error
					},
				)
				await started.promise
				await vi.advanceTimersByTimeAsync(10_000)
				expect(outcome).toBe("pending")
				expect(summarySignal?.aborted).toBe(false)
				const stopped = new DOMException("Stopped during compaction", "AbortError")
				;(Reflect.get(task, "taskCancellationController") as AbortController).abort(stopped)
				await running
				expect(outcome).toBe("failed")
				expect(failure).toBe(stopped)
				expect(summarySignal?.reason).toBe(stopped)
				released.resolve()
				await Promise.resolve()

				expect(api.createMessage).not.toHaveBeenCalled()
				expect(save).not.toHaveBeenCalled()
				expect(task.apiConversationHistory).toBe(history)
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it.each(["automatic", "manual", "forced"] as const)(
		"joins an owned %s transcript commit before surfacing compaction timeout",
		async (trigger) => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(1_000)
				vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(100)
				const { task, api, save, history } = harness()
				const result = {
					...compactedResult(history),
					prevContextTokens: 100,
					targetContextTokens: 80,
					status: "reduced" as const,
				}
				vi.mocked(manageContext).mockResolvedValueOnce(result)
				vi.mocked(summarizeConversation).mockResolvedValueOnce(result)
				const saveStarted = deferred<void>()
				const saveReleased = deferred<void>()
				const events: string[] = []
				save.mockImplementationOnce(async () => {
					events.push("commit-started")
					saveStarted.resolve()
					await saveReleased.promise
					events.push("commit-finished")
					return true
				})
				let failure: unknown
				const running = runRecovery(task, trigger).catch((error: unknown) => {
					failure = error
					events.push("timeout-reported")
				})
				await saveStarted.promise
				await vi.advanceTimersByTimeAsync(100)
				expect(events).toEqual(["commit-started"])
				expect(failure).toBeUndefined()
				saveReleased.resolve()
				await running

				expect(failure).toMatchObject({ name: "ApiStreamDeadlineError" })
				expect(events).toEqual(["commit-started", "commit-finished", "timeout-reported"])
				expect(task.apiConversationHistory).toEqual(result.messages)
				expect(save).toHaveBeenCalledOnce()
				expect(api.createMessage).not.toHaveBeenCalled()
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it("releases timed-out optional post-turn compaction while preserving the completed turn", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(1_000)
			vi.spyOn(requestTimeout, "getApiRequestTimeout").mockReturnValue(100)
			const { task, api, provider, save, history } = harness()
			provider.getState.mockResolvedValue({ postTurnCondenseContextPercent: 80 })
			api.countTokens.mockImplementation(async (blocks) =>
				JSON.stringify(blocks).includes("Original request") ? 120_000 : 10,
			)
			const started = deferred<void>()
			const released = deferred<void>()
			let summarySignal: AbortSignal | undefined
			vi.mocked(summarizeConversation).mockImplementationOnce(async ({ metadata, messages }) => {
				summarySignal = metadata?.signal
				started.resolve()
				await released.promise
				return compactedResult(messages)
			})
			let completed = false
			const running = (Reflect.get(task, "maybeCompactAfterTurn").call(task) as Promise<void>).then(() => {
				completed = true
			})
			await started.promise
			await vi.advanceTimersByTimeAsync(100)
			const completedAtDeadline = completed
			const signalAbortedAtDeadline = summarySignal?.aborted
			released.resolve()
			await running

			expect(completedAtDeadline).toBe(true)
			expect(signalAbortedAtDeadline).toBe(true)
			expect(Reflect.get(task, "postTurnCompactionAbortController")).toBeUndefined()
			expect(task.apiConversationHistory).toBe(history)
			expect(save).not.toHaveBeenCalled()
			expect(api.createMessage).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("finishes an owned context transcript commit before reporting an expired retry deadline", async () => {
		const { task, api, provider, save, history } = harness()
		let now = 1_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		const saveStarted = deferred<void>()
		const saveRelease = deferred<void>()
		const events: string[] = []
		const result = {
			...compactedResult(history),
			prevContextTokens: 100,
			targetContextTokens: 80,
			status: "reduced" as const,
		}
		vi.mocked(manageContext).mockResolvedValueOnce(result)
		save.mockImplementationOnce(async () => {
			events.push("save-started")
			now = 1_101
			saveStarted.resolve()
			await saveRelease.promise
			events.push("save-committed")
			return true
		})

		const running = Reflect.get(task, "handleContextWindowExceededError").call(task, 1_100) as Promise<void>
		let settled = false
		void running
			.finally(() => {
				settled = true
				events.push("recovery-settled")
			})
			.catch(() => undefined)
		await saveStarted.promise
		await Promise.resolve()
		expect(settled).toBe(false)

		saveRelease.resolve()
		await expect(running).rejects.toThrow("Automatic retry deadline exceeded")
		expect(events).toEqual(["save-started", "save-committed", "recovery-settled"])
		expect(task.apiConversationHistory).toEqual(result.messages)
		expect(save).toHaveBeenCalledOnce()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
	})

	it.each([
		["automatic", "exhausted"],
		["automatic", "no_progress"],
		["forced", "exhausted"],
		["forced", "no_progress"],
	] as const)("stops %s recovery with %s before another provider request", async (trigger, status) => {
		const { task, api, save, history, provider } = harness()
		vi.mocked(willManageContext).mockReturnValue(true)
		vi.mocked(manageContext).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0,
			prevContextTokens: 100,
			status,
		})
		const run =
			trigger === "automatic"
				? task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
				: Reflect.get(task, "handleContextWindowExceededError").call(task)

		await expect(run).rejects.toMatchObject({
			name: "ContextRecoveryExhaustedError",
			retryCategory: "context",
			retryable: false,
		})
		expect(manageContext).toHaveBeenCalledOnce()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
	})

	it("forces recovery below local thresholds and links its summary to rewind and task cancellation", async () => {
		const { task, save, history } = harness()
		const result = { ...compactedResult(history), prevContextTokens: 100, status: "reduced" as const }
		vi.mocked(manageContext).mockResolvedValue(result)

		await Reflect.get(task, "handleContextWindowExceededError").call(task)

		expect(save).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual(result.messages)
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({ totalTokens: 100, contextWindow: 128_000, forceCompaction: true }),
		)
		expect(vi.mocked(manageContext).mock.calls[0][0].metadata).toMatchObject({
			signal: expect.any(AbortSignal),
			deadline: expect.any(Number),
		})
		expect(task.say).toHaveBeenCalledWith(
			"condense_context",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			expect.objectContaining({ condenseId: result.condenseId }),
		)
	})

	it.each(["manual", "automatic", "forced"] as const)(
		"stops %s recovery when refreshed environment details exceed the final context budget",
		async (trigger) => {
			const { task, api, history } = harness()
			const result = {
				...compactedResult(history),
				prevContextTokens: 100,
				targetContextTokens: 80,
				status: "reduced" as const,
			}
			vi.mocked(summarizeConversation).mockResolvedValue(result)
			vi.mocked(manageContext).mockResolvedValue(result)
			api.countTokens.mockImplementation(async (blocks) =>
				blocks.some((block) => block.type === "text" && block.text.includes("Fresh environment")) ? 1000 : 10,
			)
			const replacementCountTokens = vi.fn<ApiHandler["countTokens"]>(async () => 0)
			Reflect.set(
				task,
				"refreshEnvironmentContext",
				vi.fn(async () => {
					task.apiConversationHistory.push({ role: "user", content: "Fresh environment", ts: 11 })
					task.api = { ...api, countTokens: replacementCountTokens }
				}),
			)

			await expect(runRecovery(task, trigger)).rejects.toMatchObject({
				name: "ContextRecoveryExhaustedError",
				retryable: false,
			})

			expect(api.createMessage).not.toHaveBeenCalled()
			expect(replacementCountTokens).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
			expect(trigger === "manual" ? summarizeConversation : manageContext).toHaveBeenCalledOnce()
		},
	)

	it("dispatches and retries with the measured provider when refresh selects a smaller model", async () => {
		const { task, api, history } = harness()
		const model = api.getModel()
		vi.spyOn(api, "getModel").mockReturnValue({
			...model,
			info: { ...model.info, supportsImages: true, preserveReasoning: true },
		})
		task.apiConfiguration = { apiProvider: "vscode-lm", apiModelId: "test-model" }
		Reflect.set(task, "effectiveApiConfiguration", { ...task.apiConfiguration })
		const reasoning = { type: "reasoning", text: "Exact continuation reasoning" }
		Object.assign(history[1], {
			content: [reasoning, { type: "text", text: "Recent answer" }],
			vscodeLmStatefulMarker: "captured-vscode-state",
		})
		const image: Anthropic.Messages.ImageBlockParam = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "retained-image" },
		}
		history[2].content = [{ type: "text", text: "Recent instruction" }, image]
		const replacement: ApiHandler = {
			getModel: () => ({
				id: "narrow-model",
				info: { contextWindow: 20, maxTokens: 5, supportsImages: false, supportsPromptCache: false },
			}),
			countTokens: vi.fn(async () => 1),
			createMessage: vi.fn(async function* () {
				yield { type: "text" as const, text: "Wrong provider" }
			}),
		}
		Object.assign(task, {
			refreshEnvironmentContext: vi.fn(async () => {
				task.apiConversationHistory.push({ role: "user", content: "Fresh environment", ts: 11 })
				task.api = replacement
				task.apiConfiguration = { apiProvider: "vertex", apiModelId: "narrow-model" }
				Reflect.set(task, "effectiveApiConfiguration", { ...task.apiConfiguration })
			}),
		})
		vi.mocked(manageContext).mockImplementation(async ({ prepareTools }) => {
			await prepareTools?.()
			return {
				...compactedResult(history),
				prevContextTokens: 100,
				targetContextTokens: 80,
				status: "reduced",
			}
		})
		api.createMessage.mockImplementation(async function* () {
			yield { type: "text", text: "Original provider response" }
		})
		api.createMessage.mockImplementationOnce(async function* () {
			yield* []
			throw new Error("Original provider transport failure")
		})
		const firstAttempt = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const firstResult = await firstAttempt.next().catch((error: unknown) => error)
		await firstAttempt.return(undefined)
		expect(firstResult).toMatchObject({ message: "Original provider transport failure" })
		expect(replacement.createMessage).not.toHaveBeenCalled()
		expect(replacement.countTokens).not.toHaveBeenCalled()
		const firstStep = Reflect.get(task, "currentAgentStep") as { snapshot: AgentStepSnapshot<ApiHandler, unknown> }
		expect(firstStep.snapshot.runtime.getHandler()).toBe(api)
		expect(firstStep.snapshot.context.provider).toMatchObject({
			apiProvider: "vscode-lm",
			modelId: "test-model",
			options: { apiProvider: "vscode-lm", apiModelId: "test-model" },
		})
		expect(firstStep.snapshot.context.budget.contextWindow).toBe(128_000)
		const firstCall = api.createMessage.mock.calls[0]
		expect(
			firstCall[1].flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
		).toContainEqual(image)
		expect(firstCall[1]).toContainEqual({
			role: "assistant",
			content: [reasoning, { type: "text", text: "Recent answer" }],
			vscodeLmStatefulMarker: "captured-vscode-state",
		})
		expect(firstCall[2]?.taskId).toBe(task.taskId)
		const tokenCountsBeforeRetry = api.countTokens.mock.calls.length
		const retry = task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "transport",
		})
		expect(await retry.next()).toEqual({ done: false, value: { type: "text", text: "Original provider response" } })
		expect(await retry.next()).toEqual({ done: true, value: undefined })
		expect(manageContext).toHaveBeenCalledOnce()
		expect(api.countTokens).toHaveBeenCalledTimes(tokenCountsBeforeRetry)
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		expect(replacement.createMessage).not.toHaveBeenCalled()
		expect(api.createMessage.mock.calls[1][1]).toEqual(firstCall[1])
		expect(api.createMessage.mock.calls[1][2]?.requestId).toBe(firstCall[2]?.requestId)
		expect(api.createMessage.mock.calls[1][2]?.attemptId).not.toBe(firstCall[2]?.attemptId)
		expect(api.createMessage.mock.calls[1][2]?.signal).not.toBe(firstCall[2]?.signal)
		expect(Reflect.get(task, "currentAgentStep").snapshot.runtime.getHandler()).toBe(api)
	})

	it("counts and dispatches standalone encrypted reasoning after compaction", async () => {
		const { task, api, history } = harness()
		const reasoning = {
			type: "reasoning" as const,
			encrypted_content: "exact-encrypted-continuation",
			id: "reasoning-1",
			summary: [],
		}
		history.splice(2, 0, { role: "assistant", content: [], ts: 2.5, ...reasoning })
		vi.mocked(manageContext).mockResolvedValue({
			...compactedResult(history),
			prevContextTokens: 100,
			targetContextTokens: 80,
			status: "reduced",
		})
		api.createMessage.mockImplementation(async function* () {
			yield { type: "text", text: "Reasoning continuation" }
		})
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })

		expect(await request.next()).toEqual({ done: false, value: { type: "text", text: "Reasoning continuation" } })
		expect(await request.next()).toEqual({ done: true, value: undefined })

		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(api.createMessage.mock.calls[0][1]).toContainEqual(reasoning)
		expect(
			api.countTokens.mock.calls.some(([blocks]) => JSON.stringify(blocks).includes(reasoning.encrypted_content)),
		).toBe(true)
	})

	it("uses captured model and settings when prompt generation awaits a mode lookup", async () => {
		const { task, api, provider } = harness()
		const model = api.getModel()
		vi.spyOn(api, "getModel").mockReturnValue({ ...model, info: { ...model.info, isStealthModel: false } })
		const configuration: ProviderSettings = { apiProvider: "vertex", todoListEnabled: true }
		task.apiConfiguration = configuration
		Reflect.set(task, "effectiveApiConfiguration", { ...configuration })
		Object.assign(provider, { context: {}, getSkillsManager: () => undefined })
		Reflect.set(
			task,
			"getTaskMode",
			vi.fn(async () => {
				task.api = {
					...api,
					getModel: () => ({ id: "replacement-model", info: { ...model.info, isStealthModel: true } }),
				}
				task.apiConfiguration = { apiProvider: "vertex", todoListEnabled: false }
				Reflect.set(task, "effectiveApiConfiguration", { ...task.apiConfiguration })
				return "code"
			}),
		)

		await expect(
			Reflect.get(Task.prototype, "getSystemPrompt").call(
				task,
				{ mcpEnabled: false },
				{
					apiHandler: api,
					apiConfiguration: configuration,
				},
			),
		).resolves.toBe("Captured provider prompt")

		expect(vi.mocked(SYSTEM_PROMPT_FRAGMENTS).mock.calls[0][12]).toMatchObject({
			todoListEnabled: true,
			isStealthModel: false,
		})
		expect(vi.mocked(SYSTEM_PROMPT_FRAGMENTS).mock.calls[0][14]).toBe("test-model")
	})

	it("reports the command backend shell used by a captured prompt step", async () => {
		const { task, api, provider } = harness()
		Object.assign(provider, { context: {}, getSkillsManager: () => undefined })
		vi.spyOn(BaseTerminal, "getExecaShellPath").mockReturnValue("configured-command-shell")

		await expect(
			Reflect.get(Task.prototype, "getSystemPrompt").call(
				task,
				{ mcpEnabled: false, terminalShellIntegrationDisabled: true },
				{ apiHandler: api, apiConfiguration: { apiProvider: "vertex" } },
			),
		).resolves.toBe("Captured provider prompt")

		expect(vi.mocked(SYSTEM_PROMPT_FRAGMENTS).mock.lastCall?.[12]).toMatchObject({
			commandShell: "configured-command-shell",
		})
	})

	it.each([
		["Code", "code", undefined, undefined, true, "Implement a TypeScript change and run tests."],
		["Plan", "architect", undefined, undefined, true, "Implement a TypeScript change and run tests."],
		[
			"disabled delegation",
			"code",
			["spawn_agent"],
			undefined,
			false,
			"Implement a TypeScript change and run tests.",
		],
		[
			"model excluded delegation",
			"code",
			undefined,
			["spawn_agent"],
			false,
			"Implement a TypeScript change and run tests.",
		],
		["lookup request", "code", undefined, undefined, true, "Where is retryLimit defined?"],
	] as const)(
		"advertises the pinned root role only with a callable spawn_agent tool in %s",
		async (_case, mode, disabledTools, excludedTools, expected, requestText) => {
			const { task, api, provider } = harness()
			Object.assign(provider, { context: {}, getSkillsManager: () => undefined })
			Reflect.set(task, "shouldExposeAgentLifecycleTools", () => true)
			Reflect.set(
				task,
				"getTaskMode",
				vi.fn(async () => mode),
			)
			Reflect.set(task, "getUserRequestTextForCatalog", () => requestText)
			if (excludedTools) {
				const model = api.getModel()
				vi.spyOn(api, "getModel").mockReturnValue({
					...model,
					info: { ...model.info, excludedTools: [...excludedTools] },
				})
			}

			await expect(
				Reflect.get(Task.prototype, "getSystemPrompt").call(
					task,
					{ mcpEnabled: false, ...(disabledTools ? { disabledTools: [...disabledTools] } : {}) },
					{ apiHandler: api, apiConfiguration: { apiProvider: "vertex" } },
				),
			).resolves.toBe("Captured provider prompt")

			expect(vi.mocked(SYSTEM_PROMPT_FRAGMENTS).mock.lastCall?.[12]).toMatchObject({
				codexRootDelegationAvailable: expected,
			})
		},
	)

	it.each([
		["manual", 60],
		["manual", 100],
		["automatic", 60],
		["automatic", 100],
		["forced", 60],
		["forced", 100],
	] as const)(
		"stops %s recovery when refreshed environment tokens (%s) undo its reduction",
		async (trigger, environmentTokens) => {
			const { task, api, history } = harness()
			const result = {
				...compactedResult(history),
				prevContextTokens: 100,
				targetContextTokens: 200,
				status: "reduced" as const,
			}
			vi.mocked(manageContext).mockResolvedValue(result)
			vi.mocked(summarizeConversation).mockResolvedValue(result)
			api.countTokens.mockImplementation(async (blocks) =>
				JSON.stringify(blocks).includes("Fresh environment")
					? environmentTokens
					: JSON.stringify(blocks).includes("Original request")
						? 60
						: 10,
			)
			Reflect.set(
				task,
				"refreshEnvironmentContext",
				vi.fn(async () => {
					task.apiConversationHistory.push({ role: "user", content: "Fresh environment", ts: 11 })
				}),
			)

			await expect(runRecovery(task, trigger)).rejects.toMatchObject({
				name: "ContextRecoveryExhaustedError",
				retryable: false,
			})

			expect(trigger === "manual" ? summarizeConversation : manageContext).toHaveBeenCalledOnce()
			expect(api.createMessage).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
		},
	)

	it("rejects a compacted request when the final tool catalog grows beyond its measured budget", async () => {
		const { task, api, history } = harness()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "read_file",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "read_file",
					description: "expanded-final-schema".repeat(100),
					parameters: { type: "object", properties: {} },
				},
			},
			capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
			execute: async () => {},
		})
		const surface = createTaskToolSurface({ registry, applyProfile: false })
		vi.mocked(buildNativeToolsArrayWithRestrictions)
			.mockResolvedValueOnce({ tools: [], surface })
			.mockResolvedValueOnce({ tools: [...surface.schemas], surface })
		vi.mocked(manageContext).mockImplementation(async ({ prepareTools }) => {
			await prepareTools?.()
			return {
				...compactedResult(history),
				prevContextTokens: 100,
				targetContextTokens: 80,
				status: "reduced",
			}
		})
		api.countTokens.mockImplementation(async (blocks) =>
			JSON.stringify(blocks).includes("expanded-final-schema") ? 1000 : 10,
		)

		await expect(runRecovery(task, "automatic")).rejects.toMatchObject({
			name: "ContextRecoveryExhaustedError",
			retryable: false,
		})

		expect(manageContext).toHaveBeenCalledOnce()
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(2)
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(Reflect.get(task, "currentAgentStep")).toBeUndefined()
		expect(
			api.countTokens.mock.calls.some(([blocks]) => JSON.stringify(blocks).includes("expanded-final-schema")),
		).toBe(true)
	})

	it.each([
		["manual", "vertex"],
		["automatic", "vertex"],
		["forced", "openai"],
	] as const)("uses the task catalog for %s compaction on %s", async (trigger, apiProvider) => {
		const { task, api, history } = harness()
		task.apiConfiguration = { apiProvider }
		Reflect.set(task, "effectiveApiConfiguration", { ...task.apiConfiguration })
		const tools = [
			{
				type: "function" as const,
				function: { name: "read_file", description: "Visible task tool", parameters: { type: "object" } },
			},
		]
		const allowedFunctionNames = apiProvider === "openai" ? undefined : ["read_file"]
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
			tools,
			allowedFunctionNames,
			surface: createTaskToolSurface({
				registry: new ToolRegistry({ includeBuiltIns: false }),
				applyProfile: false,
				approvalMode: "auto",
			}),
		})
		vi.mocked(summarizeConversation).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0,
			error: "No reduction",
		})
		vi.mocked(manageContext).mockImplementation(async ({ prepareTools }) => {
			await prepareTools?.()
			return {
				messages: history,
				summary: "",
				cost: 0,
				prevContextTokens: 100,
				status: "exhausted",
			}
		})

		if (trigger === "manual") await runRecovery(task, trigger)
		else await expect(runRecovery(task, trigger)).rejects.toMatchObject({ name: "ContextRecoveryExhaustedError" })

		const promptCall = vi.mocked(Reflect.get(task, "getSystemPrompt"))
		expect(promptCall.mock.calls[0][0]).toEqual(expect.anything())
		expect(promptCall.mock.calls[0][1]).toEqual({
			apiHandler: api,
			apiConfiguration: task.apiConfiguration,
		})
		if (trigger !== "forced") {
			expect(promptCall.mock.calls[0][3]).toBe("code")
			expect(promptCall.mock.calls[0][4]).toEqual(expect.any(Function))
		}
		if (trigger === "automatic") expect(promptCall.mock.calls[0][2]).toBeNull()
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledWith(
			expect.objectContaining({
				catalogCache: Reflect.get(task, "toolCatalogCache"),
				discoveryHistory: history,
				includeAllToolsWithRestrictions: apiProvider !== "openai",
			}),
		)
		const options =
			trigger === "manual"
				? vi.mocked(summarizeConversation).mock.calls[0][0]
				: vi.mocked(manageContext).mock.calls[0][0]
		expect(options.metadata?.tools).toBe(tools)
		expect(options.metadata?.allowedFunctionNames).toEqual(allowedFunctionNames)
		expect(options.environmentDetails).toBeUndefined()
	})
	it.each([
		[20_000, true],
		[200_000, false],
	] as const)(
		"checks final schema overhead %s against the safe limit after failed proactive summary",
		async (finalTokens, fits) => {
			const { task, api, history, provider } = harness()
			provider.getState.mockResolvedValue({ autoCondenseContextPercent: 5 })
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register({
				name: "read_file",
				aliases: [],
				schema: {
					type: "function",
					function: {
						name: "read_file",
						description: "expanded-after-failed-summary",
						parameters: { type: "object", properties: {} },
					},
				},
				capabilities: {
					concurrency: "serial",
					sideEffects: "none",
					controlFlow: false,
					requiresApproval: false,
				},
				execute: async () => {},
			})
			const surface = createTaskToolSurface({ registry, applyProfile: false, approvalMode: "auto" })
			vi.mocked(buildNativeToolsArrayWithRestrictions)
				.mockResolvedValueOnce({ tools: [], surface })
				.mockResolvedValueOnce({ tools: [...surface.schemas], surface })
			vi.mocked(manageContext).mockImplementation(async ({ prepareTools }) => {
				await prepareTools?.()
				return {
					messages: history,
					summary: "",
					cost: 0.01,
					prevContextTokens: 100,
					newContextTokens: 100,
					error: "Summary unavailable",
					status: "unchanged",
				}
			})
			api.countTokens.mockImplementation(async (blocks) =>
				JSON.stringify(blocks).includes("expanded-after-failed-summary") ? finalTokens : 10,
			)
			const running = runRecovery(task, "automatic")
			if (fits) {
				await running
				expect(api.createMessage).toHaveBeenCalledOnce()
			} else {
				await expect(running).rejects.toMatchObject({ name: "ContextRecoveryExhaustedError", retryable: false })
				expect(api.createMessage).not.toHaveBeenCalled()
			}
			expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(2)
			expect(
				api.countTokens.mock.calls.some(([blocks]) =>
					JSON.stringify(blocks).includes("expanded-after-failed-summary"),
				),
			).toBe(true)
			expect(task.apiConversationHistory).toBe(history)
		},
	)

	it("requests the next model step after a fitting proactive summary failure", async () => {
		const { task, api, save, history, provider } = harness()
		vi.mocked(manageContext).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0.01,
			prevContextTokens: 100,
			newContextTokens: 100,
			error: "Summary provider unavailable",
			status: "unchanged",
		})
		await task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
		expect(manageContext).toHaveBeenCalledOnce()
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
		expect(task.say).toHaveBeenCalledWith(
			"condense_context_error",
			"Summary provider unavailable",
			undefined,
			false,
			undefined,
			undefined,
			expect.objectContaining({ contextCondenseErrorCost: 0.01 }),
		)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
	})
	it.each([60_000, 200_000])(
		"dispatches after actual proactive summary failure with reported usage %s",
		async (contextTokens) => {
			const { task, api, save, history, provider } = harness()
			const { TelemetryService } = await import("@alpha-code/telemetry")
			if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
			const actualContext =
				await vi.importActual<typeof import("../../context-management")>("../../context-management")
			const actualCondense = await vi.importActual<typeof import("../../condense")>("../../condense")
			vi.mocked(manageContext).mockImplementation(actualContext.manageContext)
			vi.mocked(summarizeConversation).mockImplementation(actualCondense.summarizeConversation)
			provider.getState.mockResolvedValue({ autoCondenseContext: true, autoCondenseContextPercent: 5 })
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens } as ReturnType<Task["getTokenUsage"]>)
			history[1].content = "Earlier implementation details. ".repeat(1500)
			api.countTokens.mockImplementation(async (blocks) => Math.ceil(JSON.stringify(blocks).length / 4))
			api.createMessage
				.mockImplementationOnce(async function* () {
					yield { type: "usage", inputTokens: 1, outputTokens: 1, totalCost: 0.01 }
					throw new Error("Summary provider unavailable")
				})
				.mockImplementationOnce(async function* () {
					yield { type: "text", text: "Continue implementing the remaining requirements." }
				})
			const received: string[] = []
			for await (const chunk of task.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
			})) {
				if (chunk.type === "text") received.push(chunk.text)
			}
			expect(api.createMessage).toHaveBeenCalledTimes(2)
			expect(received).toContain("Continue implementing the remaining requirements.")
			expect(save).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toBe(history)
			const result = await vi.mocked(manageContext).mock.results[0].value
			expect(result.errorDetails).toContain("Summary provider unavailable")
			expect(task.say).toHaveBeenCalledWith(
				"condense_context_error",
				result.error,
				undefined,
				false,
				undefined,
				undefined,
				expect.objectContaining({ contextCondenseErrorCost: 0.01 }),
			)
		},
	)
})
