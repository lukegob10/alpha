import { beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalJson, sha256 } from "../../evidence/index"

const mocks = vi.hoisted(() => ({
	findRun: vi.fn(),
	findTrialForTask: vi.fn(),
	getTasks: vi.fn(),
	getPresentationModelCallPolicyEvents: vi.fn(),
	finishRun: vi.fn(),
	processTask: vi.fn(),
	processTaskInContainer: vi.fn(),
	isDockerContainer: vi.fn(),
	ensureAttempt: vi.fn(),
	applyAttemptEvent: vi.fn(),
	settleTrialAfterRetries: vi.fn(),
	updateTask: vi.fn(),
	stopHeartbeat: vi.fn(),
	startHeartbeat: vi.fn(),
	closeLogger: vi.fn(),
	logInfo: vi.fn(),
}))

vi.mock("../../db/index", () => ({ ...mocks }))
vi.mock("../processTask", () => ({
	processTask: mocks.processTask,
	processTaskInContainer: mocks.processTaskInContainer,
}))
vi.mock("../redis", () => ({ startHeartbeat: mocks.startHeartbeat, stopHeartbeat: mocks.stopHeartbeat }))
vi.mock("../utils", () => ({
	Logger: class {
		info = mocks.logInfo
		error() {}
		close() {
			mocks.closeLogger()
		}
	},
	getTag: vi.fn(() => "test"),
	isDockerContainer: mocks.isDockerContainer,
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
	const presentationPolicy = { schemaVersion: 1, presentationModelCalls: false, presentationModelCallOptOut: true }
	const policyEvent = (attemptId: number, payload: unknown = presentationPolicy) => ({
		attemptId,
		type: "extension.presentation_model_call_policy",
		payload,
		payloadDigest: sha256(canonicalJson(payload)),
		late: false,
	})
	const terminalTrial = (taskId: number, status = "passed") => ({ status, attempts: [{ id: 100 + taskId }] })

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.isDockerContainer.mockReturnValue(false)
		mocks.startHeartbeat.mockResolvedValue(1)
		tasks = [1, 2, 3].map((id) => ({
			id,
			finishedAt: null,
			benchmarkPartition: "development",
			taskMetrics: null,
		}))
		mocks.findRun.mockResolvedValue(run)
		mocks.findTrialForTask.mockImplementation(async (taskId: number) => terminalTrial(taskId))
		mocks.getPresentationModelCallPolicyEvents.mockImplementation(async (attemptId: number) => [
			policyEvent(attemptId),
		])
		mocks.getTasks.mockImplementation(async () => tasks)
		mocks.processTask.mockImplementation(async ({ taskId }: { taskId: number }) => {
			const task = tasks.find(({ id }) => id === taskId)!
			task.finishedAt = new Date()
			task.taskMetrics = { cost: taskId === 1 ? 0.07 : 0.04 }
		})
		mocks.processTaskInContainer.mockImplementation(async ({ taskId }: { taskId: number }) => {
			const task = tasks.find(({ id }) => id === taskId)!
			task.finishedAt = new Date()
			task.taskMetrics = { cost: 0.01 }
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

	it("logs only summary metrics instead of persisted credentials and provider settings", async () => {
		mocks.finishRun.mockResolvedValue({
			...run,
			jobToken: "job-token-canary",
			settings: { openAiApiKey: "provider-key-canary", customInstructions: "prompt-canary" },
			passed: 2,
			failed: 1,
			taskMetrics: { cost: 0.11, duration: 1_000, requestUsage: [{ raw: "request-canary" }] },
		})
		await runEvals(run.id)
		expect(mocks.logInfo).toHaveBeenCalledWith("result ->", {
			runId: run.id,
			passed: 2,
			failed: 1,
			costUsd: 0.11,
			durationMs: 1_000,
		})
		expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain("canary")
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

	it("stops governed dispatch after a task infrastructure failure and still releases controller resources", async () => {
		const error = new Error("owned host startup failed")
		mocks.processTask.mockRejectedValueOnce(error)
		await expect(runEvals(run.id)).rejects.toBe(error)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
		expect(mocks.finishRun).not.toHaveBeenCalled()
		expect(mocks.logInfo.mock.calls.filter(([message]) => message === "campaign budget")).toHaveLength(0)
		expect(mocks.stopHeartbeat).toHaveBeenCalledExactlyOnceWith(run.id, 1)
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it.each(["passed", "cancelled", "grader_error", "safety_failed"])(
		"stops after cancelled local execution even when the persisted trial is %s",
		async (status) => {
			const trial = Object.freeze({ status })
			mocks.findTrialForTask.mockResolvedValue(trial)
			mocks.processTask.mockImplementationOnce(async () => {
				tasks[0]!.finishedAt = new Date()
				tasks[0]!.taskMetrics = { cost: 0.01 }
				return "cancelled"
			})

			await expect(runEvals(run.id)).rejects.toThrow(/task 1.*cancelled/i)
			expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
			expect(mocks.logInfo).toHaveBeenCalledWith(
				"campaign budget",
				expect.objectContaining({ consumedUsd: 0.01, reservedUsd: 0 }),
			)
			expect(trial.status).toBe(status)
			expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
			expect(mocks.updateTask).not.toHaveBeenCalled()
			expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
			expect(mocks.finishRun).not.toHaveBeenCalled()
			expect(mocks.stopHeartbeat).toHaveBeenCalledExactlyOnceWith(run.id, 1)
			expect(mocks.closeLogger).toHaveBeenCalledOnce()
		},
	)

	it.each([
		{ surface: "local", status: "cancelled" },
		{ surface: "local", status: "grader_error" },
		{ surface: "local", status: "infrastructure_error" },
		{ surface: "local", status: "safety_failed" },
		{ surface: "container", status: "cancelled" },
		{ surface: "container", status: "grader_error" },
		{ surface: "container", status: "infrastructure_error" },
		{ surface: "container", status: "safety_failed" },
	])("stops $surface governed dispatch after a persisted $status trial", async ({ surface, status }) => {
		mocks.isDockerContainer.mockReturnValue(surface === "container")
		const trial = Object.freeze({ status })
		mocks.findTrialForTask.mockResolvedValue(trial)
		if (surface === "local")
			mocks.processTask.mockImplementationOnce(async () => {
				tasks[0]!.finishedAt = new Date()
				tasks[0]!.taskMetrics = { cost: 0.01 }
				return "completed"
			})

		await expect(runEvals(run.id)).rejects.toThrow(new RegExp(`task 1.*${status}`, "i"))
		const calledRunner = surface === "container" ? mocks.processTaskInContainer : mocks.processTask
		const otherRunner = surface === "container" ? mocks.processTask : mocks.processTaskInContainer
		expect(calledRunner.mock.calls.map(([input]) => input.taskId)).toEqual([1])
		expect(otherRunner).not.toHaveBeenCalled()
		expect(mocks.logInfo).toHaveBeenCalledWith(
			"campaign budget",
			expect.objectContaining({ consumedUsd: 0.01, reservedUsd: 0 }),
		)
		expect(trial.status).toBe(status)
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
		expect(mocks.updateTask).not.toHaveBeenCalled()
		expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
		expect(mocks.finishRun).not.toHaveBeenCalled()
		expect(mocks.stopHeartbeat).toHaveBeenCalledExactlyOnceWith(run.id, 1)
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"refuses the next governed task after unavailable or invalid actual cost %j",
		async (cost) => {
			mocks.processTask.mockImplementationOnce(async () => {
				tasks[0]!.finishedAt = new Date()
				tasks[0]!.taskMetrics = cost === null ? null : { cost }
			})
			await expect(runEvals(run.id)).rejects.toThrow(/actual cost.*task 1/i)
			expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
			expect(mocks.finishRun).not.toHaveBeenCalled()
			expect(mocks.stopHeartbeat).toHaveBeenCalledOnce()
			expect(mocks.closeLogger).toHaveBeenCalledOnce()
		},
	)

	it("refuses resumed governed admission when an earlier finished task has unknown spend", async () => {
		tasks[0]!.finishedAt = new Date()
		tasks[0]!.taskMetrics = null
		await expect(runEvals(run.id)).rejects.toThrow(/actual cost.*task 1/i)
		expect(mocks.processTask).not.toHaveBeenCalled()
		expect(mocks.findTrialForTask).not.toHaveBeenCalled()
		expect(mocks.finishRun).not.toHaveBeenCalled()
		expect(mocks.stopHeartbeat).toHaveBeenCalledOnce()
		expect(mocks.closeLogger).toHaveBeenCalledOnce()
	})

	it.each([
		{ surface: "local", status: "passed" },
		{ surface: "local", status: "outcome_failed" },
		{ surface: "container", status: "passed" },
		{ surface: "container", status: "outcome_failed" },
	])(
		"refuses $surface resume after $status with finite task cost but unknown presentation charges",
		async ({ surface, status }) => {
			mocks.isDockerContainer.mockReturnValue(surface === "container")
			tasks[0]!.finishedAt = new Date()
			tasks[0]!.taskMetrics = { cost: 0.01 }
			const trial = Object.freeze(terminalTrial(1, status))
			mocks.findTrialForTask.mockImplementation(async (taskId: number) =>
				taskId === 1 ? trial : terminalTrial(taskId),
			)
			mocks.getPresentationModelCallPolicyEvents.mockResolvedValue([])

			await expect(runEvals(run.id)).rejects.toThrow(/task 1.*presentation.*policy.*proof/i)
			expect(mocks.processTask).not.toHaveBeenCalled()
			expect(mocks.processTaskInContainer).not.toHaveBeenCalled()
			expect(tasks[0]!.taskMetrics).toEqual({ cost: 0.01 })
			expect(trial.status).toBe(status)
			expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
			expect(mocks.updateTask).not.toHaveBeenCalled()
			expect(mocks.finishRun).not.toHaveBeenCalled()
			expect(mocks.stopHeartbeat).toHaveBeenCalledOnce()
			expect(mocks.closeLogger).toHaveBeenCalledOnce()
		},
	)

	it.each([
		{ kind: "duplicate", records: () => [policyEvent(101), policyEvent(101)] },
		{ kind: "wrong attempt", records: () => [policyEvent(102)] },
		{ kind: "wrong type", records: () => [{ ...policyEvent(101), type: "extension.execution_identity" }] },
		{
			kind: "enabled presentation",
			records: () => [policyEvent(101, { ...presentationPolicy, presentationModelCalls: true })],
		},
		{
			kind: "unsupported capability",
			records: () => [policyEvent(101, { ...presentationPolicy, presentationModelCallOptOut: false })],
		},
		{ kind: "unknown schema", records: () => [policyEvent(101, { ...presentationPolicy, schemaVersion: 2 })] },
		{
			kind: "digest mismatch",
			records: () => [{ ...policyEvent(101), payloadDigest: `sha256:${"0".repeat(64)}` }],
		},
		{ kind: "late", records: () => [{ ...policyEvent(101), late: true }] },
	])("refuses completed $kind presentation policy evidence before new admission", async ({ records }) => {
		tasks[0]!.finishedAt = new Date()
		tasks[0]!.taskMetrics = { cost: 0.01 }
		mocks.getPresentationModelCallPolicyEvents.mockResolvedValue(records())
		await expect(runEvals(run.id)).rejects.toThrow(/task 1.*presentation.*policy.*proof/i)
		expect(mocks.processTask).not.toHaveBeenCalled()
		expect(mocks.processTaskInContainer).not.toHaveBeenCalled()
		expect(mocks.finishRun).not.toHaveBeenCalled()
	})

	it("does not let a later attempt's proof certify an earlier attempt's unknown presentation spend", async () => {
		tasks[0]!.finishedAt = new Date()
		tasks[0]!.taskMetrics = { cost: 0.01 }
		mocks.findTrialForTask.mockResolvedValue({ status: "passed", attempts: [{ id: 101 }, { id: 201 }] })
		mocks.getPresentationModelCallPolicyEvents.mockImplementation(async (attemptId: number) =>
			attemptId === 201 ? [policyEvent(201)] : [],
		)
		await expect(runEvals(run.id)).rejects.toThrow(/task 1.*presentation.*policy.*proof/i)
		expect(mocks.processTask).not.toHaveBeenCalled()
	})

	it("stops fresh continuation when a completed attempt did not persist its presentation policy", async () => {
		mocks.getPresentationModelCallPolicyEvents.mockResolvedValue([])
		await expect(runEvals(run.id)).rejects.toThrow(/task 1.*presentation.*policy.*proof/i)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
		expect(mocks.finishRun).not.toHaveBeenCalled()
	})

	it.each(["cancelled", "grader_error", "infrastructure_error", undefined, "pending", "running"])(
		"refuses resumed governed admission after a finished row with trial status %s",
		async (status) => {
			tasks[0]!.finishedAt = new Date()
			tasks[0]!.taskMetrics = { cost: 0.01 }
			const trial = status === undefined ? undefined : Object.freeze({ status })
			mocks.findTrialForTask.mockImplementation(async (taskId: number) =>
				taskId === 1 ? trial : { status: "passed" },
			)

			await expect(runEvals(run.id)).rejects.toThrow(new RegExp(`task 1.*${status ?? "missing trial"}`, "i"))
			expect(mocks.processTask).not.toHaveBeenCalled()
			expect(mocks.processTaskInContainer).not.toHaveBeenCalled()
			expect(tasks[0]!.taskMetrics).toEqual({ cost: 0.01 })
			expect(trial?.status).toBe(status)
			expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
			expect(mocks.updateTask).not.toHaveBeenCalled()
			expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
			expect(mocks.finishRun).not.toHaveBeenCalled()
			expect(mocks.stopHeartbeat).toHaveBeenCalledExactlyOnceWith(run.id, 1)
			expect(mocks.closeLogger).toHaveBeenCalledOnce()
		},
	)

	it.each([undefined, "pending", "running"])(
		"refuses the next governed dispatch when fresh grading leaves trial status %s",
		async (status) => {
			mocks.findTrialForTask.mockResolvedValue(status === undefined ? undefined : { status })

			await expect(runEvals(run.id)).rejects.toThrow(new RegExp(`task 1.*${status ?? "missing trial"}`, "i"))
			expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
			expect(mocks.logInfo).toHaveBeenCalledWith(
				"campaign budget",
				expect.objectContaining({ consumedUsd: 0.07, reservedUsd: 0 }),
			)
			expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
			expect(mocks.updateTask).not.toHaveBeenCalled()
			expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
			expect(mocks.finishRun).not.toHaveBeenCalled()
			expect(mocks.stopHeartbeat).toHaveBeenCalledExactlyOnceWith(run.id, 1)
			expect(mocks.closeLogger).toHaveBeenCalledOnce()
		},
	)

	it("preserves a cancellation admission stop when safety_failed masks it on a later invocation", async () => {
		const trial = Object.freeze({ status: "safety_failed" })
		mocks.findTrialForTask.mockImplementation(async (taskId: number) =>
			taskId === 1 ? trial : { status: "passed" },
		)
		mocks.processTask.mockImplementationOnce(async () => {
			tasks[0]!.finishedAt = new Date()
			tasks[0]!.taskMetrics = { cost: 0.01 }
			return "cancelled"
		})

		await expect(runEvals(run.id)).rejects.toThrow(/task 1.*cancelled/i)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
		await expect(runEvals(run.id)).rejects.toThrow(/task 1.*safety_failed/i)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1])
		expect(mocks.processTaskInContainer).not.toHaveBeenCalled()
		expect(trial.status).toBe("safety_failed")
		expect(tasks[0]!.taskMetrics).toEqual({ cost: 0.01 })
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
		expect(mocks.updateTask).not.toHaveBeenCalled()
		expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
		expect(mocks.finishRun).not.toHaveBeenCalled()
		expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(2)
		expect(mocks.closeLogger).toHaveBeenCalledTimes(2)
	})

	it.each([0, 0.01])("resumes after an ordinary graded failure with known cost %s", async (cost) => {
		tasks[0]!.finishedAt = new Date()
		tasks[0]!.taskMetrics = { cost }
		mocks.findTrialForTask.mockImplementation(async (taskId: number) => ({
			...terminalTrial(taskId, taskId === 1 ? "outcome_failed" : "passed"),
		}))

		await runEvals(run.id)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([2, 3])
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
		expect(mocks.finishRun).toHaveBeenCalledWith(run.id)
	})

	it.each([
		{ executionOutcome: "completed", status: "passed" },
		{ executionOutcome: "completed", status: "outcome_failed" },
		{ executionOutcome: "budget_exhausted", status: "budget_exhausted" },
	])("continues $status tasks when actual spend is known, including zero", async ({ executionOutcome, status }) => {
		mocks.findTrialForTask.mockImplementation(async (taskId: number) => terminalTrial(taskId, status))
		mocks.processTask.mockImplementation(async ({ taskId }: { taskId: number }) => {
			const task = tasks.find(({ id }) => id === taskId)!
			task.finishedAt = new Date()
			task.taskMetrics = { cost: taskId === 1 ? 0 : 0.01 }
			return executionOutcome
		})
		await runEvals(run.id)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1, 2, 3])
		expect(mocks.finishRun).toHaveBeenCalledWith(run.id)
	})

	it("keeps legacy best-effort task scheduling after a task failure", async () => {
		mocks.findRun.mockResolvedValue({ ...run, campaignHardCapUsd: null, taskCostCapUsd: null })
		mocks.processTask.mockRejectedValueOnce(new Error("legacy task failed"))
		await runEvals(run.id)
		expect(mocks.processTask.mock.calls.map(([input]) => input.taskId)).toEqual([1, 2, 3])
		expect(mocks.finishRun).toHaveBeenCalledWith(run.id)
	})
})
