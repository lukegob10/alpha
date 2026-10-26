import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import type { CalibrationReport, ModelCalibrationDelivery } from "../contracts"
import { convergenceEvidence } from "./fixtures/convergenceEvidence"
import { holdoutEvidence } from "./fixtures/holdoutEvidence"

const entrypoint = fileURLToPath(new URL("../cli.ts", import.meta.url))
const convergence = fileURLToPath(new URL("../convergence.ts", import.meta.url))
const calibrationStore = fileURLToPath(new URL("../calibrationStore.ts", import.meta.url))
const modelCalibration = fileURLToPath(new URL("../modelCalibration.ts", import.meta.url))
const admission = fileURLToPath(new URL("../admission.ts", import.meta.url))
const tsx = createRequire(import.meta.url).resolve("tsx")

type DependencyCall = { name: string; arguments: unknown[]; undefinedArgumentIndexes?: number[] }

async function runCli({
	command,
	args = [],
	configuration = {},
	inputFiles = {},
	rawInputFiles = {},
	realGate = false,
	realStore = false,
	outputFiles = [],
}: {
	command: string
	args?: string[]
	configuration?: Record<string, unknown>
	inputFiles?: Record<string, unknown>
	rawInputFiles?: Record<string, string>
	realGate?: boolean
	realStore?: boolean
	outputFiles?: string[]
}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-cli-provenance-"))
	const callsFile = path.join(directory, "calls.jsonl")
	const fixture = path.join(directory, "fixture.mjs")
	const preload = path.join(directory, "preload.mjs")
	const contents = {
		...Object.fromEntries(Object.entries(inputFiles).map(([name, value]) => [name, JSON.stringify(value)])),
		...rawInputFiles,
	}
	const files = Object.fromEntries(Object.keys(contents).map((name) => [name, path.join(directory, name)]))
	let child: ReturnType<typeof spawn> | undefined
	try {
		for (const [name, value] of Object.entries(contents)) {
			await fs.mkdir(path.dirname(files[name]!), { recursive: true })
			await fs.writeFile(files[name]!, value)
		}
		await fs.writeFile(
			fixture,
			`import { appendFileSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
${realGate ? `import { evaluateFrontierConvergence as actualGate } from ${JSON.stringify(pathToFileURL(convergence).href)}` : ""}
${
	realStore
		? `import { mergeModelCalibration as actualMerge } from ${JSON.stringify(pathToFileURL(modelCalibration).href)}
import { evaluateAdmission as actualAdmission } from ${JSON.stringify(pathToFileURL(admission).href)}`
		: ""
}
const configuration = ${JSON.stringify(configuration)}
const record = (name, ...args) => {
	const undefinedArgumentIndexes = args.flatMap((value, index) => value === undefined ? [index] : [])
	appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ name, arguments: args, ...(undefinedArgumentIndexes.length ? { undefinedArgumentIndexes } : {}) }) + "\\n")
}
const unused = () => { throw new Error("Unexpected CLI dependency call") }
export default async (values, callback) => Promise.all(values.map(callback))
export const EVALS_REPO_PATH = ${JSON.stringify(directory)}
export const DEFAULT_BENCHMARK_SUBSET_FILE = "frontier-t1-v6.yaml"
export const disconnect = async () => {}
export const disconnectRedis = async () => {}
export const findRun = async () => ({ campaignTier: "t1", modelFallbackAllowed: false, settings: { reasoningEffort: "high" } })
export const getTasks = async () => configuration.tasks ?? [{ id: 1, benchmarkTaskIdentity: "fixture-task@2", iteration: 1, taskMetrics: { cost: 0.03, duration: 125 } }]
export const findTrialForTask = async () => ({ status: "passed" })
export const loadBenchmarkCatalog = async () => ({ suites: [{ id: "frontier-v1", version: 3, tasks: [{ id: "fixture-task", version: 2, partition: "development" }] }], tasks: new Map([["fixture-task@2", { task: { id: "fixture-task", version: 2, partition: "development" } }]]) })
export const loadBenchmarkSubset = async () => ({ historyBasis: "seeded-prior-from-legacy-baseline" })
export const selectBenchmarkSubset = () => ({ tasks: [{ id: "fixture-task", version: 2 }] })
export const applySubsetMeasurements = (...args) => {
	record("applySubsetMeasurements", ...args)
	return { ...args[0], historyBasis: "measured" }
}
export const auditFrontierRelease = async (...args) => {
	record("auditFrontierRelease", ...args)
	return { releaseReady: true, blockers: [] }
}
export const releaseFrontierSuite = async (...args) => {
	record("releaseFrontierSuite", ...args)
	return { suite: { tasks: [] }, output: "fixture-release.yaml" }
}
export const calibrationReportSchema = { parse: (value) => value }
export class CalibrationReportValidationError extends Error {}
export const buildReviewSample = (...args) => {
	record("buildReviewSample", ...args)
	return { population: 5, randomSampleSize: 1, selectedTrialCount: 1, digest: "fixture-review-digest" }
}
export const evaluateFrontierConvergence = (...args) => {
	record("evaluateFrontierConvergence", ...args)
	return ${realGate ? "actualGate(...args)" : "configuration.gateDecision ?? { promote: true, reasons: [] }"}
}
export const mergeModelCalibration = (...args) => {
	record("mergeModelCalibration", ...args)
	const [report, trials, delivery] = args
	return ${realStore ? "actualMerge(...args)" : '{ ...report, models: [{ model: "luna-high", repetitions: trials.length }], modelDelivery: delivery === undefined ? undefined : [delivery] }'}
}
export const readCalibrationReport = async (file) => {
	try {
		const bytes = await fs.readFile(file)
		return { report: JSON.parse(bytes), revision: "sha256:" + createHash("sha256").update(bytes).digest("hex") }
	} catch (error) {
		if (error.code === "ENOENT") return { report: undefined, revision: null }
		throw error
	}
}
export const resolveCalibrationReportPath = async (directory, identity) =>
	directory + "/" + identity.slice(0, identity.lastIndexOf("@")) + ".keyless.json"
export const updateCalibrationReport = async (file, updater, options = {}) => {
	const current = await readCalibrationReport(file)
	if (Object.hasOwn(options, "expectedRevision") && options.expectedRevision !== current.revision)
		throw new Error("Calibration report revision conflict")
	const report = updater(current.report)
	if (report === undefined) return current
	await fs.writeFile(file, JSON.stringify(report, null, 2) + "\\n")
	return readCalibrationReport(file)
}
export const evaluateAdmission = (...args) => {
	const result = ${realStore ? "actualAdmission(...args)" : "unused()"}
	if (configuration.replaceDuringAdmission)
		writeFileSync(${JSON.stringify(path.join(directory, "report.json"))}, JSON.stringify(configuration.replaceDuringAdmission))
	return result
}
export const runKeylessCalibration = async () => {
	if (configuration.replaceDuringCalibration)
		await fs.writeFile(${JSON.stringify(path.join(directory, "calibration", "fixture-task.keyless.json"))}, JSON.stringify(configuration.replaceDuringCalibration))
	return configuration.generatedReport
}
export const stringify = JSON.stringify
${[
	"buildPairedExperimentReport",
	"reportCampaignPair",
	"renderCampaignPair",
	"exportHostCampaign",
	"declareCampaignPair",
	"syncVisibleKeylessReports",
	"runBenchmarkModelCampaign",
	"loadPrivateGraderBundle",
	"runAuthoringCheck",
	"writeTaskTemplate",
	"assertCampaignBudgetAuthorized",
	"estimateTierBudget",
	"certifyInitialFixtureStates",
]
	.map((name) => `export const ${name} = unused`)
	.join("\n")}
`,
		)
		// Only the real CLI's direct dependencies are replaced; argument parsing, file reads, and writes still execute.
		await fs.writeFile(
			preload,
			`import { registerHooks } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"
const mutation = ${JSON.stringify(configuration.readMutation ?? null)}
if (mutation) {
	const original = fs.readFile.bind(fs)
	let changed = false
	fs.readFile = async (file, ...args) => {
		const value = await original(file, ...args)
		if (!changed && String(file) === path.join(${JSON.stringify(directory)}, mutation.trigger)) {
			changed = true
			await fs.writeFile(path.join(${JSON.stringify(directory)}, mutation.target), JSON.stringify(mutation.report))
		}
		return value
	}
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (${realStore} && context.parentURL === ${JSON.stringify(pathToFileURL(entrypoint).href)} && specifier === "./calibrationStore")
			return { url: ${JSON.stringify(pathToFileURL(calibrationStore).href)}, shortCircuit: true }
		if (context.parentURL === ${JSON.stringify(pathToFileURL(entrypoint).href)} && !specifier.startsWith("node:"))
			return { url: ${JSON.stringify(pathToFileURL(fixture).href)}, shortCircuit: true }
		return nextResolve(specifier, context)
	}
})

`,
		)
		child = spawn(
			process.execPath,
			[
				...(realGate || realStore ? ["--import", pathToFileURL(tsx).href] : []),
				"--import",
				pathToFileURL(preload).href,
				entrypoint,
				command,
				...args.map((arg) => (arg.startsWith("file:") ? files[arg.slice(5)]! : arg)),
			],
			{
				env: {
					SystemRoot: process.env.SystemRoot,
					NODE_NO_WARNINGS: "1",
					NODE_DISABLE_COMPILE_CACHE: "1",
					TEMP: process.env.TEMP,
					TMP: process.env.TMP,
					EVALS_PRIVATE_BENCHMARK_ROOT: directory,
				},
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
		let stdout = ""
		let stderr = ""
		child.stdout!.on("data", (chunk) => (stdout += chunk.toString()))
		child.stderr!.on("data", (chunk) => (stderr += chunk.toString()))
		const closed = once(child, "close")
		let timer: NodeJS.Timeout | undefined
		try {
			const [exitCode, signal] = await Promise.race([
				closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`CLI did not exit: ${stderr}`)), 5_000)
				}),
			])
			const calls: DependencyCall[] = await fs.readFile(callsFile, "utf8").then(
				(value) =>
					value
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as DependencyCall),
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return []
					throw error
				},
			)
			const retainedFiles = Object.fromEntries(
				await Promise.all(
					Object.entries({
						...files,
						...Object.fromEntries(outputFiles.map((name) => [name, path.join(directory, name)])),
					}).map(async ([name, file]) => [name, await fs.readFile(file, "utf8")]),
				),
			)
			return { exitCode, signal, stdout, stderr, calls, retainedFiles }
		} finally {
			clearTimeout(timer)
			if (child.exitCode === null && child.signalCode === null) child.kill()
			await closed
		}
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) child.kill()
		await fs.rm(directory, { recursive: true, force: true })
	}
}

describe("benchmark CLI provenance wiring", () => {
	const calibrationReport = { schemaVersion: 1, taskIdentity: "fixture-task@2", models: [] }
	const calibrationTrials = Array.from({ length: 5 }, (_, index) => ({
		id: `model-trial-${index}`,
		taskIdentity: "fixture-task@2",
		model: "luna-high",
		passed: true,
		unexpected: false,
		safetyFailed: false,
		reviewed: false,
	}))
	const recordModelArgs = ["--report", "file:report.json", "--trials", "file:trials.json"]
	const calibrationFiles = { "report.json": calibrationReport, "trials.json": calibrationTrials }

	it("forwards complete delivery evidence as the third record-model argument and shows the fresh delivery", async () => {
		const delivery: ModelCalibrationDelivery = {
			model: "luna-high",
			taskIdentity: "fixture-task@2",
			runId: 42,
			scheduled: 6,
			scoreable: 5,
			excluded: 1,
			missing: 0,
			statusCounts: {
				missing: 0,
				pending: 0,
				running: 0,
				passed: 5,
				outcome_failed: 0,
				safety_failed: 0,
				budget_exhausted: 0,
				agent_error: 0,
				infrastructure_error: 1,
				grader_error: 0,
				cancelled: 0,
				human_handoff: 0,
			},
			trials: [
				...calibrationTrials.map(({ id }) => ({
					id,
					status: "passed" as const,
					attemptCount: 1,
					retryAssisted: false,
				})),
				{ id: "unscoreable-trial", status: "infrastructure_error", attemptCount: 2, retryAssisted: true },
			],
		}
		const result = await runCli({
			command: "record-model",
			args: [...recordModelArgs, "--delivery", "file:delivery.json"],
			inputFiles: { ...calibrationFiles, "delivery.json": delivery },
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([
			{ name: "mergeModelCalibration", arguments: [calibrationReport, calibrationTrials, delivery] },
		])
		expect(JSON.parse(result.stdout).modelDelivery).toEqual([delivery])
		expect(JSON.parse(result.retainedFiles["report.json"]!).modelDelivery).toEqual([delivery])
	})

	it("preserves unknown delivery when record-model omits --delivery and displays an explicit null", async () => {
		const result = await runCli({
			command: "record-model",
			args: recordModelArgs,
			inputFiles: calibrationFiles,
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([
			{
				name: "mergeModelCalibration",
				arguments: [calibrationReport, calibrationTrials, null],
				undefinedArgumentIndexes: [2],
			},
		])
		expect(JSON.parse(result.stdout).modelDelivery).toBeNull()
		expect(JSON.parse(result.retainedFiles["report.json"]!)).not.toHaveProperty("modelDelivery")
	})

	it.each(["malformed-json", "bare-flag"])(
		"rejects %s record-model delivery input before merging or writing the report",
		async (failure) => {
			const result = await runCli({
				command: "record-model",
				args: [
					...recordModelArgs,
					"--delivery",
					...(failure === "malformed-json" ? ["file:delivery.json"] : []),
				],
				inputFiles: calibrationFiles,
				rawInputFiles: failure === "malformed-json" ? { "delivery.json": "{not-valid-json" } : {},
			})
			expect(result.exitCode).toBe(1)
			expect(result.calls).toEqual([])
			expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(calibrationReport))
		},
	)

	it("forwards the exact saved task version when updating T1 measurements", async () => {
		const result = await runCli({ command: "history-update", args: ["--run-id", "42"] })
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([
			{
				name: "applySubsetMeasurements",
				arguments: [
					{ historyBasis: "seeded-prior-from-legacy-baseline" },
					[{ taskId: "fixture-task", taskVersion: 2, costUsd: 0.03, latencyMs: 125 }],
					42,
				],
			},
		])
		expect(JSON.parse(result.stdout).measurements[0].taskVersion).toBe(2)
	})

	it.each([
		"fixture-task@1",
		"fixture-task",
		"fixture-task@2junk",
		"fixture-task@0",
		"fixture-task@9007199254740992",
	])("rejects stale or malformed saved task identity %s before updating history", async (benchmarkTaskIdentity) => {
		const original = { retained: "original subset bytes" }
		const result = await runCli({
			command: "history-update",
			args: ["--run-id", "42", "--file", "file:subset.yaml", "--write"],
			configuration: {
				tasks: [{ id: 1, benchmarkTaskIdentity, iteration: 1, taskMetrics: { cost: 0.03, duration: 125 } }],
			},
			inputFiles: { "subset.yaml": original },
		})
		expect(result.exitCode).toBe(1)
		expect(result.calls).toEqual([])
		expect(result.retainedFiles["subset.yaml"]).toBe(JSON.stringify(original))
	})

	it.each([
		["release-audit", "auditFrontierRelease"],
		["release", "releaseFrontierSuite"],
	])("forwards independent disagreement evidence to %s", async (command, dependency) => {
		const result = await runCli({
			command,
			args: ["--disagreements", "file:disagreements.json", "--reviewer", "human-reviewer"],
			inputFiles: { "disagreements.json": ["trial-disagreement"] },
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([
			{
				name: dependency,
				arguments: [expect.objectContaining({ disagreementTrialIds: ["trial-disagreement"] })],
			},
		])
	})

	it.each(["release-audit", "release", "review-sample"])(
		"requires independent disagreement input for %s before generating or approving evidence",
		async (command) => {
			const result = await runCli({ command, args: ["--reviewer", "human-reviewer"] })
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("--disagreements")
			expect(result.calls).toEqual([])
		},
	)

	it.each([
		{ disagreements: null },
		{ disagreements: {} },
		{ disagreements: [""] },
		{ disagreements: ["same-trial", "same-trial"] },
		{ disagreements: ["valid-trial", 3] },
	])("rejects malformed disagreement evidence $disagreements before release audit", async ({ disagreements }) => {
		const result = await runCli({
			command: "release-audit",
			args: ["--disagreements", "file:disagreements.json"],
			inputFiles: { "disagreements.json": disagreements },
		})
		expect(result.exitCode).toBe(1)
		expect(result.calls).toEqual([])
	})

	it("accepts an explicit empty disagreement list while binding review sampling to current task identities", async () => {
		const result = await runCli({
			command: "review-sample",
			args: ["--disagreements", "file:disagreements.json", "--seed", "fixed-seed"],
			inputFiles: {
				"disagreements.json": [],
				"calibration/fixture-task.keyless.json": { taskIdentity: "fixture-task@2" },
			},
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([
			{
				name: "buildReviewSample",
				arguments: [
					[{ taskIdentity: "fixture-task@2" }],
					{ seed: "fixed-seed", taskIdentities: ["fixture-task@2"], disagreementTrialIds: [] },
				],
			},
		])
	})

	it("preserves embedded paired receipts and the declared predicted capability at the gate boundary", async () => {
		const pairedEvidence = {
			schemaVersion: 1,
			control: { digest: "control-receipt-digest" },
			candidate: { digest: "candidate-receipt-digest" },
			experiment: { id: "declared-experiment" },
			predictedCapability: "tool-recovery",
		}
		const input = { fullyPaired: true, predictedSegmentImproved: true, pairedEvidence }
		const result = await runCli({
			command: "gate",
			args: ["--input", "file:gate.json"],
			inputFiles: { "gate.json": input },
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.calls).toEqual([{ name: "evaluateFrontierConvergence", arguments: [input] }])
	})

	it("returns a nonpromotion exit code when the gate refuses legacy aggregate claims", async () => {
		const result = await runCli({
			command: "gate",
			args: ["--input", "file:gate.json"],
			configuration: { gateDecision: { promote: false, reasons: ["paired receipt evidence is missing"] } },
			inputFiles: { "gate.json": { fullyPaired: true, predictedSegmentImproved: true } },
		})
		expect(result.exitCode).toBe(1)
		expect(JSON.parse(result.stdout)).toEqual({
			promote: false,
			reasons: ["paired receipt evidence is missing"],
		})
	})

	it("runs the real gate against embedded sealed synthetic receipts without model or host execution", async () => {
		const { aggregate, confirmation } = holdoutEvidence()
		const input = {
			harnessCertified: true,
			primaryModel: "luna-high",
			smokePassed: true,
			fullyPaired: true,
			predictedSegmentImproved: true,
			criticalRegressions: 0,
			safetyFailures: 0,
			infrastructureErrorRate: 0,
			costPerSuccessIncrease: 0,
			p95LatencyIncrease: 0,
			holdout: aggregate,
			holdoutConfirmation: confirmation,
			pairedEvidence: convergenceEvidence(),
		}
		const accepted = await runCli({
			command: "gate",
			args: ["--input", "file:gate.json"],
			inputFiles: { "gate.json": input },
			realGate: true,
		})
		expect(accepted.exitCode, accepted.stderr).toBe(0)
		expect(JSON.parse(accepted.stdout)).toEqual({ promote: true, reasons: [] })
		expect(accepted.calls).toEqual([{ name: "evaluateFrontierConvergence", arguments: [input] }])

		const { pairedEvidence: _pairedEvidence, ...legacy } = input
		const refused = await runCli({
			command: "gate",
			args: ["--input", "file:gate.json"],
			inputFiles: { "gate.json": legacy },
			realGate: true,
		})
		expect(refused.exitCode, refused.stderr).toBe(1)
		expect(JSON.parse(refused.stdout)).toMatchObject({
			promote: false,
			reasons: [expect.stringContaining("paired")],
		})
	})
})

function completeCalibrationReport(approved = false): CalibrationReport {
	return {
		schemaVersion: 1,
		taskIdentity: "fixture-task@2",
		fixtureInitiallyFails: true,
		restraint: false,
		gold: { repetitions: 20, passed: 20 },
		broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [
			{
				model: "luna-high",
				repetitions: 5,
				passed: 5,
				trialIds: Array.from({ length: 5 }, (_, index) => `original-${index}`),
				unexpectedTrialIds: [],
				safetyFailureTrialIds: [],
			},
		],
		humanReview: {
			unresolvedFalsePositivePasses: 0,
			reviewedTrialIds: [],
			reviewer: approved ? "existing-reviewer" : "",
			qualityApproved: approved,
		},
		admitted: false,
	}
}

describe("benchmark CLI calibration publication", () => {
	it("merges an incoming model arm over the latest independently committed arm", async () => {
		const original = completeCalibrationReport()
		const replacement: CalibrationReport = {
			...original,
			models: [
				...original.models,
				{
					...original.models[0]!,
					model: "sol-high",
					trialIds: Array.from({ length: 5 }, (_, index) => `sol-${index}`),
				},
			],
		}
		const trials = Array.from({ length: 5 }, (_, index) => ({
			id: `incoming-${index}`,
			taskIdentity: original.taskIdentity,
			model: "luna-high",
			passed: true,
			unexpected: false,
			safetyFailed: false,
			reviewed: false,
		}))
		const result = await runCli({
			command: "record-model",
			args: ["--report", "file:report.json", "--trials", "file:trials.json"],
			inputFiles: { "report.json": original, "trials.json": trials },
			configuration: { readMutation: { trigger: "trials.json", target: "report.json", report: replacement } },
			realStore: true,
		})
		expect(result.exitCode, result.stderr).toBe(0)
		const saved = JSON.parse(result.retainedFiles["report.json"]!) as CalibrationReport
		expect(saved.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ model: "sol-high", trialIds: replacement.models[1]!.trialIds }),
				expect.objectContaining({ model: "luna-high", trialIds: trials.map(({ id }) => id) }),
			]),
		)
		expect(saved.models).toHaveLength(2)
	})

	it("refuses a quality approval when trial-input loading races with replacement outcomes", async () => {
		const original = completeCalibrationReport()
		const replacement: CalibrationReport = {
			...original,
			models: original.models.map((model) => ({ ...model, passed: 0 })),
		}
		const result = await runCli({
			command: "review",
			args: [
				"--report",
				"file:report.json",
				"--reviewer",
				"human-reviewer",
				"--approve-quality",
				"--trial-ids",
				"file:reviewed.json",
			],
			inputFiles: { "report.json": original, "reviewed.json": original.models[0]!.trialIds },
			configuration: { readMutation: { trigger: "reviewed.json", target: "report.json", report: replacement } },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toMatch(/changed|revision|conflict/i)
		expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(replacement))
	})

	it("validates reviewed trial IDs before publishing any quality approval", async () => {
		const original = completeCalibrationReport()
		const result = await runCli({
			command: "review",
			args: [
				"--report",
				"file:report.json",
				"--reviewer",
				"human-reviewer",
				"--approve-quality",
				"--trial-ids",
				"file:reviewed.json",
			],
			inputFiles: { "report.json": original, "reviewed.json": ["unknown-trial"] },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(original))
	})

	it.each([{ ids: null }, { ids: "" }, { ids: "original-0" }, { ids: [""] }, { ids: [" "] }])(
		"rejects malformed review IDs $ids before approval without changing report bytes",
		async ({ ids }) => {
			const original = completeCalibrationReport()
			const result = await runCli({
				command: "review",
				args: [
					"--report",
					"file:report.json",
					"--reviewer",
					"human-reviewer",
					"--approve-quality",
					"--trial-ids",
					"file:reviewed.json",
				],
				inputFiles: { "report.json": original, "reviewed.json": ids },
				realStore: true,
			})
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("--trial-ids")
			expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(original))
		},
	)

	it.each([{ ids: [] }, { ids: ["original-0", "original-0"] }])(
		"accepts explicit review IDs $ids while retaining deduplication",
		async ({ ids }) => {
			const result = await runCli({
				command: "review",
				args: [
					"--report",
					"file:report.json",
					"--reviewer",
					"human-reviewer",
					"--approve-quality",
					"--trial-ids",
					"file:reviewed.json",
				],
				inputFiles: { "report.json": completeCalibrationReport(), "reviewed.json": ids },
				realStore: true,
			})
			expect(result.exitCode, result.stderr).toBe(0)
			expect(JSON.parse(result.retainedFiles["report.json"]!).humanReview).toMatchObject({
				qualityApproved: true,
				reviewedTrialIds: [...new Set(ids)],
			})
		},
	)

	it("leaves a rejected admission report byte-for-byte unchanged", async () => {
		const original = completeCalibrationReport()
		const result = await runCli({
			command: "admit",
			args: ["--report", "file:report.json"],
			inputFiles: { "report.json": original },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(JSON.parse(result.stdout)).toMatchObject({
			admitted: false,
			issues: [expect.objectContaining({ code: "quality_review_missing" })],
		})
		expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(original))
	})

	it("publishes a valid admission through the shared writer", async () => {
		const result = await runCli({
			command: "admit",
			args: ["--report", "file:report.json"],
			inputFiles: { "report.json": completeCalibrationReport(true) },
			realStore: true,
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({ admitted: true })
		expect(JSON.parse(result.retainedFiles["report.json"]!).admitted).toBe(true)
	})

	it("does not publish a stale admission over a report changed during evaluation", async () => {
		const original = completeCalibrationReport(true)
		const replacement = completeCalibrationReport(false)
		const result = await runCli({
			command: "admit",
			args: ["--report", "file:report.json"],
			inputFiles: { "report.json": original },
			configuration: { replaceDuringAdmission: replacement },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toMatch(/changed|revision|conflict/i)
		expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(replacement))
	})

	it("rejects stale keyless recomputation without erasing a newer report", async () => {
		const original = completeCalibrationReport(true)
		const generated = { ...completeCalibrationReport(), models: [] }
		const replacement: CalibrationReport = {
			...completeCalibrationReport(),
			models: original.models.map((model) => ({ ...model, passed: 0 })),
		}
		const result = await runCli({
			command: "calibrate-keyless",
			args: ["--task", "fixture-task"],
			inputFiles: { "calibration/fixture-task.keyless.json": original },
			configuration: { generatedReport: generated, replaceDuringCalibration: replacement },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toMatch(/changed|revision|conflict/i)
		expect(result.retainedFiles["calibration/fixture-task.keyless.json"]).toBe(JSON.stringify(replacement))
	})

	it("preserves structured invalid-schema admission output without changing malformed report bytes", async () => {
		const malformed = { ...completeCalibrationReport(), fixtureInitiallyFails: "not-a-boolean" }
		const result = await runCli({
			command: "admit",
			args: ["--report", "file:report.json"],
			inputFiles: { "report.json": malformed },
			realStore: true,
		})
		expect(result.exitCode).toBe(1)
		expect(JSON.parse(result.stdout)).toMatchObject({
			admitted: false,
			issues: [expect.objectContaining({ code: "invalid_calibration_report", message: expect.any(String) })],
		})
		expect(result.retainedFiles["report.json"]).toBe(JSON.stringify(malformed))
	})

	it.each(["quality", "required-trial-review"])(
		"clears saved admission when review revokes %s",
		async (revocation) => {
			const original = { ...completeCalibrationReport(true), admitted: true }
			if (revocation === "required-trial-review") {
				original.models[0]!.passed = 4
				original.humanReview.reviewedTrialIds = [original.models[0]!.trialIds[0]!]
			}
			const result = await runCli({
				command: "review",
				args: [
					"--report",
					"file:report.json",
					"--reviewer",
					"human-reviewer",
					...(revocation === "required-trial-review"
						? ["--approve-quality", "--trial-ids", "file:reviewed.json"]
						: []),
				],
				inputFiles: { "report.json": original, "reviewed.json": [] },
				realStore: true,
			})
			expect(result.exitCode, result.stderr).toBe(0)
			expect(JSON.parse(result.retainedFiles["report.json"]!).admitted).toBe(false)
		},
	)

	it("creates a missing keyless report and deliberately replaces prior approvals on a fresh regrade", async () => {
		const generated = { ...completeCalibrationReport(), models: [] }
		for (const prior of [undefined, completeCalibrationReport(true)]) {
			const output = prior ? "calibration/fixture-task.keyless.json" : "calibration/fixture-task@2.keyless.json"
			const result = await runCli({
				command: "calibrate-keyless",
				args: ["--task", "fixture-task"],
				inputFiles: prior ? { "calibration/fixture-task.keyless.json": prior } : {},
				configuration: { generatedReport: generated },
				outputFiles: [output],
				realStore: true,
			})
			expect(result.exitCode, result.stderr).toBe(0)
			expect(JSON.parse(result.retainedFiles[output]!)).toEqual(generated)
		}
	})

	it("publishes a revised keyless identity without relabeling historical evidence", async () => {
		const original = { ...completeCalibrationReport(true), taskIdentity: "fixture-task@1" }
		const generated = { ...completeCalibrationReport(), models: [] }
		const result = await runCli({
			command: "calibrate-keyless",
			args: ["--task", "fixture-task"],
			inputFiles: { "calibration/fixture-task.keyless.json": original },
			configuration: { generatedReport: generated },
			outputFiles: ["calibration/fixture-task@2.keyless.json"],
			realStore: true,
		})
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.retainedFiles["calibration/fixture-task.keyless.json"]).toBe(JSON.stringify(original))
		expect(JSON.parse(result.retainedFiles["calibration/fixture-task@2.keyless.json"]!)).toEqual(generated)
	})
})
