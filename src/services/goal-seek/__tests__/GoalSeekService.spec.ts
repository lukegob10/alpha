import type * as vscode from "vscode"
import { describe, expect, it, vi } from "vitest"

import type {
	GoalSeekAttempt,
	GoalSeekCandidate,
	GoalSeekJob,
	GoalSeekRun,
	GoalSeekState,
	GoalSeekVerifierResult,
} from "@alpha-code/types"

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

const candidate: GoalSeekCandidate = {
	id: "candidate-a",
	title: "Bounded improvement",
	rationale: "Improve the target",
	expectedRewardImpact: 10,
	affectedPaths: ["src/example.ts"],
	directoryRisk: 1,
	complexity: 1,
	regressionRisk: 1,
	reversibility: 100,
	utilityScore: 10,
}

const passingVerifierResult: GoalSeekVerifierResult = {
	score: 100,
	direction: "maximize",
	improved: true,
	passedTarget: true,
	reason: "Target reached",
	rawOutput: '{"score":100}',
}

const createService = (jobs: GoalSeekJob[]) => {
	const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) } as unknown as ClineProvider
	const context = { globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext
	const outputChannel = {} as vscode.OutputChannel
	const service = new GoalSeekService(context, provider, outputChannel)
	const store = new MemoryGoalSeekStore(jobs)
	;(service as unknown as { store: GoalSeekStore }).store = store as unknown as GoalSeekStore
	return { service, store, provider }
}

type GoalSeekServiceInternals = {
	runAlphaTask(
		prompt: string,
		workspace: string | undefined,
		mode: string | undefined,
		writeCapable: boolean,
		runId?: string,
	): Promise<{ taskId: string; result: string }>
	handleTaskCompleted(taskId: string): Promise<void>
	getTaskCompletionText(taskId: string): Promise<string>
	taskWaiters: Map<string, unknown>
	canceledRuns: Set<string>
	activeTasksByRun: Map<string, unknown>
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

	it("joins a task canceled before start before releasing it", async () => {
		const { service, provider } = createService([])
		const internals = service as unknown as GoalSeekServiceInternals
		const runId = "run-canceled-before-start"
		const termination = deferred<void>()
		const order: string[] = []
		const task = {
			taskId: "never-started-task",
			start: vi.fn(),
			abortTask: vi.fn().mockImplementation(async () => {
				order.push("abort")
			}),
			waitForTermination: vi.fn().mockImplementation(async () => {
				order.push("wait-start")
				await termination.promise
				order.push("wait-complete")
			}),
		}
		;(provider as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask = vi.fn().mockResolvedValue(task)
		internals.canceledRuns.add(runId)

		const result = internals.runAlphaTask("Do the work", "test-workspace", "code", true, runId)
		await vi.waitFor(() => expect(task.waitForTermination).toHaveBeenCalledTimes(1))
		expect(order).toEqual(["abort", "wait-start"])
		expect(task.start).not.toHaveBeenCalled()

		termination.resolve(undefined)
		await expect(result).rejects.toThrow("Goal Seek run was canceled")
		expect(order).toEqual(["abort", "wait-start", "wait-complete"])
		expect(internals.activeTasksByRun.has(runId)).toBe(false)
	})

	it("retains a pre-start task when its termination boundary fails", async () => {
		const { service, provider } = createService([])
		const internals = service as unknown as GoalSeekServiceInternals
		const runId = "run-failed-before-start"
		const task = {
			taskId: "failed-never-started-task",
			start: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			waitForTermination: vi
				.fn()
				.mockRejectedValueOnce(new Error("termination persistence failed"))
				.mockResolvedValue(undefined),
		}
		;(provider as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask = vi.fn().mockResolvedValue(task)
		internals.canceledRuns.add(runId)

		await expect(internals.runAlphaTask("Do the work", "test-workspace", "code", true, runId)).rejects.toThrow(
			"termination persistence failed",
		)
		expect(task.start).not.toHaveBeenCalled()
		expect(internals.activeTasksByRun.has(runId)).toBe(true)

		await expect(internals.runAlphaTask("Do the work", "test-workspace", "code", true, runId)).rejects.toThrow(
			"Goal Seek run was canceled",
		)
		expect(internals.activeTasksByRun.has(runId)).toBe(false)
	})
})

describe("GoalSeekService run lifecycle", () => {
	it("preserves job edits made while a run is active", async () => {
		const workspace = process.cwd()
		const staleJob = makeJob("job-a", workspace)
		const { service, store } = createService([staleJob])
		const internals = service as unknown as {
			finishRun(job: GoalSeekJob, run: GoalSeekRun): Promise<void>
		}
		const running: GoalSeekRun = {
			id: "run-a",
			jobId: staleJob.id,
			status: "running",
			startedAt: 1,
			currentIteration: 0,
			failedAttempts: 0,
		}
		await store.updateJobAndRun(staleJob, running)
		await service.updateJob(staleJob.id, { name: "Edited during run" })

		await internals.finishRun(staleJob, {
			...running,
			status: "failed",
			exitReason: "max_attempts_reached",
			finishedAt: 2,
		})

		expect(store.getJob(staleJob.id)?.name).toBe("Edited during run")
		expect(store.getJob(staleJob.id)?.lastRunStatus).toBe("failed")
	})

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

	it("does not commit or succeed when canceled during implementation", async () => {
		const workspace = process.cwd()
		const { service, store } = createService([makeJob("job-a", workspace)])
		const internals = service as unknown as {
			assertCleanWorkspace(workspace: string): Promise<void>
			generateCandidates(job: GoalSeekJob, run: GoalSeekRun, feedback: string): Promise<GoalSeekCandidate[]>
			gitRevParse(workspace: string, ref: string): Promise<string>
			runAlphaTask(
				prompt: string,
				workspace: string | undefined,
				mode: string | undefined,
				writeCapable: boolean,
			): Promise<{ taskId: string; result: string }>
			runVerifier(job: GoalSeekJob, run: GoalSeekRun, attempt: GoalSeekAttempt): Promise<GoalSeekVerifierResult>
			commitAcceptedAttempt(
				job: GoalSeekJob,
				selected: GoalSeekCandidate,
				attempt: GoalSeekAttempt,
			): Promise<void>
			gitResetHard(workspace: string, ref: string): Promise<void>
			runExecutions: Map<string, Promise<void>>
			canceledRuns: Set<string>
		}
		const implementationStarted = deferred<void>()
		const implementation = deferred<{ taskId: string; result: string }>()
		vi.spyOn(internals, "assertCleanWorkspace").mockResolvedValue(undefined)
		vi.spyOn(internals, "generateCandidates").mockResolvedValue([candidate])
		vi.spyOn(internals, "gitRevParse").mockResolvedValue("checkpoint-a")
		vi.spyOn(internals, "runAlphaTask").mockImplementation(async () => {
			implementationStarted.resolve(undefined)
			return implementation.promise
		})
		vi.spyOn(internals, "runVerifier").mockResolvedValue(passingVerifierResult)
		const commit = vi.spyOn(internals, "commitAcceptedAttempt").mockResolvedValue(undefined)
		const reset = vi.spyOn(internals, "gitResetHard").mockResolvedValue(undefined)

		const run = await service.runJob("job-a")
		const execution = internals.runExecutions.get(run.id)!
		await implementationStarted.promise
		const cancellation = service.cancelRun(run.id)
		await Promise.resolve()
		implementation.resolve({ taskId: "implementation-task", result: "Implemented" })
		await Promise.all([cancellation, execution])

		expect(commit).not.toHaveBeenCalled()
		expect(reset).toHaveBeenCalledWith(workspace, "checkpoint-a")
		expect(store.getRun(run.id)?.status).toBe("canceled")
		expect(store.getJob("job-a")?.lastRunStatus).toBe("canceled")
		expect([...store.attempts.values()]).toMatchObject([{ status: "canceled" }])
		expect(internals.canceledRuns.has(run.id)).toBe(false)
	})

	it("aborts active background work before cancellation settles", async () => {
		const workspace = process.cwd()
		const { service, store, provider } = createService([makeJob("job-a", workspace)])
		const internals = service as unknown as {
			assertCleanWorkspace(workspace: string): Promise<void>
			generateCandidates(job: GoalSeekJob, run: GoalSeekRun, feedback: string): Promise<GoalSeekCandidate[]>
			gitRevParse(workspace: string, ref: string): Promise<string>
			gitResetHard(workspace: string, ref: string): Promise<void>
		}
		const taskStarted = deferred<void>()
		const termination = deferred<void>()
		const order: string[] = []
		const abortTask = vi.fn().mockImplementation(async () => {
			order.push("abort")
		})
		const waitForTermination = vi.fn().mockImplementation(async () => {
			order.push("wait-start")
			await termination.promise
			order.push("wait-complete")
		})
		;(provider as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask = vi.fn().mockResolvedValue({
			taskId: "implementation-task",
			start: () => taskStarted.resolve(undefined),
			abortTask,
			waitForTermination,
		})
		vi.spyOn(internals, "assertCleanWorkspace").mockResolvedValue(undefined)
		vi.spyOn(internals, "generateCandidates").mockResolvedValue([candidate])
		vi.spyOn(internals, "gitRevParse").mockResolvedValue("checkpoint-a")
		vi.spyOn(internals, "gitResetHard").mockImplementation(async () => {
			order.push("reset")
		})

		const run = await service.runJob("job-a")
		await taskStarted.promise
		const cancellation = service.cancelRun(run.id)
		await vi.waitFor(() => expect(waitForTermination).toHaveBeenCalledTimes(1))
		expect(order).toEqual(["abort", "wait-start"])
		expect(internals.gitResetHard).not.toHaveBeenCalled()

		termination.resolve(undefined)
		await cancellation

		expect(abortTask).toHaveBeenCalledTimes(1)
		expect(order).toEqual(["abort", "wait-start", "wait-complete", "reset"])
		expect(store.getRun(run.id)?.status).toBe("canceled")
	})

	it("fails closed when active task termination persistence rejects", async () => {
		const workspace = process.cwd()
		const { service, store, provider } = createService([makeJob("job-a", workspace)])
		const internals = service as unknown as GoalSeekServiceInternals & {
			assertCleanWorkspace(workspace: string): Promise<void>
			generateCandidates(job: GoalSeekJob, run: GoalSeekRun, feedback: string): Promise<GoalSeekCandidate[]>
			gitRevParse(workspace: string, ref: string): Promise<string>
			gitResetHard(workspace: string, ref: string): Promise<void>
		}
		const taskStarted = deferred<void>()
		const abortTask = vi.fn().mockResolvedValue(undefined)
		const waitForTermination = vi
			.fn()
			.mockRejectedValueOnce(new Error("termination persistence failed"))
			.mockResolvedValue(undefined)
		;(provider as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask = vi.fn().mockResolvedValue({
			taskId: "implementation-task",
			start: () => taskStarted.resolve(undefined),
			abortTask,
			waitForTermination,
		})
		vi.spyOn(internals, "assertCleanWorkspace").mockResolvedValue(undefined)
		vi.spyOn(internals, "generateCandidates").mockResolvedValue([candidate])
		vi.spyOn(internals, "gitRevParse").mockResolvedValue("checkpoint-a")
		const reset = vi.spyOn(internals, "gitResetHard").mockResolvedValue(undefined)

		const run = await service.runJob("job-a")
		await taskStarted.promise

		await expect(service.cancelRun(run.id)).rejects.toThrow("termination persistence failed")
		expect(reset).not.toHaveBeenCalled()
		expect(store.getRun(run.id)?.status).toBe("running")
		expect(internals.taskWaiters.has("implementation-task")).toBe(true)
		expect(internals.activeTasksByRun.has(run.id)).toBe(true)

		await service.cancelRun(run.id)
		expect(reset).toHaveBeenCalledWith(workspace, "checkpoint-a")
		expect(store.getRun(run.id)?.status).toBe("canceled")
	})

	it("drains an active run before deleting its persisted state", async () => {
		const workspace = process.cwd()
		const { service, store } = createService([makeJob("job-a", workspace)])
		const internals = service as unknown as {
			assertCleanWorkspace(workspace: string): Promise<void>
			generateCandidates(job: GoalSeekJob, run: GoalSeekRun, feedback: string): Promise<GoalSeekCandidate[]>
			gitRevParse(workspace: string, ref: string): Promise<string>
			runAlphaTask(
				prompt: string,
				workspace: string | undefined,
				mode: string | undefined,
				writeCapable: boolean,
			): Promise<{ taskId: string; result: string }>
			runVerifier(job: GoalSeekJob, run: GoalSeekRun, attempt: GoalSeekAttempt): Promise<GoalSeekVerifierResult>
			commitAcceptedAttempt(
				job: GoalSeekJob,
				selected: GoalSeekCandidate,
				attempt: GoalSeekAttempt,
			): Promise<void>
			gitResetHard(workspace: string, ref: string): Promise<void>
			runExecutions: Map<string, Promise<void>>
		}
		const implementationStarted = deferred<void>()
		const implementation = deferred<{ taskId: string; result: string }>()
		vi.spyOn(internals, "assertCleanWorkspace").mockResolvedValue(undefined)
		vi.spyOn(internals, "generateCandidates").mockResolvedValue([candidate])
		vi.spyOn(internals, "gitRevParse").mockResolvedValue("checkpoint-a")
		vi.spyOn(internals, "runAlphaTask").mockImplementation(async () => {
			implementationStarted.resolve(undefined)
			return implementation.promise
		})
		vi.spyOn(internals, "runVerifier").mockResolvedValue(passingVerifierResult)
		const commit = vi.spyOn(internals, "commitAcceptedAttempt").mockResolvedValue(undefined)
		const reset = vi.spyOn(internals, "gitResetHard").mockResolvedValue(undefined)

		const run = await service.runJob("job-a")
		const execution = internals.runExecutions.get(run.id)!
		await implementationStarted.promise
		const deletion = service.deleteJob("job-a")
		await Promise.resolve()
		implementation.resolve({ taskId: "implementation-task", result: "Implemented" })
		await Promise.all([deletion, execution])

		expect(commit).not.toHaveBeenCalled()
		expect(reset).toHaveBeenCalledWith(workspace, "checkpoint-a")
		expect(store.jobs.size).toBe(0)
		expect(store.runs.size).toBe(0)
		expect(store.attempts.size).toBe(0)
	})

	it("drains a run preflight and rejects updates after deletion begins", async () => {
		const workspace = process.cwd()
		const { service, store } = createService([makeJob("job-a", workspace)])
		const internals = service as unknown as {
			assertCleanWorkspace(workspace: string): Promise<void>
			executeRun(jobId: string, runId: string): Promise<void>
			activeWorkspaceRuns: Map<string, string>
		}
		const clean = deferred<void>()
		vi.spyOn(internals, "assertCleanWorkspace").mockReturnValue(clean.promise)
		const execute = vi.spyOn(internals, "executeRun").mockResolvedValue(undefined)

		await service.updateJob("job-a", { name: "Updated before delete" })
		const run = service.runJob("job-a")
		const deletion = service.deleteJob("job-a")
		await Promise.resolve()
		const jobWhileDeletionDrained = store.getJob("job-a")
		await expect(service.updateJob("job-a", { name: "Updated after delete" })).rejects.toThrow(/delet/i)

		clean.resolve(undefined)
		await expect(run).rejects.toThrow(/deleted/i)
		await deletion

		expect(jobWhileDeletionDrained?.name).toBe("Updated before delete")
		expect(execute).not.toHaveBeenCalled()
		expect(store.jobs.size).toBe(0)
		expect(store.runs.size).toBe(0)
		expect(internals.activeWorkspaceRuns.size).toBe(0)
	})
})
