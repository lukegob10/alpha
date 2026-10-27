import type Anthropic from "@anthropic-ai/sdk"
import { EventEmitter } from "events"
import type { AlphaMessage } from "@alpha-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shouldCompactAfterTurn, Task } from "../Task"
import { runLifecycleHooks, type CompletionHookConfig, type LifecycleHookOutcome } from "../../agent/CompletionHooks"

vi.mock("../../agent/CompletionHooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/CompletionHooks")>()),
	runLifecycleHooks: vi.fn(),
}))

const command = { command: process.execPath }
const ownedTranscriptKeys = new Set<string>()
const persistedUiMessages = new Map<string, AlphaMessage[]>()

afterEach(() => {
	for (const key of ownedTranscriptKeys) Task["apiConversationHistoryOwnerGenerations"].delete(key)
	ownedTranscriptKeys.clear()
	persistedUiMessages.clear()
})

function fixture(configuration: CompletionHookConfig) {
	const persistenceKey = `${process.cwd()}\u0000hook-stop-compaction`
	const owners = Task["apiConversationHistoryOwnerGenerations"]
	const ownerGeneration = (owners.get(persistenceKey) ?? 0) + 1
	owners.set(persistenceKey, ownerGeneration)
	ownedTranscriptKeys.add(persistenceKey)
	const task = Object.assign(Object.setPrototypeOf(new EventEmitter(), Task.prototype), {
		taskId: "hook-stop-compaction",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		providerRef: { deref: () => undefined },
		apiConversationHistoryPersistenceKey: persistenceKey,
		apiConversationHistoryOwnerGeneration: ownerGeneration,
		taskCancellationController: new AbortController(),
		agentRunId: "run-1",
		agentTurnId: "turn-1",
		alphaMessages: [],
		completionHookConfig: configuration,
		lifecycleHookStartConsumed: false,
		lifecycleHookStoppedThisTurn: false,
		submittedLifecycleHookBlocks: new WeakSet(),
		inputBlockOrigins: new WeakMap(),
		pendingLifecycleHookContexts: [],
		currentAgentStep: {
			turnId: "turn-1",
			stepId: "step-1",
			requestId: "request-1",
			attemptId: "attempt-1",
			snapshot: {
				context: {
					provider: { modelId: "fixture-model" },
					policy: { approval: { mode: "ask" } },
				},
			},
		},
		completionHookTranscriptPath: vi.fn(async () => null),
	}) as Task
	// Keep native lifecycle guards/publication active; replace only the storage I/O boundary.
	task["enqueueAlphaMessagesSave"] = vi.fn<Task["enqueueAlphaMessagesSave"]>(
		async (createSnapshot, onPersisted, _designHandoff, _reasoning, ownership) => {
			if (ownership && !ownership.guard()) return false
			const snapshot = createSnapshot ? createSnapshot() : structuredClone(task.alphaMessages)
			await Promise.resolve()
			if (ownership && !ownership.guard()) return false
			persistedUiMessages.set(task.taskId, structuredClone(snapshot))
			onPersisted?.()
			return true
		},
	)
	return task
}

function human(task: Task, text: string): Anthropic.TextBlockParam {
	const block: Anthropic.TextBlockParam = { type: "text", text }
	task["captureInputBlockOrigins"]([block], "human")
	return block
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(runLifecycleHooks).mockResolvedValue({ warnings: [] })
})

// This regression concerns automatic post-turn admission. The completed-after-PostCompact
// metric guarantee is proactive-only; manual compaction metrics remain a separate contract.
describe("current lifecycle stops suppress automatic post-turn compaction", () => {
	it.each(["SessionStart", "UserPromptSubmit"] as const)(
		"does not compact after an actual %s stop",
		async (event) => {
			const task = fixture({
				stop: [],
				subagentStop: [],
				...(event === "SessionStart" ? { sessionStart: [command] } : { userPromptSubmit: [command] }),
			})
			vi.mocked(runLifecycleHooks).mockResolvedValue({
				warnings: [],
				shouldStop: true,
				stopReason: "Installed hook paused this turn",
			})
			const content = event === "UserPromptSubmit" ? [human(task, "Original request")] : []
			const outcome = await task["inspectLifecycleHookInput"](content, new AbortController().signal)

			expect(outcome.shouldStop).toBe(true)
			expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
				event,
			])
			expect(shouldCompactAfterTurn({ status: "awaiting-user" }, task["lifecycleHookStoppedThisTurn"])).toBe(
				false,
			)
			expect(
				shouldCompactAfterTurn(
					{ status: "completed", completionReason: "assistant" },
					task["lifecycleHookStoppedThisTurn"],
				),
			).toBe(false)
		},
	)

	it("does not retry PreCompact at the outer awaiting-user boundary after a controlled stop", async () => {
		const task = fixture({ stop: [], subagentStop: [], preCompact: [command] })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			warnings: [],
			shouldStop: true,
			stopReason: "Pause automatic compaction",
		})

		await expect(
			task["runCompactionLifecycleHook"]("PreCompact", "auto", new AbortController().signal),
		).rejects.toMatchObject({ name: "LifecycleHookStoppedError", event: "PreCompact" })
		expect(runLifecycleHooks).toHaveBeenCalledOnce()
		expect(shouldCompactAfterTurn({ status: "awaiting-user" }, task["lifecycleHookStoppedThisTurn"])).toBe(false)
	})

	it("does not compact again after a typed PostCompact stop", async () => {
		const task = fixture({ stop: [], subagentStop: [], postCompact: [command] })
		vi.mocked(runLifecycleHooks).mockResolvedValue({
			warnings: [],
			shouldStop: true,
			stopReason: "Pause after compaction",
		})

		await expect(
			task["runCompactionLifecycleHook"]("PostCompact", "auto", new AbortController().signal),
		).rejects.toMatchObject({ name: "LifecycleHookStoppedError", event: "PostCompact" })
		const save = vi.mocked(task["enqueueAlphaMessagesSave"])
		expect(save).toHaveBeenCalledTimes(2)
		expect(save.mock.calls[0]).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			{
				guard: expect.any(Function),
				provider: undefined,
			},
		])
		expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runLifecycleHooks).mock.invocationCallOrder[0])
		expect(persistedUiMessages.get(task.taskId)).toEqual(task.alphaMessages)
		expect(task.alphaMessages).toEqual([
			expect.objectContaining({ type: "say", say: "text", text: "Pause after compaction" }),
		])
		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request.hook_event_name)).toEqual([
			"PostCompact",
		])
		expect(shouldCompactAfterTurn({ status: "awaiting-user" }, task["lifecycleHookStoppedThisTurn"])).toBe(false)
	})

	it("keeps ordinary awaiting-user and assistant completion eligible after a successful hook", async () => {
		const task = fixture({ stop: [], subagentStop: [], userPromptSubmit: [command] })
		await task["inspectLifecycleHookInput"]([human(task, "Accepted request")], new AbortController().signal)

		expect(task["lifecycleHookStoppedThisTurn"]).toBe(false)
		expect(shouldCompactAfterTurn({ status: "awaiting-user" }, task["lifecycleHookStoppedThisTurn"])).toBe(true)
		expect(
			shouldCompactAfterTurn(
				{ status: "completed", completionReason: "assistant" },
				task["lifecycleHookStoppedThisTurn"],
			),
		).toBe(true)
	})

	it("does not retain a late cancelled hook stop as a current turn decision", async () => {
		const task = fixture({ stop: [], subagentStop: [], userPromptSubmit: [command] })
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
		const pending = task["inspectLifecycleHookInput"]([human(task, "Interrupted request")], controller.signal)
		await Promise.race([
			started,
			pending.then(() => {
				throw new Error("Lifecycle input settled before the cancellation barrier")
			}),
		])
		controller.abort(new Error("Fresh input interrupted the old hook"))
		finish({ warnings: [], shouldStop: true, stopReason: "Stale stop" })

		expect(await pending).toEqual({ warnings: [] })
		expect(task["lifecycleHookStoppedThisTurn"]).toBe(false)
		expect(shouldCompactAfterTurn({ status: "aborted" }, task["lifecycleHookStoppedThisTurn"])).toBe(false)
	})

	it("does not retain a hook stop after transcript ownership changes", async () => {
		const task = fixture({ stop: [], subagentStop: [], sessionStart: [command] })
		const persistenceKey = task["apiConversationHistoryPersistenceKey"]
		vi.mocked(runLifecycleHooks).mockImplementation(async () => {
			const owners = Task["apiConversationHistoryOwnerGenerations"]
			owners.set(persistenceKey, (owners.get(persistenceKey) ?? 0) + 1)
			return { warnings: [], shouldStop: true, stopReason: "Old owner stop" }
		})

		await expect(task["inspectLifecycleHookInput"]([], new AbortController().signal)).rejects.toMatchObject({
			name: "AbortError",
			message: "Request lifecycle preflight was superseded by a newer agent step",
		})
		expect(runLifecycleHooks).toHaveBeenCalledOnce()
		expect(task["lifecycleHookStoppedThisTurn"]).toBe(false)
		expect(persistedUiMessages.has(task.taskId)).toBe(false)
	})

	it.each([
		[{ status: "completed", completionReason: "assistant" }, true],
		[{ status: "completed", completionReason: "host" }, false],
		[{ status: "awaiting-user" }, true],
		[{ status: "incomplete" }, false],
		[{ status: "aborted" }, false],
	] as const)("preserves the existing decision for %s when the new turn has no hook stop", (outcome, expected) => {
		expect(shouldCompactAfterTurn(outcome)).toBe(expected)
		expect(shouldCompactAfterTurn(outcome, false)).toBe(expected)
		expect(shouldCompactAfterTurn(outcome, true)).toBe(false)
	})
})
