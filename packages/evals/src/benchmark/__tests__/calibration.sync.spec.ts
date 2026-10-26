import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

import { syncVisibleKeylessReports } from "../calibration"
import {
	benchmarkSuiteManifestSchema,
	calibrationReportSchema,
	modelCalibrationStatusSchema,
	type BenchmarkCatalog,
	type CalibrationReport,
} from "../contracts"
import { mergeModelCalibration } from "../modelCalibration"

let catalog: BenchmarkCatalog
let root: string
let publicRoot: string
let privateRoot: string
const firstId = "sync-task-00"

function keyless(taskIdentity = `${firstId}@1`): CalibrationReport {
	return calibrationReportSchema.parse({
		schemaVersion: 1,
		taskIdentity,
		fixtureInitiallyFails: true,
		gold: { repetitions: 20, passed: 20 },
		broken: ["one", "two", "three"].map((id) => ({
			id,
			repetitions: 20,
			rejected: 20,
			expectedCode: "wrong-output",
		})),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [],
		humanReview: { unresolvedFalsePositivePasses: 0, reviewedTrialIds: [], reviewer: "", qualityApproved: false },
		admitted: false,
	})
}

function withModel(report: CalibrationReport, model: "luna-high" | "sol-high", prefix: string): CalibrationReport {
	const trials = Array.from({ length: 5 }, (_, index) => ({
		id: `${prefix}-${index}`,
		taskIdentity: report.taskIdentity,
		model,
		passed: true,
		unexpected: false,
		safetyFailed: false,
		reviewed: true,
	}))
	return mergeModelCalibration(report, trials, {
		model,
		taskIdentity: report.taskIdentity,
		runId: 42,
		scheduled: 6,
		scoreable: 5,
		excluded: 1,
		missing: 0,
		statusCounts: Object.fromEntries(
			modelCalibrationStatusSchema.options.map((status) => [
				status,
				status === "passed" ? 5 : status === "infrastructure_error" ? 1 : 0,
			]),
		),
		trials: [
			...trials.map(({ id }) => ({ id, status: "passed", attemptCount: 1, retryAssisted: false })),
			{ id: `${prefix}-excluded`, status: "infrastructure_error", attemptCount: 2, retryAssisted: true },
		],
	})
}

const output = () => path.join(publicRoot, "calibration", `${firstId}.keyless.json`)
const source = () => path.join(privateRoot, "reports", `${firstId}.keyless.json`)
const save = (file: string, report: CalibrationReport) => fs.writeFile(file, JSON.stringify(report) + "\n")
const read = async () => calibrationReportSchema.parse(JSON.parse(await fs.readFile(output(), "utf8")))
const sync = () => syncVisibleKeylessReports({ catalog, publicRoot, privateRoot })

function barrier(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

beforeAll(async () => {
	const suite = benchmarkSuiteManifestSchema.parse(
		parse(await fs.readFile(new URL("../../../../../evals/frontier-v1.yaml", import.meta.url), "utf8")),
	)
	catalog = {
		suites: [suite],
		tasks: new Map(
			Array.from({ length: 28 }, (_, index) => {
				const task = { ...suite.tasks[0]!, id: `sync-task-${String(index).padStart(2, "0")}`, version: 1 }
				return [`${task.id}@1`, { suite, task: { ...task, partition: "development" as const } }]
			}),
		),
	}
})

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "calibration-sync-"))
	publicRoot = path.join(root, "public")
	privateRoot = path.join(root, "private")
	await fs.mkdir(path.join(publicRoot, "calibration"), { recursive: true })
	await fs.mkdir(path.join(privateRoot, "reports"), { recursive: true })
	for (const { task } of catalog.tasks.values())
		await save(path.join(privateRoot, "reports", `${task.id}.keyless.json`), keyless(`${task.id}@1`))
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

describe("visible keyless report synchronization", () => {
	it("syncs a new version into its own report without inheriting the old version's model admission", async () => {
		const previous = withModel(keyless(), "luna-high", "historical")
		previous.humanReview.qualityApproved = true
		previous.admitted = true
		await save(output(), previous)
		const previousBytes = await fs.readFile(output())
		const privateBytes = await fs.readFile(source())
		const revised = keyless(`${firstId}@2`)
		await save(path.join(privateRoot, "reports", `${firstId}@2.keyless.json`), revised)
		const tasks = new Map(catalog.tasks)
		const entry = tasks.get(`${firstId}@1`)!
		tasks.delete(`${firstId}@1`)
		tasks.set(`${firstId}@2`, { ...entry, task: { ...entry.task, version: 2 } })
		await syncVisibleKeylessReports({ catalog: { ...catalog, tasks }, publicRoot, privateRoot })
		expect(
			JSON.parse(await fs.readFile(path.join(publicRoot, "calibration", `${firstId}@2.keyless.json`), "utf8")),
		).toEqual(revised)
		expect(await fs.readFile(output())).toEqual(previousBytes)
		expect(await fs.readFile(source())).toEqual(privateBytes)
	})

	it("preserves visible delivery, model observations, and approval together instead of importing private arms", async () => {
		const visible = withModel(keyless(), "luna-high", "visible")
		visible.humanReview.reviewer = "visible-reviewer"
		visible.humanReview.qualityApproved = true
		visible.admitted = true
		await save(output(), visible)
		await save(source(), withModel(keyless(), "sol-high", "private"))
		await sync()
		const actual = await read()
		expect(actual.modelDelivery).toEqual(visible.modelDelivery)
		expect(actual.models).toEqual(visible.models)
		expect(actual.humanReview).toEqual(visible.humanReview)
		expect(actual.admitted).toBe(true)
	})

	it("retains an unknown legacy delivery denominator when private model delivery is unrelated", async () => {
		const visible = withModel(keyless(), "luna-high", "legacy")
		delete visible.modelDelivery
		await save(output(), visible)
		await save(source(), withModel(keyless(), "sol-high", "private"))
		await sync()
		const actual = await read()
		expect(actual.models).toEqual(visible.models)
		expect(actual.modelDelivery).toBeUndefined()
	})

	it("invalidates quality approval and admission when keyless control evidence changes", async () => {
		const visible = withModel(keyless(), "luna-high", "visible")
		visible.humanReview.reviewer = "visible-reviewer"
		visible.humanReview.qualityApproved = true
		visible.admitted = true
		await save(output(), visible)
		await save(source(), { ...keyless(), gold: { repetitions: 21, passed: 21 } })
		await sync()
		const actual = await read()
		expect(actual.gold).toEqual({ repetitions: 21, passed: 21 })
		expect(actual.models).toEqual(visible.models)
		expect(actual.modelDelivery).toEqual(visible.modelDelivery)
		expect(actual.humanReview).toEqual({ ...visible.humanReview, qualityApproved: false })
		expect(actual.admitted).toBe(false)
	})

	it("does not invalidate approval for formatting or normalized legacy defaults", async () => {
		const visible = withModel(keyless(), "luna-high", "visible")
		visible.humanReview.reviewer = "visible-reviewer"
		visible.humanReview.qualityApproved = true
		visible.admitted = true
		const { restraint: _restraint, ...legacy } = visible
		await fs.writeFile(output(), JSON.stringify(legacy, null, 4))
		await sync()
		const actual = await read()
		expect(actual.humanReview).toEqual(visible.humanReview)
		expect(actual.admitted).toBe(true)
	})

	it("keeps the visible bytes intact when the replacement keyless controls are incomplete", async () => {
		await save(output(), withModel(keyless(), "luna-high", "visible"))
		const bytes = await fs.readFile(output(), "utf8")
		await save(source(), { ...keyless(), gold: { repetitions: 20, passed: 19 } })
		await expect(sync()).rejects.toThrow(/unstable gold/)
		expect(await fs.readFile(output(), "utf8")).toBe(bytes)
	})

	it("captures task identities and root paths before awaiting private report reads", async () => {
		const options = { catalog: structuredClone(catalog), publicRoot, privateRoot }
		const entered = barrier()
		const resume = barrier()
		const readFile = fs.readFile.bind(fs)
		vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
			const bytes = await readFile(...args)
			entered.resolve()
			await resume.promise
			return bytes
		})
		const pending = syncVisibleKeylessReports(options)
		await entered.promise
		options.publicRoot = path.join(root, "other-public")
		options.privateRoot = path.join(root, "other-private")
		options.catalog.tasks.get(`${firstId}@1`)!.task.id = "changed-after-start"
		options.catalog.tasks.get(`${firstId}@1`)!.task.version = 9
		resume.resolve()
		expect((await pending).taskIds[0]).toBe(firstId)
		expect(
			JSON.parse(await fs.readFile(path.join(publicRoot, "calibration", `${firstId}@1.keyless.json`), "utf8"))
				.taskIdentity,
		).toBe(`${firstId}@1`)
		await expect(fs.stat(options.publicRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("merges model delivery and review committed after the private source read", async () => {
		const visible = withModel(keyless(), "luna-high", "visible")
		await save(output(), visible)
		const persistence = await import("../calibrationStore")
		const transact = persistence.updateCalibrationReport
		let concurrent: CalibrationReport | undefined
		vi.spyOn(persistence, "updateCalibrationReport").mockImplementationOnce(async (file, update, options) => {
			await transact(file, (current) => {
				if (!current) throw new Error("Expected the existing visible calibration")
				concurrent = withModel(current, "sol-high", "concurrent")
				concurrent.humanReview.reviewer = "concurrent-reviewer"
				concurrent.humanReview.qualityApproved = true
				concurrent.admitted = true
				return concurrent
			})
			return transact(file, update, options)
		})
		await sync()
		expect(concurrent).toBeDefined()
		const actual = await read()
		expect(actual.models).toEqual(concurrent!.models)
		expect(actual.modelDelivery).toEqual(concurrent!.modelDelivery)
		expect(actual.humanReview).toEqual(concurrent!.humanReview)
		expect(actual.admitted).toBe(true)
	})

	it("rejects an explicit versioned report that belongs to a different task version without changing its bytes", async () => {
		const visible = keyless(`${firstId}@2`)
		const versioned = path.join(publicRoot, "calibration", `${firstId}@1.keyless.json`)
		await save(versioned, visible)
		const bytes = await fs.readFile(versioned, "utf8")
		await expect(sync()).rejects.toThrow(/identity mismatch/)
		expect(await fs.readFile(versioned, "utf8")).toBe(bytes)
	})
})
