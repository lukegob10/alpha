import fs from "node:fs/promises"
import path from "node:path"

import pMap from "p-map"
import { stringify } from "yaml"

import { EVALS_REPO_PATH } from "../exercises/index"
import { findRun, findTrialForTask, getTasks } from "../db/index"
import { buildPairedExperimentReport } from "../experiments/index"
import { evaluateAdmission } from "./admission"
import { runKeylessCalibration, syncVisibleKeylessReports } from "./calibration"
import { mergeModelCalibration, type ModelCalibrationTrial } from "./modelCalibration"
import { calibrationReportSchema } from "./contracts"
import { buildReviewSample } from "./reviewSampling"
import { auditFrontierRelease, releaseFrontierSuite } from "./release"
import { runBenchmarkModelCampaign, type ModelCampaignPartition, type ModelCampaignProvider } from "./modelCampaign"
import { evaluateFrontierConvergence, type FrontierConvergenceGate } from "./convergence"
import { loadBenchmarkCatalog, loadPrivateGraderBundle } from "./loader"
import { runAuthoringCheck } from "./authoring"
import { writeTaskTemplate, type TaskTemplateProfile } from "./templates"
import { applySubsetMeasurements, loadBenchmarkSubset, selectBenchmarkSubset } from "./subsets"
import { assertCampaignBudgetAuthorized, estimateTierBudget, type CampaignTier } from "./budgets"
import { certifyInitialFixtureStates } from "./fixtures"

async function main() {
	const [command, ...args] = process.argv.slice(2)
	if (command === "estimate") {
		const tier = valueAfter(args, "--tier") as CampaignTier
		if (!["t0", "t1", "t2", "t3", "t4", "t5"].includes(tier))
			throw new Error("--tier must be t0, t1, t2, t3, t4, or t5")
		let budget = estimateTierBudget(tier)
		let selection: ReturnType<typeof selectBenchmarkSubset> | undefined
		let taskIds: string[] | undefined
		if (tier === "t1") {
			const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
			const subset = await loadBenchmarkSubset(path.join(EVALS_REPO_PATH, "subsets", "frontier-t1.yaml"))
			selection = selectBenchmarkSubset(catalog, subset)
			budget = estimateTierBudget("t1", {
				taskCount: selection.tasks.length,
				meanCostUsd: selection.estimatedCostUsd / selection.tasks.length,
				hardCapUsd: selection.hardCapUsd,
				taskReservationUsd: subset.taskReservationUsd,
			})
		}
		if (tier === "t4") {
			const tasksFile = valueAfter(args, "--tasks-file")
			taskIds = await readTaskIdsFile(tasksFile)
			const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
			const visible = new Set(
				[...catalog.tasks.values()]
					.map(({ task }) => task)
					.filter(({ partition }) => partition === "development" || partition === "regression")
					.map(({ id }) => id),
			)
			if (taskIds.some((id) => !visible.has(id))) throw new Error("T4 tasks must all be visible frontier tasks")
			budget = estimateTierBudget("t4", {
				taskCount: taskIds.length,
				iterations: optionalNumberAfter(args, "--iterations") ?? 5,
				meanCostUsd: optionalPositiveNumberAfter(args, "--mean-cost-usd") ?? 0.05,
				taskReservationUsd: optionalPositiveNumberAfter(args, "--task-reservation-usd") ?? 0.08,
				hardCapUsd: optionalPositiveNumberAfter(args, "--hard-cap-usd") ?? 2,
			})
		}
		assertCampaignBudgetAuthorized(budget, args.includes("--approve-high-cost"))
		console.log(
			JSON.stringify(
				{
					dryRun: true,
					budget,
					tasks: taskIds ?? selection?.tasks.map(({ id }) => id),
					coverage: selection?.coverage,
					explanation: selection?.explanation,
				},
				null,
				2,
			),
		)
		return
	}
	if (command === "subset") {
		const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
		const subsetFile = path.resolve(
			optionalValueAfter(args, "--file") ?? path.join(EVALS_REPO_PATH, "subsets", "frontier-t1.yaml"),
		)
		console.log(JSON.stringify(selectBenchmarkSubset(catalog, await loadBenchmarkSubset(subsetFile)), null, 2))
		return
	}
	if (command === "history-update") {
		const runId = positiveInteger(valueAfter(args, "--run-id"), "--run-id")
		const subsetFile = path.resolve(
			optionalValueAfter(args, "--file") ?? path.join(EVALS_REPO_PATH, "subsets", "frontier-t1.yaml"),
		)
		const [run, tasks, manifest, catalog] = await Promise.all([
			findRun(runId),
			getTasks(runId),
			loadBenchmarkSubset(subsetFile),
			loadBenchmarkCatalog(EVALS_REPO_PATH),
		])
		if (run.campaignTier !== "t1") throw new Error(`Run ${runId} is not a governed T1 campaign`)
		if (run.modelFallbackAllowed) throw new Error(`Run ${runId} allowed model fallback`)
		if ((run.settings as { reasoningEffort?: unknown } | null)?.reasoningEffort !== "high")
			throw new Error(`Run ${runId} did not use high reasoning`)
		const selected = selectBenchmarkSubset(catalog, manifest)
		const expected = new Set(selected.tasks.map(({ id }) => id))
		if (tasks.length !== expected.size) throw new Error(`Run ${runId} does not contain the complete T1 subset`)
		const measurements = await Promise.all(
			tasks.map(async (task) => {
				const taskId = task.benchmarkTaskIdentity?.split("@")[0]
				if (!taskId || !expected.delete(taskId))
					throw new Error(`Run ${runId} contains an unexpected or duplicate task: ${taskId ?? task.exercise}`)
				if (task.iteration !== 1) throw new Error(`Run ${runId} contains repeated task ${taskId}`)
				if (!task.taskMetrics) throw new Error(`Run ${runId} task ${taskId} is missing usage metrics`)
				const trial = await findTrialForTask(task.id)
				if (!trial || trial.status === "pending" || trial.status === "running")
					throw new Error(`Run ${runId} task ${taskId} is not terminal`)
				const latencyMs =
					task.startedAt && task.finishedAt
						? task.finishedAt.getTime() - task.startedAt.getTime()
						: task.taskMetrics.duration
				return { taskId, costUsd: task.taskMetrics.cost, latencyMs }
			}),
		)
		if (expected.size) throw new Error(`Run ${runId} is missing T1 tasks: ${[...expected].join(", ")}`)
		const updated = applySubsetMeasurements(manifest, measurements, runId)
		if (args.includes("--write")) {
			const temporary = `${subsetFile}.tmp`
			await fs.writeFile(temporary, stringify(updated, { lineWidth: 0 }))
			await fs.rename(temporary, subsetFile)
		}
		console.log(
			JSON.stringify(
				{
					runId,
					written: args.includes("--write"),
					file: subsetFile,
					historyBasis: updated.historyBasis,
					measurements,
				},
				null,
				2,
			),
		)
		return
	}
	if (command === "fixture-check") {
		const report = await certifyInitialFixtureStates({
			catalog: await loadBenchmarkCatalog(EVALS_REPO_PATH),
			publicRoot: EVALS_REPO_PATH,
		})
		console.log(JSON.stringify(report, null, 2))
		if (!report.valid) process.exitCode = 1
		return
	}
	if (command === "author-check") {
		const outputRoot = path.resolve(
			optionalValueAfter(args, "--output") ?? path.join(process.cwd(), ".frontier-campaign"),
		)
		const fingerprints = optionalValueAfter(args, "--private-fingerprints")
		const report = await runAuthoringCheck({
			publicRoot: EVALS_REPO_PATH,
			privateFingerprintsFile: fingerprints ? path.resolve(fingerprints) : undefined,
			outputRoot,
		})
		console.log(
			JSON.stringify(
				{
					valid: report.valid,
					tasks: report.taskCount,
					issues: report.issues.length,
					publicDuplicatePairs: report.similarity.duplicatePairs.length,
					privateDuplicateGroups: report.similarity.privateDuplicatePairs.length,
					report: report.jsonPath,
					summary: report.markdownPath,
				},
				null,
				2,
			),
		)
		if (!report.valid) process.exitCode = 1
		return
	}
	if (command === "template") {
		const profile = valueAfter(args, "--profile") as TaskTemplateProfile
		if (!["compact", "medium", "long"].includes(profile))
			throw new Error("--profile must be compact, medium, or long")
		const partition = (optionalValueAfter(args, "--partition") ?? "development") as "development" | "regression"
		if (!["development", "regression"].includes(partition))
			throw new Error("--partition must be development or regression")
		const result = await writeTaskTemplate(EVALS_REPO_PATH, { id: valueAfter(args, "--id"), profile, partition })
		console.log(JSON.stringify({ fixture: result.fixture, task: result.task }, null, 2))
		return
	}
	if (command === "validate") {
		const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
		let privateBundles = 0
		for (const { task } of catalog.tasks.values()) {
			if (task.graders.some(({ bundleId }) => bundleId)) {
				if (process.env.EVALS_PRIVATE_BENCHMARK_ROOT || args.includes("--require-private"))
					await loadPrivateGraderBundle(task)
				privateBundles++
			}
		}
		const tasks = [...catalog.tasks.values()].map(({ task }) => task)
		console.log(
			JSON.stringify(
				{
					valid: true,
					suites: catalog.suites.length,
					tasks: tasks.length,
					partitions: count(tasks, "partition"),
					admissions: count(tasks, "admission"),
					privateBundles,
				},
				null,
				2,
			),
		)
		return
	}
	if (command === "admit") {
		const reportPath = valueAfter(args, "--report")
		const absolute = path.resolve(reportPath)
		const candidate = { ...(JSON.parse(await fs.readFile(absolute, "utf8")) as object), admitted: true }
		const result = evaluateAdmission(candidate)
		if (result.admitted) await fs.writeFile(absolute, JSON.stringify(result.report, null, 2) + "\n")
		console.log(JSON.stringify(result, null, 2))
		if (!result.admitted) process.exitCode = 1
		return
	}
	if (command === "record-model") {
		const reportPath = path.resolve(valueAfter(args, "--report"))
		const trialsPath = path.resolve(valueAfter(args, "--trials"))
		const report = mergeModelCalibration(
			JSON.parse(await fs.readFile(reportPath, "utf8")),
			JSON.parse(await fs.readFile(trialsPath, "utf8")) as ModelCalibrationTrial[],
		)
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n")
		console.log(JSON.stringify({ report: reportPath, models: report.models }, null, 2))
		return
	}
	if (command === "review") {
		const reportPath = path.resolve(valueAfter(args, "--report"))
		const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
			humanReview: {
				reviewedTrialIds: string[]
				unresolvedFalsePositivePasses: number
				reviewer?: string
				qualityApproved?: boolean
			}
		}
		const reviewedTrialIds = optionalValueAfter(args, "--trial-ids")
			? (JSON.parse(await fs.readFile(path.resolve(valueAfter(args, "--trial-ids")), "utf8")) as string[])
			: report.humanReview.reviewedTrialIds
		report.humanReview = {
			...report.humanReview,
			reviewer: valueAfter(args, "--reviewer"),
			qualityApproved: args.includes("--approve-quality"),
			reviewedTrialIds: [...new Set(reviewedTrialIds)].sort(),
		}
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n")
		console.log(JSON.stringify({ report: reportPath, humanReview: report.humanReview }, null, 2))
		return
	}
	if (command === "review-sample") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required")
		const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
		const suite = catalog.suites.find(({ id }) => id === "frontier-v1")
		if (!suite) throw new Error("frontier-v1 suite is missing")
		const reports = await Promise.all(
			suite.tasks.map(async (task) => {
				const root =
					task.partition === "holdout"
						? path.join(privateRoot, "reports")
						: path.join(EVALS_REPO_PATH, "calibration")
				return calibrationReportSchema.parse(
					JSON.parse(await fs.readFile(path.join(root, `${task.id}.keyless.json`), "utf8")),
				)
			}),
		)
		const disagreementTrialIds = optionalValueAfter(args, "--disagreements")
			? (JSON.parse(await fs.readFile(path.resolve(valueAfter(args, "--disagreements")), "utf8")) as string[])
			: undefined
		const manifest = buildReviewSample(reports, {
			seed: optionalValueAfter(args, "--seed") ?? `frontier-v1@${suite.version}`,
			disagreementTrialIds,
		})
		const output = path.resolve(
			optionalValueAfter(args, "--output") ??
				path.join(privateRoot, "reviews", `frontier-v1-review-sample-v${suite.version}.json`),
		)
		await writeJsonAtomic(output, manifest)
		console.log(
			JSON.stringify(
				{
					output,
					population: manifest.population,
					randomSampleSize: manifest.randomSampleSize,
					selectedTrialCount: manifest.selectedTrialCount,
					digest: manifest.digest,
				},
				null,
				2,
			),
		)
		return
	}
	if (command === "paired-report") {
		const control = JSON.parse(await fs.readFile(path.resolve(valueAfter(args, "--control")), "utf8")) as unknown
		const candidate = JSON.parse(
			await fs.readFile(path.resolve(valueAfter(args, "--candidate")), "utf8"),
		) as unknown
		const readJson = async (flag: string) =>
			JSON.parse(await fs.readFile(path.resolve(valueAfter(args, flag)), "utf8")) as never
		const report = buildPairedExperimentReport(control, candidate, {
			manifest: await readJson("--experiment"),
			taskSet: await readJson("--task-set"),
			controlVariant: await readJson("--control-variant"),
			candidateVariant: await readJson("--candidate-variant"),
		})
		const output = path.resolve(valueAfter(args, "--output"))
		await writeJsonAtomic(output, report)
		console.log(
			JSON.stringify(
				{
					output,
					pairCount: report.pairCount,
					safetyFailures: report.safetyFailures,
					highRiskRegressions: report.highRiskRegressions,
					digest: report.digest,
				},
				null,
				2,
			),
		)
		return
	}
	if (command === "release") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required")
		const result = await releaseFrontierSuite({
			publicRoot: EVALS_REPO_PATH,
			privateRoot,
			reviewer: valueAfter(args, "--reviewer"),
		})
		console.log(
			JSON.stringify({ released: true, output: result.output, tasks: result.suite.tasks.length }, null, 2),
		)
		return
	}
	if (command === "release-audit") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required")
		const audit = await auditFrontierRelease({ publicRoot: EVALS_REPO_PATH, privateRoot })
		console.log(JSON.stringify(audit, null, 2))
		if (!audit.releaseReady) process.exitCode = 1
		return
	}
	if (command === "run-model") {
		const role = valueAfter(args, "--role") as "luna-high"
		if (role !== "luna-high") throw new Error("frontier-v1 model campaigns require --role luna-high")
		const provider = (optionalValueAfter(args, "--provider") ??
			process.env.EVALS_MODEL_PROVIDER ??
			"openai-native") as ModelCampaignProvider
		if (provider !== "openai-native" && provider !== "openrouter")
			throw new Error("--provider must be openai-native or openrouter")
		const modelEnvironment = "EVALS_LUNA_HIGH_MODEL"
		const modelId = optionalValueAfter(args, "--model-id") ?? process.env[modelEnvironment]
		if (!modelId) throw new Error(`--model-id or ${modelEnvironment} is required`)
		const tier = valueAfter(args, "--tier") as CampaignTier
		if (!["t1", "t2", "t3", "t4", "t5"].includes(tier))
			throw new Error("Paid model runs require --tier t1, t2, t3, t4, or t5")
		const partition = valueAfter(args, "--partition") as ModelCampaignPartition | "visible" | "frontier"
		const iterations = optionalNumberAfter(args, "--iterations") ?? 1
		if (["t1", "t2", "t3"].includes(tier) && iterations !== 1)
			throw new Error(`${tier.toUpperCase()} research tiers require exactly one iteration`)
		if (tier === "t5" && iterations !== 5) throw new Error("T5 frozen calibration requires exactly five iterations")
		if (tier === "t5" && role !== "luna-high") throw new Error("T5 frontier calibration is Luna-only")
		const requestedTask = optionalValueAfter(args, "--task")
		const tasksFile = optionalValueAfter(args, "--tasks-file")
		if (requestedTask && tasksFile) throw new Error("Use either --task or --tasks-file, not both")
		if (tasksFile && tier !== "t4") throw new Error("--tasks-file is reserved for targeted T4 calibration")
		let taskIds: string[] | undefined
		let meanCostUsd = 0.04
		let taskReservationUsd: number | undefined
		let hardCapUsd: number | undefined
		if (tasksFile) {
			taskIds = await readTaskIdsFile(tasksFile)
		}
		if (tier === "t1") {
			if (partition !== "visible") throw new Error("T1 runs use the visible high-value subset")
			const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
			const manifest = await loadBenchmarkSubset(path.join(EVALS_REPO_PATH, "subsets", "frontier-t1.yaml"))
			const selection = selectBenchmarkSubset(catalog, manifest)
			taskIds = requestedTask ? [requestedTask] : selection.tasks.map(({ id }) => id)
			if (requestedTask && !taskIds.every((id) => selection.tasks.some((task) => task.id === id)))
				throw new Error("--task must belong to the T1 subset")
			meanCostUsd = selection.estimatedCostUsd / selection.tasks.length
			taskReservationUsd = manifest.taskReservationUsd
			hardCapUsd = manifest.hardCapUsd
		}
		if (tier === "t2") {
			if (partition !== "visible") throw new Error("T2 runs use 20 visible tasks")
			const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
			taskIds = requestedTask ? [requestedTask] : selectTier2TaskIds(catalog)
		}
		if (tier === "t4") {
			if (partition !== "visible") throw new Error("T4 calibration samples use visible tasks")
			if (!taskIds?.length) throw new Error("T4 requires an explicit --tasks-file")
			if (iterations < 3 || iterations > 5)
				throw new Error("Targeted Luna High reliability calibration requires 3-5 iterations")
			meanCostUsd = optionalPositiveNumberAfter(args, "--mean-cost-usd") ?? 0.05
			taskReservationUsd = optionalPositiveNumberAfter(args, "--task-reservation-usd") ?? 0.08
			hardCapUsd = optionalPositiveNumberAfter(args, "--hard-cap-usd") ?? 2
		}
		if ((tier === "t3" || tier === "t5") && partition !== "frontier")
			throw new Error(
				`${tier.toUpperCase()} runs require --partition frontier so the cap covers visible and holdout tasks together`,
			)
		if (partition === "holdout")
			throw new Error(
				"Direct holdout runs are disabled; use a governed frontier T3/T5 run after visible evidence",
			)
		if (tier === "t5") {
			meanCostUsd = 0.052
			taskReservationUsd = 0.08
			hardCapUsd = 16
		}
		const budget = estimateTierBudget(tier, {
			taskCount: taskIds?.length ?? (requestedTask ? 1 : tier === "t2" ? 20 : partition === "frontier" ? 40 : 28),
			iterations,
			meanCostUsd,
			...(taskReservationUsd ? { taskReservationUsd } : {}),
			...(hardCapUsd ? { hardCapUsd } : {}),
		})
		assertCampaignBudgetAuthorized(budget, args.includes("--approve-high-cost"))
		const runId = await runBenchmarkModelCampaign({
			publicRoot: EVALS_REPO_PATH,
			partition,
			modelRole: role,
			modelId,
			provider,
			taskId: requestedTask,
			taskIds,
			iterations,
			concurrency: optionalNumberAfter(args, "--concurrency"),
			campaignBudget: budget,
			highCostApproved: args.includes("--approve-high-cost"),
		})
		console.log(JSON.stringify({ runId, role, tier, budget }, null, 2))
		return
	}
	if (command === "gate") {
		const decision = evaluateFrontierConvergence(
			JSON.parse(await fs.readFile(path.resolve(valueAfter(args, "--input")), "utf8")) as FrontierConvergenceGate,
		)
		console.log(JSON.stringify(decision, null, 2))
		if (!decision.promote) process.exitCode = 1
		return
	}
	if (command === "calibrate-keyless") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required")
		const catalog = await loadBenchmarkCatalog(EVALS_REPO_PATH)
		const taskId = optionalValueAfter(args, "--task")
		const entries = [...catalog.tasks.values()].filter(
			({ task }) => task.partition !== "smoke" && (!taskId || task.id === taskId),
		)
		if (entries.length === 0)
			throw new Error(taskId ? `Unknown benchmark task: ${taskId}` : "No frontier tasks found")
		const results = await pMap(
			entries,
			async (entry) => {
				const report = await runKeylessCalibration({
					task: entry.task,
					publicRoot: EVALS_REPO_PATH,
					privateRoot,
				})
				const outputRoot =
					entry.task.partition === "holdout"
						? path.join(privateRoot, "reports")
						: path.join(EVALS_REPO_PATH, "calibration")
				await fs.mkdir(outputRoot, { recursive: true })
				const output = path.join(outputRoot, `${entry.task.id}.keyless.json`)
				await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n")
				return {
					taskId: entry.task.id,
					output,
					keylessPassed:
						report.fixtureInitiallyFails &&
						report.gold.passed === report.gold.repetitions &&
						report.broken.every(({ rejected, repetitions }) => rejected === repetitions) &&
						report.determinism.distinctDigests === 1,
				}
			},
			{ concurrency: 2 },
		)
		console.log(
			JSON.stringify(
				{ tasks: results.length, passed: results.filter(({ keylessPassed }) => keylessPassed).length, results },
				null,
				2,
			),
		)
		if (results.some(({ keylessPassed }) => !keylessPassed)) process.exitCode = 1
		return
	}
	if (command === "sync-keyless") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required")
		const result = await syncVisibleKeylessReports({
			catalog: await loadBenchmarkCatalog(EVALS_REPO_PATH),
			publicRoot: EVALS_REPO_PATH,
			privateRoot,
		})
		console.log(JSON.stringify({ synced: result.taskIds.length, outputRoot: result.outputRoot }, null, 2))
		return
	}
	throw new Error(
		"Usage: benchmark <validate|author-check|fixture-check|template|subset|history-update|estimate|admit|record-model|review|review-sample|paired-report|calibrate-keyless|sync-keyless|release-audit|release|run-model|gate>",
	)
}

async function writeJsonAtomic(output: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(output), { recursive: true })
	const temporary = `${output}.tmp`
	await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n")
	await fs.rename(temporary, output)
}

function selectTier2TaskIds(catalog: Awaited<ReturnType<typeof loadBenchmarkCatalog>>): string[] {
	const visible = [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition }) => partition === "development" || partition === "regression")
	const byFamily = new Map<string, typeof visible>()
	for (const task of visible) byFamily.set(task.family, [...(byFamily.get(task.family) ?? []), task])
	for (const tasks of byFamily.values()) tasks.sort((a, b) => a.id.localeCompare(b.id))
	const selected: string[] = []
	const families = [...byFamily.keys()].sort()
	while (selected.length < 20) {
		let added = false
		for (const family of families) {
			const task = byFamily.get(family)?.shift()
			if (task) {
				selected.push(task.id)
				added = true
				if (selected.length === 20) break
			}
		}
		if (!added) break
	}
	if (selected.length !== 20) throw new Error(`T2 requires 20 visible tasks; found ${selected.length}`)
	return selected
}

function optionalValueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag)
	return index >= 0 ? args[index + 1] : undefined
}

async function readTaskIdsFile(file: string): Promise<string[]> {
	const parsed = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as unknown
	if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !id.trim()))
		throw new Error("--tasks-file must contain a JSON array of task ids")
	const taskIds = [...new Set(parsed)] as string[]
	if (taskIds.length !== parsed.length) throw new Error("--tasks-file contains duplicate task ids")
	return taskIds
}

function optionalNumberAfter(args: string[], flag: string): number | undefined {
	const value = optionalValueAfter(args, flag)
	if (value === undefined) return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
	return parsed
}

function optionalPositiveNumberAfter(args: string[], flag: string): number | undefined {
	const value = optionalValueAfter(args, flag)
	if (value === undefined) return undefined
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`)
	return parsed
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
	return parsed
}

function valueAfter(args: string[], flag: string): string {
	const index = args.indexOf(flag)
	if (index < 0 || !args[index + 1]) throw new Error(`${flag} is required`)
	return args[index + 1]!
}

function count<T extends Record<string, unknown>, K extends keyof T>(values: T[], key: K): Record<string, number> {
	return values.reduce<Record<string, number>>((result, value) => {
		const item = String(value[key])
		result[item] = (result[item] ?? 0) + 1
		return result
	}, {})
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
