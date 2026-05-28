import * as fs from "fs/promises"
import * as path from "path"

import type { GoalSeekAttempt, GoalSeekJob, GoalSeekRun, GoalSeekState } from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"

export class GoalSeekStore {
	private jobs = new Map<string, GoalSeekJob>()
	private runs = new Map<string, GoalSeekRun>()
	private attempts = new Map<string, GoalSeekAttempt>()
	private writeLock: Promise<void> = Promise.resolve()

	constructor(private readonly globalStoragePath: string) {}

	async initialize(): Promise<void> {
		const dir = await this.getDir()
		await fs.mkdir(dir, { recursive: true })
		await Promise.all([this.loadJobs(), this.loadRuns(), this.loadAttempts()])
	}

	getState(): GoalSeekState {
		return {
			jobs: Array.from(this.jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt),
			runs: Array.from(this.runs.values()).sort((a, b) => b.startedAt - a.startedAt),
			attempts: Array.from(this.attempts.values()).sort((a, b) => a.iteration - b.iteration),
		}
	}

	getJob(id: string): GoalSeekJob | undefined {
		return this.jobs.get(id)
	}

	getRun(id: string): GoalSeekRun | undefined {
		return this.runs.get(id)
	}

	getAttemptsForRun(runId: string): GoalSeekAttempt[] {
		return this.getState().attempts.filter((attempt) => attempt.runId === runId)
	}

	async upsertJob(job: GoalSeekJob): Promise<GoalSeekState> {
		return this.withLock(async () => {
			this.jobs.set(job.id, job)
			await this.writeJobs()
			return this.getState()
		})
	}

	async deleteJob(jobId: string): Promise<GoalSeekState> {
		return this.withLock(async () => {
			this.jobs.delete(jobId)
			const runIds = new Set<string>()
			for (const run of this.runs.values()) {
				if (run.jobId === jobId) {
					runIds.add(run.id)
					this.runs.delete(run.id)
				}
			}
			for (const attempt of this.attempts.values()) {
				if (runIds.has(attempt.runId)) {
					this.attempts.delete(attempt.id)
				}
			}
			await Promise.all([this.writeJobs(), this.writeRuns(), this.writeAttempts()])
			return this.getState()
		})
	}

	async upsertRun(run: GoalSeekRun): Promise<GoalSeekState> {
		return this.withLock(async () => {
			this.runs.set(run.id, run)
			await this.writeRuns()
			return this.getState()
		})
	}

	async upsertAttempt(attempt: GoalSeekAttempt): Promise<GoalSeekState> {
		return this.withLock(async () => {
			this.attempts.set(attempt.id, attempt)
			await this.writeAttempts()
			return this.getState()
		})
	}

	async updateJobAndRun(job: GoalSeekJob, run: GoalSeekRun): Promise<GoalSeekState> {
		return this.withLock(async () => {
			this.jobs.set(job.id, job)
			this.runs.set(run.id, run)
			await Promise.all([this.writeJobs(), this.writeRuns()])
			return this.getState()
		})
	}

	private async loadJobs(): Promise<void> {
		await this.loadArray(await this.getJobsPath(), this.jobs, this.isGoalSeekJob)
	}

	private async loadRuns(): Promise<void> {
		await this.loadArray(await this.getRunsPath(), this.runs, this.isGoalSeekRun)
	}

	private async loadAttempts(): Promise<void> {
		await this.loadArray(await this.getAttemptsPath(), this.attempts, this.isGoalSeekAttempt)
	}

	private async loadArray<T extends { id: string }>(
		filePath: string,
		target: Map<string, T>,
		guard: (value: unknown) => value is T,
	): Promise<void> {
		try {
			const raw = await fs.readFile(filePath, "utf8")
			const parsed = JSON.parse(raw)
			const items = Array.isArray(parsed) ? parsed : parsed.items
			for (const item of items ?? []) {
				if (guard(item)) {
					target.set(item.id, item)
				}
			}
		} catch {
			target.clear()
		}
	}

	private async writeJobs(): Promise<void> {
		await safeWriteJson(await this.getJobsPath(), this.getState().jobs)
	}

	private async writeRuns(): Promise<void> {
		await safeWriteJson(await this.getRunsPath(), this.getState().runs)
	}

	private async writeAttempts(): Promise<void> {
		await safeWriteJson(await this.getAttemptsPath(), this.getState().attempts)
	}

	private isGoalSeekJob(value: unknown): value is GoalSeekJob {
		const job = value as Partial<GoalSeekJob>
		return typeof job?.id === "string" && typeof job.name === "string" && typeof job.goal === "string"
	}

	private isGoalSeekRun(value: unknown): value is GoalSeekRun {
		const run = value as Partial<GoalSeekRun>
		return typeof run?.id === "string" && typeof run.jobId === "string" && typeof run.status === "string"
	}

	private isGoalSeekAttempt(value: unknown): value is GoalSeekAttempt {
		const attempt = value as Partial<GoalSeekAttempt>
		return (
			typeof attempt?.id === "string" && typeof attempt.runId === "string" && typeof attempt.status === "string"
		)
	}

	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	private async getDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "goal-seek")
	}

	private async getJobsPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.goalSeekJobs)
	}

	private async getRunsPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.goalSeekRuns)
	}

	private async getAttemptsPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.goalSeekAttempts)
	}
}
