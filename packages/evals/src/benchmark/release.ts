import fs from "node:fs/promises"
import path from "node:path"

import { stringify } from "yaml"

import { sha256 } from "../evidence/index"
import { evaluateAdmission } from "./admission"
import { calibrationReportSchema, type BenchmarkSuiteManifest } from "./contracts"
import { assertKeylessCalibrationComplete } from "./calibration"
import { validateReviewSample, type ReviewSampleManifest } from "./reviewSampling"
import { digestBenchmarkDirectory, loadBenchmarkCatalog, writeBenchmarkReleaseLock } from "./loader"

export async function releaseFrontierSuite(options: {
	publicRoot: string
	privateRoot: string
	reviewer: string
}): Promise<{ suite: BenchmarkSuiteManifest; output: string }> {
	if (!options.reviewer.trim()) throw new Error("A human reviewer identity is required to release a benchmark")
	const catalog = await loadBenchmarkCatalog(options.publicRoot)
	const current = catalog.suites.find(({ id }) => id === "frontier-v1")
	if (!current) throw new Error("frontier-v1 suite is missing")
	validateFrontierBankShape(current)
	const tasks = []
	const reports = []
	for (const task of current.tasks) {
		const reportRoot =
			task.partition === "holdout"
				? path.join(options.privateRoot, "reports")
				: path.join(options.publicRoot, "calibration")
		const reportFile = path.join(reportRoot, `${task.id}.keyless.json`)
		const result = evaluateAdmission(JSON.parse(await fs.readFile(reportFile, "utf8")))
		if (!result.admitted || !result.report)
			throw new Error(
				`Task ${task.id} has not passed admission: ${result.issues.map(({ code }) => code).join(", ")}`,
			)
		reports.push(result.report)
		const fixtureRoot =
			task.partition === "holdout"
				? path.join(options.privateRoot, task.fixture)
				: path.join(options.publicRoot, task.fixture)
		const fixtureDigest = await digestBenchmarkDirectory(fixtureRoot)
		const promptDigest = sha256(await fs.readFile(path.join(fixtureRoot, task.prompt)))
		tasks.push({
			...task,
			admission: "admitted" as const,
			fixtureDigest,
			promptDigest,
			repository: { ...task.repository, snapshotDigest: fixtureDigest },
		})
	}
	await assertReviewSampleComplete(options.privateRoot, current.version, reports)
	const suite: BenchmarkSuiteManifest = { ...current, status: "released", tasks }
	const output = path.join(options.publicRoot, "frontier-v1.yaml")
	await fs.writeFile(output, stringify(suite, { lineWidth: 120 }))
	await writeBenchmarkReleaseLock(options.publicRoot, suite)
	return { suite, output }
}

export type FrontierReleaseAudit = {
	tasks: number
	keylessComplete: number
	lunaCalibrated: number
	qualityApproved: number
	reviewSampleReady: boolean
	admissionReady: number
	releaseReady: boolean
	blockers: string[]
}

export async function auditFrontierRelease(options: {
	publicRoot: string
	privateRoot: string
}): Promise<FrontierReleaseAudit> {
	const catalog = await loadBenchmarkCatalog(options.publicRoot)
	const current = catalog.suites.find(({ id }) => id === "frontier-v1")
	if (!current) throw new Error("frontier-v1 suite is missing")
	validateFrontierBankShape(current)
	let keylessComplete = 0
	let lunaCalibrated = 0
	let qualityApproved = 0
	let admissionReady = 0
	const reports = []
	for (const task of current.tasks) {
		const reportRoot =
			task.partition === "holdout"
				? path.join(options.privateRoot, "reports")
				: path.join(options.publicRoot, "calibration")
		const report = calibrationReportSchema.parse(
			JSON.parse(await fs.readFile(path.join(reportRoot, `${task.id}.keyless.json`), "utf8")),
		)
		reports.push(report)
		if (report.taskIdentity !== `${task.id}@${task.version}`)
			throw new Error(`Calibration report identity mismatch for ${task.id}`)
		try {
			assertKeylessCalibrationComplete(report)
			keylessComplete++
		} catch {
			// The aggregate below intentionally does not expose private task identities.
		}
		if (report.models.some(({ model, repetitions }) => model === "luna-high" && repetitions >= 5)) lunaCalibrated++
		if (report.humanReview.qualityApproved && report.humanReview.reviewer.trim()) qualityApproved++
		if (evaluateAdmission({ ...report, admitted: true }).admitted) admissionReady++
	}
	const tasks = current.tasks.length
	const blockers: string[] = []
	let reviewSampleReady = false
	try {
		await assertReviewSampleComplete(options.privateRoot, current.version, reports)
		reviewSampleReady = true
	} catch {
		blockers.push("suite-level deterministic human-review sample is incomplete")
	}
	if (keylessComplete !== tasks) blockers.push(`${tasks - keylessComplete} task(s) lack complete keyless evidence`)
	if (lunaCalibrated !== tasks) blockers.push(`${tasks - lunaCalibrated} task(s) lack five Luna High trials`)
	if (qualityApproved !== tasks) blockers.push(`${tasks - qualityApproved} task(s) lack authorized quality review`)
	if (admissionReady !== tasks) blockers.push(`${tasks - admissionReady} task(s) are not admission-ready`)
	return {
		tasks,
		keylessComplete,
		lunaCalibrated,
		qualityApproved,
		reviewSampleReady,
		admissionReady,
		releaseReady: blockers.length === 0,
		blockers,
	}
}

async function assertReviewSampleComplete(
	privateRoot: string,
	suiteVersion: number,
	reports: ReturnType<typeof calibrationReportSchema.parse>[],
): Promise<void> {
	const file = path.join(privateRoot, "reviews", `frontier-v1-review-sample-v${suiteVersion}.json`)
	const manifest = JSON.parse(await fs.readFile(file, "utf8")) as ReviewSampleManifest
	validateReviewSample(reports, manifest)
}

export function validateFrontierBankShape(suite: BenchmarkSuiteManifest): void {
	if (suite.tasks.length !== 40) throw new Error(`frontier-v1 requires exactly 40 tasks; found ${suite.tasks.length}`)
	assertCounts(
		suite.tasks.map(({ partition }) => partition),
		{ development: 20, regression: 8, holdout: 12 },
		"partition",
	)
	assertCounts(
		suite.tasks.map(({ family }) => family),
		{ "real-repository": 16, "alpha-extension": 8, "safety-stateful": 8, "long-horizon": 8 },
		"family",
	)
	assertCounts(
		suite.tasks.map(({ difficulty }) => difficulty),
		{ foundation: 10, challenging: 20, frontier: 10 },
		"difficulty",
	)
}

function assertCounts(values: string[], expected: Record<string, number>, label: string): void {
	const actual = Object.fromEntries(
		[...new Set(values)].map((value) => [value, values.filter((item) => item === value).length]),
	)
	for (const [value, count] of Object.entries(expected))
		if (actual[value] !== count)
			throw new Error(`Expected ${count} ${label}=${value} tasks; found ${actual[value] ?? 0}`)
}
