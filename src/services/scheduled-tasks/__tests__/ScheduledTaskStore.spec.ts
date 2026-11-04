import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ScheduledTask, ScheduledTaskRun, TaskReasoningState } from "@alpha-code/types"

import { ScheduledTaskStore } from "../ScheduledTaskStore"

vi.mock("fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs/promises")>()
	return { ...original, rename: vi.fn(original.rename) }
})

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const { safeWriteJsonMock } = vi.hoisted(() => ({ safeWriteJsonMock: vi.fn() }))

vi.mock("../../../utils/safeWriteJson", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../utils/safeWriteJson")>()
	return { ...original, safeWriteJson: safeWriteJsonMock.mockImplementation(original.safeWriteJson) }
})

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
		vi.mocked(fs.rename).mockReset()
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("loads empty state", () => {
		expect(store.getState()).toEqual({ tasks: [], runs: [] })
	})

	it("rejects an untrusted owner ID before using it as a lease path", async () => {
		await expect(store.isOwnerLive("../../outside-storage")).resolves.toBe(false)
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

	it("preserves changes from another window when its local state is stale", async () => {
		const otherWindow = new ScheduledTaskStore(tmpDir)
		await otherWindow.initialize()

		await store.upsertTask(makeTask())
		await otherWindow.upsertTask(makeTask({ id: "task-2", name: "Second repo" }))
		expect(await store.refresh()).toBe(true)
		expect(store.getState().tasks).toHaveLength(2)

		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().tasks.map((task) => task.id)).toEqual(["task-1", "task-2"])
	})

	it("shows only open workspace schedules and preserves unassigned legacy schedules", async () => {
		const repoA = path.join(tmpDir, "repo-a")
		const repoB = path.join(tmpDir, "repo-b")
		await store.upsertTask(makeTask({ workspace: repoA }))
		await store.upsertTask(makeTask({ id: "task-2", name: "Other repo", workspace: repoB }))
		await store.upsertTask(makeTask({ id: "task-3", name: "Legacy" }))

		const scoped = new ScheduledTaskStore(tmpDir, () => [repoA])
		await scoped.initialize()
		expect(scoped.getState().tasks.map((task) => task.id)).toEqual(["task-3", "task-1"])
		expect(scoped.getTask("task-2")).toBeUndefined()
		await expect(scoped.upsertTask(makeTask({ id: "task-2", workspace: repoB }))).rejects.toThrow(
			"not found in this workspace",
		)
	})

	it("claims a due occurrence once across two window instances", async () => {
		const task = makeTask({ workspace: path.join(tmpDir, "repo-a") })
		await store.upsertTask(task)
		const otherWindow = new ScheduledTaskStore(tmpDir)
		await otherWindow.initialize()
		const claim = (instance: ScheduledTaskStore, runId: string) =>
			instance.claimRun(task.id, 1_000, "schedule", (current) => ({
				task: { ...current, enabled: false, nextRunAt: undefined, lastRunId: runId },
				run: makeRun({ id: runId, workspace: current.workspace }),
			}))

		const results = await Promise.all([claim(store, "run-a"), claim(otherWindow, "run-b")])
		expect(results.filter(Boolean)).toHaveLength(1)
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().runs).toHaveLength(1)
		expect(reloaded.getTask(task.id)?.enabled).toBe(false)
	})

	it("allows a user to reschedule a completed one-time task for the same time", async () => {
		const task = makeTask({ workspace: path.join(tmpDir, "repo-a") })
		await store.upsertTask(task)
		const claim = (runId: string) =>
			store.claimRun(task.id, 1_000, "schedule", (current) => ({
				task: { ...current, enabled: false, nextRunAt: undefined },
				run: makeRun({ id: runId, workspace: current.workspace }),
			}))
		const first = await claim("run-a")
		expect(first).toBeDefined()
		await store.completeRun({ ...first!.run, status: "succeeded", finishedAt: 2_000 })
		await store.updateTask(task.id, (current) => ({ ...current, enabled: true, nextRunAt: 1_000 }))

		expect(await claim("run-b")).toBeDefined()
		expect(store.getRunsForTask(task.id)).toHaveLength(2)
	})

	it("finishes a captured run after its schedule moves to another open root", async () => {
		const repoA = path.join(tmpDir, "repo-a")
		const repoB = path.join(tmpDir, "repo-b")
		await store.upsertTask(makeTask({ workspace: repoA }))
		const originalWindow = new ScheduledTaskStore(tmpDir, () => [repoA])
		const editingWindow = new ScheduledTaskStore(tmpDir, () => [repoA, repoB])
		await originalWindow.initialize()
		await editingWindow.initialize()
		const claimed = await originalWindow.claimRun("task-1", 1_000, "schedule", (current) => ({
			task: { ...current, nextRunAt: undefined },
			run: makeRun({ workspace: repoA, ownerId: "26ecc491-458a-480e-9f69-737fef9739d8" }),
		}))
		expect(claimed).toBeDefined()
		await editingWindow.updateTask("task-1", (current) => ({
			...current,
			workspace: repoB,
			prompt: "Edited in another window",
		}))

		expect(await originalWindow.projectRunStatus({ ...claimed!.run, status: "running" })).toBe(true)
		expect(
			await originalWindow.completeRun({ ...claimed!.run, status: "succeeded", finishedAt: 2_000 }),
		).toMatchObject({
			task: { workspace: repoB, prompt: "Edited in another window", lastRunStatus: "succeeded" },
		})
	})

	it("finalizes an owned running run after its workspace closes without restoring admission", async () => {
		const workspace = path.join(tmpDir, "repo-a")
		const roots = [workspace]
		const ownerId = "26ecc491-458a-480e-9f69-737fef9739d8"
		await store.upsertTask(makeTask({ workspace }))
		const scoped = new ScheduledTaskStore(tmpDir, () => roots)
		await scoped.initialize()
		const claimed = await scoped.claimRun("task-1", 1_000, "schedule", (current) => ({
			task: { ...current, nextRunAt: undefined },
			run: makeRun({ workspace, ownerId }),
		}))
		expect(claimed).toBeDefined()
		const running = { ...claimed!.run, status: "running" as const }
		expect(await scoped.projectRunStatus(running)).toBe(true)
		roots.length = 0

		expect(scoped.getState()).toEqual({ tasks: [], runs: [] })
		const build = vi.fn()
		expect(await scoped.claimRun("task-1", 2_000, "manual", build)).toBeUndefined()
		expect(build).not.toHaveBeenCalled()
		expect(await scoped.projectRunStatus(running)).toBe(false)
		const succeeded = { ...running, status: "succeeded" as const, finishedAt: 2_000 }
		expect(await scoped.completeRun(succeeded)).toMatchObject({
			task: { workspace, lastRunStatus: "succeeded" },
			run: succeeded,
		})
		expect(await scoped.completeRun(succeeded)).toBeUndefined()
		expect(scoped.getState()).toEqual({ tasks: [], runs: [] })

		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getRunsForTask("task-1")).toMatchObject([succeeded])
		expect(reloaded.getTask("task-1")?.lastRunStatus).toBe("succeeded")
	})

	it.each([
		{ label: "ownerless", storedOwnerId: undefined, callerOwnerId: undefined, status: "running" as const },
		{
			label: "missing caller owner",
			storedOwnerId: "26ecc491-458a-480e-9f69-737fef9739d8",
			callerOwnerId: undefined,
			status: "running" as const,
		},
		{
			label: "different owner",
			storedOwnerId: "26ecc491-458a-480e-9f69-737fef9739d8",
			callerOwnerId: "a2a213e0-b2da-4771-a6af-97861dc171a8",
			status: "running" as const,
		},
		{
			label: "not admitted",
			storedOwnerId: "26ecc491-458a-480e-9f69-737fef9739d8",
			callerOwnerId: "26ecc491-458a-480e-9f69-737fef9739d8",
			status: "queued" as const,
		},
	])("does not finalize a hidden $label run", async ({ storedOwnerId, callerOwnerId, status }) => {
		const workspace = path.join(tmpDir, "repo-a")
		await store.upsertTask(makeTask({ workspace }))
		const run = makeRun({ workspace, ownerId: storedOwnerId, status })
		await store.upsertRun(run)
		const scoped = new ScheduledTaskStore(tmpDir, () => [])
		await scoped.initialize()

		expect(
			await scoped.completeRun({ ...run, ownerId: callerOwnerId, status: "succeeded", finishedAt: 2_000 }),
		).toBeUndefined()
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		const persisted = reloaded.getRunsForTask("task-1")[0]
		expect(persisted).toMatchObject({ id: run.id, status, workspace })
		expect(persisted?.ownerId).toBe(storedOwnerId)
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

		await store.upsertTask(task)
		await store.upsertRun(run)
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

	it("rolls back a run claim when its task update fails", async () => {
		const originalTask = makeTask({
			workspace: path.join(tmpDir, "repo-a"),
			nextRunAt: 2_000,
			reasoningPreference: { kind: "effort", effort: "low" },
		})
		const originalRun = makeRun({ status: "succeeded", reasoningPreference: originalTask.reasoningPreference })
		await store.upsertTask(originalTask)
		await store.upsertRun(originalRun)

		const updatedTask = {
			...originalTask,
			reasoningPreference: { kind: "effort" as const, effort: "high" as const },
		}
		const updatedRun = makeRun({
			id: "run-2",
			scheduledFor: 2_000,
			reasoningPreference: updatedTask.reasoningPreference,
		})
		let enterRunWrite!: () => void
		let releaseRunWrite!: () => void
		const runWriteEntered = new Promise<void>((resolve) => {
			enterRunWrite = resolve
		})
		const runWriteGate = new Promise<void>((resolve) => {
			releaseRunWrite = resolve
		})
		safeWriteJsonMock.mockImplementationOnce(async (filePath: string, data: unknown) => {
			enterRunWrite()
			await runWriteGate
			await writeJson(filePath, data)
		})
		safeWriteJsonMock.mockRejectedValueOnce(new Error("task write failed"))

		const pending = store.claimRun(originalTask.id, 2_000, "schedule", () => ({
			task: { ...updatedTask, nextRunAt: undefined },
			run: updatedRun,
		}))
		await runWriteEntered
		let rejected = false
		void pending.catch(() => {
			rejected = true
		})
		await Promise.resolve()
		expect(rejected).toBe(false)
		expect(store.getTask(originalTask.id)?.reasoningPreference).toEqual(originalTask.reasoningPreference)

		releaseRunWrite()
		await expect(pending).rejects.toThrow("task write failed")
		expect(store.getTask(originalTask.id)?.reasoningPreference).toEqual(originalTask.reasoningPreference)
		expect(store.getRunsForTask(originalTask.id)).toHaveLength(1)
		expect(store.getRunsForTask(originalTask.id)[0]?.reasoningPreference).toEqual(originalRun.reasoningPreference)

		const persistedTasks = JSON.parse(
			await fs.readFile(path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json"), "utf8"),
		)
		const persistedRuns = JSON.parse(
			await fs.readFile(path.join(tmpDir, "scheduled-tasks", "scheduled_task_runs.json"), "utf8"),
		)
		expect(persistedTasks[0].reasoningPreference).toEqual(originalTask.reasoningPreference)
		expect(persistedRuns).toHaveLength(1)
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

	it.each(["scheduled_tasks.json", "scheduled_task_runs.json"])(
		"keeps %s authoritative until its atomic replacement commits",
		async (filename) => {
			await store.upsertTask(makeTask())
			await store.upsertRun(makeRun())
			const file = path.join(tmpDir, "scheduled-tasks", filename)
			const previous = await fs.readFile(file, "utf8")
			let entered!: () => void
			let release!: () => void
			const committing = new Promise<void>((resolve) => (entered = resolve))
			const gate = new Promise<void>((resolve) => (release = resolve))
			const rename = vi.mocked(fs.rename).getMockImplementation()!
			vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
				if (String(destination) === file && String(source).includes(".new_")) {
					entered()
					await gate
				}
				await rename(source, destination)
			})
			const update =
				filename === "scheduled_tasks.json"
					? store.upsertTask(makeTask({ name: "Updated schedule" }))
					: store.upsertRun(makeRun({ status: "running" }))
			try {
				await committing
				expect(await fs.readFile(file, "utf8")).toBe(previous)
			} finally {
				release()
				await update
			}
		},
	)

	it("recovers legacy backup files without deleting their recovery evidence", async () => {
		await store.upsertTask(makeTask())
		await store.upsertRun(makeRun())
		const directory = path.join(tmpDir, "scheduled-tasks")
		for (const name of ["scheduled_tasks.json", "scheduled_task_runs.json"]) {
			await fs.rename(path.join(directory, name), path.join(directory, `.${name}.bak_1000_recovery.tmp`))
		}
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState()).toEqual(store.getState())
		await reloaded.updateTask("task-1", (task) => ({ ...task, name: "Recovered schedule" }))
		for (const name of ["scheduled_tasks.json", "scheduled_task_runs.json"]) {
			expect(await fs.readFile(path.join(directory, `.${name}.bak_1000_recovery.tmp`), "utf8")).toBeTruthy()
		}
	})

	it("isolates invalid records and retains their original data through valid mutations", async () => {
		const directory = path.join(tmpDir, "scheduled-tasks")
		const invalidTask = { ...makeTask({ id: "invalid-task" }), schedule: { type: "unsupported" } }
		const invalidRun = { ...makeRun({ id: "invalid-run" }), status: "unknown-status", preserved: "recovery data" }
		await writeJson(path.join(directory, "scheduled_tasks.json"), [invalidTask, makeTask()])
		await writeJson(path.join(directory, "scheduled_task_runs.json"), [invalidRun, makeRun()])
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getState().tasks.map((task) => task.id)).toEqual(["task-1"])
		expect(reloaded.getState().runs.map((run) => run.id)).toEqual(["run-1"])
		await reloaded.updateTask("task-1", (task) => ({ ...task, name: "Valid edit" }))
		await reloaded.upsertRun(makeRun({ status: "running" }))
		expect(JSON.parse(await fs.readFile(path.join(directory, "scheduled_tasks.json"), "utf8"))).toContainEqual(
			invalidTask,
		)
		expect(JSON.parse(await fs.readFile(path.join(directory, "scheduled_task_runs.json"), "utf8"))).toContainEqual(
			invalidRun,
		)
	})

	it("normalizes legacy interval defaults and preserves unknown fields on valid records", async () => {
		const legacyTask = { ...makeTask(), schedule: { type: "daily", startAt: 1_000, timezone: "UTC" }, future: true }
		await writeJson(path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json"), [legacyTask])
		const reloaded = new ScheduledTaskStore(tmpDir)
		await reloaded.initialize()
		expect(reloaded.getTask("task-1")?.schedule).toMatchObject({ intervalDays: 1 })
		await reloaded.updateTask("task-1", (task) => ({ ...task, name: "Updated legacy task" }))
		expect(
			JSON.parse(await fs.readFile(path.join(tmpDir, "scheduled-tasks", "scheduled_tasks.json"), "utf8"))[0],
		).toMatchObject({ future: true })
	})
})
