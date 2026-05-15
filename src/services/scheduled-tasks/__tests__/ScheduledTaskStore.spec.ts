import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ScheduledTask, ScheduledTaskRun } from "@alpha-code/types"

import { ScheduledTaskStore } from "../ScheduledTaskStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: any) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
}))

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

	it("ignores corrupted persisted files on startup", async () => {
		const corruptedDir = path.join(tmpDir, "scheduled-tasks")
		await fs.mkdir(corruptedDir, { recursive: true })
		await fs.writeFile(path.join(corruptedDir, "scheduled_tasks.json"), "{bad json", "utf8")

		const freshStore = new ScheduledTaskStore(tmpDir)
		await freshStore.initialize()

		expect(freshStore.getState().tasks).toEqual([])
	})
})
