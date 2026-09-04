import type { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import type { AgentResponse } from "../../agent/AgentResponse"
import type { ToolSchedulerOutcome } from "../../agent/ToolScheduler"
import { summarizeConversation, type SummarizeResponse } from "../../condense"
import { manageContext, willManageContext } from "../../context-management"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

vi.mock("../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn(async () => "") }))
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
		countTokens: vi.fn<ApiHandler["countTokens"]>(async () => 10),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {}),
	} satisfies ApiHandler
	const provider = {
		getState: vi.fn(async () => ({})),
		postMessageToWebview: vi.fn(async () => {}),
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
		api,
		apiConfiguration: { apiProvider: "anthropic" } satisfies ProviderSettings,
		providerRef: { deref: () => provider },
		apiConversationHistory: history,
		toolCatalogCache: new TaskToolCatalogCache(),
		userMessageContent: [],
		clineMessages: [],
		getTaskMode: vi.fn(async () => "code"),
		getCurrentProfileId: vi.fn(async () => "default"),
		getSystemPrompt: vi.fn(async () => "System prompt"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 100 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		getFilesReadByRooSafely: vi.fn(async () => undefined),
		environmentContext: { reset: vi.fn() },
		refreshEnvironmentContext: vi.fn(async () => {}),
		saveApiConversationHistory: save,
		say: vi.fn(async () => undefined),
		emit: vi.fn(),
		messageQueueService: new MessageQueueService(),
		beginCanonicalLifecycleTurn: vi.fn(async () => {}),
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
		surface: createTaskToolSurface({ registry: new ToolRegistry({ includeBuiltIns: false }), applyProfile: false }),
	})
	vi.mocked(summarizeConversation).mockImplementation(async ({ messages }) => compactedResult(messages))
	return { task, api, provider, save, history }
}

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

describe("Task manual compaction boundary", () => {
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
		expect(outcome.results).toMatchObject([{ callId: call.id, status: "success", content: "Actual file content" }])
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
			await expect(task.recursivelyMakeClineRequests([])).rejects.toThrow("Context compaction is in progress")
			const runStep = vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
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

describe("Task context recovery admission", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

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
		expect(task.apiConversationHistory).toBe(result.messages)
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({ totalTokens: 100, contextWindow: 128_000, forceCompaction: true }),
		)
		expect(vi.mocked(manageContext).mock.calls[0][0].metadata?.signal).toBe(
			task.getTaskLifetimeCancellationSignal(),
		)
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

	it.each([
		["manual", "gemini"],
		["automatic", "vertex"],
		["forced", "anthropic"],
	] as const)("uses the task catalog for %s compaction on %s", async (trigger, apiProvider) => {
		const { task, history } = harness()
		task.apiConfiguration = { apiProvider }
		const tools = [
			{
				type: "function" as const,
				function: { name: "read_file", description: "Visible task tool", parameters: { type: "object" } },
			},
		]
		const allowedFunctionNames = apiProvider === "anthropic" ? undefined : ["read_file"]
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
			tools,
			allowedFunctionNames,
			surface: createTaskToolSurface({
				registry: new ToolRegistry({ includeBuiltIns: false }),
				applyProfile: false,
			}),
		})
		vi.mocked(summarizeConversation).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0,
			error: "No reduction",
		})
		vi.mocked(manageContext).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0,
			prevContextTokens: 100,
			status: "exhausted",
		})

		if (trigger === "manual") await runRecovery(task, trigger)
		else await expect(runRecovery(task, trigger)).rejects.toMatchObject({ name: "ContextRecoveryExhaustedError" })

		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledWith(
			expect.objectContaining({
				catalogCache: Reflect.get(task, "toolCatalogCache"),
				discoveryHistory: history,
				includeAllToolsWithRestrictions: apiProvider !== "anthropic",
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
})
