import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

import { canonicalJson, sha256 } from "../../evidence/index"
import { benchmarkSuiteManifestSchema, type BenchmarkCatalog, type CalibrationReport } from "../contracts"
import { auditFrontierRelease, releaseFrontierSuite } from "../release"
import { buildReviewSample } from "../reviewSampling"

const mocks = vi.hoisted(() => ({
	catalog: undefined as BenchmarkCatalog | undefined,
	digest: vi.fn(async () => `sha256:${"a".repeat(64)}`),
	writeLock: vi.fn(),
}))

vi.mock("../loader", () => ({
	loadBenchmarkCatalog: async () => mocks.catalog,
	digestBenchmarkDirectory: mocks.digest,
	writeBenchmarkReleaseLock: mocks.writeLock,
}))

let root: string
let publicRoot: string
let privateRoot: string
let reports: CalibrationReport[]
let sampleFile: string

async function writeSample(disagreementTrialIds: string[] = []): Promise<void> {
	await fs.writeFile(
		sampleFile,
		JSON.stringify(buildReviewSample(reports, { seed: "release-source", disagreementTrialIds })),
	)
}

describe("frontier release review-source binding", () => {
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "frontier-review-source-"))
		publicRoot = path.join(root, "public")
		privateRoot = path.join(root, "private")
		const suite = benchmarkSuiteManifestSchema.parse(
			parse(await fs.readFile(path.resolve(process.cwd(), "../../evals/frontier-v1.yaml"), "utf8")),
		)
		mocks.catalog = { suites: [suite], tasks: new Map() }
		mocks.digest.mockClear()
		mocks.writeLock.mockClear()
		reports = []
		for (const task of suite.tasks) {
			const trialIds = Array.from({ length: 5 }, (_, index) => `${task.id}-trial-${index}`)
			const report: CalibrationReport = {
				schemaVersion: 1,
				taskIdentity: `${task.id}@${task.version}`,
				fixtureInitiallyFails: true,
				restraint: false,
				gold: { repetitions: 20, passed: 20 },
				broken: ["one", "two", "three"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: id })),
				determinism: { repetitions: 50, distinctDigests: 1 },
				models: [
					{
						model: "luna-high",
						repetitions: 5,
						passed: 5,
						trialIds,
						unexpectedTrialIds: [],
						safetyFailureTrialIds: [],
					},
				],
				humanReview: {
					unresolvedFalsePositivePasses: 0,
					reviewedTrialIds: [...trialIds],
					reviewer: "fixture-reviewer",
					qualityApproved: true,
				},
				admitted: true,
			}
			reports.push(report)
			const reportRoot =
				task.partition === "holdout" ? path.join(privateRoot, "reports") : path.join(publicRoot, "calibration")
			await fs.mkdir(reportRoot, { recursive: true })
			await fs.writeFile(path.join(reportRoot, `${task.id}.keyless.json`), JSON.stringify(report))
			const fixtureRoot = path.join(task.partition === "holdout" ? privateRoot : publicRoot, task.fixture)
			await fs.mkdir(fixtureRoot, { recursive: true })
			await fs.writeFile(path.join(fixtureRoot, task.prompt), "Fixture prompt\n")
		}
		sampleFile = path.join(privateRoot, "reviews", `frontier-v1-review-sample-v${suite.version}.json`)
		await fs.mkdir(path.dirname(sampleFile), { recursive: true })
		await writeSample()
	})

	afterEach(async () => {
		if (root && root.startsWith(`${path.resolve(os.tmpdir())}${path.sep}frontier-review-source-`))
			await fs.rm(root, { recursive: true, force: true })
	})

	it("admits an independently supplied empty disagreement source and complete population", async () => {
		const audit = await auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds: [] })
		expect(audit).toMatchObject({ tasks: 40, reviewSampleReady: true, releaseReady: true, blockers: [] })
		const result = await releaseFrontierSuite({
			publicRoot,
			privateRoot,
			reviewer: "fixture-reviewer",
			disagreementTrialIds: [],
		})
		expect(result.suite.status).toBe("released")
		expect(mocks.writeLock).toHaveBeenCalledOnce()
	})

	it("blocks a sample with a deleted and resealed independent disagreement obligation", async () => {
		const base = buildReviewSample(reports, { seed: "release-source" })
		const disagreementTrialId = reports
			.flatMap(({ models }) => models[0]!.trialIds)
			.find((trialId) => !base.entries.some((entry) => entry.trialId === trialId))!
		await writeSample([disagreementTrialId])
		expect(
			(await auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds: [disagreementTrialId] }))
				.releaseReady,
		).toBe(true)
		await writeSample()
		expect(
			await auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds: [disagreementTrialId] }),
		).toMatchObject({ reviewSampleReady: false, releaseReady: false })
		await expect(
			releaseFrontierSuite({
				publicRoot,
				privateRoot,
				reviewer: "fixture-reviewer",
				disagreementTrialIds: [disagreementTrialId],
			}),
		).rejects.toThrow("does not match")
		expect(mocks.writeLock).not.toHaveBeenCalled()
		await expect(fs.access(path.join(publicRoot, "frontier-v1.yaml"))).rejects.toThrow()
	})

	it("blocks legacy sample release until a fresh population binding is generated", async () => {
		const {
			digest: _digest,
			populationDigest: _populationDigest,
			...body
		} = buildReviewSample(reports, { seed: "release-source" })
		await fs.writeFile(sampleFile, JSON.stringify({ ...body, digest: sha256(canonicalJson(body)) }))
		expect(await auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds: [] })).toMatchObject({
			reviewSampleReady: false,
			releaseReady: false,
			blockers: ["suite-level human-review sample requires a fresh complete population digest"],
		})
		await expect(
			releaseFrontierSuite({ publicRoot, privateRoot, reviewer: "fixture-reviewer", disagreementTrialIds: [] }),
		).rejects.toThrow("Legacy review sample lacks")
		expect(mocks.writeLock).not.toHaveBeenCalled()
	})

	it("does not interpret missing independent source as an empty disagreement list", async () => {
		await expect(
			auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds: undefined as never }),
		).rejects.toThrow("Independent")
		await expect(
			releaseFrontierSuite({
				publicRoot,
				privateRoot,
				reviewer: "fixture-reviewer",
				disagreementTrialIds: undefined as never,
			}),
		).rejects.toThrow("Independent")
		expect(mocks.writeLock).not.toHaveBeenCalled()
	})

	it.each(["audit", "release"] as const)(
		"retains independent obligations while %s awaits report input",
		async (operation) => {
			const base = buildReviewSample(reports, { seed: "release-source" })
			const disagreementTrialId = reports
				.flatMap(({ models }) => models[0]!.trialIds)
				.find((trialId) => !base.entries.some((entry) => entry.trialId === trialId))!
			const disagreementTrialIds = [disagreementTrialId]
			const pending =
				operation === "audit"
					? auditFrontierRelease({ publicRoot, privateRoot, disagreementTrialIds })
					: releaseFrontierSuite({
							publicRoot,
							privateRoot,
							reviewer: "fixture-reviewer",
							disagreementTrialIds,
						})
			disagreementTrialIds.length = 0
			if (operation === "audit") {
				expect(await pending).toMatchObject({ reviewSampleReady: false, releaseReady: false })
			} else {
				await expect(pending).rejects.toThrow("does not match")
			}
			expect(mocks.writeLock).not.toHaveBeenCalled()
		},
	)

	it("rejects otherwise admitted reports swapped between task filenames before publishing", async () => {
		const suite = mocks.catalog!.suites[0]!
		const first = suite.tasks[0]!
		const second = suite.tasks[1]!
		await fs.writeFile(path.join(publicRoot, "calibration", `${first.id}.keyless.json`), JSON.stringify(reports[1]))
		await fs.writeFile(
			path.join(publicRoot, "calibration", `${second.id}.keyless.json`),
			JSON.stringify(reports[0]),
		)
		await expect(
			releaseFrontierSuite({ publicRoot, privateRoot, reviewer: "fixture-reviewer", disagreementTrialIds: [] }),
		).rejects.toThrow("Calibration report identity mismatch")
		expect(mocks.digest).not.toHaveBeenCalled()
		expect(mocks.writeLock).not.toHaveBeenCalled()
	})
})
