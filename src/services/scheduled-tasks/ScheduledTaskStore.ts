import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import {
	taskReasoningPreferenceSchema,
	taskReasoningStateSchema,
	type ScheduledTask,
	type ScheduledTaskRun,
	type ScheduledTaskState,
} from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { withFileLock } from "../../core/task-persistence/atomicWrite"
import { arePathsEqual } from "../../utils/path"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"

const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ScheduledTaskStore {
	private tasks = new Map<string, ScheduledTask>()
	private runs = new Map<string, ScheduledTaskRun>()
	private writeLock: Promise<void> = Promise.resolve()
	private storageDir: Promise<string> | undefined

	constructor(
		private readonly globalStoragePath: string,
		private readonly openWorkspacePaths?: () => string[],
	) {}

	async initialize(): Promise<void> {
		const dir = await this.getDir()
		await fs.mkdir(dir, { recursive: true })
		await withFileLock(path.join(dir, "scheduled_tasks.transaction"), async () => {
			await this.loadTasks()
			await this.loadRuns()
		})
	}

	getState(): ScheduledTaskState {
		const tasks = Array.from(this.tasks.values()).filter((task) => this.isVisible(task))
		const visibleIds = new Set(tasks.map((task) => task.id))
		return {
			tasks: tasks.sort((a, b) => a.name.localeCompare(b.name)),
			runs: Array.from(this.runs.values())
				.filter((run) => visibleIds.has(run.taskId))
				.sort((a, b) => b.scheduledFor - a.scheduledFor),
		}
	}

	getTask(id: string): ScheduledTask | undefined {
		const task = this.tasks.get(id)
		return task && this.isVisible(task) ? task : undefined
	}

	async refresh(): Promise<boolean> {
		const before = JSON.stringify(this.getState())
		await this.withLock(async () => undefined)
		return before !== JSON.stringify(this.getState())
	}

	async acquireOwnerLease(ownerId: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
		if (!OWNER_ID_PATTERN.test(ownerId)) throw new Error("Invalid scheduled task owner ID")
		const leasePath = path.join(await this.getDir(), "owners", ownerId)
		await fs.mkdir(path.dirname(leasePath), { recursive: true })
		return lockfile.lock(leasePath, {
			stale: 31_000,
			update: 10_000,
			realpath: false,
			retries: 0,
			onCompromised,
		})
	}

	async isOwnerLive(ownerId: string): Promise<boolean> {
		if (!OWNER_ID_PATTERN.test(ownerId)) return false
		return lockfile.check(path.join(await this.getDir(), "owners", ownerId), {
			stale: 31_000,
			realpath: false,
		})
	}

	async watchChanges(onChange: () => void, onError: (error: Error) => void): Promise<() => void> {
		const watcher = fsSync.watch(await this.getDir(), { persistent: false }, (_event, filename) => {
			const name = filename?.toString()
			if (!name || name === GlobalFileNames.scheduledTasks || name === GlobalFileNames.scheduledTaskRuns) {
				onChange()
			}
		})
		watcher.on("error", (error) => {
			onError(error)
			watcher.close()
		})
		return () => watcher.close()
	}

	getRunsForTask(taskId: string): ScheduledTaskRun[] {
		return this.getState().runs.filter((run) => run.taskId === taskId)
	}

	async upsertTask(task: ScheduledTask): Promise<ScheduledTaskState> {
		return this.withLock(async () => {
			const normalizedTask = this.normalizeTask(task)
			this.assertWritableTask(normalizedTask)
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
			if (!this.getTask(taskId)) throw new Error(`Scheduled task not found in this workspace: ${taskId}`)
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
			const current = this.runs.get(run.id)
			if (!this.getTask(run.taskId) && !(current && this.getTaskForRun(current))) {
				throw new Error(`Scheduled task not found in this workspace: ${run.taskId}`)
			}
			if (current?.ownerId && current.ownerId !== run.ownerId)
				throw new Error("Scheduled run is owned by another window")
			if (current && ["succeeded", "failed", "skipped", "canceled"].includes(current.status)) {
				throw new Error("Scheduled run is already complete")
			}
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

	async updateTask(taskId: string, update: (current: ScheduledTask) => ScheduledTask): Promise<ScheduledTask> {
		return this.withLock(async () => {
			const current = this.getTask(taskId)
			if (!current) throw new Error(`Scheduled task not found in this workspace: ${taskId}`)
			const next = this.normalizeTask(update(current))
			if (next.id !== taskId) throw new Error("Scheduled task ID cannot change")
			this.assertWritableTask(next)
			const candidate = new Map(this.tasks)
			candidate.set(taskId, next)
			try {
				await this.writeTasks(candidate)
			} catch (error) {
				await this.writeTasks(this.tasks).catch(() => undefined)
				throw error
			}
			this.tasks = candidate
			return next
		})
	}

	async claimRun(
		taskId: string,
		scheduledFor: number,
		trigger: ScheduledTaskRun["trigger"],
		build: (task: ScheduledTask, hasActiveRun: boolean) => { task: ScheduledTask; run: ScheduledTaskRun },
	): Promise<{ task: ScheduledTask; run: ScheduledTaskRun } | undefined> {
		return this.withLock(async () => {
			const current = this.getTask(taskId)
			if (!current?.workspace) return undefined
			if (trigger !== "manual") {
				if (!current.enabled || current.nextRunAt !== scheduledFor) return undefined
			}
			const active = Array.from(this.runs.values()).some(
				(run) =>
					run.taskId === taskId &&
					(run.status === "pending" ||
						run.status === "queued" ||
						run.status === "running" ||
						run.status === "waiting_for_approval"),
			)
			const claimed = build(current, active)
			if (claimed.task.id !== taskId || claimed.run.taskId !== taskId) {
				throw new Error("Scheduled run claim must update its owning task")
			}
			this.assertWritableTask(claimed.task)
			await this.commitTaskAndRun(this.normalizeTask(claimed.task), this.normalizeRun(claimed.run), true)
			return claimed
		})
	}

	async completeRun(run: ScheduledTaskRun): Promise<{ task: ScheduledTask; run: ScheduledTaskRun } | undefined> {
		if (!["succeeded", "failed", "skipped", "canceled"].includes(run.status)) {
			throw new Error("Scheduled run completion requires a terminal status")
		}
		return this.withLock(async () => {
			const currentRun = this.runs.get(run.id)
			const task = currentRun && this.getTaskForRun(currentRun)
			if (
				!currentRun ||
				!task ||
				!["pending", "queued", "running", "waiting_for_approval"].includes(currentRun.status)
			) {
				return undefined
			}
			if (currentRun.ownerId && currentRun.ownerId !== run.ownerId) return undefined
			const finishedRun = this.normalizeRun({
				...currentRun,
				status: run.status,
				finishedAt: run.finishedAt,
				summary: run.summary,
				error: run.error,
				output: run.output,
				exitCode: run.exitCode,
			})
			const updatedTask = {
				...task,
				lastRunId: run.id,
				lastRunStatus: run.status,
				lastRunSummary: run.summary ?? run.error,
				updatedAt: Date.now(),
			}
			await this.commitTaskAndRun(updatedTask, finishedRun)
			return { task: updatedTask, run: finishedRun }
		})
	}

	async projectRunStatus(run: ScheduledTaskRun): Promise<boolean> {
		return this.withLock(async () => {
			const currentRun = this.runs.get(run.id)
			const task = currentRun && this.getTaskForRun(currentRun)
			if (
				!currentRun ||
				!task ||
				!["pending", "queued", "running", "waiting_for_approval"].includes(currentRun.status)
			) {
				return false
			}
			if (currentRun.ownerId && currentRun.ownerId !== run.ownerId) return false
			const nextRun = this.normalizeRun({ ...currentRun, ...run })
			const nextTask = {
				...task,
				lastRunId: run.id,
				lastRunStatus: run.status,
				updatedAt: Date.now(),
			}
			await this.commitTaskAndRun(nextTask, nextRun)
			return true
		})
	}

	private async loadTasks(strict = false): Promise<void> {
		try {
			const raw = await fs.readFile(await this.getTasksPath(), "utf8")
			const parsed = JSON.parse(raw)
			const tasks = Array.isArray(parsed) ? parsed : parsed.tasks
			const loaded = new Map<string, ScheduledTask>()
			for (const item of tasks ?? []) {
				if (this.isScheduledTask(item)) {
					loaded.set(item.id, this.normalizeTask(item))
				}
			}
			this.tasks = loaded
		} catch (error) {
			if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			this.tasks.clear()
		}
	}

	private async loadRuns(strict = false): Promise<void> {
		try {
			const raw = await fs.readFile(await this.getRunsPath(), "utf8")
			const parsed = JSON.parse(raw)
			const runs = Array.isArray(parsed) ? parsed : parsed.runs
			const loaded = new Map<string, ScheduledTaskRun>()
			for (const item of runs ?? []) {
				if (this.isScheduledTaskRun(item)) {
					loaded.set(item.id, this.normalizeRun(item))
				}
			}
			this.runs = loaded
		} catch (error) {
			if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			this.runs.clear()
		}
	}

	private async writeTasks(tasks: ReadonlyMap<string, ScheduledTask> = this.tasks): Promise<void> {
		await safeWriteJson(
			await this.getTasksPath(),
			Array.from(tasks.values()).sort((a, b) => a.name.localeCompare(b.name)),
		)
	}

	private async commitTaskAndRun(task: ScheduledTask, run: ScheduledTaskRun, runFirst = false): Promise<void> {
		const candidateTasks = new Map(this.tasks)
		const candidateRuns = new Map(this.runs)
		candidateTasks.set(task.id, task)
		candidateRuns.set(run.id, run)
		try {
			if (runFirst) {
				// Persist the claim before advancing the schedule; a crash cannot leave a consumed occurrence with no run.
				await this.writeRuns(candidateRuns)
				await this.writeTasks(candidateTasks)
			} else {
				const results = await Promise.allSettled([
					this.writeTasks(candidateTasks),
					this.writeRuns(candidateRuns),
				])
				const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
				if (failure) throw failure.reason
			}
		} catch (error) {
			await Promise.allSettled([this.writeTasks(this.tasks), this.writeRuns(this.runs)])
			throw error
		}
		this.tasks = candidateTasks
		this.runs = candidateRuns
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
		const transact = async () =>
			withFileLock(path.join(await this.getDir(), "scheduled_tasks.transaction"), async () => {
				await this.loadTasks(true)
				await this.loadRuns(true)
				return fn()
			})
		const result = this.writeLock.then(transact, transact)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	private isVisible(task: ScheduledTask): boolean {
		if (!this.openWorkspacePaths) return true
		// Old schedules without a workspace remain visible so they can be assigned on save.
		return !task.workspace || this.openWorkspacePaths().some((root) => arePathsEqual(root, task.workspace))
	}

	private getTaskForRun(run: ScheduledTaskRun): ScheduledTask | undefined {
		const task = this.tasks.get(run.taskId)
		if (!task) return undefined
		if (this.isVisible(task)) return task
		// A run keeps its captured workspace if the schedule moves while queued or running.
		return run.workspace && this.openWorkspacePaths?.().some((root) => arePathsEqual(root, run.workspace))
			? task
			: undefined
	}

	private assertWritableTask(task: ScheduledTask): void {
		if (!this.openWorkspacePaths) return
		const existing = this.tasks.get(task.id)
		if (existing && !this.isVisible(existing)) {
			throw new Error(`Scheduled task not found in this workspace: ${task.id}`)
		}
		if (!task.workspace || !this.openWorkspacePaths().some((root) => arePathsEqual(root, task.workspace))) {
			throw new Error("Scheduled task workspace must be an open workspace root")
		}
	}

	private async getDir(): Promise<string> {
		this.storageDir ??= Promise.resolve(getStorageBasePath(this.globalStoragePath)).then((basePath) =>
			path.join(basePath, "scheduled-tasks"),
		)
		return this.storageDir
	}

	private async getTasksPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.scheduledTasks)
	}

	private async getRunsPath(): Promise<string> {
		return path.join(await this.getDir(), GlobalFileNames.scheduledTaskRuns)
	}
}
