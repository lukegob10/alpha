import type Anthropic from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Task } from "../Task"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import {
	readCompletionHookConfig,
	runLifecycleHooks,
	type CompletionHookConfig,
	type CompletionHookPromptProvenance,
	type LifecycleHookOutcome,
} from "../../agent/CompletionHooks"

vi.mock("../../agent/CompletionHooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(),
	runLifecycleHooks: vi.fn(),
}))

const command = { command: process.execPath }
const configuration: CompletionHookConfig = {
	stop: [],
	subagentStop: [],
	sessionStart: [command],
	subagentStart: [command],
	userPromptSubmit: [command],
}

function fixture(overrides: Record<string, unknown> = {}) {
	const history: ApiMessage[] = []
	const order: string[] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "lifecycle-task",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		providerRef: { deref: vi.fn(() => undefined) },
		taskCancellationController: new AbortController(),
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		clineMessages: [],
		apiConversationHistory: history,
		userMessageContent: [],
		consecutiveMistakeLimit: 0,
		mergePendingToolResultsIntoUserContent: vi.fn((content: Anthropic.Messages.ContentBlockParam[]) => content),
		includeQueuedToolReplyContent: vi.fn((content: Anthropic.Messages.ContentBlockParam[]) => content),
		lifecycleHookStartSource: "startup",
		lifecycleHookStartConsumed: false,
		submittedLifecycleHookBlocks: new WeakSet(),
		inputBlockOrigins: new WeakMap(),
		pendingLifecycleHookContexts: [],
		currentAgentStep: { turnId: "turn-1", snapshot: { context: { provider: { modelId: "fixture-model" } } } },
		completionHookTranscriptPath: vi.fn(async () => null),
		requireAlphaMessagesSaved: vi.fn(async () => {
			order.push("save-compaction-receipt")
		}),
		enqueueAlphaMessagesSave: vi.fn(async () => {
			order.push("save-compaction-receipt")
			return true
		}),
		getStepApprovalMode: vi.fn(() => "ask"),
		say: vi.fn(async () => undefined),
		publishLifecycleHookMessage: vi.fn(async () => undefined),
		flushPendingToolResultsToHistory: vi.fn(async () => {
			order.push("tool-receipts")
			return true
		}),
		flushApiConversationHistoryPersistence: vi.fn(async () => {
			order.push("history-fence")
		}),
		stageApiUserMessage: vi.fn((message: ApiMessage) => {
			order.push("stage-context")
			history.push(message)
		}),
		saveApiConversationHistory: vi.fn(async () => {
			order.push("save-context")
			return true
		}),
		...overrides,
	}) as Task
	return { task, history, order }
}

function human(task: Task, text: string): Anthropic.TextBlockParam {
	const block: Anthropic.TextBlockParam = { type: "text", text }
	task["captureInputBlockOrigins"]([block], "human")
	return block
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(readCompletionHookConfig).mockReturnValue(configuration)
	vi.mocked(runLifecycleHooks).mockResolvedValue({ warnings: [] })
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("task lifecycle hook admission and provenance", () => {
	it("runs SessionStart before the first human submit, then deduplicates retained retry blocks", async () => {
		const { task } = fixture()
		const block = human(task, "Original human request")
		const signal = new AbortController().signal
		await task["inspectLifecycleHookInput"]([block], signal)
		await task["inspectLifecycleHookInput"]([block], signal)
		const correction = human(task, "New human steering")
		await task["inspectLifecycleHookInput"]([block, correction], signal)

		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"UserPromptSubmit",
		])
		expect(vi.mocked(runLifecycleHooks).mock.calls[1][1]).toMatchObject({ prompt: "Original human request" })
		expect(vi.mocked(runLifecycleHooks).mock.calls[2][1]).toMatchObject({ prompt: "New human steering" })
		expect(readCompletionHookConfig).toHaveBeenCalledOnce()
	})

	it("resubmits the same raw human block after cancelled hook admission, then deduplicates success", async () => {
		const { task } = fixture({ completionHookConfig: { stop: [], subagentStop: [], userPromptSubmit: [command] } })
		const block = human(task, "Retained original human request")
		let finish!: (outcome: LifecycleHookOutcome) => void
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		vi.mocked(runLifecycleHooks).mockImplementationOnce(async () => {
			entered()
			return new Promise<LifecycleHookOutcome>((resolve) => {
				finish = resolve
			})
		})
		const cancelled = new AbortController()
		const first = task["inspectLifecycleHookInput"]([block], cancelled.signal)
		await started
		cancelled.abort(new Error("Steering interrupted hook admission"))
		finish({ warnings: [] })
		await first

		await task["inspectLifecycleHookInput"]([block], new AbortController().signal)
		await task["inspectLifecycleHookInput"]([block], new AbortController().signal)
		expect(runLifecycleHooks).toHaveBeenCalledTimes(2)
		for (const [, request] of vi.mocked(runLifecycleHooks).mock.calls) {
			expect(request).toMatchObject({
				hook_event_name: "UserPromptSubmit",
				prompt: "Retained original human request",
			})
		}
	})

	it("keeps agent/tool/hook input out of UserPromptSubmit", async () => {
		const { task } = fixture()
		const content: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "text", text: "Agent steering is not human input" },
			{ type: "tool_result", tool_use_id: "call-1", content: "Tool output" },
		]
		task["captureInputBlockOrigins"](content, "agent")
		await task["inspectLifecycleHookInput"](content, new AbortController().signal)

		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"SessionStart",
		])
	})

	it("uses resume source and dispatches SubagentStart only for user-created managed children", async () => {
		const { task: resumed } = fixture({ lifecycleHookStartSource: "resume" })
		await resumed["inspectLifecycleHookInput"]([], new AbortController().signal)
		expect(vi.mocked(runLifecycleHooks).mock.calls[0][1]).toMatchObject({
			hook_event_name: "SessionStart",
			source: "resume",
		})
		vi.mocked(runLifecycleHooks).mockClear()

		const { task: child } = fixture({
			taskKind: "subagent",
			parentTaskId: "parent",
			subagentGroupId: "group",
			subagentRole: "review",
		})
		await child["inspectLifecycleHookInput"]([], new AbortController().signal)
		expect(vi.mocked(runLifecycleHooks).mock.calls[0][1]).toMatchObject({
			hook_event_name: "SubagentStart",
			session_id: "parent",
			agent_id: "lifecycle-task",
			agent_type: "review",
		})
		vi.mocked(runLifecycleHooks).mockClear()
		const { task: internal } = fixture({ taskKind: "subagent" })
		await internal["inspectLifecycleHookInput"]([], new AbortController().signal)
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it("honors a session-start stop before admitting prompt submission", async () => {
		const { task } = fixture()
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			shouldStop: true,
			stopReason: "Session stopped",
			warnings: [],
		})
		expect(
			await task["inspectLifecycleHookInput"]([human(task, "Original")], new AbortController().signal),
		).toMatchObject({ shouldStop: true, stopReason: "Session stopped" })
		expect(runLifecycleHooks).toHaveBeenCalledOnce()
	})

	it("drops late hook context and control output when cancellation wins", async () => {
		const { task, history } = fixture()
		let finish!: (outcome: LifecycleHookOutcome) => void
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		vi.mocked(runLifecycleHooks).mockImplementation(async () => {
			entered()
			return new Promise<LifecycleHookOutcome>((resolve) => {
				finish = resolve
			})
		})
		const controller = new AbortController()
		const pending = task["inspectLifecycleHookInput"]([human(task, "Original")], controller.signal)
		await started
		controller.abort()
		finish({
			shouldStop: true,
			additionalContext: [{ hook_run_id: "late-run", text: "Late context" }],
			warnings: ["Late warning"],
		})

		expect(await pending).toEqual({ warnings: [] })
		await task["persistLifecycleHookContexts"]()
		expect(history).toEqual([])
		expect(task.say).not.toHaveBeenCalled()
		expect(task["publishLifecycleHookMessage"]).not.toHaveBeenCalled()
	})

	it("cancels transcript lookup before dispatching a lifecycle command", async () => {
		let finishLookup!: (path: string | null) => void
		const lookup = new Promise<string | null>((resolve) => {
			finishLookup = resolve
		})
		const { task } = fixture({ completionHookTranscriptPath: vi.fn(() => lookup) })
		const controller = new AbortController()
		const running = task["runTaskLifecycleHook"](
			{ hook_event_name: "SessionStart", source: "startup" },
			controller.signal,
		)
		controller.abort(new Error("Cancelled while resolving transcript"))
		finishLookup(null)

		await expect(running).rejects.toThrow("Cancelled while resolving transcript")
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it("discards hook context and control when cancellation wins a warning save", async () => {
		let finishWarning!: () => void
		let warningEntered!: () => void
		const warningSaving = new Promise<void>((resolve) => {
			warningEntered = resolve
		})
		const warningBarrier = new Promise<void>((resolve) => {
			finishWarning = resolve
		})
		const { task, history } = fixture({
			publishLifecycleHookMessage: vi.fn(async () => {
				warningEntered()
				await warningBarrier
			}),
		})
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			warnings: ["Hook warning"],
			shouldStop: true,
			stopReason: "Stale stop",
			additionalContext: [{ hook_run_id: "cancelled-warning-run", text: "Stale context" }],
		})
		const controller = new AbortController()
		const running = task["runTaskLifecycleHook"](
			{ hook_event_name: "SessionStart", source: "startup" },
			controller.signal,
		)
		await warningSaving
		controller.abort(new Error("Cancelled while saving warning"))
		finishWarning()

		expect(await running).toEqual({ warnings: [] })
		await task["persistLifecycleHookContexts"]()
		expect(history).toEqual([])
	})

	it("suppresses hook dispatch for an abandoned task or a replaced transcript owner", async () => {
		for (const overrides of [{ abandoned: true }, { isCurrentApiConversationHistoryOwner: vi.fn(() => false) }]) {
			const { task } = fixture(overrides)
			const running = task["runTaskLifecycleHook"](
				{ hook_event_name: "SessionStart", source: "startup" },
				new AbortController().signal,
			)
			if (overrides.isCurrentApiConversationHistoryOwner) {
				await expect(running).rejects.toMatchObject({ name: "AbortError" })
			} else await running
			expect(task["completionHookTranscriptPath"]).not.toHaveBeenCalled()
		}
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it("persists bounded hook context only after tool receipts with explicit agent provenance", async () => {
		const { task, history, order } = fixture()
		for (let index = 0; index < 20; index++) {
			task["queueLifecycleHookContext"]("PostToolUse", [{ hook_run_id: `run-${index}`, text: "X".repeat(2_000) }])
		}
		await task["persistLifecycleHookContexts"]()

		expect(history.length).toBeLessThanOrEqual(16)
		expect(
			history.reduce(
				(total, message) =>
					total +
					(typeof message.content === "string"
						? message.content.length
						: JSON.stringify(message.content).length),
				0,
			),
		).toBeLessThan(17_000)
		expect(order[0]).toBe("tool-receipts")
		expect(order.at(-1)).toBe("save-context")
		for (const message of history) {
			expect(message).toMatchObject({
				role: "user",
				input_origin: "agent",
				hook_prompt: { event: "PostToolUse" },
			})
		}
		await task["persistLifecycleHookContexts"]()
		expect(task["saveApiConversationHistory"]).toHaveBeenCalledOnce()
	})

	it("fails closed before staging when tool receipts cannot persist", async () => {
		const { task, history } = fixture()
		task["queueLifecycleHookContext"]("PreToolUse", [{ hook_run_id: "run-1", text: "Context" }])
		vi.mocked(task["flushPendingToolResultsToHistory"]).mockResolvedValue(false)

		await expect(task["persistLifecycleHookContexts"]()).rejects.toThrow("tool receipts")
		expect(history).toEqual([])
		expect(task["saveApiConversationHistory"]).not.toHaveBeenCalled()
	})

	it("retries a failed context save without staging the hook input twice", async () => {
		const { task, history } = fixture()
		task["queueLifecycleHookContext"]("PreToolUse", [{ hook_run_id: "run-1", text: "Context" }])
		vi.mocked(task["saveApiConversationHistory"]).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

		await expect(task["persistLifecycleHookContexts"]()).rejects.toThrow("lifecycle hook context")
		await task["persistLifecycleHookContexts"]()
		expect(history).toHaveLength(1)
		expect(task["stageApiUserMessage"]).toHaveBeenCalledOnce()
		expect(task["saveApiConversationHistory"]).toHaveBeenCalledTimes(2)
	})

	it("durably disposes a rejected queued delivery before its callback and queue acknowledgment", async () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("ORIGINAL_BLOCKED_PROMPT", undefined, "blocked-queued-input")!
		queue.claimMessage(message.id)
		const { task, history } = fixture({ messageQueueService: queue })
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [], userPromptSubmit: [command] })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			shouldStop: true,
			stopReason: "Rejected by installed hook",
			warnings: [],
			stopProvenance: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: "actual-hook-run", text: "Rejected by installed hook" }],
			},
		})
		let release!: () => void
		let entered!: () => void
		const saving = new Promise<void>((resolve) => {
			entered = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const persisted: ApiMessage[][] = []
		Object.assign(task, {
			addToApiConversationHistory: vi.fn(
				async (
					entry: ApiMessage,
					_reasoning: unknown,
					onPersisted?: () => void,
					_allowAborted?: boolean,
					hook_prompt?: CompletionHookPromptProvenance,
				) => {
					const staged: ApiMessage = { ...entry, ...(hook_prompt ? { hook_prompt } : {}) }
					history.push(staged)
					entered()
					await barrier
					persisted.push(structuredClone(history))
					onPersisted?.()
					return true
				},
			),
			retrySaveApiConversationHistory: vi.fn(async () => false),
		})
		const onDisposed = vi.fn(async () => {
			expect(persisted).toHaveLength(1)
			expect(queue.getClaimedMessageIds()).toEqual([message.id])
		})
		const content = task["buildUserMessageContent"](message.text, undefined, [message.id])
		const running = task.runAgentRequests(content, false, onDisposed, { queuedMessageIds: [message.id] })
		try {
			await Promise.race([
				saving,
				running.then(() => {
					throw new Error("Request completed before its rejection receipt save")
				}),
			])
			expect(onDisposed).not.toHaveBeenCalled()
			expect(queue.getClaimedMessageIds()).toEqual([message.id])
		} finally {
			release()
		}
		expect(await running).toMatchObject({ status: "awaiting-user", reason: "Rejected by installed hook" })
		expect(onDisposed).toHaveBeenCalledOnce()
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(queue.hasUnconsumedInput()).toBe(false)
		expect(persisted[0].at(-1)).toMatchObject({
			role: "user",
			input_origin: "agent",
			queued_message_ids: [message.id],
			hook_prompt: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: "actual-hook-run", text: "Rejected by installed hook" }],
			},
		})
		expect(JSON.stringify(persisted)).not.toContain("ORIGINAL_BLOCKED_PROMPT")
	})

	it("retains a rejected queued delivery and suppresses admission callbacks when its receipt save fails", async () => {
		const queue = new MessageQueueService()
		const message = queue.addMessage("RECOVERABLE_BLOCKED_PROMPT", undefined, "failed-rejection-receipt")!
		queue.claimMessage(message.id)
		const { task, history } = fixture({ messageQueueService: queue })
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [], userPromptSubmit: [command] })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			shouldStop: true,
			stopReason: "Rejected by installed hook",
			warnings: [],
			stopProvenance: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: "actual-hook-run", text: "Rejected by installed hook" }],
			},
		})
		Object.assign(task, {
			addToApiConversationHistory: vi.fn(async (entry: ApiMessage) => {
				history.push(entry)
				return false
			}),
			retrySaveApiConversationHistory: vi.fn(async () => false),
		})
		const onDisposed = vi.fn()
		const content = task["buildUserMessageContent"](message.text, undefined, [message.id])

		await expect(
			task.runAgentRequests(content, false, onDisposed, { queuedMessageIds: [message.id] }),
		).rejects.toThrow("persist the user turn")
		expect(onDisposed).not.toHaveBeenCalled()
		expect(queue.getClaimedMessageIds()).toEqual([message.id])
		expect(queue.visibleMessages).toContainEqual(
			expect.objectContaining({ text: "RECOVERABLE_BLOCKED_PROMPT", deliveryState: "delivering" }),
		)
		expect(history).toEqual([])
	})

	it("disposes every uncommitted queued input in a blocked original-and-steering envelope", async () => {
		const queue = new MessageQueueService()
		const original = queue.addMessage("BLOCKED_ORIGINAL", undefined, "original-claim")!
		const steer = queue.addMessage("BLOCKED_STEER", undefined, "steer-claim")!
		queue.claimMessage(original.id)
		queue.claimMessage(steer.id)
		const onOriginalDisposed = vi.fn()
		const onSteerDisposed = vi.fn()
		const { task, history } = fixture({
			messageQueueService: queue,
			resetMistakeRecoveryState: vi.fn(),
			pendingSteerMessage: {
				text: steer.text,
				queuedMessageIds: [steer.id],
				inputOrigin: "human",
				onPersisted: onSteerDisposed,
			},
		})
		vi.mocked(readCompletionHookConfig).mockReturnValue({ stop: [], subagentStop: [], userPromptSubmit: [command] })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			shouldStop: true,
			stopReason: "Input envelope rejected",
			warnings: [],
			stopProvenance: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: "envelope-run", text: "Input envelope rejected" }],
			},
		})
		Object.assign(task, {
			addToApiConversationHistory: vi.fn(
				async (
					entry: ApiMessage,
					_reasoning: unknown,
					onPersisted?: () => void,
					_allowAborted?: boolean,
					hook_prompt?: CompletionHookPromptProvenance,
				) => {
					history.push({ ...entry, ...(hook_prompt ? { hook_prompt } : {}) })
					onPersisted?.()
					return true
				},
			),
			retrySaveApiConversationHistory: vi.fn(async () => false),
		})
		const content = task["buildUserMessageContent"](original.text, undefined, [original.id])
		expect(
			await task.runAgentRequests(content, false, onOriginalDisposed, { queuedMessageIds: [original.id] }),
		).toMatchObject({ status: "awaiting-user" })

		const submitted = vi
			.mocked(runLifecycleHooks)
			.mock.calls.find(([, request]) => request.hook_event_name === "UserPromptSubmit")?.[1]
		expect(submitted).toMatchObject({ prompt: expect.stringContaining("BLOCKED_ORIGINAL") })
		expect(submitted).toMatchObject({ prompt: expect.stringContaining("BLOCKED_STEER") })
		expect(history.at(-1)?.queued_message_ids).toEqual(expect.arrayContaining([original.id, steer.id]))
		expect(history.at(-1)?.queued_message_ids).toHaveLength(2)
		expect(JSON.stringify(history)).not.toContain("BLOCKED_ORIGINAL")
		expect(JSON.stringify(history)).not.toContain("BLOCKED_STEER")
		expect(queue.getClaimedMessageIds()).toEqual([])
		expect(onOriginalDisposed).toHaveBeenCalledOnce()
		expect(onSteerDisposed).toHaveBeenCalledOnce()
	})

	it("keeps a compact hook stop distinct from provider failure and retry control", async () => {
		const { task } = fixture({ completionHookConfig: { stop: [], subagentStop: [], preCompact: [command] } })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			shouldStop: true,
			stopReason: "Pause compaction",
			warnings: [],
		})

		await expect(
			task["runCompactionLifecycleHook"]("PreCompact", "manual", new AbortController().signal),
		).rejects.toMatchObject({ name: "LifecycleHookStoppedError", event: "PreCompact", message: "Pause compaction" })
		expect(vi.mocked(runLifecycleHooks).mock.calls[0][1]).toMatchObject({
			hook_event_name: "PreCompact",
			trigger: "manual",
		})
	})

	it("refreshes root SessionStart context after successful compaction with compact provenance", async () => {
		const { task, history, order } = fixture({
			completionHookConfig: { stop: [], subagentStop: [], postCompact: [command], sessionStart: [command] },
		})
		vi.mocked(runLifecycleHooks)
			.mockResolvedValueOnce({ warnings: [] })
			.mockResolvedValueOnce({
				additionalContext: [{ hook_run_id: "compact-start-run", text: "After compact context" }],
				warnings: [],
			})
		await task["runCompactionLifecycleHook"]("PostCompact", "auto", new AbortController().signal)

		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"PostCompact",
			"SessionStart",
		])
		expect(vi.mocked(runLifecycleHooks).mock.calls[1][1]).toMatchObject({ source: "compact" })
		expect(order[0]).toBe("save-compaction-receipt")
		expect(task["enqueueAlphaMessagesSave"]).toHaveBeenCalledWith(undefined, undefined, undefined, undefined, {
			guard: expect.any(Function),
			provider: undefined,
		})
		expect(history).toEqual([
			expect.objectContaining({
				input_origin: "agent",
				hook_prompt: {
					event: "SessionStart",
					fragments: [{ hook_run_id: "compact-start-run", text: "After compact context" }],
				},
			}),
		])
	})

	it("joins interrupted receipts before fresh input and emits one interrupt across cleanup paths", async () => {
		const { task, history, order } = fixture({
			interruptHookPending: true,
			completionHookConfig: {
				stop: [],
				subagentStop: [],
				interrupt: [command],
				userPromptSubmit: [command],
				sessionEnd: [command],
			},
		})
		vi.mocked(readCompletionHookConfig).mockReturnValue({
			stop: [],
			subagentStop: [],
			interrupt: [command],
			userPromptSubmit: [command],
			sessionEnd: [command],
		})
		vi.mocked(task["mergePendingToolResultsIntoUserContent"]).mockImplementation((content) => {
			order.push("merge-pending-results")
			return content
		})
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
			order.push(request.hook_event_name)
			return request.hook_event_name === "UserPromptSubmit"
				? {
						warnings: [],
						shouldStop: true,
						stopReason: "Input rejected after interruption",
						stopProvenance: {
							event: "UserPromptSubmit",
							fragments: [
								{ hook_run_id: "after-interrupt-run", text: "Input rejected after interruption" },
							],
						},
					}
				: { warnings: [] }
		})
		Object.assign(task, {
			addToApiConversationHistory: vi.fn(
				async (
					entry: ApiMessage,
					_reasoning: unknown,
					onPersisted?: () => void,
					_allowAborted?: boolean,
					hook_prompt?: CompletionHookPromptProvenance,
				) => {
					history.push({ ...entry, ...(hook_prompt ? { hook_prompt } : {}) })
					onPersisted?.()
					return true
				},
			),
		})
		const content = task["buildUserMessageContent"]("Fresh instruction")
		expect(await task.runAgentRequests(content)).toMatchObject({ status: "awaiting-user" })
		await task["runPendingInterruptLifecycleHook"]()
		await task["runTerminationLifecycleHooks"]()

		expect(order.slice(0, 5)).toEqual([
			"tool-receipts",
			"history-fence",
			"Interrupt",
			"merge-pending-results",
			"UserPromptSubmit",
		])
		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"Interrupt",
			"UserPromptSubmit",
			"SessionEnd",
		])
	})

	it("retains a pending interrupt when its tool receipts cannot be committed", async () => {
		const { task } = fixture({
			interruptHookPending: true,
			completionHookConfig: { stop: [], subagentStop: [], interrupt: [command] },
		})
		vi.mocked(task.flushPendingToolResultsToHistory).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

		await expect(task["runPendingInterruptLifecycleHook"]()).rejects.toThrow("interrupted tool receipts")
		expect(runLifecycleHooks).not.toHaveBeenCalled()
		await task["runPendingInterruptLifecycleHook"]()
		await task["runPendingInterruptLifecycleHook"]()
		expect(runLifecycleHooks).toHaveBeenCalledOnce()
		expect(vi.mocked(runLifecycleHooks).mock.calls[0][1]).toMatchObject({ hook_event_name: "Interrupt" })
	})

	it("joins root interrupt and session-end cleanup once even after task cancellation", async () => {
		const { task } = fixture({
			abort: true,
			interruptHookPending: true,
			completionHookConfig: { stop: [], subagentStop: [], interrupt: [command], sessionEnd: [command] },
		})
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, _request, signal) => {
			expect(signal.aborted).toBe(false)
			return { warnings: [] }
		})
		await task["runTerminationLifecycleHooks"]()
		await task["runTerminationLifecycleHooks"]()

		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"Interrupt",
			"SessionEnd",
		])
	})

	it("keeps managed children out of root SessionEnd cleanup", async () => {
		const { task } = fixture({
			taskKind: "subagent",
			interruptHookPending: true,
			completionHookConfig: { stop: [], subagentStop: [], interrupt: [command], sessionEnd: [command] },
		})
		await task["runTerminationLifecycleHooks"]()
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it("suppresses shutdown hooks after the transcript owner changes during lookup", async () => {
		let finishLookup!: (path: string | null) => void
		const lookup = new Promise<string | null>((resolve) => {
			finishLookup = resolve
		})
		const { task } = fixture({
			completionHookConfig: { stop: [], subagentStop: [], interrupt: [command], sessionEnd: [command] },
			interruptHookPending: true,
			completionHookTranscriptPath: vi.fn(() => lookup),
		})
		const pending = task["runTerminationLifecycleHooks"]()
		vi.mocked(task["isCurrentApiConversationHistoryOwner"]).mockReturnValue(false)
		finishLookup(null)
		await pending
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it("shares one three-second execution deadline across interrupt and session-end cleanup", async () => {
		vi.useFakeTimers()
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController()
			setTimeout(() => controller.abort(new Error("Cleanup deadline")), milliseconds)
			return controller.signal
		})
		const { task } = fixture({
			interruptHookPending: true,
			completionHookConfig: { stop: [], subagentStop: [], interrupt: [command], sessionEnd: [command] },
		})
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, _request, signal) => {
			if (!signal.aborted)
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			return { warnings: [] }
		})
		let settled = false
		const pending = task["runTerminationLifecycleHooks"]().then(() => {
			settled = true
		})
		try {
			await vi.advanceTimersByTimeAsync(3_000)
			expect(settled).toBe(true)
		} finally {
			await vi.advanceTimersByTimeAsync(3_000)
			await pending
		}
	})
})
