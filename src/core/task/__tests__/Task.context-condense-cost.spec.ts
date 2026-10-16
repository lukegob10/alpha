import { TelemetryService } from "@alpha-code/telemetry"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { summarizeConversation, type SummarizeResponse } from "../../condense"
import { manageContext } from "../../context-management"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

// Module mocks retain their last implementation under Vitest 4 unless explicitly reset.
beforeEach(() => {
	vi.resetAllMocks()
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
})

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
		clineMessages: [],
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

function runRecovery(task: Task, trigger: "manual" | "automatic" | "forced") {
	if (trigger === "manual") return task.condenseContext()
	if (trigger === "automatic")
		return task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
	return Reflect.get(task, "handleContextWindowExceededError").call(task) as Promise<void>
}

describe("failed summary cost receipts", () => {
	function captureRows(task: Task) {
		task.clineMessages = [
			{ ts: 1, type: "say", say: "text", text: "Original task" },
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 100, tokensOut: 20, cost: 2 }),
			},
		]
		vi.mocked(task.say).mockImplementation(
			async (say, text, images, partial, _checkpoint, _progress, options, contextCondense, contextTruncation) => {
				task.clineMessages.push({
					ts: task.clineMessages.length + 1,
					type: "say",
					say,
					text,
					images,
					partial,
					contextCondense,
					contextTruncation,
					...(options?.contextCondenseErrorCost === undefined
						? {}
						: { contextCondenseErrorCost: options.contextCondenseErrorCost }),
				})
				return undefined
			},
		)
		Reflect.set(
			task,
			"addToAlphaMessages",
			vi.fn(async (message: import("@alpha-code/types").AlphaMessage) => {
				task.clineMessages.push(message)
			}),
		)
		Reflect.set(
			task,
			"saveAlphaMessages",
			vi.fn(async () => true),
		)
		Reflect.set(
			task,
			"updateAlphaMessage",
			vi.fn(async () => undefined),
		)
	}
	function verifyFailure(task: Task, expectedCost = 2.01) {
		const rows = task.clineMessages
		const failureRows = rows.filter((row) => row.say === "condense_context_error")
		expect(failureRows).toHaveLength(1)
		expect(failureRows[0]).toMatchObject({ text: "Summary unavailable" })
		expect(failureRows[0].contextCondenseErrorCost).toBeCloseTo(expectedCost - 2)
		expect(rows.some((row) => row.say === "condense_context")).toBe(false)
		expect(Task.prototype.getTokenUsage.call(task)).toMatchObject({
			totalCost: expectedCost,
			contextTokens: 120,
			totalTokensIn: 100,
			totalTokensOut: 20,
		})
		task.clineMessages = JSON.parse(JSON.stringify(rows))
		expect(Task.prototype.getTokenUsage.call(task)).toMatchObject({ totalCost: expectedCost, contextTokens: 120 })
	}
	it.each(["manual", "automatic"] as const)(
		"charges %s returned failures without changing provider history",
		async (trigger) => {
			const { task, api, history, save } = harness()
			const unchanged = {
				messages: history,
				summary: "",
				cost: 0.01,
				prevContextTokens: 100,
				newContextTokens: 100,
				error: "Summary unavailable",
				status: "unchanged" as const,
			}
			vi.mocked(summarizeConversation).mockResolvedValue(unchanged)
			vi.mocked(manageContext).mockResolvedValue(unchanged)
			captureRows(task)
			await runRecovery(task, trigger)
			verifyFailure(task)
			expect(task.apiConversationHistory).toBe(history)
			expect(save).not.toHaveBeenCalled()
			expect(api.createMessage).toHaveBeenCalledTimes(trigger === "automatic" ? 1 : 0)
		},
	)
	it("charges two returned manual failures independently across reload", async () => {
		const { task, history } = harness()
		vi.mocked(summarizeConversation)
			.mockResolvedValueOnce({ messages: history, summary: "", cost: 0.01, error: "First summary unavailable" })
			.mockResolvedValueOnce({ messages: history, summary: "", cost: 0.01, error: "Second summary unavailable" })
		captureRows(task)
		await runRecovery(task, "manual")
		task.clineMessages = JSON.parse(JSON.stringify(task.clineMessages))
		await runRecovery(task, "manual")
		const failures = task.clineMessages.filter((row) => row.say === "condense_context_error")
		expect(failures).toHaveLength(2)
		expect(failures.map((row) => row.contextCondenseErrorCost)).toEqual([0.01, 0.01])
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.02)
		expect(Task.prototype.getTokenUsage.call(task).contextTokens).toBe(120)
	})
	it.each(["automatic", "forced"] as const)(
		"charges %s successful fallback without a contradictory error row",
		async (trigger) => {
			const { task, history } = harness()
			vi.mocked(manageContext).mockResolvedValueOnce({
				...compactedResult(history),
				summary: "",
				cost: 0.01,
				prevContextTokens: 100,
				targetContextTokens: 80,
				status: "reduced",
				truncationId: "fallback-1",
				messagesRemoved: 1,
				error: "Summary unavailable",
			})
			captureRows(task)
			await runRecovery(task, trigger)
			const fallbacks = task.clineMessages.filter((row) => row.say === "sliding_window_truncation")
			expect(fallbacks).toHaveLength(1)
			expect(fallbacks[0]).toMatchObject({
				contextCondenseErrorCost: 0.01,
				contextTruncation: { truncationId: "fallback-1" },
			})
			expect(
				task.clineMessages.some(
					(row) => row.say === "condense_context_error" || row.say === "condense_context",
				),
			).toBe(false)
			expect(Task.prototype.getTokenUsage.call(task)).toMatchObject({ totalCost: 2.01, contextTokens: 120 })
		},
	)
	it("charges a fitting nonreducing proactive summary as unchanged without a false error receipt", async () => {
		const { task, api, history, save } = harness()
		vi.mocked(manageContext).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0.01,
			prevContextTokens: 120,
			newContextTokens: 120,
			status: "unchanged",
		})
		captureRows(task)
		await runRecovery(task, "automatic")
		const receipts = task.clineMessages.filter((row) => row.say === "condense_context")
		expect(receipts).toHaveLength(1)
		expect(receipts[0]).toMatchObject({
			contextCondense: {
				outcome: "unchanged",
				cost: 0.01,
				summary: "",
				prevContextTokens: 120,
				newContextTokens: 120,
			},
		})
		expect(
			task.clineMessages.some(
				(row) => row.say === "condense_context_error" || row.contextCondenseErrorCost !== undefined,
			),
		).toBe(false)
		expect(Task.prototype.getTokenUsage.call(task)).toMatchObject({ totalCost: 2.01, contextTokens: 120 })
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toBe(history)
		expect(save).not.toHaveBeenCalled()
	})
	it.each(["manual", "automatic", "forced"] as const)(
		"does not double charge %s successful reduction",
		async (trigger) => {
			const { task, history } = harness()
			const result = {
				...compactedResult(history),
				cost: 0.01,
				prevContextTokens: 100,
				targetContextTokens: 80,
				status: "reduced" as const,
			}
			vi.mocked(summarizeConversation).mockResolvedValue(result)
			vi.mocked(manageContext).mockResolvedValue(result)
			captureRows(task)
			await runRecovery(task, trigger)
			expect(task.clineMessages.filter((row) => row.say === "condense_context")).toHaveLength(1)
			expect(
				task.clineMessages.some(
					(row) => row.say === "condense_context_error" || row.contextCondenseErrorCost !== undefined,
				),
			).toBe(false)
			expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
		},
	)
	it.each([
		["automatic", "no_progress"],
		["automatic", "exhausted"],
		["forced", "no_progress"],
		["forced", "exhausted"],
	] as const)("charges %s/%s before terminal recovery guard", async (trigger, status) => {
		const { task, api, history, save } = harness()
		vi.mocked(manageContext).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0.01,
			prevContextTokens: 100,
			error: "Summary unavailable",
			status,
		})
		captureRows(task)
		await expect(runRecovery(task, trigger)).rejects.toMatchObject({
			name: "ContextRecoveryExhaustedError",
			retryable: false,
		})
		verifyFailure(task)
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(history)
	})
	it.each(["manual", "automatic", "forced"] as const)(
		"does not invent %s failure cost for a thrown cancellation",
		async (trigger) => {
			const { task } = harness()
			const cancelled = new Error("Summary cancelled")
			cancelled.name = "AbortError"
			vi.mocked(summarizeConversation).mockRejectedValue(cancelled)
			vi.mocked(manageContext).mockRejectedValue(cancelled)
			captureRows(task)
			await expect(runRecovery(task, trigger)).rejects.toMatchObject({ name: "AbortError" })
			expect(task.clineMessages.some((row) => row.contextCondenseErrorCost !== undefined)).toBe(false)
			expect(Task.prototype.getTokenUsage.call(task).totalCost).toBe(2)
		},
	)
	function gate<T>() {
		let resolve!: (value: T) => void
		const promise = new Promise<T>((done) => {
			resolve = done
		})
		return { promise, resolve }
	}
	function verifyKnownCancelledCost(task: Task, history: ApiMessage[]) {
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
		expect(Task.prototype.getTokenUsage.call(task).contextTokens).toBe(120)
		expect(task.clineMessages.some((row) => row.say === "condense_context")).toBe(false)
		expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
		expect(task.apiConversationHistory).toBe(history)
		task.clineMessages = JSON.parse(JSON.stringify(task.clineMessages))
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
	}
	it("preserves observed summary cost and original cancellation during a stalled stream", async () => {
		const { task, api, history, provider, save } = harness()
		const actual = await vi.importActual<typeof import("../../condense")>("../../condense")
		vi.mocked(summarizeConversation).mockImplementation(actual.summarizeConversation)
		provider.getState.mockResolvedValue({ autoCondenseContextPercent: 5 })
		history[1].content = "Earlier implementation detail. ".repeat(1_500)
		api.countTokens.mockImplementation(async (blocks) => Math.ceil(JSON.stringify(blocks).length / 4))
		const afterUsage = gate<void>()
		const stalled = gate<IteratorResult<import("../../../api/transform/stream").ApiStreamChunk>>()
		let calls = 0
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		api.createMessage.mockReturnValue({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					if (calls++ === 0)
						return {
							done: false,
							value: { type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.01 },
						}
					afterUsage.resolve()
					return stalled.promise
				},
				return: close,
			}),
		} as unknown as ReturnType<ApiHandler["createMessage"]>)
		captureRows(task)
		task.say = Task.prototype.say.bind(task)
		const reason = new DOMException("User cancelled after summary usage", "AbortError")
		const pending = task.condenseContext()
		const rejected = expect(pending).rejects.toBe(reason)
		await Promise.race([
			afterUsage.promise,
			pending.then(() => {
				throw new Error("Summary completed before the usage barrier")
			}),
		])
		task.abort = true
		Reflect.get(task, "taskCancellationController").abort(reason)
		await rejected
		expect(close).toHaveBeenCalledOnce()
		expect(save).not.toHaveBeenCalled()
		verifyKnownCancelledCost(task, history)
	})
	it("preserves observed cost when cancellation interrupts final summary token counting", async () => {
		const { task, api, history, provider, save } = harness()
		const actual = await vi.importActual<typeof import("../../condense")>("../../condense")
		vi.mocked(summarizeConversation).mockImplementation(actual.summarizeConversation)
		provider.getState.mockResolvedValue({ autoCondenseContextPercent: 5 })
		history[1].content = "Earlier implementation detail. ".repeat(1_500)
		const atCandidateCount = gate<void>()
		const releaseCount = gate<void>()
		api.countTokens.mockImplementation(async (blocks) => {
			if (
				blocks.some(
					(block) =>
						block.type === "text" && block.text.startsWith("## Conversation Summary\nComplete summary."),
				)
			) {
				atCandidateCount.resolve()
				await releaseCount.promise
			}
			return Math.ceil(JSON.stringify(blocks).length / 4)
		})
		api.createMessage.mockImplementation(async function* () {
			yield { type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.01 }
			yield { type: "text", text: "Complete summary." }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		captureRows(task)
		task.say = Task.prototype.say.bind(task)
		const reason = new DOMException("User cancelled during final count", "AbortError")
		const pending = task.condenseContext()
		const rejected = expect(pending).rejects.toBe(reason)
		try {
			await Promise.race([
				atCandidateCount.promise,
				pending.then(() => {
					throw new Error("Summary completed before final count")
				}),
			])
			task.abort = true
			Reflect.get(task, "taskCancellationController").abort(reason)
			await rejected
		} finally {
			releaseCount.resolve()
		}
		expect(save).not.toHaveBeenCalled()
		verifyKnownCancelledCost(task, history)
	})
	it.each(["repeated", "backward"] as const)(
		"cancellation cost receipts preserve command IDs and archived timestamp bounds under a %s clock",
		async (clockMode) => {
			const { task, history, save } = harness()
			captureRows(task)
			task.clineMessages.push(
				{ ts: 9_000, type: "ask", ask: "command", text: "echo retained", isAnswered: true },
				{
					ts: 9_001,
					type: "say",
					say: "command_output",
					text: "retained output",
					partial: false,
					commandExecutionId: "9000",
				},
			)
			Reflect.set(task, "lastMessageTs", 9_100)
			let now = 1_000
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
			try {
				// Allocate through actual say, then remove the row as a rewind/archive would.
				// The retained high-water must still protect its ID after the wall clock moves.
				await Task.prototype.say.call(
					task,
					"text",
					"Archived receipt",
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
				const archived = task.clineMessages.pop()!
				expect(archived.ts).toBeGreaterThan(9_100)
				const retained = JSON.parse(JSON.stringify(task.clineMessages))
				const inputBoundary = Reflect.get(task, "lastMessageTs")
				let persisted = ""
				const saveReceipt = vi.fn(async () => {
					persisted = JSON.stringify(task.clineMessages)
					return true
				})
				Reflect.set(task, "saveAlphaMessages", saveReceipt)
				task.say = Task.prototype.say.bind(task)
				const reason = new DOMException("Cancelled after known summary usage", "AbortError")
				vi.mocked(summarizeConversation).mockImplementation(async (options) => {
					options.observeCost?.(0.01)
					now = clockMode === "backward" ? 250 : 1_000
					task.abort = true
					Reflect.get(task, "taskCancellationController").abort(reason)
					throw reason
				})
				await expect(task.condenseContext()).rejects.toBe(reason)
				expect(task.clineMessages.slice(0, retained.length)).toEqual(retained)
				const receipts = task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)
				expect(receipts).toHaveLength(1)
				expect(receipts[0]).toMatchObject({
					type: "say",
					say: "condense_context_error",
					contextCondenseErrorCost: 0.01,
				})
				expect(receipts[0].ts).toBeGreaterThan(archived.ts)
				expect(new Set(task.clineMessages.map((row) => row.ts)).size).toBe(task.clineMessages.length)
				expect(Reflect.get(task, "lastMessageTs")).toBe(inputBoundary)
				expect(task.clineMessages.find((row) => row.say === "command_output")).toMatchObject({
					ts: 9_001,
					commandExecutionId: "9000",
					text: "retained output",
					partial: false,
				})
				expect(saveReceipt).toHaveBeenCalledOnce()
				expect(save).not.toHaveBeenCalled()
				expect(JSON.parse(persisted)).toEqual(task.clineMessages)
				verifyKnownCancelledCost(task, history)
				task.clineMessages = JSON.parse(persisted)
				expect(Task.prototype.getTokenUsage.call(task)).toMatchObject({ totalCost: 2.01, contextTokens: 120 })
				expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
			} finally {
				clock.mockRestore()
			}
		},
	)
	it.each(["exhausted high-water", "nonfinite clock"] as const)(
		"preserves original cancellation when receipt allocation fails due to %s",
		async (failure) => {
			const { task, history } = harness()
			captureRows(task)
			task.clineMessages.push({
				ts: failure === "exhausted high-water" ? Number.MAX_VALUE : 9_001,
				type: "say",
				say: "command_output",
				text: "retained output",
				partial: false,
				commandExecutionId: "9000",
			})
			Reflect.set(task, "lastMessageTs", 9_100)
			const retained = JSON.parse(JSON.stringify(task.clineMessages))
			const saveReceipt = vi.fn(async () => true)
			Reflect.set(task, "saveAlphaMessages", saveReceipt)
			let now = 1_000
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			const reason = new DOMException("Cancelled after known summary usage", "AbortError")
			vi.mocked(summarizeConversation).mockImplementation(async (options) => {
				options.observeCost?.(0.01)
				if (failure === "nonfinite clock") now = Infinity
				task.abort = true
				Reflect.get(task, "taskCancellationController").abort(reason)
				throw reason
			})
			try {
				await expect(task.condenseContext()).rejects.toBe(reason)
				expect(task.clineMessages).toEqual(retained)
				expect(task.clineMessages.some((row) => row.contextCondenseErrorCost !== undefined)).toBe(false)
				expect(saveReceipt).not.toHaveBeenCalled()
				expect(warning).toHaveBeenCalledWith(
					"Unable to persist observed context compaction cost during failure cleanup.",
				)
				expect(Reflect.get(task, "lastMessageTs")).toBe(9_100)
				expect(task.apiConversationHistory).toBe(history)
			} finally {
				warning.mockRestore()
				clock.mockRestore()
			}
		},
	)
	it("surfaces receipt allocation failure when cleanup has no earlier error", async () => {
		const { task } = harness()
		captureRows(task)
		task.clineMessages.push({ ts: Number.MAX_VALUE, type: "say", say: "text", text: "Retained high-water" })
		Reflect.set(task, "lastMessageTs", 9_100)
		const retained = JSON.parse(JSON.stringify(task.clineMessages))
		const saveReceipt = vi.fn(async () => true)
		Reflect.set(task, "saveAlphaMessages", saveReceipt)
		const createAccounting = Reflect.get(task, "createContextCondenseAccounting")
		expect(typeof createAccounting).toBe("function")
		const accounting = createAccounting.call(task) as {
			observeCost: (cost: number) => void
			persistUnreportedCost: (preserveError: boolean) => Promise<void>
		}
		accounting.observeCost(0.01)
		await expect(accounting.persistUnreportedCost(false)).rejects.toThrow(
			"Unable to allocate a unique UI message timestamp.",
		)
		expect(task.clineMessages).toEqual(retained)
		expect(saveReceipt).not.toHaveBeenCalled()
		expect(Reflect.get(task, "lastMessageTs")).toBe(9_100)
	})
	it("charges a returned failed summary before rejecting a concurrent transcript replacement", async () => {
		const { task, history } = harness()
		vi.mocked(summarizeConversation).mockImplementation(async () => {
			task.apiConversationHistory = [...history, { role: "user", content: "New externally retained history" }]
			return { messages: history, summary: "", cost: 0.01, error: "Summary unavailable", status: "no_progress" }
		})
		captureRows(task)
		await expect(task.condenseContext()).rejects.toThrow("Conversation history changed during context compaction")
		expect(task.apiConversationHistory).not.toBe(history)
		expect(task.apiConversationHistory.at(-1)?.content).toBe("New externally retained history")
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
		expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
		expect(task.clineMessages.some((row) => row.say === "condense_context")).toBe(false)
	})
	it("charges a returned failed summary before rejecting an expired manual deadline", async () => {
		const { task, history } = harness()
		let now = Date.now()
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
		vi.mocked(summarizeConversation).mockImplementation(async () => {
			now += 1_000_000
			return { messages: history, summary: "", cost: 0.01, error: "Summary unavailable", status: "no_progress" }
		})
		captureRows(task)
		try {
			await expect(task.condenseContext()).rejects.toThrow(/deadline|timed out/i)
			expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
			expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
			expect(task.clineMessages.some((row) => row.say === "condense_context")).toBe(false)
		} finally {
			clock.mockRestore()
		}
	})
	it.each(["false", "throw"] as const)(
		"preserves original cancellation and one receipt if final save returns %s",
		async (failure) => {
			const { task } = harness()
			const reason = new DOMException("Cancelled after observed usage", "AbortError")
			vi.mocked(summarizeConversation).mockImplementation(async (options) => {
				options.observeCost?.(0.01)
				throw reason
			})
			captureRows(task)
			const saveReceipt =
				failure === "throw"
					? vi.fn(async () => {
							throw new Error("Disk unavailable")
						})
					: vi.fn(async () => false)
			Reflect.set(task, "saveAlphaMessages", saveReceipt)
			await expect(task.condenseContext()).rejects.toBe(reason)
			expect(saveReceipt).toHaveBeenCalledOnce()
			expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
			expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
		},
	)
	it.each(["false", "throw"] as const)(
		"closes forced recovery UI and preserves terminal error when receipt save returns %s",
		async (failure) => {
			const { task, history, provider } = harness()
			vi.mocked(manageContext).mockResolvedValue({
				messages: history,
				summary: "",
				cost: 0.01,
				prevContextTokens: 100,
				error: "Summary unavailable",
				status: "no_progress",
			})
			captureRows(task)
			Reflect.set(
				task,
				"saveAlphaMessages",
				failure === "throw"
					? vi.fn(async () => {
							throw new Error("Disk unavailable")
						})
					: vi.fn(async () => false),
			)
			await expect(runRecovery(task, "forced")).rejects.toMatchObject({
				name: "ContextRecoveryExhaustedError",
				retryable: false,
			})
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "condenseTaskContextResponse",
				text: task.taskId,
			})
			expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
			expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
		},
	)
	it("confirms normal receipt durability even when the first Task.say save returns false", async () => {
		const { task, history } = harness()
		vi.mocked(summarizeConversation).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0.01,
			error: "Summary unavailable",
		})
		captureRows(task)
		const saveReceipt = vi.fn(async () => true).mockResolvedValueOnce(false)
		Reflect.set(task, "saveAlphaMessages", saveReceipt)
		Reflect.set(
			task,
			"addToAlphaMessages",
			vi.fn(async (row: import("@alpha-code/types").AlphaMessage) => {
				task.clineMessages.push(row)
				await saveReceipt()
			}),
		)
		task.say = Task.prototype.say.bind(task)
		await task.condenseContext()
		expect(saveReceipt).toHaveBeenCalledTimes(2)
		expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
	})
	it.each(["false", "throw"] as const)(
		"closes proactive recovery UI when final receipt save returns %s without an earlier error",
		async (failure) => {
			const { task, history, provider, api } = harness()
			vi.mocked(manageContext).mockResolvedValue({
				messages: history,
				summary: "",
				cost: 0.01,
				prevContextTokens: 100,
				newContextTokens: 100,
				error: "Summary unavailable",
				status: "unchanged",
			})
			captureRows(task)
			Reflect.set(
				task,
				"saveAlphaMessages",
				failure === "throw"
					? vi.fn(async () => {
							throw new Error("Disk unavailable")
						})
					: vi.fn(async () => false),
			)
			await expect(runRecovery(task, "automatic")).rejects.toThrow(/persist.*compaction cost|Disk unavailable/i)
			expect(api.createMessage).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "condenseTaskContextResponse",
				text: task.taskId,
			})
			expect(task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)).toHaveLength(1)
		},
	)
	it("recognizes a preexisting partial error finalized by this attempt as its single receipt", async () => {
		const { task, history } = harness()
		vi.mocked(summarizeConversation).mockResolvedValue({
			messages: history,
			summary: "",
			cost: 0.01,
			error: "Summary unavailable",
		})
		captureRows(task)
		task.clineMessages.push({
			ts: 3,
			type: "say",
			say: "condense_context_error",
			text: "Summarizing",
			partial: true,
		})
		task.say = Task.prototype.say.bind(task)
		await task.condenseContext()
		const receipts = task.clineMessages.filter((row) => row.contextCondenseErrorCost !== undefined)
		expect(receipts).toHaveLength(1)
		expect(receipts[0]).toMatchObject({ ts: 3, partial: false, contextCondenseErrorCost: 0.01 })
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
	})
	it("treats the latest valid zero-cost report as authoritative", async () => {
		const { task, history } = harness()
		vi.mocked(summarizeConversation).mockImplementation(async (options) => {
			options.observeCost?.(0.01)
			options.observeCost?.(0)
			return { messages: history, summary: "", cost: 0, error: "Summary unavailable" }
		})
		captureRows(task)
		await task.condenseContext()
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBe(2)
		expect(task.clineMessages.some((row) => row.contextCondenseErrorCost !== undefined)).toBe(false)
	})
	it.each([false, true])(
		"manual compaction termination joins its cost save before replacement (settles before abort join: %s)",
		async (earlySettlement) => {
			vi.useFakeTimers()
			try {
				const { task } = harness()
				captureRows(task)
				Reflect.set(
					task,
					"finishCanonicalLifecycleCancellation",
					vi.fn(async () => undefined),
				)
				Reflect.set(task, "canonicalLifecycleQueue", Promise.resolve())
				Reflect.set(
					task,
					"flushApiConversationHistoryPersistence",
					vi.fn(async () => undefined),
				)
				const finalUsage = vi.fn()
				Reflect.set(task, "emitFinalTokenUsageUpdate", finalUsage)
				const summaryEntered = gate<void>()
				const saving = gate<void>()
				const releaseSave = gate<void>()
				let persisted = structuredClone(task.clineMessages)
				const events: string[] = []
				vi.mocked(summarizeConversation).mockImplementation((options) => {
					options.observeCost?.(0.01)
					summaryEntered.resolve()
					return new Promise<never>((_resolve, reject) => {
						const signal = options.metadata!.signal!
						if (signal.aborted) reject(signal.reason)
						else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					})
				})
				Reflect.set(
					task,
					"saveAlphaMessages",
					vi.fn(async () => {
						events.push("cost-save-started")
						saving.resolve()
						await releaseSave.promise
						persisted = structuredClone(task.clineMessages)
						events.push("cost-save-committed")
						return true
					}),
				)
				const summary = task.condenseContext()
				const cancelled = expect(summary).rejects.toThrow("Current task request was cancelled")
				await summaryEntered.promise
				task.abort = true
				task.cancelCurrentRequest()
				await saving.promise
				await expect(task.condenseContext()).rejects.toThrow("Context compaction is already in progress")
				let terminationFinished = false
				const abortFence = gate<void>()
				const cancellation = task["captureTaskCancellationBoundary"]()
				const termination = task["finalizeTerminationAfterAbort"](abortFence.promise, cancellation).then(() => {
					terminationFinished = true
					events.push("termination-finished")
				}) as Promise<void>
				if (!earlySettlement) abortFence.resolve()
				// Drain current microtasks under the fake scheduler; the held save is the only pending owner.
				await vi.advanceTimersByTimeAsync(0)
				try {
					expect(terminationFinished).toBe(false)
				} finally {
					releaseSave.resolve()
				}
				await cancelled
				if (earlySettlement) {
					await vi.advanceTimersByTimeAsync(0)
					abortFence.resolve()
				}
				await termination
				expect(finalUsage).toHaveBeenCalledOnce()
				expect(events).toEqual(["cost-save-started", "cost-save-committed", "termination-finished"])
				task.clineMessages = JSON.parse(JSON.stringify(persisted))
				expect(Task.prototype.getTokenUsage.call(task).totalCost).toBeCloseTo(2.01)
			} finally {
				vi.useRealTimers()
			}
		},
	)
	it.each([false, undefined])("actual say persists a completed cost receipt (partial: %s)", async (partial) => {
		const { task } = harness()
		const add = vi.fn(async (message: import("@alpha-code/types").AlphaMessage) => {
			task.clineMessages.push(message)
		})
		Reflect.set(task, "addToAlphaMessages", add)
		await Task.prototype.say.call(
			task,
			"condense_context_error",
			"Summary unavailable",
			undefined,
			partial,
			undefined,
			undefined,
			{ isNonInteractive: true, contextCondenseErrorCost: 0.01 },
		)
		expect(add).toHaveBeenCalledOnce()
		expect(task.clineMessages[0]).toMatchObject({ say: "condense_context_error", contextCondenseErrorCost: 0.01 })
	})
	it("actual say finalizes a previous partial error with exactly one cost receipt", async () => {
		const { task } = harness()
		task.clineMessages = [
			{ ts: 1, type: "say", say: "text", text: "Original task" },
			{ ts: 2, type: "say", say: "condense_context_error", text: "Summarizing", partial: true },
		]
		Reflect.set(
			task,
			"saveAlphaMessages",
			vi.fn(async () => undefined),
		)
		Reflect.set(
			task,
			"updateAlphaMessage",
			vi.fn(async () => undefined),
		)
		const add = vi.fn(async () => undefined)
		Reflect.set(task, "addToAlphaMessages", add)
		await Task.prototype.say.call(
			task,
			"condense_context_error",
			"Summary unavailable",
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true, contextCondenseErrorCost: 0.01 },
		)
		expect(add).not.toHaveBeenCalled()
		expect(task.clineMessages).toHaveLength(2)
		expect(task.clineMessages[1]).toMatchObject({ partial: false, contextCondenseErrorCost: 0.01 })
		expect(Task.prototype.getTokenUsage.call(task).totalCost).toBe(0.01)
	})
	it.each([
		["text", false, 0.01],
		["condense_context", false, 0.01],
		["condense_context_error", true, 0.01],
		["condense_context_error", false, -1],
		["condense_context_error", false, Infinity],
	] as const)("actual say rejects misplaced/invalid failure cost: %s/%s/%s", async (say, partial, cost) => {
		const { task } = harness()
		const add = vi.fn(async () => undefined)
		Reflect.set(task, "addToAlphaMessages", add)
		await expect(
			Task.prototype.say.call(task, say, "Summary unavailable", undefined, partial, undefined, undefined, {
				isNonInteractive: true,
				contextCondenseErrorCost: cost,
			}),
		).rejects.toThrow("Failed summary cost requires a completed error or truncation message")
		expect(add).not.toHaveBeenCalled()
	})

	it("allows the next manual request immediately after an original summary rejection", async () => {
		const { task, history } = harness()
		const reason = new Error("Summary provider failed")
		vi.mocked(summarizeConversation)
			.mockRejectedValueOnce(reason)
			.mockResolvedValueOnce({ messages: history, summary: "", cost: 0.01, error: "Summary unavailable" })
		captureRows(task)
		let failure: unknown
		try {
			await task.condenseContext()
		} catch (error) {
			failure = error
		}
		expect(failure).toBe(reason)
		await task.condenseContext()
		expect(summarizeConversation).toHaveBeenCalledTimes(2)
		verifyFailure(task)
	})
})
