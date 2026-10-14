import { describe, expect, it, vi } from "vitest"

import { Task } from "../Task"

describe("Task performance observability", () => {
	const createTaskHarness = (enabled: boolean) => {
		const appendAgentTurnEvent = vi.fn()
		const task = Object.assign(Object.create(Task.prototype), {
			performanceObservabilityEnabled: enabled,
			appendAgentTurnEvent,
		}) as Task
		return { task, appendAgentTurnEvent }
	}

	it("keeps per-task timing evidence off unless explicitly enabled", () => {
		const { task, appendAgentTurnEvent } = createTaskHarness(false)

		task.recordTaskPerformance("first_provider_request", performance.now() - 20)

		expect(appendAgentTurnEvent).not.toHaveBeenCalled()
	})

	it("records only a bounded phase, status, and duration when enabled", () => {
		const { task, appendAgentTurnEvent } = createTaskHarness(true)

		task.recordTaskPerformance("completed_task_followup", performance.now() - 20)

		expect(appendAgentTurnEvent).toHaveBeenCalledOnce()
		expect(appendAgentTurnEvent.mock.calls[0][0]).toMatchObject({
			type: "task_performance",
			phase: "completed_task_followup",
			status: "completed",
			durationMs: expect.any(Number),
		})
		expect(appendAgentTurnEvent.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0)
	})
})
