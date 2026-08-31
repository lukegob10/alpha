import type * as vscode from "vscode"
import { describe, expect, it, vi } from "vitest"

import type { GoalSeekAttempt, GoalSeekJob, GoalSeekRun, GoalSeekState } from "@alpha-code/types"

import type { ClineProvider } from "../../../core/webview/ClineProvider"
import type { GoalSeekStore } from "../GoalSeekStore"
import { GoalSeekService } from "../GoalSeekService"

const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

class MemoryGoalSeekStore {
	readonly jobs = new Map<string, GoalSeekJob>()
	readonly runs = new Map<string, GoalSeekRun>()
	readonly attempts = new Map<string, GoalSeekAttempt>()

	constructor(jobs: GoalSeekJob[]) {
		for (const job of jobs) {
			this.jobs.set(job.id, job)
		}
	}

	getState(): GoalSeekState {
		return {
			jobs: [...this.jobs.values()],
			runs: [...this.runs.values()],
			attempts: [...this.attempts.values()],
		}
	}

	getJob(id: string): GoalSeekJob | undefined {
		return this.jobs.get(id)
	}

	getRun(id: string): GoalSeekRun | undefined {
		return this.runs.get(id)
	}

	async upsertJob(job: GoalSeekJob): Promise<GoalSeekState> {
		this.jobs.set(job.id, job)
		return this.getState()
	}

	async deleteJob(jobId: string): Promise<GoalSeekState> {
		this.jobs.delete(jobId)
		const runIds = new Set(
			[...this.runs.values()].filter(({ jobId: ownerId }) => ownerId === jobId).map(({ id }) => id),
		)
		for (const runId of runIds) {
			this.runs.delete(runId)
		}
		for (const [attemptId, attempt] of this.attempts) {
			if (runIds.has(attempt.runId)) {
				this.attempts.delete(attemptId)
			}
		}
		return this.getState()
	}

	async upsertRun(run: GoalSeekRun): Promise<GoalSeekState> {
		this.runs.set(run.id, run)
		return this.getState()
	}

	async upsertAttempt(attempt: GoalSeekAttempt): Promise<GoalSeekState> {
		this.attempts.set(attempt.id, attempt)
		return this.getState()
	}

	async updateJobAndRun(job: GoalSeekJob, run: GoalSeekRun): Promise<GoalSeekState> {
		this.jobs.set(job.id, job)
		this.runs.set(run.id, run)
		return this.getState()
	}
}

const makeJob = (id: string, workspace: string): GoalSeekJob => ({
	id,
	name: `Job ${id}`,
	goal: "Improve the score",
	verifier: { type: "prompt", prompt: "Return a score" },
	direction: "maximize",
	targetScore: 100,
	maxAttempts: 1,
	maxFailedAttempts: 1,
	candidateCount: 1,
	workspace,
	rankingWeights: {
		expectedReward: 1,
		directoryRisk: 0.8,
		complexity: 0.7,
		regressionRisk: 0.8,
		reversibility: 0.5,
	},
	createdAt: 1,
	updatedAt: 1,
})

const createService = (jobs: GoalSeekJob[]) => {
	const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) } as unknown as ClineProvider
	const context = { globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext
	const outputChannel = {} as vscode.OutputChannel
	const service = new GoalSeekService(context, provider, outputChannel)
	const store = new MemoryGoalSeekStore(jobs)
	;(service as unknown as { store: GoalSeekStore }).store = store as unknown as GoalSeekStore
	return { service, store }
}

type GoalSeekServiceInternals = {
	runAlphaTask(
		prompt: string,
		workspace: string | undefined,
		mode: string | undefined,
		writeCapable: boolean,
	): Promise<{ taskId: string; result: string }>
	handleTaskCompleted(taskId: string): Promise<void>
	getTaskCompletionText(taskId: string): Promise<string>
	taskWaiters: Map<string, unknown>
}

describe("GoalSeekService task completion", () => {
	it("installs its completion waiter before a fast task can start", async () => {
		const taskId = "fast-task"
		let internals!: GoalSeekServiceInternals
		const start = vi.fn(() => {
			expect(internals.taskWaiters.has(taskId)).toBe(true)
			void internals.handleTaskCompleted(taskId)
		})
		const createTask = vi.fn(
			async (
				_prompt: string,
				_images: string[] | undefined,
				_parentTask: undefined,
				options: { startTask?: boolean },
			) => {
				expect(options.startTask).toBe(false)
				return { taskId, start }
			},
		)
		const provider = { createTask } as unknown as ClineProvider
		const context = { globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext
		const outputChannel = {} as vscode.OutputChannel
		const service = new GoalSeekService(context, provider, outputChannel)
		internals = service as unknown as GoalSeekServiceInternals
		vi.spyOn(internals, "getTaskCompletionText").mockResolvedValue("Fast completion result")

		const result = await internals.runAlphaTask("Do the work", "test-workspace", "code", true)

		expect(start).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ taskId, result: "Fast completion result" })
		expect(internals.taskWaiters.size).toBe(0)
	})
})

describe("GoalSeekService run lifecycle", () => {
	it("claims a workspace before awaiting its cleanliness check", async () => {
		const workspace = process.cwd()
		const { service, store } = createService([makeJob("job-a", workspace), makeJob("job-b", workspace)])
		const internals = service as unknown as {
			assertCleanWorkspace(workspace: string): Promise<void>
			executeRun(jobId: string, runId: string): Promise<void>
		}
		const clean = deferred<void>()
		const execution = deferred<void>()
		const cleanSpy = vi.spyOn(internals, "assertCleanWorkspace").mockReturnValue(clean.promise)
		const executeSpy = vi.spyOn(internals, "executeRun").mockReturnValue(execution.promise)

		const first = service.runJob("job-a")
		const second = service.runJob("job-b")
		await Promise.resolve()
		const cleanCallsBeforeRelease = cleanSpy.mock.calls.length
		clean.resolve(undefined)
		const outcomes = await Promise.allSettled([first, second])
		execution.resolve(undefined)
		await execution.promise

		expect(cleanCallsBeforeRelease).toBe(1)
		expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
		expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1)
		expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringMatching(/already has an active run/i) }),
		})
		expect(store.runs.size).toBe(1)
		expect(executeSpy).toHaveBeenCalledTimes(1)
	})
})
