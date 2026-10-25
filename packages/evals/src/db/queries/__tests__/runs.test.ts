import { createRun, findRun, finishRun } from "../runs"
import { createTask } from "../tasks"
import { createTaskMetrics } from "../taskMetrics"
import { applyAttemptEvent, ensureAttempt, settleTrialAfterRetries } from "../lifecycle"

async function passTask(taskId: number): Promise<void> {
	const attempt = await ensureAttempt(taskId, 1)
	for (const event of [
		{ type: "start" },
		{ type: "setup_completed" },
		{ type: "agent_completed" },
		{ type: "evidence_collected" },
		{ type: "finalize", status: "passed" },
	] as const)
		await applyAttemptEvent(attempt.id, event)
}

describe("finishRun", () => {
	it("aggregates task metrics, including tool usage", async () => {
		const run = await createRun({ model: "gpt-4.1-mini", socketPath: "/tmp/roo.sock" })

		const first = await createTask({
			runId: run.id,
			taskMetricsId: (
				await createTaskMetrics({
					duration: 45_000,
					tokensIn: 100_000,
					tokensOut: 2_000,
					tokensContext: 102_000,
					cacheWrites: 0,
					cacheReads: 0,
					cost: 0.05,
					toolUsage: {
						read_file: {
							attempts: 3,
							failures: 0,
						},
						apply_diff: {
							attempts: 3,
							failures: 1,
						},
					},
				})
			).id,
			language: "go",
			exercise: "go/say",
			passed: true,
			startedAt: new Date(),
			finishedAt: new Date(),
		})

		await passTask(first.id)
		const second = await createTask({
			runId: run.id,
			taskMetricsId: (
				await createTaskMetrics({
					duration: 30_000,
					tokensIn: 75_000,
					tokensOut: 1_000,
					tokensContext: 76_000,
					cacheWrites: 0,
					cacheReads: 0,
					cost: 0.04,
					toolUsage: {
						read_file: {
							attempts: 3,
							failures: 0,
						},
						apply_diff: {
							attempts: 2,
							failures: 0,
						},
					},
				})
			).id,
			language: "go",
			exercise: "go/octal",
			passed: true,
			startedAt: new Date(),
			finishedAt: new Date(),
		})

		await passTask(second.id)
		const { taskMetrics } = await finishRun(run.id)

		expect(taskMetrics).toEqual({
			id: expect.any(Number),
			tokensIn: 175000,
			tokensOut: 3000,
			tokensContext: 178000,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0.09,
			duration: 75000,
			toolUsage: {
				read_file: { attempts: 6, failures: 0 },
				apply_diff: { attempts: 5, failures: 1 },
			},
			requestUsage: [],
			createdAt: expect.any(Date),
		})
	})

	it("does not finalize a run with one unfinished task or a legacy timestamp without a classified trial", async () => {
		const run = await createRun({ model: "fixture-model", socketPath: "/tmp/fixture.sock" })
		const passed = await createTask({ runId: run.id, language: "javascript", exercise: "pass" })
		await passTask(passed.id)
		const unfinished = await createTask({
			runId: run.id,
			language: "javascript",
			exercise: "unfinished",
			passed: true,
			finishedAt: new Date(),
		})
		await expect(finishRun(run.id)).rejects.toThrow(`incomplete: ${unfinished.id}`)
		expect((await findRun(run.id)).taskMetricsId).toBeNull()
	})

	it("retains an infrastructure failure in classified counts without manufacturing a scored failure", async () => {
		const run = await createRun({ model: "fixture-model", socketPath: "/tmp/fixture.sock" })
		const task = await createTask({ runId: run.id, language: "javascript", exercise: "setup-failure" })
		const attempt = await ensureAttempt(task.id, 1)
		await applyAttemptEvent(attempt.id, { type: "start" })
		await applyAttemptEvent(attempt.id, { type: "finalize", status: "infrastructure_error" })
		await settleTrialAfterRetries(task.id)
		const finished = await finishRun(run.id)
		expect(finished).toMatchObject({
			passed: 0,
			failed: 0,
			outcomeSummary: {
				total: 1,
				invalid: 1,
				counts: { infrastructure_error: 1 },
				incompleteTaskIds: [],
			},
		})
	})
})
