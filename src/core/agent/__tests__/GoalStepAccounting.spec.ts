import { describe, expect, it, vi, afterEach } from "vitest"

import { createAgentResponse } from "../AgentResponse"
import { accountGoalResponse, finishGoalStep, goalResponseTokens, type GoalStepAccounting } from "../GoalStepAccounting"
import { GoalController } from "../goals/GoalController"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"

class MemoryStore implements GoalStateStore {
	state: TaskGoalEnvelope = { schemaVersion: 1, taskId: "root", usageReceipts: [] }
	async read() {
		return structuredClone(this.state)
	}
	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const working = structuredClone(this.state)
		const result = operation(working)
		this.state = working
		return structuredClone(result)
	}
}

const response = createAgentResponse([
	{
		type: "usage",
		inputTokens: 100,
		cacheReadTokens: 60,
		cacheWriteTokens: 10,
		outputTokens: 30,
		reasoningTokens: 20,
	},
])

afterEach(() => vi.useRealTimers())

describe("goal receipts from existing provider usage", () => {
	it("charges noncached input and output once when input already includes cache", () => {
		expect(goalResponseTokens(response)).toBe(70)
	})

	it("normalizes protocols whose input excludes cache without billing reads", () => {
		expect(goalResponseTokens(response, false)).toBe(140)
	})

	it("does not lose billable tokens when adding cached input would exceed the safe integer range", () => {
		const response = createAgentResponse([
			{
				type: "usage",
				inputTokens: Number.MAX_SAFE_INTEGER - 1,
				cacheReadTokens: Number.MAX_SAFE_INTEGER,
				cacheWriteTokens: 1,
				outputTokens: 0,
			},
		])
		expect(goalResponseTokens(response, false)).toBe(Number.MAX_SAFE_INTEGER)
	})

	it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid counter %s", (inputTokens) => {
		expect(() =>
			goalResponseTokens(createAgentResponse([{ type: "usage", inputTokens, outputTokens: 0 }])),
		).toThrow()
	})

	it("idempotently bills canonical response and elapsed receipts, including replay after a crash", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const store = new MemoryStore()
		const controller = new GoalController({ taskId: "root", store, newId: () => "goal" })
		await controller.create({ objective: "Finish the work." }, "user")
		const step: GoalStepAccounting = {
			controller,
			goalId: "goal",
			goalTaskId: "root",
			controlVersion: 1,
			requestGeneration: 1,
			eventId: "durable-step-attempt",
			startedAt: 900,
			accountElapsed: true,
		}
		await accountGoalResponse(step, response)
		await accountGoalResponse(step, response)
		vi.setSystemTime(1_200)
		await finishGoalStep(step)
		await finishGoalStep(step)
		const reloaded = new GoalController({ taskId: "root", store })
		for (const receipt of [step.usageReceipt!, step.elapsedReceipt!]) {
			await reloaded.recordUsage(receipt.eventId, receipt.tokens, receipt.timeMs, receipt.goalId)
		}
		expect(await reloaded.get()).toMatchObject({ tokensUsed: 70, timeUsedMs: 300, recoveryDeferred: true })
	})

	it("rolls descendant tokens into the captured root without charging overlapping elapsed time", async () => {
		const controller = new GoalController({ taskId: "root", store: new MemoryStore(), newId: () => "goal" })
		await controller.create({ objective: "Finish the work." }, "user")
		const step: GoalStepAccounting = {
			controller,
			goalId: "goal",
			goalTaskId: "root",
			controlVersion: 1,
			requestGeneration: 1,
			eventId: "child-step",
			startedAt: 0,
			accountElapsed: false,
		}
		await accountGoalResponse(step, response)
		await finishGoalStep(step)
		expect(await controller.get()).toMatchObject({ tokensUsed: 70, timeUsedMs: 0 })
	})

	it("never transfers old child usage to a replacement goal", async () => {
		let id = 0
		const controller = new GoalController({ taskId: "root", store: new MemoryStore(), newId: () => `goal-${++id}` })
		const old = await controller.create({ objective: "Old work." }, "user")
		await controller.updateStatus("complete")
		await controller.create({ objective: "New work." }, "user")
		await accountGoalResponse(
			{
				controller,
				goalId: old.goalId,
				goalTaskId: "root",
				controlVersion: 1,
				requestGeneration: 1,
				eventId: "old-child",
				startedAt: 0,
				accountElapsed: false,
			},
			response,
		)
		expect(await controller.get()).toMatchObject({ objective: "New work.", tokensUsed: 0 })
	})
})
