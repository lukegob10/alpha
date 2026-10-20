import os from "node:os"
import path from "node:path"
import PQueue from "p-queue"

import {
	applyAttemptEvent,
	ensureAttempt,
	findRun,
	findTrialForTask,
	finishRun,
	getTasks,
	getPresentationModelCallPolicyEvents,
	settleTrialAfterRetries,
	updateTask,
} from "../db/index"
import { CampaignCostLedger } from "../benchmark/budgets"
import { canonicalJson, sha256 } from "../evidence/index"
import { EVALS_REPO_PATH } from "../exercises/index"

import { Logger, getTag, isDockerContainer, resetEvalsRepo, commitEvalsRepoChanges } from "./utils"
import { startHeartbeat, stopHeartbeat } from "./redis"
import { processTask, processTaskInContainer } from "./processTask"
import { presentationModelCallPolicySchema } from "./types"

export const runEvals = async (runId: number) => {
	const run = await findRun(runId)

	if (run.taskMetricsId) {
		throw new Error(`Run ${run.id} already finished.`)
	}

	const tasks = await getTasks(runId)

	if (tasks.length === 0) {
		throw new Error(`Run ${run.id} has no tasks.`)
	}
	if (run.campaignHardCapUsd !== null) {
		if (run.taskCostCapUsd === null) throw new Error("Governed campaigns require a per-task cost reservation")
		const reserved = tasks.length * run.taskCostCapUsd
		if (reserved > run.campaignHardCapUsd + Number.EPSILON)
			throw new Error(
				`Campaign reservations $${reserved.toFixed(2)} exceed hard cap $${run.campaignHardCapUsd.toFixed(2)}`,
			)
		if ((run.campaignTier === "t5" || run.campaignHardCapUsd > 2) && !run.highCostApproved)
			throw new Error("T5 or a campaign cap above $2 requires explicit approval")
		if (run.modelFallbackAllowed) throw new Error("Governed benchmark campaigns prohibit model fallback")
		if (run.concurrency !== 1)
			throw new Error("Governed benchmark campaigns require concurrency 1 for live cost reconciliation")
	}

	const containerized = isDockerContainer()
	const benchmarkTasks = tasks.filter((task) => task.benchmarkTaskIdentity)
	if (benchmarkTasks.length > 0 && benchmarkTasks.length !== tasks.length) {
		throw new Error("Benchmark and legacy tasks must use separate runs")
	}
	const managesLegacyCheckout = !containerized && benchmarkTasks.length === 0

	const logger = new Logger({
		logDir: containerized
			? `/var/log/evals/runs/${run.id}`
			: path.join(os.tmpdir(), "evals", "runs", String(run.id)),
		filename: `controller.log`,
		tag: getTag("runEvals", { run }),
	})

	let heartbeat: Awaited<ReturnType<typeof startHeartbeat>> | undefined
	let failure: { error: unknown } | undefined
	try {
		logger.info(`running ${tasks.length} task(s)`)

		if (managesLegacyCheckout) {
			await resetEvalsRepo({ run, cwd: EVALS_REPO_PATH })
		}

		heartbeat = await startHeartbeat(run.id)
		const queue = new PQueue({ concurrency: run.concurrency })

		const STAGGER_DELAY_MS = 5000
		const filteredTasks = tasks.filter((task) => task.finishedAt === null)

		const createTaskRunner = (task: (typeof filteredTasks)[number]) => async () => {
			try {
				if (task.benchmarkPartition === "holdout") await assertVisibleGatePassed(run.id)
				if (containerized) {
					return await processTaskInContainer({ taskId: task.id, jobToken: run.jobToken, logger })
				} else {
					return await processTask({ taskId: task.id, jobToken: run.jobToken, logger })
				}
			} catch (error) {
				logger.error("error processing task", error)
				// A failed governed attempt cannot establish known spend or authorize another paid dispatch.
				if (run.campaignHardCapUsd !== null) throw error
			}
		}

		if (run.campaignHardCapUsd !== null && run.taskCostCapUsd !== null) {
			const ledger = new CampaignCostLedger(run.campaignHardCapUsd)
			for (const completed of tasks.filter(({ finishedAt }) => finishedAt !== null)) {
				const actualCost = requireActualTaskCost(completed.id, completed.taskMetrics?.cost)
				await assertGovernedContinuationAllowed(completed.id)
				ledger.settle(0, actualCost)
			}
			for (let index = 0; index < filteredTasks.length; index++) {
				const task = filteredTasks[index]!
				try {
					ledger.reserve(run.taskCostCapUsd)
				} catch {
					await finalizeCampaignBudgetExhausted(filteredTasks.slice(index))
					break
				}
				const executionOutcome = await createTaskRunner(task)()
				const refreshed = (await getTasks(run.id)).find(({ id }) => id === task.id)
				const actualCost = requireActualTaskCost(task.id, refreshed?.taskMetrics?.cost)
				try {
					ledger.settle(run.taskCostCapUsd, actualCost)
				} catch (error) {
					logger.error("campaign hard cap exceeded after provider accounting", error)
					await finalizeCampaignBudgetExhausted(filteredTasks.slice(index + 1))
					break
				}
				logger.info("campaign budget", ledger.snapshot())
				await assertGovernedContinuationAllowed(task.id, executionOutcome)
			}
		} else {
			// Legacy, non-governed campaigns retain concurrent scheduling.
			for (let i = 0; i < filteredTasks.length; i++) {
				const task = filteredTasks[i]
				if (!task) continue
				if (run.concurrency > 1 && i > 0) await new Promise((resolve) => setTimeout(resolve, STAGGER_DELAY_MS))
				queue.add(createTaskRunner(task))
			}
			await queue.onIdle()
		}

		logger.info("finishRun")
		const result = await finishRun(run.id)
		logger.info("result ->", {
			runId: result.id,
			passed: result.passed,
			failed: result.failed,
			costUsd: result.taskMetrics?.cost,
			durationMs: result.taskMetrics?.duration,
		})

		// There's no need to commit the changes in the container since they
		// will lost when the container is destroyed. I think we should
		// store the diffs in the database instead.
		if (managesLegacyCheckout) {
			await commitEvalsRepoChanges({ run, cwd: EVALS_REPO_PATH })
		}
	} catch (error) {
		failure = { error }
	} finally {
		try {
			logger.info("cleaning up")
			if (heartbeat !== undefined) await stopHeartbeat(run.id, heartbeat)
		} catch (error) {
			if (!failure) failure = { error }
		} finally {
			try {
				logger.close()
			} catch (error) {
				if (!failure) failure = { error }
			}
		}
	}
	if (failure) throw failure.error
}

function requireActualTaskCost(taskId: number, cost: number | null | undefined): number {
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
		throw new Error(`Known finite actual cost is required for governed task ${taskId}`)
	return cost
}

async function assertGovernedContinuationAllowed(
	taskId: number,
	executionOutcome?: Awaited<ReturnType<typeof processTask>>,
): Promise<void> {
	const trial = await findTrialForTask(taskId)
	const status = executionOutcome === "cancelled" ? "cancelled" : trial?.status
	if (
		!trial ||
		status === undefined ||
		status === "pending" ||
		status === "running" ||
		status === "cancelled" ||
		status === "safety_failed" ||
		status === "grader_error" ||
		status === "infrastructure_error"
	) {
		throw new Error(`Governed campaign stopped after task ${taskId}: ${status ?? "missing trial"}`)
	}
	const missingPolicyProof = () =>
		new Error(
			`Governed campaign stopped after task ${taskId}: missing or invalid presentation model call policy proof`,
		)
	if (!trial.attempts?.length) throw missingPolicyProof()
	for (const attempt of trial.attempts) {
		const records = await getPresentationModelCallPolicyEvents(attempt.id)
		const record = records.length === 1 ? records[0] : undefined
		if (
			!record ||
			record.attemptId !== attempt.id ||
			record.type !== "extension.presentation_model_call_policy" ||
			record.late !== false ||
			!presentationModelCallPolicySchema.safeParse(record.payload).success ||
			record.payloadDigest !== sha256(canonicalJson(record.payload))
		)
			throw missingPolicyProof()
	}
}

async function finalizeCampaignBudgetExhausted(tasks: Array<{ id: number }>): Promise<void> {
	for (const task of tasks) {
		const attempt = await ensureAttempt(task.id, 1)
		if (!attempt.terminalStatus) {
			if (attempt.phase === "created") await applyAttemptEvent(attempt.id, { type: "start" })
			await applyAttemptEvent(attempt.id, {
				type: "finalize",
				status: "budget_exhausted",
				failureCode: "campaign_budget_unavailable",
				failureDetail: "The remaining campaign budget could not reserve this task",
			})
		}
		await updateTask(task.id, { finishedAt: new Date() })
		await settleTrialAfterRetries(task.id)
	}
}

async function assertVisibleGatePassed(runId: number): Promise<void> {
	const visible = (await getTasks(runId)).filter(
		({ benchmarkPartition }) => benchmarkPartition === "development" || benchmarkPartition === "regression",
	)
	if (!visible.length || visible.some(({ finishedAt }) => finishedAt === null))
		throw new Error("Private holdout execution requires completed visible evidence")
	const trials = await Promise.all(visible.map(({ id }) => findTrialForTask(id)))
	if (trials.some((trial) => !trial || trial.status === "pending" || trial.status === "running"))
		throw new Error("Private holdout execution requires terminal visible trials")
	if (trials.some((trial) => trial?.status === "safety_failed"))
		throw new Error("Private holdout execution is blocked by a visible safety failure")
	if (trials.some((trial) => trial?.status === "infrastructure_error" || trial?.status === "grader_error"))
		throw new Error("Private holdout execution is blocked by invalid visible evidence")
}
