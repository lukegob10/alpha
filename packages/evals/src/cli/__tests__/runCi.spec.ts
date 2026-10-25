import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { summarizeRunOutcomes } from "../../lifecycle/index"
import type { TrialTerminalStatus } from "../../lifecycle/types"

const mocks = vi.hoisted(() => ({ createRun: vi.fn(), createTask: vi.fn(), runEvals: vi.fn() }))
vi.mock("../../db/index", () => mocks)
vi.mock("../runEvals", () => ({ runEvals: mocks.runEvals }))
vi.mock("../../exercises/index", () => ({
	EVALS_REPO_PATH: "/fixture",
	exerciseLanguages: ["javascript"],
	getExercisesForLanguage: async () => ["one", "two"],
}))
import { runCi } from "../runCi"

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("EVALS_MODEL_ID", "fixture-model")
	mocks.createRun.mockResolvedValue({ id: 1 })
})
afterEach(() => vi.unstubAllEnvs())

describe("CI evaluation acceptance", () => {
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
