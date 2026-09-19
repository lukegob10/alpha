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
	stopHeartbeat: vi.fn(),
	startHeartbeat: vi.fn(),
	closeLogger: vi.fn(),
}))

vi.mock("../../db/index", () => ({
	...mocks,
	findTrialForTask: vi.fn(),
}))
vi.mock("../processTask", () => ({ processTask: mocks.processTask, processTaskInContainer: vi.fn() }))
vi.mock("../redis", () => ({ startHeartbeat: mocks.startHeartbeat, stopHeartbeat: mocks.stopHeartbeat }))
vi.mock("../utils", () => ({
	Logger: class {
		info() {}
		error() {}
		close() {
			mocks.closeLogger()
		}
	},
	getTag: vi.fn(() => "test"),
	isDockerContainer: vi.fn(() => false),
	resetEvalsRepo: vi.fn(),
	commitEvalsRepoChanges: vi.fn(),
}))

import { resetEvalsRepo, commitEvalsRepoChanges } from "../utils"

import { runEvals } from "../runEvals"

describe("governed production scheduling", () => {
	type FakeTask = {
		id: number
		benchmarkTaskIdentity?: string
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
		mocks.startHeartbeat.mockResolvedValue(1)
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

	it("never resets or commits the source checkout for disposable benchmark tasks", async () => {
		for (const task of tasks) task.benchmarkTaskIdentity = `task-${task.id}`
		await runEvals(run.id)
		expect(resetEvalsRepo).not.toHaveBeenCalled()
		expect(commitEvalsRepoChanges).not.toHaveBeenCalled()
	})

	it("rejects mixed checkout ownership before reset", async () => {
		tasks[0]!.benchmarkTaskIdentity = "task-1"
		await expect(runEvals(run.id)).rejects.toThrow("separate runs")
		expect(resetEvalsRepo).not.toHaveBeenCalled()
	})

	it("closes the logger when checkout validation rejects before heartbeat startup", async () => {
		const error = new Error("unsafe checkout")
		vi.mocked(resetEvalsRepo).mockRejectedValueOnce(error)
		await expect(runEvals(run.id)).rejects.toBe(error)
		expect(mocks.startHeartbeat).not.toHaveBeenCalled()
		expect(mocks.stopHeartbeat).not.toHaveBeenCalled()
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it("closes the logger when heartbeat startup rejects without stopping an unowned heartbeat", async () => {
		const error = new Error("startup failed")
		mocks.startHeartbeat.mockRejectedValueOnce(error)
		await expect(runEvals(run.id)).rejects.toBe(error)
		expect(mocks.stopHeartbeat).not.toHaveBeenCalled()
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it("preserves the run failure and closes the logger when heartbeat cleanup rejects", async () => {
		const primary = new Error("run failed")
		mocks.finishRun.mockRejectedValueOnce(primary)
		mocks.stopHeartbeat.mockRejectedValueOnce(new Error("cleanup failed"))
		await expect(runEvals(run.id)).rejects.toBe(primary)
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it("reports cleanup failure after a successful run and still closes the logger", async () => {
		const cleanup = new Error("cleanup failed")
		mocks.stopHeartbeat.mockRejectedValueOnce(cleanup)
		await expect(runEvals(run.id)).rejects.toBe(cleanup)
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it("rejects concurrent governed execution", async () => {
		mocks.findRun.mockResolvedValue({ ...run, concurrency: 2 })
		await expect(runEvals(run.id)).rejects.toThrow("require concurrency 1")
		expect(mocks.processTask).not.toHaveBeenCalled()
	})
})
