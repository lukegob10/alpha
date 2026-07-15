import { EVALS_SETTINGS, type RooCodeSettings } from "@alpha-code/types"
import fs from "node:fs/promises"
import path from "node:path"

import { createRun, createTask, findTrialForTask, getTasks } from "../db/index"
import { runEvals } from "../cli/runEvals"
import type { ExerciseLanguage } from "../exercises/index"
import type { TrialTerminalStatus } from "../lifecycle/index"
import type { BenchmarkPartition } from "./publicTypes"
import { loadBenchmarkCatalog } from "./loader"
import { mergeModelCalibration, type ModelCalibrationTrial } from "./modelCalibration"
import { assertCampaignBudgetAuthorized, type TierBudget } from "./budgets"

export type ModelCampaignPartition = Extract<BenchmarkPartition, "smoke" | "development" | "regression" | "holdout">
export type ModelCampaignProvider = "openai-native" | "openrouter"

export async function runBenchmarkModelCampaign(options: {
	publicRoot: string
	partition: ModelCampaignPartition | "visible" | "frontier"
	modelRole: "luna-high" | "sol-high"
	modelId: string
	provider?: ModelCampaignProvider
	taskId?: string
	iterations?: number
	concurrency?: number
	timeoutMinutes?: number
	taskIds?: string[]
	campaignBudget?: TierBudget
	highCostApproved?: boolean
}): Promise<number> {
	if (!options.modelId.trim()) throw new Error("A concrete provider model id is required")
	const provider = options.provider ?? "openai-native"
	const apiKeyVariable = provider === "openai-native" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"
	if (!process.env[apiKeyVariable]?.trim()) throw new Error(`${apiKeyVariable} is required for provider ${provider}`)
	const catalog = await loadBenchmarkCatalog(options.publicRoot)
	const selected = [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(
			(task) =>
				(options.taskIds ? options.taskIds.includes(task.id) : true) &&
				(options.taskId ? task.id === options.taskId : true) &&
				(options.partition === "frontier"
					? task.partition !== "smoke"
					: options.partition === "visible"
						? task.partition === "development" || task.partition === "regression"
						: task.partition === options.partition),
		)
	if (!selected.length) throw new Error(`No tasks found for partition ${options.partition}`)
	if (options.taskIds && selected.length !== new Set(options.taskIds).size)
		throw new Error("One or more selected benchmark tasks are outside the requested partition")
	// Research campaigns default to one observation per task. Promotion and
	// calibration workflows must opt into repeated trials explicitly.
	const iterations = options.iterations ?? 1
	if (options.campaignBudget) {
		if (options.campaignBudget.taskCount !== selected.length || options.campaignBudget.iterations !== iterations)
			throw new Error("Campaign budget task/iteration count does not match selected work")
		assertCampaignBudgetAuthorized(options.campaignBudget, options.highCostApproved ?? false)
	}
	if (selected.some(({ partition }) => partition === "holdout") && (options.concurrency ?? 1) !== 1)
		throw new Error("Campaigns containing private holdouts require concurrency 1")
	const settings: RooCodeSettings = {
		...EVALS_SETTINGS,
		apiProvider: provider,
		reasoningEffort: "high",
		...(provider === "openrouter" ? { openRouterModelId: options.modelId } : { apiModelId: options.modelId }),
	}
	const run = await createRun({
		model: options.modelId,
		...(options.modelId === "gpt-5.6-luna"
			? { inputPrice: 1, outputPrice: 6, cacheReadsPrice: 0.1, cacheWritesPrice: 1.25 }
			: {}),
		name: `${options.modelRole}:${options.partition}`,
		description: `Governed ${options.modelRole} ${options.partition} benchmark campaign`,
		settings,
		socketPath: "",
		executionMethod: "cli",
		concurrency: options.concurrency ?? 1,
		timeout: options.timeoutMinutes ?? 15,
		campaignTier: options.campaignBudget?.tier,
		campaignHardCapUsd: options.campaignBudget?.hardCapUsd,
		taskCostCapUsd: options.campaignBudget?.taskReservationUsd,
		estimatedCostUsd: options.campaignBudget?.estimatedCostUsd,
		highCostApproved: options.highCostApproved ?? false,
		modelFallbackAllowed: false,
	})
	for (const task of selected) {
		const [fixtureLanguage, fixtureExercise] = task.fixture.split("/")
		const language = task.partition === "holdout" ? "javascript" : fixtureLanguage
		const exercise = task.partition === "holdout" ? task.id : fixtureExercise
		if (!language || !exercise) throw new Error(`Invalid task fixture ${task.fixture}`)
		for (let iteration = 1; iteration <= iterations; iteration++) {
			await createTask({
				runId: run.id,
				language: language as ExerciseLanguage,
				exercise,
				iteration,
				benchmarkTaskIdentity: `${task.id}@${task.version}`,
				benchmarkPartition: task.partition,
			})
		}
	}
	await runEvals(run.id)
	await ingestModelCampaign({
		runId: run.id,
		modelRole: options.modelRole,
		publicRoot: options.publicRoot,
		privateRoot: process.env.EVALS_PRIVATE_BENCHMARK_ROOT,
	})
	return run.id
}

export async function ingestModelCampaign(options: {
	runId: number
	modelRole: "luna-high" | "sol-high"
	publicRoot: string
	privateRoot?: string
}): Promise<void> {
	const tasks = await getTasks(options.runId)
	const groups = new Map<string, typeof tasks>()
	for (const task of tasks) {
		if (!task.benchmarkTaskIdentity || !task.benchmarkPartition) continue
		groups.set(task.benchmarkTaskIdentity, [...(groups.get(task.benchmarkTaskIdentity) ?? []), task])
	}
	for (const [identity, taskRows] of groups) {
		// One-pass research runs are valid baseline observations, but they do not
		// satisfy the five-trial calibration contract. Keep their results in the
		// run/task metrics and defer report merging until a calibration campaign.
		if (taskRows.length < 5) continue
		const partition = taskRows[0]!.benchmarkPartition!
		if (partition === "holdout" && !options.privateRoot)
			throw new Error("Private benchmark root is required to ingest holdout trials")
		const reportRoot =
			partition === "holdout"
				? path.join(options.privateRoot!, "reports")
				: path.join(options.publicRoot, "calibration")
		const reportPath = path.join(reportRoot, `${identity.split("@")[0]}.keyless.json`)
		let reportSource: string
		try {
			reportSource = await fs.readFile(reportPath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		const trials = (
			await Promise.all(
				taskRows.map(async (task): Promise<ModelCalibrationTrial | undefined> => {
					const trial = await findTrialForTask(task.id)
					const outcome =
						trial && trial.status !== "pending" && trial.status !== "running"
							? calibrationOutcome(trial.status)
							: undefined
					if (!outcome) {
						return undefined
					}
					return {
						id: `run-${options.runId}-task-${task.id}`,
						taskIdentity: identity,
						model: options.modelRole,
						passed: outcome.passed,
						unexpected: false,
						safetyFailed: outcome.safetyFailed,
						reviewed: false,
					}
				}),
			)
		).filter((trial): trial is ModelCalibrationTrial => Boolean(trial))
		if (trials.length < 5) continue
		const report = mergeModelCalibration(JSON.parse(reportSource), trials)
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n")
	}
}

export function calibrationOutcome(
	status: TrialTerminalStatus,
): { passed: boolean; safetyFailed: boolean } | undefined {
	if (["infrastructure_error", "grader_error", "cancelled", "human_handoff"].includes(status)) return undefined
	return { passed: status === "passed", safetyFailed: status === "safety_failed" }
}
