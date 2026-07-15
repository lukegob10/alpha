import { describe, expect, it } from "vitest"

import { getTaskStatusCategory, type TaskWithTrial } from "../task-lifecycle-status"

function task(overrides: Partial<TaskWithTrial> = {}): TaskWithTrial {
	return {
		id: 1,
		runId: 1,
		taskMetricsId: null,
		language: "javascript",
		exercise: "status",
		benchmarkTaskIdentity: null,
		benchmarkPartition: null,
		iteration: 1,
		passed: null,
		startedAt: null,
		finishedAt: null,
		createdAt: new Date(),
		...overrides,
	}
}

describe("getTaskStatusCategory", () => {
	it("keeps scored outcomes compatible", () => {
		expect(getTaskStatusCategory(task({ passed: true }))).toBe("passed")
		expect(getTaskStatusCategory(task({ passed: false }))).toBe("failed")
	})

	it.each(["infrastructure_error", "grader_error", "cancelled", "human_handoff"] as const)(
		"shows terminal %s separately from in-progress",
		(status) => {
			expect(
				getTaskStatusCategory(
					task({
						startedAt: new Date(),
						finishedAt: new Date(),
						trial: { status, finishedAt: new Date() },
					}),
				),
			).toBe("not_scored")
		},
	)

	it("uses persisted or streaming evidence for in-progress", () => {
		expect(getTaskStatusCategory(task({ startedAt: new Date() }))).toBe("in_progress")
		expect(getTaskStatusCategory(task(), true)).toBe("in_progress")
	})

	it("leaves untouched tasks not started", () => {
		expect(getTaskStatusCategory(task())).toBe("not_started")
	})
})
