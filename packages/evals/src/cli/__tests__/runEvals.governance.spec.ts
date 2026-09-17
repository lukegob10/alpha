import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	findRun: vi.fn(),
	getTasks: vi.fn(),
	finishRun: vi.fn(),
	processTask: vi.fn(),
	ensureAttempt: vi.fn(),
	applyAttemptEvent: vi.fn(),
	settleTrialAfterRetries: vi.fn(),
	updateTask: vi.fn(),
}))

vi.mock("../../db/index", () => ({
	...mocks,
	findTrialForTask: vi.fn(),
}))
vi.mock("../processTask", () => ({ processTask: mocks.processTask, processTaskInContainer: vi.fn() }))
vi.mock("../redis", () => ({ startHeartbeat: vi.fn(async () => 1), stopHeartbeat: vi.fn() }))
vi.mock("../utils", () => ({
	Logger: class {
		info() {}
		error() {}
		close() {}
	},
	getTag: vi.fn(() => "test"),
	isDockerContainer: vi.fn(() => false),
	resetEvalsRepo: vi.fn(),
	commitEvalsRepoChanges: vi.fn(),
}))

import { runEvals } from "../runEvals"

describe("governed production scheduling", () => {
	type FakeTask = {
		id: number
		finishedAt: Date | null
		benchmarkPartition: "development"
		taskMetrics: { cost: number } | null
	}
	const run = {
		id: 91,
		taskMetricsId: null,
		taskCostCapUsd: 0.04,
		campaignHardCapUsd: 0.12,
		campaignTier: "t1",
		highCostApproved: false,
		modelFallbackAllowed: false,
		concurrency: 1,
	}
	let tasks: FakeTask[]

	beforeEach(() => {
		vi.clearAllMocks()
		tasks = [1, 2, 3].map((id) => ({
			id,
			finishedAt: null,
			benchmarkPartition: "development",
			taskMetrics: null,
		}))
		mocks.findRun.mockResolvedValue(run)
		mocks.getTasks.mockImplementation(async () => tasks)
		mocks.processTask.mockImplementation(async ({ taskId }: { taskId: number }) => {
			const task = tasks.find(({ id }) => id === taskId)!
			task.finishedAt = new Date()
			task.taskMetrics = { cost: taskId === 1 ? 0.07 : 0.04 }
		})
		mocks.ensureAttempt.mockImplementation(async (taskId: number) => ({
			id: 100 + taskId,
			phase: "created",
			terminalStatus: null,
		}))
		mocks.finishRun.mockResolvedValue({ id: run.id })
	})

	it("reconciles actual spend before reserving the next task", async () => {
		await runEvals(run.id)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1, 2])
		expect(mocks.applyAttemptEvent).toHaveBeenCalledWith(
			103,
			expect.objectContaining({
				type: "finalize",
				status: "budget_exhausted",
				failureCode: "campaign_budget_unavailable",
			}),
		)
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(3)
		expect(mocks.finishRun).toHaveBeenCalledWith(run.id)
	})

	it("rejects concurrent governed execution", async () => {
		mocks.findRun.mockResolvedValue({ ...run, concurrency: 2 })
		await expect(runEvals(run.id)).rejects.toThrow("require concurrency 1")
		expect(mocks.processTask).not.toHaveBeenCalled()
	})
})
