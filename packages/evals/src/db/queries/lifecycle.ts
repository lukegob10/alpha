import { and, asc, eq, isNull, sql } from "drizzle-orm"

import {
	deriveTrialResult,
	initialAttemptState,
	transitionAttempt,
	type AttemptLifecycleEvent,
} from "../../lifecycle/index"
import { attempts, tasks, trials, type Attempt, type Trial } from "../schema"
import { client as db, type DatabaseOrTransaction } from "../db"

export class LifecycleVersionConflictError extends Error {
	constructor(readonly attemptId: number) {
		super(`Attempt ${attemptId} changed while applying a lifecycle transition`)
		this.name = "LifecycleVersionConflictError"
	}
}

export async function ensureTrial(taskId: number, database: DatabaseOrTransaction = db): Promise<Trial> {
	const now = new Date()
	await database
		.insert(trials)
		.values({ taskId, createdAt: now, updatedAt: now })
		.onConflictDoNothing({ target: trials.taskId })

	const trial = await database.query.trials.findFirst({ where: eq(trials.taskId, taskId) })
	if (!trial) throw new Error(`Unable to create or find trial for task ${taskId}`)
	return trial
}

export async function ensureAttempt(taskId: number, attemptNumber: number): Promise<Attempt> {
	if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
		throw new Error(`attemptNumber must be a positive integer, received ${attemptNumber}`)
	}

	return db.transaction(async (tx) => {
		const trial = await ensureTrial(taskId, tx)
		const now = new Date()
		await tx
			.insert(attempts)
			.values({ trialId: trial.id, attemptNumber, createdAt: now, updatedAt: now })
			.onConflictDoNothing({ target: [attempts.trialId, attempts.attemptNumber] })

		const attempt = await tx.query.attempts.findFirst({
			where: and(eq(attempts.trialId, trial.id), eq(attempts.attemptNumber, attemptNumber)),
		})
		if (!attempt) throw new Error(`Unable to create or find attempt ${attemptNumber} for task ${taskId}`)
		return attempt
	})
}

export async function applyAttemptEvent(
	attemptId: number,
	event: AttemptLifecycleEvent,
	options: { expectedVersion?: number; now?: Date; retryPolicyExhausted?: boolean } = {},
): Promise<{ attempt: Attempt; trial: Trial }> {
	return db.transaction(async (tx) => {
		const current = await tx.query.attempts.findFirst({ where: eq(attempts.id, attemptId) })
		if (!current) throw new Error(`Attempt ${attemptId} not found`)
		if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
			throw new LifecycleVersionConflictError(attemptId)
		}

		const next = transitionAttempt(
			{
				phase: current.phase,
				terminalStatus: current.terminalStatus ?? undefined,
				failureCode: current.failureCode ?? undefined,
				failureDetail: current.failureDetail ?? undefined,
				version: current.version,
			},
			event,
		)
		const now = options.now ?? new Date()
		const [updated] = await tx
			.update(attempts)
			.set({
				phase: next.phase,
				terminalStatus: next.terminalStatus,
				failureCode: next.failureCode,
				failureDetail: next.failureDetail,
				version: next.version,
				startedAt: event.type === "start" ? now : current.startedAt,
				finishedAt: next.terminalStatus ? now : null,
				updatedAt: now,
			})
			.where(and(eq(attempts.id, attemptId), eq(attempts.version, current.version)))
			.returning()

		if (!updated) throw new LifecycleVersionConflictError(attemptId)
		const trial = await projectTrial(updated.trialId, tx, options.retryPolicyExhausted === true, now)
		return { attempt: updated, trial }
	})
}

export async function settleTrialAfterRetries(taskId: number, now = new Date()): Promise<Trial> {
	return db.transaction(async (tx) => {
		const trial = await ensureTrial(taskId, tx)
		await lockTrial(trial.id, tx)
		const persistedAttempts = await tx.query.attempts.findMany({
			where: eq(attempts.trialId, trial.id),
			orderBy: asc(attempts.attemptNumber),
		})
		if (persistedAttempts.length === 0) {
			await tx.insert(attempts).values({
				trialId: trial.id,
				attemptNumber: 1,
				phase: "created",
				terminalStatus: "infrastructure_error",
				failureCode: "retry_policy_exhausted_without_attempt",
				version: 1,
				finishedAt: now,
				createdAt: now,
				updatedAt: now,
			})
		} else {
			for (const attempt of persistedAttempts.filter(({ terminalStatus }) => terminalStatus === null)) {
				await tx
					.update(attempts)
					.set({
						terminalStatus: "infrastructure_error",
						failureCode: "retry_policy_exhausted_with_active_attempt",
						version: attempt.version + 1,
						finishedAt: now,
						updatedAt: now,
					})
					.where(and(eq(attempts.id, attempt.id), eq(attempts.version, attempt.version)))
			}
		}
		return projectTrial(trial.id, tx, true, now, false)
	})
}

export async function reconcileTrialAttempts(
	taskId: number,
	options: { failureCode: string; failureDetail?: string; retryPolicyExhausted?: boolean; now?: Date },
): Promise<Trial> {
	return db.transaction(async (tx) => {
		const trial = await ensureTrial(taskId, tx)
		await lockTrial(trial.id, tx)
		const activeAttempts = await tx.query.attempts.findMany({
			where: and(eq(attempts.trialId, trial.id), isNull(attempts.terminalStatus)),
			orderBy: asc(attempts.attemptNumber),
		})
		const now = options.now ?? new Date()

		for (const attempt of activeAttempts) {
			const next = transitionAttempt(
				{ ...initialAttemptState(), phase: attempt.phase, version: attempt.version },
				{
					type: "reconcile_interrupted",
					failureCode: options.failureCode,
					failureDetail: options.failureDetail,
				},
			)
			await tx
				.update(attempts)
				.set({
					terminalStatus: next.terminalStatus,
					failureCode: next.failureCode,
					failureDetail: next.failureDetail,
					version: next.version,
					finishedAt: now,
					updatedAt: now,
				})
				.where(and(eq(attempts.id, attempt.id), eq(attempts.version, attempt.version)))
		}

		return projectTrial(trial.id, tx, options.retryPolicyExhausted === true, now, false)
	})
}

export async function findTrialForTask(taskId: number) {
	return db.query.trials.findFirst({
		where: eq(trials.taskId, taskId),
		with: { attempts: { orderBy: asc(attempts.attemptNumber) } },
	})
}

async function projectTrial(
	trialId: number,
	tx: DatabaseOrTransaction,
	retryPolicyExhausted: boolean,
	now: Date,
	acquireLock = true,
): Promise<Trial> {
	if (acquireLock) await lockTrial(trialId, tx)
	const trial = await tx.query.trials.findFirst({ where: eq(trials.id, trialId) })
	if (!trial) throw new Error(`Trial ${trialId} not found`)
	const trialAttempts = await tx.query.attempts.findMany({
		where: eq(attempts.trialId, trialId),
		orderBy: asc(attempts.attemptNumber),
	})
	const derived = deriveTrialResult(
		trialAttempts.map((attempt) => attempt.terminalStatus ?? undefined),
		{ retryPolicyExhausted },
	)
	const firstStartedAt = trialAttempts.find((attempt) => attempt.startedAt)?.startedAt ?? trial.startedAt
	const status =
		derived.finished && derived.status ? derived.status : trialAttempts.length > 0 ? "running" : "pending"
	const [updatedTrial] = await tx
		.update(trials)
		.set({
			status,
			firstAttemptStatus: derived.firstAttemptStatus,
			retryAssisted: derived.retryAssisted,
			attemptCount: derived.attemptCount,
			startedAt: firstStartedAt,
			finishedAt: derived.finished ? now : null,
			updatedAt: now,
			version: sql`${trials.version} + 1`,
		})
		.where(eq(trials.id, trialId))
		.returning()
	if (!updatedTrial) throw new Error(`Unable to project trial ${trialId}`)

	await tx
		.update(tasks)
		.set({
			startedAt: firstStartedAt,
			finishedAt: derived.finished ? now : null,
			passed: derived.passed,
		})
		.where(eq(tasks.id, updatedTrial.taskId))

	return updatedTrial
}

async function lockTrial(trialId: number, tx: DatabaseOrTransaction): Promise<void> {
	await tx.execute(sql`SELECT ${trials.id} FROM ${trials} WHERE ${trials.id} = ${trialId} FOR UPDATE`)
}
