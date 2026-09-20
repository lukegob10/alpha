import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ScheduledTask, ScheduledTaskRun, TaskReasoningState } from "@alpha-code/types"

import { ScheduledTaskStore } from "../ScheduledTaskStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const { safeWriteJsonMock } = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn(async (filePath: string, data: any) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
}))

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: safeWriteJsonMock }))

const makeTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
	id: "task-1",
	name: "Repo health",
	prompt: "Summarize repository health.",
	enabled: true,
	schedule: { type: "daily", startAt: 1_000, timezone: "UTC", intervalDays: 1 },
	permissions: {
		readFiles: true,
		runCommands: false,
		editFiles: false,
		stageChanges: false,
		commitChanges: false,
		pushBranches: false,
		openPullRequests: false,
		sendNotifications: false,
	},
	notificationPreference: "on_failure",
	createdAt: 1,
	updatedAt: 1,
	nextRunAt: 1_000,
	...overrides,
})

const makeRun = (overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun => ({
	id: "run-1",
	taskId: "task-1",
	status: "queued",
	trigger: "schedule",
	scheduledFor: 1_000,
	prompt: "Summarize repository health.",
	...overrides,
})

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
}

describe("ScheduledTaskStore", () => {
	let tmpDir: string
	let store: ScheduledTaskStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-task-store-"))
		store = new ScheduledTaskStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("loads empty state", () => {
		expect(store.getState()).toEqual({ tasks: [], runs: [] })
	})

	it("reloads legacy schedules and history without profile fields", async () => {
		await store.upsertTask(makeTask())
		await store.upsertRun(makeRun({ status: "succeeded" }))
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState()).toEqual(store.getState())
		expect(reloaded.getTask("task-1")?.apiConfig).toBeUndefined()
		expect(reloaded.getTask("task-1")?.reasoningPreference).toEqual({ kind: "default" })
	})

	it("loads genuinely legacy files without reasoning fields", async () => {
		const legacyTask = makeTask()
		const legacyRun = makeRun({ status: "succeeded" })
		await writeJson(path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json"), [legacyTask])
		await writeJson(path.join(tmpDir, "scheduled-tasks", "scheduled_task_runs.json"), [legacyRun])

		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()

		expect(reloaded.getTask(legacyTask.id)).toMatchObject(legacyTask)
		expect(reloaded.getTask(legacyTask.id)?.reasoningPreference).toEqual({ kind: "default" })
		expect(reloaded.getRunsForTask(legacyTask.id)[0]).toMatchObject(legacyRun)
		expect(reloaded.getRunsForTask(legacyTask.id)[0]?.reasoningPreference).toEqual({ kind: "default" })
		expect(reloaded.getRunsForTask(legacyTask.id)[0]?.reasoningState).toBeUndefined()
	})

	it("creates, updates, and deletes scheduled tasks with their runs", async () => {
		const task = makeTask()
		const run = makeRun()

		await store.upsertTask(task)
		await store.upsertRun(run)
		expect(store.getState().tasks).toHaveLength(1)
		expect(store.getState().runs).toHaveLength(1)

		await store.upsertTask({ ...task, enabled: false })
		expect(store.getTask(task.id)?.enabled).toBe(false)

		await store.deleteTask(task.id)
		expect(store.getState()).toEqual({ tasks: [], runs: [] })
	})

	it("persists independent reasoning preferences on schedules and queued runs", async () => {
		const reasoningPreference = { kind: "effort" as const, effort: "high" as const }
		const task = makeTask({ reasoningPreference })
		const reasoningState: TaskReasoningState = {
			requested: reasoningPreference,
			effective: reasoningPreference,
			capabilities: { kind: "effort" as const, efforts: ["low", "medium", "high"], canDisable: true },
		}
		const run = makeRun({ reasoningPreference, reasoningState })

		await store.updateTaskAndRun(task, run)
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()

		expect(reloaded.getTask(task.id)?.reasoningPreference).toEqual(reasoningPreference)
		expect(reloaded.getRunsForTask(task.id)[0]?.reasoningPreference).toEqual(reasoningPreference)
		expect(reloaded.getRunsForTask(task.id)[0]?.reasoningState).toEqual(reasoningState)
	})

	it("keeps the last accepted task when persistence rejects an update", async () => {
		const original = makeTask({ reasoningPreference: { kind: "effort", effort: "low" } })
		await store.upsertTask(original)
		safeWriteJsonMock.mockRejectedValueOnce(new Error("disk full"))

		await expect(
			store.upsertTask({ ...original, reasoningPreference: { kind: "effort", effort: "high" } }),
		).rejects.toThrow("disk full")
		expect(store.getTask(original.id)?.reasoningPreference).toEqual(original.reasoningPreference)
	})

	it("does not publish a task until its persistence succeeds", async () => {
		const task = makeTask({ reasoningPreference: { kind: "effort", effort: "high" } })
		let enterWrite!: () => void
		let releaseWrite!: () => void
		const writeEntered = new Promise<void>((resolve) => {
			enterWrite = resolve
		})
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		safeWriteJsonMock.mockImplementationOnce(async (filePath: string, data: unknown) => {
			enterWrite()
			await writeGate
			await writeJson(filePath, data)
		})

		const pending = store.upsertTask(task)
		await writeEntered
		expect(store.getTask(task.id)).toBeUndefined()
		expect(store.getState().tasks).toEqual([])

		releaseWrite()
		await pending
		expect(store.getTask(task.id)?.reasoningPreference).toEqual(task.reasoningPreference)
	})

	it("settles both writes before restoring a rejected task/run transaction", async () => {
		const originalTask = makeTask({ reasoningPreference: { kind: "effort", effort: "low" } })
		const originalRun = makeRun({ reasoningPreference: originalTask.reasoningPreference })
		await store.updateTaskAndRun(originalTask, originalRun)

		const updatedTask = {
			...originalTask,
			reasoningPreference: { kind: "effort" as const, effort: "high" as const },
		}
		const updatedRun = { ...originalRun, reasoningPreference: updatedTask.reasoningPreference }
		let enterTaskWrite!: () => void
		let releaseTaskWrite!: () => void
		const taskWriteEntered = new Promise<void>((resolve) => {
			enterTaskWrite = resolve
		})
		const taskWriteGate = new Promise<void>((resolve) => {
			releaseTaskWrite = resolve
		})
		safeWriteJsonMock.mockImplementationOnce(async (filePath: string, data: unknown) => {
			enterTaskWrite()
			await taskWriteGate
			await writeJson(filePath, data)
		})
		safeWriteJsonMock.mockRejectedValueOnce(new Error("run write failed"))

		const pending = store.updateTaskAndRun(updatedTask, updatedRun)
		await taskWriteEntered
		let rejected = false
		void pending.catch(() => {
			rejected = true
		})
		await Promise.resolve()
		expect(rejected).toBe(false)
		expect(store.getTask(originalTask.id)?.reasoningPreference).toEqual(originalTask.reasoningPreference)

		releaseTaskWrite()
		await expect(pending).rejects.toThrow("run write failed")
		expect(store.getTask(originalTask.id)?.reasoningPreference).toEqual(originalTask.reasoningPreference)
		expect(store.getRunsForTask(originalTask.id)[0]?.reasoningPreference).toEqual(originalRun.reasoningPreference)

		const persistedTasks = JSON.parse(
			await fs.readFile(path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json"), "utf8"),
		)
		const persistedRuns = JSON.parse(
			await fs.readFile(path.join(tmpDir, "scheduled-tasks", "scheduled_task_runs.json"), "utf8"),
		)
		expect(persistedTasks[0].reasoningPreference).toEqual(originalTask.reasoningPreference)
		expect(persistedRuns[0].reasoningPreference).toEqual(originalRun.reasoningPreference)
	})

	it("ignores corrupted persisted files on startup", async () => {
		const corruptedDir = path.join(tmpDir, "scheduled-tasks")
		await fs.mkdir(corruptedDir, { recursive: true })
		await fs.writeFile(path.join(corruptedDir, "scheduled_tasks.json"), "{bad json", "utf8")

		const freshStore = new ScheduledTaskStore(tmpDir)
		await freshStore.initialize()

		expect(freshStore.getState().tasks).toEqual([])
	})
})
