import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	createRun: vi.fn(),
	createTask: vi.fn(),
	findTrialForTask: vi.fn(),
	getTasks: vi.fn(),
	loadBenchmarkCatalog: vi.fn(),
	runEvals: vi.fn(),
}))

vi.mock("../../db/index", () => ({
	createRun: mocks.createRun,
	createTask: mocks.createTask,
	findTrialForTask: mocks.findTrialForTask,
	getTasks: mocks.getTasks,
}))

vi.mock("../../cli/runEvals", () => ({ runEvals: mocks.runEvals }))
vi.mock("../loader", () => ({ loadBenchmarkCatalog: mocks.loadBenchmarkCatalog }))

import { runBenchmarkModelCampaign } from "../modelCampaign"

describe("runBenchmarkModelCampaign", () => {
	const originalOpenAiApiKey = process.env.OPENAI_API_KEY

	beforeEach(() => {
		process.env.OPENAI_API_KEY = "test-key"
		mocks.createRun.mockResolvedValue({ id: 42 })
		mocks.createTask.mockResolvedValue({ id: 101 })
		mocks.findTrialForTask.mockResolvedValue(undefined)
		mocks.getTasks.mockResolvedValue([])
		mocks.loadBenchmarkCatalog.mockResolvedValue({
			tasks: new Map([
				[
					"task@1",
					{
						task: {
							id: "task",
							version: 1,
							partition: "development",
							fixture: "javascript/example",
						},
					},
				],
			]),
		})
	})

	afterEach(() => {
		vi.clearAllMocks()
		if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY
		else process.env.OPENAI_API_KEY = originalOpenAiApiKey
	})

	it("creates a VS Code run that the evaluator can execute", async () => {
		await runBenchmarkModelCampaign({
			publicRoot: "benchmarks",
			partition: "development",
			modelRole: "luna-high",
			modelId: "gpt-5.6-luna",
		})

		expect(mocks.createRun).toHaveBeenCalledWith(
			expect.objectContaining({
				executionMethod: "vscode",
				socketPath: "",
			}),
		)
		expect(mocks.runEvals).toHaveBeenCalledWith(42)
	})
})
