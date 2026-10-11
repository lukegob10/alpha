import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import * as storage from "../../../utils/storage"
import { GoalController, type GoalIdleBoundary } from "../../agent/goals/GoalController"
import { TASK_GOAL_FILE_NAME, TaskGoalStore, type TaskGoalEnvelope } from "../TaskGoalStore"

const idle: GoalIdleBoundary = { isIdle: true, hasPendingInput: false, isPaused: false, isCancelled: false }
let directory: string

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-goal-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	const resolved = path.resolve(directory)
	expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(resolved)).toMatch(/^alpha-task-goal-/)
	await fs.rm(resolved, { recursive: true, force: true })
})

function goalController(taskId = "task-1") {
	return new GoalController({ taskId, store: new TaskGoalStore(directory, taskId) })
}

describe("durable goal state", () => {
	it("reads old tasks without creating goal state or directories", async () => {
		const store = new TaskGoalStore(directory, "old-task")
		expect(await store.read()).toEqual({ schemaVersion: 1, taskId: "old-task", usageReceipts: [] })
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("reloads goal identity, accounting receipts, limits and status without automatically restarting", async () => {
		const first = goalController()
		const created = await first.create({ objective: "Ship", tokenBudget: 100, maxContinuations: 2 }, "user")
		await first.recordUsage("durable-step", 25, 30, created.goalId)
		const recovered = goalController()
		expect(await recovered.get()).toMatchObject({
			goalId: created.goalId,
			status: "active",
			tokensUsed: 25,
			timeUsedMs: 30,
			maxContinuations: 2,
			recoveryDeferred: true,
		})
		expect(await recovered.reserveContinuation(idle)).toBeUndefined()
		await recovered.recordUsage("durable-step", 25, 30, created.goalId)
		expect((await recovered.get())?.tokensUsed).toBe(25)
		await recovered.pause()
		expect((await goalController().get())?.status).toBe("paused")
	})

	it("serializes distinct instances so duplicate and concurrent descendant receipts are not lost", async () => {
		const first = goalController()
		const created = await first.create({ objective: "Ship" }, "user")
		const second = goalController()
		await Promise.all([
			first.recordUsage("parent-step", 10, 10, created.goalId),
			second.recordUsage("parent-step", 10, 10, created.goalId),
			second.recordUsage("child-step", 5, 0, created.goalId),
			first.recordUsage("grandchild-step", 3, 0, created.goalId),
		])
		expect(await goalController().get()).toMatchObject({ tokensUsed: 18, timeUsedMs: 10 })
		expect((await new TaskGoalStore(directory, "task-1").read()).usageReceipts).toHaveLength(3)
	})

	it("admits only one cross-instance reservation for the same durable version", async () => {
		const first = goalController()
		await first.create({ objective: "Ship" }, "user")
		const a = await first.reserveContinuation(idle)
		const second = goalController()
		await second.resume()
		const b = await second.reserveContinuation(idle)
		const results = await Promise.all([first.consumeContinuation(a!, idle), second.consumeContinuation(b!, idle)])
		expect(results.filter(Boolean)).toHaveLength(1)
		expect((await first.get())?.continuationCount).toBe(1)
	})

	it("keeps independent task files and same-named receipts isolated", async () => {
		const a = goalController("a")
		const b = goalController("b")
		const [one, two] = await Promise.all([
			a.create({ objective: "A" }, "user"),
			b.create({ objective: "B" }, "user"),
		])
		await Promise.all([a.recordUsage("step", 1, 2, one.goalId), b.recordUsage("step", 3, 4, two.goalId)])
		await a.clear()
		expect(await goalController("a").get()).toBeUndefined()
		expect(await goalController("b").get()).toMatchObject({ goalId: two.goalId, tokensUsed: 3, timeUsedMs: 4 })
	})

	it("rejects corrupt and cross-task state without replacing its bytes", async () => {
		await goalController().create({ objective: "Ship" }, "user")
		const file = path.join(directory, "tasks", "task-1", TASK_GOAL_FILE_NAME)
		const state = JSON.parse(await fs.readFile(file, "utf8"))
		state.taskId = "different-task"
		const corrupt = JSON.stringify(state)
		await fs.writeFile(file, corrupt, "utf8")
		await expect(new TaskGoalStore(directory, "task-1").read()).rejects.toThrow()
		await expect(goalController().clear()).rejects.toThrow()
		expect(await fs.readFile(file, "utf8")).toBe(corrupt)
	})

	it("rejects a configured storage path change during lock acquisition without changing either store", async () => {
		await goalController().create({ objective: "Ship" }, "user")
		const originalDirectory = path.join(directory, "tasks", "task-1")
		const originalFile = path.join(originalDirectory, TASK_GOAL_FILE_NAME)
		const original = await fs.readFile(originalFile, "utf8")
		const changedDirectory = path.join(directory, "changed-storage", "tasks", "task-1")
		await fs.mkdir(changedDirectory, { recursive: true })
		const changedFile = path.join(changedDirectory, TASK_GOAL_FILE_NAME)
		const changed = "preserve the other configured storage snapshot"
		await fs.writeFile(changedFile, changed, "utf8")
		vi.spyOn(storage, "resolveExistingTaskDirectoryPathReadOnly")
			.mockResolvedValueOnce(originalDirectory)
			.mockResolvedValueOnce(changedDirectory)
		const mutate = vi.fn((state: TaskGoalEnvelope) => {
			delete state.goal
		})
		await expect(new TaskGoalStore(directory, "task-1").transact(mutate)).rejects.toThrow("path changed")
		expect(mutate).not.toHaveBeenCalled()
		expect(await fs.readFile(originalFile, "utf8")).toBe(original)
		expect(await fs.readFile(changedFile, "utf8")).toBe(changed)
	})

	it.each(["../outside", "..\\outside", "C:\\outside", "", ".", ".."])(
		"rejects task path traversal (%s)",
		async (taskId) => {
			await expect(new TaskGoalStore(directory, taskId).read()).rejects.toThrow("Invalid task ID")
			expect(await fs.readdir(directory)).toEqual([])
		},
	)

	it("rejects symlinked task storage before creating an external goal file", async () => {
		const outside = path.join(directory, "outside")
		await fs.mkdir(outside)
		await fs.mkdir(path.join(directory, "tasks"))
		await fs.symlink(
			outside,
			path.join(directory, "tasks", "task-1"),
			process.platform === "win32" ? "junction" : "dir",
		)
		await expect(goalController().create({ objective: "Ship" }, "user")).rejects.toThrow("regular directory")
		expect(await fs.readdir(outside)).toEqual([])
	})

	it("rejects a symlinked tasks root when the task directory is missing", async () => {
		const outside = path.join(directory, "outside")
		await fs.mkdir(outside)
		await fs.symlink(outside, path.join(directory, "tasks"), process.platform === "win32" ? "junction" : "dir")
		await expect(goalController().create({ objective: "Ship" }, "user")).rejects.toThrow("Invalid goal storage")
		expect(await fs.readdir(outside)).toEqual([])
	})
})
