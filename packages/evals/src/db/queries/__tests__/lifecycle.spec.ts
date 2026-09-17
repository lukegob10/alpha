import { describe, expect, it } from "vitest"

import type { AttemptLifecycleEvent, TrialTerminalStatus } from "../../../lifecycle/index"
import { createRun, finishRun } from "../runs"
import { createTask, findTask } from "../tasks"
import {
	LifecycleVersionConflictError,
	applyAttemptEvent,
	ensureAttempt,
	findTrialForTask,
	reconcileTrialAttempts,
	settleTrialAfterRetries,
} from "../lifecycle"

async function makeTask() {
	const run = await createRun({ model: "test-model", socketPath: "test.sock" })
	return createTask({ runId: run.id, language: "javascript", exercise: `lifecycle-${crypto.randomUUID()}` })
}

async function advanceToGrading(attemptId: number) {
	const events: AttemptLifecycleEvent[] = [
		{ type: "start" },
		{ type: "setup_completed" },
		{ type: "agent_completed" },
		{ type: "evidence_collected" },
	]
	let result
	for (const event of events) result = await applyAttemptEvent(attemptId, event)
	return result!
}

async function finalizeScored(attemptId: number, status: Extract<TrialTerminalStatus, "passed" | "outcome_failed">) {
	await advanceToGrading(attemptId)
	return applyAttemptEvent(attemptId, { type: "finalize", status })
}

describe("durable trial lifecycle", () => {
	it("idempotently creates one trial and attempt under concurrency", async () => {
		const task = await makeTask()
		const created = await Promise.all(Array.from({ length: 5 }, () => ensureAttempt(task.id, 1)))
		expect(new Set(created.map(({ id }) => id))).toHaveLength(1)
		const trial = await findTrialForTask(task.id)
		expect(trial?.attempts).toHaveLength(1)
		expect(trial?.status).toBe("pending")
	})

	it("projects a passed attempt into the legacy task fields", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		const { trial } = await finalizeScored(attempt.id, "passed")
		const projectedTask = await findTask(task.id)

		expect(trial).toMatchObject({
			status: "passed",
			firstAttemptStatus: "passed",
			retryAssisted: false,
			attemptCount: 1,
		})
		expect(trial.startedAt).not.toBeNull()
		expect(trial.finishedAt).not.toBeNull()
		expect(projectedTask).toMatchObject({ passed: true })
		expect(projectedTask.startedAt).not.toBeNull()
		expect(projectedTask.finishedAt).not.toBeNull()
	})

	it("retains first-attempt failure when a retry passes", async () => {
		const task = await makeTask()
		const first = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(first.id, { type: "start" })
		await applyAttemptEvent(first.id, {
			type: "finalize",
			status: "infrastructure_error",
			failureCode: "runner_exit",
		})
		const second = await ensureAttempt(task.id, 2)
		const { trial } = await finalizeScored(second.id, "passed")

		expect(trial).toMatchObject({
			status: "passed",
			firstAttemptStatus: "infrastructure_error",
			retryAssisted: true,
			attemptCount: 2,
		})
		expect((await findTrialForTask(task.id))?.attempts.map(({ terminalStatus }) => terminalStatus)).toEqual([
			"infrastructure_error",
			"passed",
		])
	})

	it("settles exhausted infrastructure retries without scoring an agent failure", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(attempt.id, { type: "start" })
		const active = await applyAttemptEvent(attempt.id, {
			type: "finalize",
			status: "infrastructure_error",
			failureCode: "container_exit",
		})
		expect(active.trial.status).toBe("running")
		expect((await findTask(task.id)).finishedAt).toBeNull()

		const settled = await settleTrialAfterRetries(task.id)
		const projectedTask = await findTask(task.id)
		expect(settled.status).toBe("infrastructure_error")
		expect(settled.finishedAt).not.toBeNull()
		expect(projectedTask.passed).toBeNull()
		expect(projectedTask.finishedAt).not.toBeNull()
	})

	it("creates terminal infrastructure evidence when settlement occurs before an attempt starts", async () => {
		const task = await makeTask()
		const settled = await settleTrialAfterRetries(task.id)
		const persisted = await findTrialForTask(task.id)
		expect(settled.status).toBe("infrastructure_error")
		expect(persisted?.attempts).toHaveLength(1)
		expect(persisted?.attempts[0]).toMatchObject({
			phase: "created",
			terminalStatus: "infrastructure_error",
			failureCode: "retry_policy_exhausted_without_attempt",
		})
		expect((await findTask(task.id)).finishedAt).not.toBeNull()
	})

	it("rejects stale optimistic transitions without mutating the attempt", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(attempt.id, { type: "start" }, { expectedVersion: 0 })
		await expect(
			applyAttemptEvent(attempt.id, { type: "setup_completed" }, { expectedVersion: 0 }),
		).rejects.toBeInstanceOf(LifecycleVersionConflictError)
		expect((await findTrialForTask(task.id))?.attempts[0]).toMatchObject({ phase: "setup", version: 1 })
	})

	it("allows only one winner when duplicate transitions race", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		const results = await Promise.allSettled([
			applyAttemptEvent(attempt.id, { type: "start" }, { expectedVersion: 0 }),
			applyAttemptEvent(attempt.id, { type: "start" }, { expectedVersion: 0 }),
		])
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
		expect((await findTrialForTask(task.id))?.attempts[0]).toMatchObject({ phase: "setup", version: 1 })
	})

	it("reconciles every open attempt and can settle the trial", async () => {
		const task = await makeTask()
		const first = await ensureAttempt(task.id, 1)
		const second = await ensureAttempt(task.id, 2)
		await applyAttemptEvent(first.id, { type: "start" })
		await applyAttemptEvent(second.id, { type: "start" })

		const trial = await reconcileTrialAttempts(task.id, {
			failureCode: "controller_restart",
			failureDetail: "active attempts had no live runner",
			retryPolicyExhausted: true,
		})
		const persisted = await findTrialForTask(task.id)
		expect(trial.status).toBe("infrastructure_error")
		expect(persisted?.attempts).toHaveLength(2)
		expect(persisted?.attempts.every(({ terminalStatus }) => terminalStatus === "infrastructure_error")).toBe(true)
		expect(persisted?.attempts.every(({ failureCode }) => failureCode === "controller_restart")).toBe(true)
	})

	it("is outcome-idempotent when restart reconciliation repeats", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(attempt.id, { type: "start" })
		const first = await reconcileTrialAttempts(task.id, {
			failureCode: "controller_restart",
			retryPolicyExhausted: true,
		})
		const second = await reconcileTrialAttempts(task.id, {
			failureCode: "controller_restart",
			retryPolicyExhausted: true,
		})
		const persisted = await findTrialForTask(task.id)
		expect(first.status).toBe("infrastructure_error")
		expect(second.status).toBe("infrastructure_error")
		expect(persisted?.attempts).toHaveLength(1)
		expect(persisted?.attempts[0]).toMatchObject({ terminalStatus: "infrastructure_error", version: 2 })
	})

	it("deterministically derives a pass when concurrent attempts finalize different scored outcomes", async () => {
		const task = await makeTask()
		const first = await ensureAttempt(task.id, 1)
		const second = await ensureAttempt(task.id, 2)
		await Promise.all([advanceToGrading(first.id), advanceToGrading(second.id)])
		await Promise.all([
			applyAttemptEvent(first.id, { type: "finalize", status: "outcome_failed" }),
			applyAttemptEvent(second.id, { type: "finalize", status: "passed" }),
		])
		const trial = await findTrialForTask(task.id)
		expect(trial).toMatchObject({
			status: "passed",
			firstAttemptStatus: "outcome_failed",
			retryAssisted: true,
			attemptCount: 2,
		})
		expect((await findTask(task.id)).passed).toBe(true)
	})

	it("finishes a deterministic outcome failure as a scored failure", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		const { trial } = await finalizeScored(attempt.id, "outcome_failed")
		expect(trial.status).toBe("outcome_failed")
		expect((await findTask(task.id)).passed).toBe(false)
	})

	it("excludes infrastructure outcomes from legacy pass/fail run totals", async () => {
		const task = await makeTask()
		const attempt = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(attempt.id, { type: "start" })
		await applyAttemptEvent(attempt.id, {
			type: "finalize",
			status: "infrastructure_error",
			failureCode: "runner_unavailable",
		})
		await settleTrialAfterRetries(task.id)

		const result = await finishRun(task.runId)
		expect(result).toMatchObject({ passed: 0, failed: 0 })
		expect(result.taskMetrics).toMatchObject({
			tokensIn: 0,
			tokensOut: 0,
			cost: 0,
			duration: 0,
		})
	})
})
