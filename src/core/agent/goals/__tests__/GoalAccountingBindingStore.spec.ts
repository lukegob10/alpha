import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { GoalAccountingBindingStore, GOAL_ACCOUNTING_OWNER_FILE } from "../GoalAccountingBindingStore"

let directory: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-goal-owner-"))
})
afterEach(async () => {
	const resolved = path.resolve(directory)
	expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(resolved)).toMatch(/^alpha-goal-owner-/)
	await fs.rm(resolved, { recursive: true, force: true })
})

const owner = { goalTaskId: "root", goalId: "goal-a", controlVersion: 1 }

describe("immutable child goal ownership", () => {
	it("reads old children without creating storage", async () => {
		expect(await new GoalAccountingBindingStore(directory, "child").read()).toBeUndefined()
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("persists the original owner and permits exact admission retries", async () => {
		const store = new GoalAccountingBindingStore(directory, "child")
		await Promise.all([store.save(owner), store.save(owner)])
		expect(await new GoalAccountingBindingStore(directory, "child").read()).toEqual({
			schemaVersion: 1,
			taskId: "child",
			owner: { ...owner, drainOnly: false },
		})
		await expect(store.save({ ...owner, goalId: "goal-b" })).rejects.toThrow("cannot be replaced")
		await expect(store.save({ ...owner, controlVersion: 2 })).rejects.toThrow("cannot be replaced")
	})

	it("preserves a no-goal sentinel so a later root objective cannot be adopted", async () => {
		const store = new GoalAccountingBindingStore(directory, "child")
		await store.save(undefined)
		expect((await store.read())?.owner).toBeNull()
		await expect(store.save(owner)).rejects.toThrow("cannot be replaced")
	})

	it("persists legacy receipt ownership as drain only across repeated reloads", async () => {
		await new GoalAccountingBindingStore(directory, "child").save({ ...owner, drainOnly: true })
		for (let reload = 0; reload < 2; reload++) {
			expect((await new GoalAccountingBindingStore(directory, "child").read())?.owner).toMatchObject({
				...owner,
				drainOnly: true,
			})
		}
	})

	it("rejects foreign task identities and malformed ownership", async () => {
		const store = new GoalAccountingBindingStore(directory, "child")
		await store.save(owner)
		const file = path.join(directory, "tasks", "child", GOAL_ACCOUNTING_OWNER_FILE)
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, taskId: "other", owner }), "utf8")
		await expect(store.read()).rejects.toThrow("another child")
		await fs.writeFile(
			file,
			JSON.stringify({ schemaVersion: 1, taskId: "child", owner: { ...owner, controlVersion: -1 } }),
			"utf8",
		)
		await expect(store.read()).rejects.toThrow()
	})

	it.each(["../escape", "..\\escape", "C:\\escape", "child/other"])("rejects unsafe task ID %s", async (taskId) => {
		await expect(new GoalAccountingBindingStore(directory, taskId).save(owner)).rejects.toThrow()
	})
})
