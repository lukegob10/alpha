import { Task } from "../Task"
import type { ApiHandler } from "../../../api"
import { summarizeConversation } from "../../condense"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalStepAccounting } from "../../agent/GoalStepAccounting"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"
import type { AlphaMessage } from "@alpha-code/types"

class MemoryStore implements GoalStateStore {
	state: TaskGoalEnvelope = { schemaVersion: 1, taskId: "usage-task", usageReceipts: [] }
	async read() {
		return structuredClone(this.state)
	}
	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const next = structuredClone(this.state)
		const result = operation(next)
		this.state = next
		return structuredClone(result)
	}
}

async function fixture(goal = true) {
	const store = new MemoryStore()
	let id = 0
	const controller = new GoalController({ taskId: "usage-task", store, newId: () => `goal-${++id}` })
	const created = goal
		? await controller.create({ objective: "Preserve accounting", tokenBudget: 1000 }, "user")
		: undefined
	const activeGoalStep: GoalStepAccounting | undefined = created
		? {
				controller,
				goalId: created.goalId,
				goalTaskId: "usage-task",
				controlVersion: created.controlVersion,
				requestGeneration: controller.getRequestGeneration(),
				eventId: "model-step",
				startedAt: 0,
				accountElapsed: false,
				executionMode: "code",
			}
		: undefined
	const durable: AlphaMessage[][] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "usage-task",
		taskKind: "primary",
		_taskMode: "code",
		activeGoalStep,
		goalController: goal ? controller : undefined,
		alphaMessages: [
			{ ts: 0, type: "say", say: "text", text: "Original task" },
			{ ts: 1, type: "say", say: "text", text: "Existing retained response" },
		] satisfies AlphaMessage[],
		apiConversationHistory: [],
		providerRef: { deref: () => undefined },
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		enqueueAlphaMessagesSave: vi.fn(
			async (
				snapshot: () => AlphaMessage[],
				commit?: () => void,
				_a?: unknown,
				_b?: unknown,
				ownership?: { guard: () => boolean },
			) => {
				if (ownership && !ownership.guard()) return false
				durable.push(structuredClone(snapshot()))
				commit?.()
				return true
			},
		),
		observeUiMessageTimestamps: vi.fn(),
	}) as Task
	return { task, controller, store, durable }
}

const usage = {
	type: "usage" as const,
	usageSource: "provider" as const,
	inputTokens: 100,
	outputTokens: 20,
	cacheReadTokens: 40,
	cacheWriteTokens: 5,
	reasoningTokens: 10,
	totalCost: 0.25,
}

it.each([true, false])(
	"durably charges finalized compaction usage with inputIncludesCache=%s",
	async (inputIncludesCache) => {
		const { task, controller, durable } = await fixture()
		const accounting = task["createContextCondenseAccounting"]()
		await accounting.beforeAttempt()
		await accounting.observeUsage(usage, "attempt-1", inputIncludesCache)
		await accounting.observeUsage(usage, "attempt-1", inputIncludesCache)
		expect(await controller.get()).toMatchObject({ tokensUsed: inputIncludesCache ? 80 : 125 })
		expect(durable.at(-1)?.[1].compactionUsageReceipts).toHaveLength(1)
		expect(task.alphaMessages[1].compactionUsageReceipts?.[0]).toMatchObject({
			attemptId: "attempt-1",
			inputIncludesCache,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 40,
		})
		expect(task.apiConversationHistory).toEqual([])
	},
)

it("persists non-goal usage evidence without granting goal authority", async () => {
	const { task, durable, store } = await fixture(false)
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	await accounting.observeUsage(usage, "standalone", true)
	expect(durable.at(-1)?.[1].compactionUsageReceipts?.[0]).toMatchObject({
		attemptId: "standalone",
		inputTokens: 100,
	})
	expect(task.alphaMessages[1].compactionUsageReceipts?.[0].goalReceipt).toBeUndefined()
	expect(store.state.usageReceipts).toEqual([])
})

it("replays a durable receipt after goal-store charging failed exactly once", async () => {
	const { task, controller } = await fixture()
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	vi.spyOn(controller, "recordUsage").mockRejectedValueOnce(new Error("goal store unavailable"))
	await expect(accounting.observeUsage(usage, "recoverable", true)).rejects.toThrow("goal store unavailable")
	expect(task.alphaMessages[1].compactionUsageReceipts).toHaveLength(1)
	await task["reconcileGoalUsageFromHistory"]()
	await task["reconcileGoalUsageFromHistory"]()
	expect(await controller.get()).toMatchObject({ tokensUsed: 80 })
})

it("keeps late cancelled usage on its original goal and blocks another attempt", async () => {
	const { task, controller } = await fixture()
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	await controller.updateStatus("paused")
	await accounting.observeUsage(usage, "cancelled", true)
	expect(await controller.get()).toMatchObject({ tokensUsed: 80, status: "paused" })
	await expect(accounting.beforeAttempt()).rejects.toThrow("goal")
})

it("never charges a replacement goal for an old finalized attempt", async () => {
	const { task, controller } = await fixture()
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	await controller.updateStatus("complete")
	await controller.create({ objective: "Replacement", tokenBudget: 1000 }, "user")
	await accounting.observeUsage(usage, "old-goal", true)
	expect(await controller.get()).toMatchObject({ objective: "Replacement", tokensUsed: 0 })
	await task["reconcileGoalUsageFromHistory"]()
	expect(await controller.get()).toMatchObject({ tokensUsed: 0 })
	await expect(accounting.beforeAttempt()).rejects.toThrow("goal")
})

it("refuses late evidence writes after another Task owns the saved history", async () => {
	const { task, controller, durable } = await fixture()
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	vi.mocked(task["isCurrentApiConversationHistoryOwner"]).mockReturnValue(false)
	await expect(accounting.observeUsage(usage, "stale-task", true)).rejects.toThrow("compaction usage")
	expect(durable).toEqual([])
	expect(await controller.get()).toMatchObject({ tokensUsed: 0 })
})

it("surfaces a failed evidence save before charging the goal", async () => {
	const { task, controller } = await fixture()
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	vi.mocked(task["enqueueAlphaMessagesSave"]).mockResolvedValue(false)
	await expect(accounting.observeUsage(usage, "failed-save", true)).rejects.toThrow("compaction usage")
	expect(await controller.get()).toMatchObject({ tokensUsed: 0 })
	expect(task.alphaMessages[1].compactionUsageReceipts).toBeUndefined()
})

it("does not discharge a new cost when usage replaces an older same-cost anchor", async () => {
	const { task } = await fixture(false)
	task.alphaMessages = [
		{ ts: 0, type: "say", say: "text", text: "Original task" },
		{ ts: 1, type: "say", say: "condense_context_error", contextCondenseErrorCost: 0.25 },
	]
	Object.assign(task, { reserveUiMessageTimestamp: vi.fn(() => 2), saveAlphaMessages: vi.fn(async () => true) })
	const accounting = task["createContextCondenseAccounting"]()
	accounting.observeCost(0.25)
	await accounting.observeUsage(usage, "new-attempt", true)
	await accounting.persistUnreportedCost(false)
	expect(task.alphaMessages.filter((message) => message.contextCondenseErrorCost === 0.25)).toHaveLength(2)
})

it.each([true, false])("charges manual root elapsed work only without an outer goal step (outer=%s)", async (outer) => {
	const { task, controller } = await fixture()
	if (!outer) Reflect.set(task, "activeGoalStep", undefined)
	const clock = vi.spyOn(performance, "now").mockReturnValue(100)
	try {
		const accounting = task["createContextCondenseAccounting"]()
		await accounting.beforeAttempt()
		clock.mockReturnValue(350)
		await accounting.observeUsage(usage, "first", true)
		clock.mockReturnValue(500)
		await accounting.observeUsage(usage, "second", true)
		clock.mockReturnValue(800)
		await accounting.observeUsage(usage, "second", true)
		expect(await controller.get()).toMatchObject({ tokensUsed: 160, timeUsedMs: outer ? 0 : 400 })
		expect(task.alphaMessages[1].compactionUsageReceipts?.map((entry) => entry.goalReceipt?.timeMs)).toEqual(
			outer ? [0, 0] : [250, 150],
		)
	} finally {
		clock.mockRestore()
	}
})

it("blocks a later compaction attempt when finalized usage consumes the captured goal budget", async () => {
	const { task, controller, store } = await fixture()
	store.state.goal!.tokenBudget = 50
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	await accounting.observeUsage(usage, "budget-consumed", true)
	expect(await controller.get()).toMatchObject({ tokensUsed: 80, status: "budget_limited" })
	await expect(accounting.beforeAttempt()).rejects.toThrow("goal")
})

it("awaits a manual goal binding before admitting provider effects", async () => {
	const { task } = await fixture()
	const binding = await task.captureGoalAccountingBinding()
	Reflect.set(task, "activeGoalStep", undefined)
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	vi.spyOn(task, "captureGoalAccountingBinding").mockImplementation(async () => {
		await held
		return binding
	})
	const accounting = task["createContextCondenseAccounting"]()
	let admitted = false
	const pending = accounting.beforeAttempt().then(() => {
		admitted = true
	})
	await Promise.resolve()
	expect(admitted).toBe(false)
	release()
	await pending
	expect(admitted).toBe(true)
})

it("does not debit child compaction wall time already owned by its parent", async () => {
	const { task, controller } = await fixture()
	const binding = await task.captureGoalAccountingBinding()
	Reflect.set(task, "taskId", "child-task")
	Reflect.set(task, "activeGoalStep", undefined)
	Reflect.set(task, "inheritedGoalBinding", Promise.resolve(binding))
	const clock = vi.spyOn(performance, "now").mockReturnValue(100)
	try {
		const accounting = task["createContextCondenseAccounting"]()
		await accounting.beforeAttempt()
		clock.mockReturnValue(500)
		await accounting.observeUsage(usage, "child-attempt", true)
		expect(await controller.get()).toMatchObject({ tokensUsed: 80, timeUsedMs: 0 })
	} finally {
		clock.mockRestore()
	}
})

it("keeps receipt anchors through the actual task metrics projection", async () => {
	const { task } = await fixture(false)
	task.alphaMessages.push(
		{ ts: 2, type: "say", say: "command_output", text: "Legacy command output" },
		{ ts: 3, type: "say", say: "mcp_server_response", text: "Legacy MCP output" },
		{ ts: 4, type: "say", say: "api_req_finished", text: "{}" },
	)
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	await accounting.observeUsage(usage, "retained-anchor", true)
	const projected = task.combineMessages(task.alphaMessages.slice(1))
	expect(projected.flatMap((message) => message.compactionUsageReceipts ?? [])).toHaveLength(1)
	expect(task.alphaMessages[1].compactionUsageReceipts?.[0].attemptId).toBe("retained-anchor")
})

it("rejects a missing retained anchor before issuing another provider attempt", async () => {
	const { task } = await fixture(false)
	task.alphaMessages.splice(1)
	const accounting = task["createContextCondenseAccounting"]()
	await expect(accounting.beforeAttempt()).rejects.toThrow("compaction usage")
})

it("rejects a full anchor before further provider spend", async () => {
	const { task } = await fixture(false)
	task.alphaMessages[1].compactionUsageReceipts = Array.from({ length: 64 }, (_, index) => ({
		attemptId: `old-${index}`,
		inputIncludesCache: true,
		inputTokens: 1,
		outputTokens: 1,
	}))
	const accounting = task["createContextCondenseAccounting"]()
	await expect(accounting.beforeAttempt()).rejects.toThrow("capacity")
})

it("settles trailing manual root work through cleanup with immutable replayable receipts", async () => {
	const { task, controller } = await fixture()
	Reflect.set(task, "activeGoalStep", undefined)
	const clock = vi.spyOn(performance, "now").mockReturnValue(100)
	try {
		const accounting = task["createContextCondenseAccounting"]()
		await accounting.beforeAttempt()
		clock.mockReturnValue(350)
		await accounting.observeUsage(usage, "last-attempt", true)
		clock.mockReturnValue(800)
		await accounting.persistUnreportedCost(false)
		expect(await controller.get()).toMatchObject({ tokensUsed: 80, timeUsedMs: 700 })
		const first = structuredClone(task.alphaMessages[1].compactionUsageReceipts)
		expect(first?.[0].goalElapsedReceipt).toMatchObject({ tokens: 0, timeMs: 450 })
		clock.mockReturnValue(1000)
		await accounting.observeUsage(usage, "last-attempt", true)
		await accounting.persistUnreportedCost(false)
		task.alphaMessages = JSON.parse(JSON.stringify(task.alphaMessages))
		await task["reconcileGoalUsageFromHistory"]()
		await task["reconcileGoalUsageFromHistory"]()
		expect(task.alphaMessages[1].compactionUsageReceipts).toEqual(JSON.parse(JSON.stringify(first)))
		expect(await controller.get()).toMatchObject({ tokensUsed: 80, timeUsedMs: 700 })
	} finally {
		clock.mockRestore()
	}
})

it("does not assign a successor turn to late usage from a manual no-turn operation", async () => {
	const { task, durable } = await fixture(false)
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	Object.assign(task, { agentRunId: "successor-run", agentTurnId: "successor-turn" })
	await expect(accounting.observeUsage(usage, "unscoped-late", true)).rejects.toThrow("compaction usage")
	expect(durable).toEqual([])
	expect(task.alphaMessages[1].turn).toBeUndefined()
})

it.each([false, true])(
	"settles elapsed after a cost save failure and preserves the primary error (preserveError=%s)",
	async (preserveError) => {
		const { task, controller, durable } = await fixture()
		Reflect.set(task, "activeGoalStep", undefined)
		const clock = vi.spyOn(performance, "now").mockReturnValue(100)
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const costFailure = new Error("cost save failed")
		const elapsedFailure = new Error("elapsed goal charge failed")
		Object.assign(task, {
			reserveUiMessageTimestamp: vi.fn(() => 2),
			saveAlphaMessages: vi.fn(async () => {
				throw costFailure
			}),
		})
		try {
			const accounting = task["createContextCondenseAccounting"]()
			await accounting.beforeAttempt()
			clock.mockReturnValue(350)
			await accounting.observeUsage(usage, "cost-and-elapsed-failure", true)
			accounting.observeCost(0.25)
			clock.mockReturnValue(800)
			const charge = vi.spyOn(controller, "recordUsage").mockRejectedValueOnce(elapsedFailure)
			await expect(accounting.persistUnreportedCost(preserveError)).rejects.toBe(
				preserveError ? elapsedFailure : costFailure,
			)
			expect(durable.at(-1)?.[1].compactionUsageReceipts?.[0].goalElapsedReceipt).toMatchObject({
				tokens: 0,
				timeMs: 450,
			})
			expect(charge).toHaveBeenCalledTimes(1)
			expect(warning).toHaveBeenCalledTimes(preserveError ? 1 : 0)
		} finally {
			clock.mockRestore()
			warning.mockRestore()
		}
	},
)

it("joins an admitted zero-cost usage write before compaction cleanup returns", async () => {
	const { task } = await fixture(false)
	let entered!: () => void
	let release!: () => void
	const started = new Promise<void>((resolve) => {
		entered = resolve
	})
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const original = vi.mocked(task["enqueueAlphaMessagesSave"]).getMockImplementation()
	if (!original) throw new Error("Missing fixture save implementation")
	vi.mocked(task["enqueueAlphaMessagesSave"]).mockImplementation(async (...args) => {
		entered()
		await held
		return original(...args)
	})
	const accounting = task["createContextCondenseAccounting"]()
	await accounting.beforeAttempt()
	vi.useFakeTimers()
	const pending = accounting.observeUsage({ ...usage, totalCost: undefined }, "zero-cost", true)
	await started
	let cleaned = false
	const cleanup = accounting.persistUnreportedCost(false).then(() => {
		cleaned = true
	})
	try {
		await vi.advanceTimersByTimeAsync(0)
		expect(cleaned).toBe(false)
	} finally {
		release()
		await pending
		await cleanup
		vi.useRealTimers()
	}
})

it.each(["network failure", "Stop"])(
	"retains manual elapsed when %s arrives before provider usage",
	async (failure) => {
		const { task, controller } = await fixture()
		Reflect.set(task, "activeGoalStep", undefined)
		const clock = vi.spyOn(performance, "now").mockReturnValue(100)
		const control = new AbortController()
		const stopped = new DOMException("Stop before usage", "AbortError")
		const api: ApiHandler = {
			getModel: () => ({
				id: "manual-model",
				info: { contextWindow: 100_000, maxTokens: 1000, supportsPromptCache: false },
			}),
			countTokens: vi.fn(async (content) => Math.ceil(JSON.stringify(content).length / 100)),
			createMessage: vi.fn(async function* () {
				clock.mockReturnValue(500)
				if (failure === "Stop") {
					control.abort(stopped)
					throw stopped
				}
				yield* []
				throw new Error("network offline")
			}),
		}
		try {
			const accounting = task["createContextCondenseAccounting"]()
			const pending = summarizeConversation({
				messages: [
					{ role: "user", content: "Original requirement. ".repeat(500) },
					{ role: "assistant", content: "Prior evidence. ".repeat(500) },
				],
				apiHandler: api,
				taskId: task.taskId,
				systemPrompt: "Current rules",
				maxContextTokens: 1000,
				forceCompaction: true,
				recentTailTokenBudget: 0,
				beforeAttempt: accounting.beforeAttempt,
				observeUsage: accounting.observeUsage,
				metadata: { taskId: task.taskId, signal: control.signal },
			})
			if (failure === "Stop") await expect(pending).rejects.toBe(stopped)
			else expect((await pending).status).toBe("no_progress")
			expect(api.createMessage).toHaveBeenCalledOnce()
			clock.mockReturnValue(800)
			await accounting.persistUnreportedCost(failure === "Stop")
			expect(await controller.get()).toMatchObject({ tokensUsed: 0, timeUsedMs: 700 })
			expect(task.alphaMessages[1].compactionUsageReceipts?.[0]).toMatchObject({
				usageSource: "unknown",
				inputTokens: 0,
				outputTokens: 0,
			})
		} finally {
			clock.mockRestore()
		}
	},
)
