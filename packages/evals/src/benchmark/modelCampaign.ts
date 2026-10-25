import { EVALS_SETTINGS, type AlphaCodeSettings } from "@alpha-code/types"
import fs from "node:fs/promises"
import path from "node:path"

import { createRun, createTask, findTrialForTask, getTasks, getRuntimeVariantManifest } from "../db/index"
import { runEvals } from "../cli/runEvals"
import type { ExerciseLanguage } from "../exercises/index"
import type { TrialTerminalStatus } from "../lifecycle/index"
import type { BenchmarkPartition } from "./publicTypes"
import { loadBenchmarkCatalog } from "./loader"
import { mergeModelCalibration, type ModelCalibrationTrial } from "./modelCalibration"
import { readCalibrationReport, updateCalibrationReport } from "./calibrationStore"
import { benchmarkPartitionSchema, modelCalibrationStatusSchema } from "./contracts"
import { assertCampaignBudgetAuthorized, type TierBudget } from "./budgets"
import { sealCampaignExport } from "../experiments/campaign"
import { canonicalJson, sha256 } from "../evidence/canonical"

export type ModelCampaignPartition = Extract<BenchmarkPartition, "smoke" | "development" | "regression" | "holdout">
export type ModelCampaignProvider = "openai" | "openai-native"

/** Campaign transport is OpenAI Compatible; accept the existing native-provider configuration alias. */
export function resolveModelCampaignProvider(provider: string = "openai"): "openai" {
	if (provider === "openai" || provider === "openai-native") return "openai"
	throw new Error(`Unsupported campaign provider: ${provider}`)
}

export async function runBenchmarkModelCampaign(optionsValue: {
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
	evidenceOutput?: string
}): Promise<number> {
	const options = {
		...optionsValue,
		taskIds: optionsValue.taskIds ? [...optionsValue.taskIds] : undefined,
		campaignBudget: optionsValue.campaignBudget ? { ...optionsValue.campaignBudget } : undefined,
	}
	const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
	const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
	if (!options.modelId.trim()) throw new Error("A concrete provider model id is required")
	const provider = resolveModelCampaignProvider(options.provider)
	const apiKeyVariable = "OPENAI_API_KEY"
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
	const settings: AlphaCodeSettings = {
		...EVALS_SETTINGS,
		apiProvider: provider,
		reasoningEffort: "high",
		openAiModelId: options.modelId,
		openAiBaseUrl: baseUrl,
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
		executionMethod: "vscode",
		concurrency: options.concurrency ?? 1,
		timeout: options.timeoutMinutes ?? 15,
		campaignTier: options.campaignBudget?.tier,
		campaignHardCapUsd: options.campaignBudget?.hardCapUsd,
		taskCostCapUsd: options.campaignBudget?.taskReservationUsd,
		estimatedCostUsd: options.campaignBudget?.estimatedCostUsd,
		highCostApproved: options.highCostApproved ?? false,
		modelFallbackAllowed: false,
	})
	let executionFailure: { error: unknown } | undefined
	const finalizationFailures: unknown[] = []
	try {
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
	} catch (error) {
		executionFailure = { error }
	}
	try {
		if (options.evidenceOutput) {
			const rows = await getTasks(run.id)
			const lifecycle = []
			for (const row of rows) {
				const trial = await findTrialForTask(row.id)
				const variant = trial?.variantIdentity ? await getRuntimeVariantManifest(trial.variantIdentity) : null
				lifecycle.push({
					taskId: row.id,
					benchmarkTaskIdentity: row.benchmarkTaskIdentity,
					repetition: row.iteration,
					trialId: trial?.id ?? null,
					status: trial?.status ?? "missing",
					firstAttemptStatus: trial?.firstAttemptStatus ?? null,
					retryAssisted: trial?.retryAssisted ?? null,
					attemptCount: trial?.attemptCount ?? null,
					taskDefinitionIdentity: trial?.taskDefinitionIdentity ?? null,
					runtimeVariantIdentity: trial?.variantIdentity ?? null,
					executionIdentity: variant?.executionIdentity ?? null,
					runtimeIdentityStatus: variant?.identityStatus ?? "executed_harness_unavailable",
				})
			}
			const receipt = sealCampaignExport({
				schemaVersion: 1,
				runId: String(run.id),
				executionFidelity: "actual-host",
				decisionSource: "live",
				variant: null,
				taskSet: {
					schemaVersion: 1,
					id: "benchmark-campaign",
					version: 1,
					tasks: selected.map((task) => ({
						id: task.id,
						version: task.version,
						digest: sha256(canonicalJson(task)),
					})),
				},
				observations: [],
				incomplete: [
					{
						reason: lifecycle.some((trial) => trial.executionIdentity)
							? "executed_component_identity_only: lifecycle.json retains owned exact-host entrypoint/manifest evidence; complete experiment component identities remain unavailable"
							: "executed_harness_unavailable: no owned execution receipt was captured; lifecycle.json preserves available trial evidence",
					},
				],
			})
			const directory = path.join(options.evidenceOutput, `run-${run.id}`)
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(path.join(directory, "campaign.json"), JSON.stringify(receipt, null, 2) + "\n", {
				flag: "wx",
				mode: 0o600,
			})
			await fs.writeFile(
				path.join(directory, "lifecycle.json"),
				JSON.stringify(
					{
						runId: run.id,
						model: options.modelId,
						configurationDigest: sha256(canonicalJson(settings)),
						trials: lifecycle,
					},
					null,
					2,
				) + "\n",
				{ flag: "wx", mode: 0o600 },
			)
		}
	} catch (error) {
		finalizationFailures.push(error)
	}
	// Dispatch failure still leaves scheduled, incomplete, or excluded work that must stay visible.
	try {
		await ingestModelCampaign({
			runId: run.id,
			modelRole: options.modelRole,
			publicRoot: options.publicRoot,
			privateRoot,
		})
	} catch (error) {
		finalizationFailures.push(error)
	}
	if (executionFailure) {
		if (finalizationFailures.length)
			throw new AggregateError(
				[executionFailure.error, ...finalizationFailures],
				"Campaign execution and finalization failed",
				{ cause: executionFailure.error },
			)
		throw executionFailure.error
	}
	if (finalizationFailures.length === 1) throw finalizationFailures[0]
	if (finalizationFailures.length) throw new AggregateError(finalizationFailures, "Campaign finalization failed")
	return run.id
}

export async function ingestModelCampaign(optionsValue: {
	runId: number
	modelRole: "luna-high" | "sol-high"
	publicRoot: string
	privateRoot?: string
}): Promise<void> {
	const options = { ...optionsValue }
	const tasks = await getTasks(options.runId)
	const groups = new Map<string, typeof tasks>()
	for (const task of tasks) {
		if (!task.benchmarkTaskIdentity && !task.benchmarkPartition) continue
		if (!task.benchmarkTaskIdentity || !task.benchmarkPartition)
			throw new Error(`Calibration task ${task.id} has incomplete benchmark identity or partition`)
		groups.set(task.benchmarkTaskIdentity, [...(groups.get(task.benchmarkTaskIdentity) ?? []), task])
	}
	for (const [identity, taskRows] of groups) {
		const partitions = new Set(taskRows.map(({ benchmarkPartition }) => benchmarkPartition))
		if (partitions.size !== 1) throw new Error(`Calibration task ${identity} has mixed benchmark partitions`)
		const partition = benchmarkPartitionSchema.parse(taskRows[0]!.benchmarkPartition)
		if (
			new Set(taskRows.map(({ id }) => id)).size !== taskRows.length ||
			new Set(taskRows.map(({ iteration }) => iteration)).size !== taskRows.length ||
			taskRows.some(({ iteration }) => !Number.isSafeInteger(iteration) || iteration < 1)
		)
			throw new Error(`Calibration task ${identity} contains duplicate scheduled rows or invalid repetitions`)
		if (partition === "holdout" && !options.privateRoot)
			throw new Error("Private benchmark root is required to ingest holdout trials")
		const reportRoot =
			partition === "holdout"
				? path.join(options.privateRoot!, "reports")
				: path.join(options.publicRoot, "calibration")
		const reportPath = path.join(reportRoot, `${identity.split("@")[0]}.keyless.json`)
		// Do not query or fabricate controls for tasks without an existing keyless report.
		if (!(await readCalibrationReport(reportPath)).report) continue
		const trials: ModelCalibrationTrial[] = []
		const delivered = []
		const statusCounts = Object.fromEntries(modelCalibrationStatusSchema.options.map((status) => [status, 0]))
		for (const task of taskRows) {
			const trial = await findTrialForTask(task.id)
			const parsedStatus = modelCalibrationStatusSchema.safeParse(trial ? trial.status : "missing")
			if (!parsedStatus.success) throw new Error(`Calibration task ${task.id} has an unknown trial status`)
			const status = parsedStatus.data
			statusCounts[status]!++
			const id = `run-${options.runId}-task-${task.id}`
			delivered.push({
				id,
				status,
				...(trial ? { attemptCount: trial.attemptCount, retryAssisted: trial.retryAssisted } : {}),
			})
			const outcome =
				status === "missing" || status === "pending" || status === "running"
					? undefined
					: calibrationOutcome(status)
			if (!outcome) continue
			trials.push({
				id,
				taskIdentity: identity,
				model: options.modelRole,
				passed: outcome.passed,
				unexpected: false,
				safetyFailed: outcome.safetyFailed,
				reviewed: false,
			})
		}
		const delivery = {
			model: options.modelRole,
			taskIdentity: identity,
			runId: options.runId,
			scheduled: taskRows.length,
			scoreable: trials.length,
			excluded: taskRows.length - trials.length,
			missing: statusCounts.missing,
			statusCounts,
			trials: delivered,
		}
		// Trial collection can overlap another model arm or human review. Merge only
		// this arm into the latest locked report, never the pre-query snapshot.
		await updateCalibrationReport(reportPath, (report) => {
			if (!report) return undefined
			if (report.taskIdentity !== identity)
				throw new Error(`Calibration report identity mismatch for ${identity}`)
			return mergeModelCalibration(report, trials, delivery)
		})
	}
}

export function calibrationOutcome(
	status: TrialTerminalStatus,
): { passed: boolean; safetyFailed: boolean } | undefined {
	switch (status) {
		case "infrastructure_error":
		case "grader_error":
		case "cancelled":
		case "human_handoff":
			return undefined
		case "passed":
		case "outcome_failed":
		case "safety_failed":
		case "budget_exhausted":
		case "agent_error":
			return { passed: status === "passed", safetyFailed: status === "safety_failed" }
		default:
			throw new Error("Unknown calibration trial status")
	}
}
