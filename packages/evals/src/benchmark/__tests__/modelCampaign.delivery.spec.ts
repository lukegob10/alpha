import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { calibrationReportSchema, modelCalibrationStatusSchema } from "../contracts"
import { mergeModelCalibration } from "../modelCalibration"

const mocks = vi.hoisted(() => ({
	createRun: vi.fn(),
	createTask: vi.fn(),
	findTrialForTask: vi.fn(),
	getTasks: vi.fn(),
	getRuntimeVariantManifest: vi.fn(),
	runEvals: vi.fn(),
	loadBenchmarkCatalog: vi.fn(),
}))

vi.mock("../../db/index", () => mocks)
vi.mock("../../cli/runEvals", () => ({ runEvals: mocks.runEvals }))
vi.mock("../loader", () => ({ loadBenchmarkCatalog: mocks.loadBenchmarkCatalog }))

import { ingestModelCampaign, runBenchmarkModelCampaign } from "../modelCampaign"

function initialReport() {
	return calibrationReportSchema.parse({
		schemaVersion: 1,
		taskIdentity: "task@1",
		fixtureInitiallyFails: true,
		gold: { repetitions: 20, passed: 20 },
		broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [
			{
				model: "luna-high",
				repetitions: 5,
				passed: 5,
				trialIds: Array.from({ length: 5 }, (_, i) => `old-${i}`),
			},
		],
		humanReview: {
			unresolvedFalsePositivePasses: 0,
			reviewedTrialIds: ["old-0"],
			reviewer: "prior-reviewer",
			qualityApproved: true,
		},
		admitted: true,
	})
}

function barrier() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe("model campaign delivery accounting", () => {
	let root: string
	let reportPath: string
	let statuses: Array<string | undefined>

	beforeEach(async () => {
		vi.resetAllMocks()
		root = await fs.mkdtemp(path.join(os.tmpdir(), "model-campaign-delivery-"))
		reportPath = path.join(root, "calibration", "task.keyless.json")
		await fs.mkdir(path.dirname(reportPath))
		await fs.writeFile(reportPath, JSON.stringify(initialReport()))
		statuses = [
			"passed",
			"passed",
			"passed",
			"passed",
			"passed",
			undefined,
			"pending",
			"running",
			"infrastructure_error",
			"grader_error",
			"cancelled",
			"human_handoff",
		]
		mocks.getTasks.mockImplementation(async () =>
			statuses.map((_, index) => ({
				id: index + 1,
				benchmarkTaskIdentity: "task@1",
				benchmarkPartition: "development",
				iteration: index + 1,
			})),
		)
		mocks.findTrialForTask.mockImplementation(async (id: number) =>
			statuses[id - 1] === undefined
				? undefined
				: {
						id: `actual-trial-${id}`,
						status: statuses[id - 1],
						attemptCount: id === 1 ? 2 : 1,
						retryAssisted: id === 1,
					},
		)
		mocks.createRun.mockResolvedValue({ id: 42 })
		mocks.loadBenchmarkCatalog.mockResolvedValue({
			tasks: new Map([
				["task", { task: { id: "task", version: 1, partition: "development", fixture: "javascript/task" } }],
			]),
		})
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(root, { recursive: true, force: true })
	})

	async function readReport() {
		return calibrationReportSchema.parse(JSON.parse(await fs.readFile(reportPath, "utf8")))
	}

	async function ingest() {
		await ingestModelCampaign({ runId: 42, modelRole: "luna-high", publicRoot: root })
	}

	it("retains missing, pending, running, and excluded statuses without inflating scoreable repetitions", async () => {
		await ingest()
		const report = await readReport()
		expect(report.modelDelivery).toMatchObject([
			{
				model: "luna-high",
				runId: 42,
				scheduled: 12,
				scoreable: 5,
				excluded: 7,
				missing: 1,
				statusCounts: {
					passed: 5,
					missing: 1,
					pending: 1,
					running: 1,
					infrastructure_error: 1,
					grader_error: 1,
					cancelled: 1,
					human_handoff: 1,
				},
			},
		])
		expect(report.modelDelivery?.[0]?.trials[0]).toMatchObject({
			id: "run-42-task-1",
			status: "passed",
			attemptCount: 2,
			retryAssisted: true,
		})
		expect(report.models[0]).toMatchObject({ repetitions: 5, passed: 5 })
		expect(report.humanReview.qualityApproved).toBe(false)
	})

	it.each([["passed"], ["passed", "passed", "grader_error", undefined], Array(6).fill("infrastructure_error")])(
		"persists delivery-only evidence for an insufficient campaign: %j",
		async (...values) => {
			statuses = values
			await ingest()
			const report = await readReport()
			expect(report.modelDelivery?.[0]).toMatchObject({
				scheduled: statuses.length,
				scoreable: statuses.filter((status) => status === "passed").length,
			})
			expect(report.models).toEqual([])
			expect(report.humanReview).toMatchObject({ qualityApproved: false, reviewedTrialIds: [] })
			expect(report.admitted).toBe(false)
		},
	)

	it("updates a repeated ingest after pending settles without adding duplicate trials", async () => {
		await ingest()
		statuses[6] = "passed"
		await ingest()
		const report = await readReport()
		expect(report.modelDelivery).toHaveLength(1)
		expect(report.modelDelivery?.[0]).toMatchObject({
			scheduled: 12,
			scoreable: 6,
			excluded: 6,
			statusCounts: { pending: 0, passed: 6 },
		})
		expect(report.models[0]?.trialIds).toHaveLength(6)
	})

	it("preserves another arm, its delivery, and its review committed while trial queries are pending", async () => {
		const queried = barrier()
		const resume = barrier()
		mocks.findTrialForTask.mockImplementationOnce(async () => {
			queried.release()
			await resume.promise
			return { status: "passed", attemptCount: 2, retryAssisted: true }
		})
		const pending = ingest()
		await queried.promise
		const solTrials = Array.from({ length: 5 }, (_, index) => ({
			id: `sol-${index}`,
			taskIdentity: "task@1",
			model: "sol-high" as const,
			passed: true,
			unexpected: false,
			safetyFailed: false,
			reviewed: false,
		}))
		const updated = mergeModelCalibration(await readReport(), solTrials, {
			model: "sol-high",
			taskIdentity: "task@1",
			runId: 41,
			scheduled: 5,
			scoreable: 5,
			excluded: 0,
			missing: 0,
			statusCounts: Object.fromEntries(
				modelCalibrationStatusSchema.options.map((status) => [status, status === "passed" ? 5 : 0]),
			),
			trials: solTrials.map(({ id }) => ({ id, status: "passed" })),
		})
		updated.humanReview = {
			...updated.humanReview,
			reviewer: "current-reviewer",
			reviewedTrialIds: ["sol-0"],
			qualityApproved: true,
		}
		updated.admitted = true
		await fs.writeFile(reportPath, JSON.stringify(updated))
		resume.release()
		await pending
		const report = await readReport()
		expect(report.models.find(({ model }) => model === "sol-high")).toEqual(
			updated.models.find(({ model }) => model === "sol-high"),
		)
		expect(report.modelDelivery?.find(({ model }) => model === "sol-high")).toEqual(
			updated.modelDelivery?.find(({ model }) => model === "sol-high"),
		)
		expect(report.humanReview).toMatchObject({
			reviewer: "current-reviewer",
			reviewedTrialIds: ["sol-0"],
			qualityApproved: false,
		})
		expect(report.admitted).toBe(false)
	})

	it("keeps both model arms when their independent ingests finish querying together", async () => {
		statuses = Array<string>(5).fill("passed")
		const bothQueried = barrier()
		let firstQueries = 0
		mocks.findTrialForTask.mockImplementation(async (id: number) => {
			if (id === 1) {
				if (++firstQueries === 2) bothQueried.release()
				await bothQueried.promise
			}
			return { status: "passed", attemptCount: 1, retryAssisted: false }
		})
		await Promise.all([ingest(), ingestModelCampaign({ runId: 43, modelRole: "sol-high", publicRoot: root })])
		const report = await readReport()
		expect(report.models.map(({ model }) => model).sort()).toEqual(["luna-high", "sol-high"])
		expect(report.modelDelivery?.map(({ runId }) => runId).sort()).toEqual([42, 43])
	})

	it("does not recreate a control report removed while trial queries are pending", async () => {
		const queried = barrier()
		const resume = barrier()
		mocks.findTrialForTask.mockImplementationOnce(async () => {
			queried.release()
			await resume.promise
			return { status: "passed", attemptCount: 1, retryAssisted: false }
		})
		const pending = ingest()
		await queried.promise
		await fs.unlink(reportPath)
		resume.release()
		await pending
		await expect(fs.readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects a different task version published while trial queries are pending", async () => {
		const queried = barrier()
		const resume = barrier()
		mocks.findTrialForTask.mockImplementationOnce(async () => {
			queried.release()
			await resume.promise
			return { status: "passed", attemptCount: 1, retryAssisted: false }
		})
		const pending = ingest()
		await queried.promise
		const replacement = { ...initialReport(), taskIdentity: "task@2" }
		await fs.writeFile(reportPath, JSON.stringify(replacement))
		resume.release()
		await expect(pending).rejects.toThrow(/identity mismatch/i)
		expect(await readReport()).toEqual(replacement)
	})

	it("binds delivery to the run and model captured before awaiting task rows", async () => {
		const rows = await mocks.getTasks()
		let resolveRows!: (value: typeof rows) => void
		mocks.getTasks.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRows = resolve
				}),
		)
		const options: { runId: number; modelRole: "luna-high" | "sol-high"; publicRoot: string } = {
			runId: 42,
			modelRole: "luna-high",
			publicRoot: root,
		}
		const pending = ingestModelCampaign(options)
		options.runId = 99
		options.modelRole = "sol-high"
		resolveRows(rows)
		await pending
		const report = await readReport()
		expect(report.modelDelivery?.[0]).toMatchObject({ runId: 42, model: "luna-high" })
		expect(report.modelDelivery?.[0]?.trials[0]?.id).toBe("run-42-task-1")
	})

	it("captures campaign selection, model, and budget before awaiting the catalog", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-only-no-network")
		const catalog = await mocks.loadBenchmarkCatalog()
		let resolveCatalog!: (value: typeof catalog) => void
		mocks.loadBenchmarkCatalog.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCatalog = resolve
				}),
		)
		const options: Parameters<typeof runBenchmarkModelCampaign>[0] = {
			publicRoot: root,
			partition: "development",
			modelRole: "luna-high",
			modelId: "fixture-model",
			taskIds: ["task"],
			campaignBudget: {
				tier: "t1",
				taskCount: 1,
				iterations: 1,
				estimatedCostUsd: 0.04,
				taskReservationUsd: 0.08,
				reservedCostUsd: 0.08,
				hardCapUsd: 1,
				requiresExplicitApproval: false,
			},
		}
		const pending = runBenchmarkModelCampaign(options)
		options.modelRole = "sol-high"
		options.modelId = "unintended-model"
		options.taskIds![0] = "unintended-task"
		options.campaignBudget!.hardCapUsd = 99
		resolveCatalog(catalog)
		await expect(pending).resolves.toBe(42)
		expect(mocks.createRun).toHaveBeenCalledWith(
			expect.objectContaining({ model: "fixture-model", name: "luna-high:development", campaignHardCapUsd: 1 }),
		)
		expect((await readReport()).modelDelivery?.[0]?.model).toBe("luna-high")
	})

	it("records an aborted campaign's remaining rows before preserving its execution failure", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-only-no-network")
		const failure = new Error("owned host failed")
		mocks.runEvals.mockRejectedValue(failure)
		await expect(
			runBenchmarkModelCampaign({
				publicRoot: root,
				partition: "development",
				modelRole: "luna-high",
				modelId: "fixture-model",
				iterations: 12,
			}),
		).rejects.toBe(failure)
		expect((await readReport()).modelDelivery?.[0]).toMatchObject({ scheduled: 12, excluded: 7 })
	})

	it("records a partial scheduling failure without dispatching the incomplete campaign", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-only-no-network")
		const failure = new Error("task row creation failed")
		const created: Array<{
			id: number
			benchmarkTaskIdentity: string
			benchmarkPartition: string
			iteration: number
		}> = []
		mocks.createTask.mockImplementation(async (input) => {
			if (created.length === 2) throw failure
			created.push({ id: created.length + 1, ...input })
		})
		mocks.getTasks.mockImplementation(async () => created)
		statuses = [undefined, undefined]
		await expect(
			runBenchmarkModelCampaign({
				publicRoot: root,
				partition: "development",
				modelRole: "luna-high",
				modelId: "fixture-model",
				iterations: 12,
			}),
		).rejects.toBe(failure)
		expect(mocks.runEvals).not.toHaveBeenCalled()
		const report = await readReport()
		expect(report.modelDelivery?.[0]).toMatchObject({ scheduled: 2, scoreable: 0, excluded: 2, missing: 2 })
		expect(report.models).toEqual([])
		expect(report.humanReview.qualityApproved).toBe(false)
	})

	it("keeps execution failure primary when delivery ingestion also fails", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-only-no-network")
		const primary = new Error("owned host failed")
		const secondary = new Error("delivery read failed")
		mocks.runEvals.mockRejectedValue(primary)
		mocks.getTasks.mockRejectedValue(secondary)
		try {
			await runBenchmarkModelCampaign({
				publicRoot: root,
				partition: "development",
				modelRole: "luna-high",
				modelId: "fixture-model",
			})
			throw new Error("Expected campaign failure")
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError)
			expect((error as AggregateError).cause).toBe(primary)
			expect((error as AggregateError).errors).toEqual([primary, secondary])
		}
	})

	it("persists delivery despite evidence export failure without replacing an execution error", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-only-no-network")
		const primary = new Error("owned host failed")
		mocks.runEvals.mockRejectedValue(primary)
		await fs.writeFile(path.join(root, "run-42"), "owned collision")
		await expect(
			runBenchmarkModelCampaign({
				publicRoot: root,
				partition: "development",
				modelRole: "luna-high",
				modelId: "fixture-model",
				evidenceOutput: root,
			}),
		).rejects.toMatchObject({ cause: primary, errors: [primary, expect.objectContaining({ code: "EEXIST" })] })
		expect((await readReport()).modelDelivery?.[0]).toMatchObject({ scheduled: 12, excluded: 7 })
	})

	it("fails closed on an unknown status before replacing the saved calibration", async () => {
		statuses[0] = "unknown-status"
		await expect(ingest()).rejects.toThrow(/status/i)
		expect(await readReport()).toEqual(initialReport())
	})

	it("rejects mixed partitions for one task identity before writing", async () => {
		mocks.getTasks.mockImplementationOnce(async () =>
			statuses.map((_, index) => ({
				id: index + 1,
				benchmarkTaskIdentity: "task@1",
				benchmarkPartition: index === 0 ? "holdout" : "development",
				iteration: index + 1,
			})),
		)
		await expect(ingest()).rejects.toThrow(/partition/i)
		expect(await readReport()).toEqual(initialReport())
	})

	it("does not reinterpret an existing malformed trial as a missing row", async () => {
		mocks.findTrialForTask.mockResolvedValueOnce({ status: null })
		await expect(ingest()).rejects.toThrow(/status/i)
		expect(await readReport()).toEqual(initialReport())
	})

	it("rejects duplicate scheduled repetitions instead of counting them toward five", async () => {
		mocks.getTasks.mockResolvedValueOnce(
			Array.from({ length: 5 }, (_, index) => ({
				id: index + 1,
				benchmarkTaskIdentity: "task@1",
				benchmarkPartition: "development",
				iteration: 1,
			})),
		)
		await expect(ingest()).rejects.toThrow(/duplicate scheduled/i)
		expect(await readReport()).toEqual(initialReport())
	})

	it("retains a mostly excluded campaign denominator instead of reporting only its five successes", async () => {
		statuses = [...Array<string>(5).fill("passed"), ...Array<string>(95).fill("infrastructure_error")]
		await ingest()
		expect((await readReport()).modelDelivery?.[0]).toMatchObject({
			scheduled: 100,
			scoreable: 5,
			excluded: 95,
			statusCounts: { infrastructure_error: 95 },
		})
	})

	it("rejects a declared benchmark row with missing partition instead of hiding its scheduled count", async () => {
		mocks.getTasks.mockResolvedValueOnce([
			{ id: 1, benchmarkTaskIdentity: "task@1", benchmarkPartition: null, iteration: 1 },
		])
		await expect(ingest()).rejects.toThrow(/incomplete benchmark identity or partition/i)
		expect(await readReport()).toEqual(initialReport())
	})
})
