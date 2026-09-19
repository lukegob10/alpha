import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
				settings: expect.objectContaining({ apiProvider: "openai", openAiModelId: "gpt-5.6-luna" }),
			}),
		)
		expect(mocks.runEvals).toHaveBeenCalledWith(42)
	})
	it("rejects a retired provider before creating a campaign", async () => {
		await expect(
			runBenchmarkModelCampaign({
				publicRoot: "benchmarks",
				partition: "development",
				modelRole: "luna-high",
				modelId: "test-model",
				provider: "openrouter" as never,
			}),
		).rejects.toThrow("Unsupported campaign provider: openrouter")
		expect(mocks.createRun).not.toHaveBeenCalled()
	})
	it("exports available lifecycle evidence but cannot attest an installed extension from fixture identity", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-export-"))
		try {
			await runBenchmarkModelCampaign({
				publicRoot: "benchmarks",
				partition: "development",
				modelRole: "luna-high",
				modelId: "gpt-5.6-luna",
				evidenceOutput: directory,
			})
			const receipt = JSON.parse(await fs.readFile(path.join(directory, "run-42", "campaign.json"), "utf8"))
			expect(receipt.variant).toBeNull()
			expect(receipt.incomplete[0].reason).toContain("executed_harness_unavailable")
			expect(
				JSON.parse(await fs.readFile(path.join(directory, "run-42", "lifecycle.json"), "utf8")),
			).toMatchObject({ runId: 42, model: "gpt-5.6-luna", trials: [] })
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
	it("retains both the execution failure and evidence export failure", async () => {
		const execution = new Error("execution failed")
		const evidence = new Error("evidence failed")
		mocks.runEvals.mockRejectedValueOnce(execution)
		mocks.getTasks.mockRejectedValueOnce(evidence)
		await expect(
			runBenchmarkModelCampaign({
				publicRoot: "benchmarks",
				partition: "development",
				modelRole: "luna-high",
				modelId: "gpt-5.6-luna",
				evidenceOutput: "unused",
			}),
		).rejects.toMatchObject({ errors: [execution, evidence] })
	})
})
