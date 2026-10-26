import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { summarizeRunOutcomes } from "../../lifecycle/index"
import type { TrialTerminalStatus } from "../../lifecycle/types"

const mocks = vi.hoisted(() => ({
	createRun: vi.fn(),
	createTask: vi.fn(),
	runEvals: vi.fn(),
	getExercisesForLanguage: vi.fn(),
	findBenchmarkTask: vi.fn(),
	loadPrivateGraderBundle: vi.fn(),
}))
vi.mock("../../db/index", () => mocks)
vi.mock("../runEvals", () => ({ runEvals: mocks.runEvals }))
vi.mock("../../benchmark/loader", () => ({
	findBenchmarkTask: mocks.findBenchmarkTask,
	loadPrivateGraderBundle: mocks.loadPrivateGraderBundle,
}))
vi.mock("../../exercises/index", () => ({
	EVALS_REPO_PATH: "/fixture",
	exerciseLanguages: ["javascript"],
	getExercisesForLanguage: mocks.getExercisesForLanguage,
}))
import { runCi } from "../runCi"

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("EVALS_MODEL_ID", "fixture-model")
	mocks.createRun.mockResolvedValue({ id: 1 })
	mocks.getExercisesForLanguage.mockResolvedValue(["one", "two"])
	mocks.findBenchmarkTask.mockImplementation(async (_root, fixture) => ({ task: { id: fixture, graders: [] } }))
	mocks.loadPrivateGraderBundle.mockResolvedValue(undefined)
	mocks.runEvals.mockResolvedValue(
		summarizeRunOutcomes([
			{
				id: 1,
				finishedAt: new Date(0),
				trial: {
					status: "passed",
					finishedAt: new Date(0),
					attempts: [{ terminalStatus: "passed" }],
				},
			},
		]),
	)
})
afterEach(() => vi.unstubAllEnvs())

describe("CI evaluation acceptance", () => {
	it("preflights every selected fixture and private bundle before creating a run", async () => {
		const dispose = vi.fn(async () => {})
		mocks.loadPrivateGraderBundle.mockResolvedValue({ dispose })
		await expect(runCi()).resolves.toBeUndefined()
		expect(mocks.findBenchmarkTask.mock.calls).toEqual([
			["/fixture", "javascript/one"],
			["/fixture", "javascript/two"],
		])
		expect(dispose).toHaveBeenCalledTimes(2)
		expect(dispose.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.createRun.mock.invocationCallOrder[0]!)
	})

	it.each(["missing manifest", "missing private grader", "private grader digest mismatch"])(
		"rejects %s before creating paid work",
		async (reason) => {
			if (reason === "missing manifest") mocks.findBenchmarkTask.mockRejectedValue(new Error(reason))
			else mocks.loadPrivateGraderBundle.mockRejectedValue(new Error(reason))
			await expect(runCi()).rejects.toThrow(reason)
			expect(mocks.createRun).not.toHaveBeenCalled()
			expect(mocks.createTask).not.toHaveBeenCalled()
			expect(mocks.runEvals).not.toHaveBeenCalled()
		},
	)

	it("selects a stable sorted fixture prefix and rejects an empty selection before run creation", async () => {
		mocks.getExercisesForLanguage.mockResolvedValue(["two", "one"])
		await expect(runCi({ exercisesPerLanguage: 1 })).resolves.toBeUndefined()
		expect(mocks.createTask).toHaveBeenCalledExactlyOnceWith({ runId: 1, language: "javascript", exercise: "one" })
		vi.clearAllMocks()
		mocks.getExercisesForLanguage.mockResolvedValue([])
		await expect(runCi()).rejects.toThrow("at least one selected fixture")
		expect(mocks.createRun).not.toHaveBeenCalled()
	})

	it.each([
		"outcome_failed",
		"safety_failed",
		"budget_exhausted",
		"agent_error",
		"grader_error",
		"infrastructure_error",
	] as TrialTerminalStatus[])(
		"rejects a completed %s campaign instead of merely producing scores",
		async (status) => {
			mocks.runEvals.mockResolvedValue(
				summarizeRunOutcomes([
					{
						id: 1,
						finishedAt: new Date(0),
						trial: {
							status,
							finishedAt: new Date(0),
							attempts: [{ terminalStatus: status }],
						},
					},
				]),
			)
			await expect(runCi()).rejects.toThrow("acceptance failed")
		},
	)
	it("accepts only a complete passing campaign", async () => {
		mocks.runEvals.mockResolvedValue(
			summarizeRunOutcomes([
				{
					id: 1,
					finishedAt: new Date(0),
					trial: {
						status: "passed",
						finishedAt: new Date(0),
						attempts: [{ terminalStatus: "passed" }],
					},
				},
			]),
		)
		await expect(runCi()).resolves.toBeUndefined()
	})
})
