import * as fs from "fs/promises"
import * as path from "path"

import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskState } from "@roo-code/types"

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
			this.tasks.set(task.id, task)
			await this.writeTasks()
			return this.getState()
		})
	}

	async deleteTask(taskId: string): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			this.tasks.delete(taskId)
			for (const run of this.runs.values()) {
				if (run.taskId === taskId) {
					this.runs.delete(run.id)
				}
			}
			await Promise.all([this.writeTasks(), this.writeRuns()])
			return this.getState()
		})
	}

	async upsertRun(run: ScheduledTaskRun): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			this.runs.set(run.id, run)
			await this.writeRuns()
			return this.getState()
		})
	}

	async updateTaskAndRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			this.tasks.set(task.id, task)
			this.runs.set(run.id, run)
			await Promise.all([this.writeTasks(), this.writeRuns()])
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
					this.tasks.set(item.id, item)
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
					this.runs.set(item.id, item)
				}
			}
		} catch {
			this.runs.clear()
		}
	}

	private async writeTasks(): Promise<void> {
		await safeWriteJson(await this.getTasksPath(), this.getState().tasks)
	}

	private async writeRuns(): Promise<void> {
		await safeWriteJson(await this.getRunsPath(), this.getState().runs)
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
