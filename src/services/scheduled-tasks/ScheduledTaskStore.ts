import * as fs from "fs/promises"
import * as path from "path"

import {
	taskReasoningPreferenceSchema,
	taskReasoningStateSchema,
	type ScheduledTask,
	type ScheduledTaskRun,
	type ScheduledTaskState,
} from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"

export class ScheduledTaskStore {
	private tasks = new Map<string, ScheduledTask>()
	private runs = new Map<string, ScheduledTaskRun>()
	private writeLock: Promise<void> = Promise.resolve()

	constructor(private readonly globalStoragePath: string) {}

	async initialize(): Promise<void> {
		const dir = await this.getDir()
		await fs.mkdir(dir, { recursive: true })
		await this.loadTasks()
		await this.loadRuns()
	}

	getState(): ScheduledTaskState {
		return {
			tasks: Array.from(this.tasks.values()).sort((a, b) => a.name.localeCompare(b.name)),
			runs: Array.from(this.runs.values()).sort((a, b) => b.scheduledFor - a.scheduledFor),
		}
	}

	getTask(id: string): ScheduledTask | undefined {
		return this.tasks.get(id)
	}

	getRunsForTask(taskId: string): ScheduledTaskRun[] {
		return this.getState().runs.filter((run) => run.taskId === taskId)
	}

	async upsertTask(task: ScheduledTask): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			const normalizedTask = this.normalizeTask(task)
			const candidate = new Map(this.tasks)
			candidate.set(normalizedTask.id, normalizedTask)
			try {
				await this.writeTasks(candidate)
			} catch (error) {
				await this.writeTasks(this.tasks).catch(() => undefined)
				throw error
			}
			this.tasks = candidate
			return this.getState()
		})
	}

	async deleteTask(taskId: string): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			const candidateTasks = new Map(this.tasks)
			const candidateRuns = new Map(this.runs)
			candidateTasks.delete(taskId)
			for (const run of candidateRuns.values()) {
				if (run.taskId === taskId) {
					candidateRuns.delete(run.id)
				}
			}
			const results = await Promise.allSettled([this.writeTasks(candidateTasks), this.writeRuns(candidateRuns)])
			const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
			if (failure) {
				await Promise.allSettled([this.writeTasks(this.tasks), this.writeRuns(this.runs)])
				throw failure.reason
			}
			this.tasks = candidateTasks
			this.runs = candidateRuns
			return this.getState()
		})
	}

	async upsertRun(run: ScheduledTaskRun): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			const normalizedRun = this.normalizeRun(run)
			const candidate = new Map(this.runs)
			candidate.set(normalizedRun.id, normalizedRun)
			try {
				await this.writeRuns(candidate)
			} catch (error) {
				await this.writeRuns(this.runs).catch(() => undefined)
				throw error
			}
			this.runs = candidate
			return this.getState()
		})
	}

	async updateTaskAndRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			const normalizedTask = this.normalizeTask(task)
			const normalizedRun = this.normalizeRun(run)
			const candidateTasks = new Map(this.tasks)
			const candidateRuns = new Map(this.runs)
			candidateTasks.set(normalizedTask.id, normalizedTask)
			candidateRuns.set(normalizedRun.id, normalizedRun)
			const results = await Promise.allSettled([this.writeTasks(candidateTasks), this.writeRuns(candidateRuns)])
			const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
			if (failure) {
				await Promise.allSettled([this.writeTasks(this.tasks), this.writeRuns(this.runs)])
				throw failure.reason
			}
			this.tasks = candidateTasks
			this.runs = candidateRuns
			return this.getState()
		})
	}

	private async loadTasks(): Promise<void> {
		try {
			const raw = await fs.readFile(await this.getTasksPath(), "utf8")
			const parsed = JSON.parse(raw)
			const tasks = Array.isArray(parsed) ? parsed : parsed.tasks
			for (const item of tasks ?? []) {
				if (this.isScheduledTask(item)) {
					this.tasks.set(item.id, this.normalizeTask(item))
				}
			}
		} catch {
			this.tasks.clear()
		}
	}

	private async loadRuns(): Promise<void> {
		try {
			const raw = await fs.readFile(await this.getRunsPath(), "utf8")
			const parsed = JSON.parse(raw)
			const runs = Array.isArray(parsed) ? parsed : parsed.runs
			for (const item of runs ?? []) {
				if (this.isScheduledTaskRun(item)) {
					this.runs.set(item.id, this.normalizeRun(item))
				}
			}
		} catch {
			this.runs.clear()
		}
	}

	private async writeTasks(tasks: ReadonlyMap<string, ScheduledTask> = this.tasks): Promise<void> {
		await safeWriteJson(
			await this.getTasksPath(),
			Array.from(tasks.values()).sort((a, b) => a.name.localeCompare(b.name)),
		)
	}

	private async writeRuns(runs: ReadonlyMap<string, ScheduledTaskRun> = this.runs): Promise<void> {
		await safeWriteJson(
			await this.getRunsPath(),
			Array.from(runs.values()).sort((a, b) => b.scheduledFor - a.scheduledFor),
		)
	}

	private isScheduledTask(value: unknown): value is ScheduledTask {
		const task = value as Partial<ScheduledTask>
		return (
			typeof task?.id === "string" &&
			typeof task.name === "string" &&
			typeof task.prompt === "string" &&
			typeof task.enabled === "boolean" &&
			typeof task.schedule?.type === "string"
		)
	}

	private normalizeTask(task: ScheduledTask): ScheduledTask {
		const parsed = taskReasoningPreferenceSchema.safeParse(task.reasoningPreference ?? { kind: "default" })
		if (parsed.success) {
			return { ...task, reasoningPreference: parsed.data }
		}
		return { ...task, reasoningPreference: { kind: "default" } }
	}

	private isScheduledTaskRun(value: unknown): value is ScheduledTaskRun {
		const run = value as Partial<ScheduledTaskRun>
		return (
			typeof run?.id === "string" &&
			typeof run.taskId === "string" &&
			typeof run.status === "string" &&
			typeof run.trigger === "string" &&
			typeof run.scheduledFor === "number" &&
			typeof run.prompt === "string"
		)
	}

	private normalizeRun(run: ScheduledTaskRun): ScheduledTaskRun {
		const preferenceResult = taskReasoningPreferenceSchema.safeParse(run.reasoningPreference ?? { kind: "default" })
		const stateResult =
			run.reasoningState === undefined ? undefined : taskReasoningStateSchema.safeParse(run.reasoningState)
		const reasoningPreference = preferenceResult.success ? preferenceResult.data : { kind: "default" as const }
		const reasoningState = stateResult?.success ? stateResult.data : undefined
		return {
			...run,
			reasoningPreference,
			...(reasoningState ? { reasoningState } : { reasoningState: undefined }),
		}
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
		return path.join(basePath, "scheduled-tasks")
	}

	private async getTasksPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.scheduledTasks)
	}

	private async getRunsPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.scheduledTaskRuns)
	}
}
