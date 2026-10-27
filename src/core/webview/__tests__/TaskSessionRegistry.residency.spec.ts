import { describe, expect, it } from "vitest"

import {
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const task = (taskId: string, taskKind: Task["taskKind"] = "subagent"): Task =>
	({ taskId, taskKind, taskStatus: TaskStatus.Idle, alphaMessages: [], isStreaming: false }) as unknown as Task

const snapshot = (taskId: string): AgentLifecycleSnapshot =>
	agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId,
		runId: `run-${taskId}`,
		turnId: `turn-${taskId}`,
		status: "completed",
		phase: "finalizing",
		lastSequence: 0,
		terminalEventId: `terminal-${taskId}`,
		items: [{ itemId: `item-${taskId}`, type: "assistant_text", text: `durable transcript ${taskId}` }],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
	})

const registerTerminal = (registry: TaskSessionRegistry, child: Task) => {
	registry.register(child, { focus: false, lifecycleSnapshot: snapshot(child.taskId) })
	registry.markLifecycle(child.taskId, TaskLifecycleState.Completed)
}

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

let hostId = 0
const hostViews = () => {
	const storage = `managed-residency-regression-${++hostId}`
	return {
		owner: TaskSessionRegistry.forGlobalStorage(storage),
		borrower: TaskSessionRegistry.forGlobalStorage(storage),
	}
}

describe("terminal managed task residency", () => {
	it("enumerates only terminal managed tasks owned by this view", () => {
		const { owner, borrower } = hostViews()
		const first = task("first")
		const second = task("second")
		const primary = task("primary", "primary")
		const active = task("active")
		const foreign = task("foreign")
		registerTerminal(owner, first)
		registerTerminal(owner, second)
		registerTerminal(owner, primary)
		owner.register(active, { focus: false })
		owner.markLifecycle(active.taskId, TaskLifecycleState.Running)
		registerTerminal(borrower, foreign)

		expect(owner.getTerminalSubagentTasks()).toEqual([first, second])
		expect(borrower.getTerminalSubagentTasks()).toEqual([foreign])
	})

	it("retains owner and cached transcript until cleanup settles, then releases both", async () => {
		const registry = new TaskSessionRegistry()
		const child = task("completed")
		registerTerminal(registry, child)
		registry.markLifecycleDegraded(child.taskId)
		registry.markLifecycle(child.taskId, TaskLifecycleState.Completed)
		const cleanupStarted = deferred()
		const cleanupFinished = deferred()
		const unloading = registry.unloadAfterCleanup(child, async () => {
			cleanupStarted.resolve()
			await cleanupFinished.promise
		})
		await cleanupStarted.promise

		expect(registry.getTask(child.taskId)).toBe(child)
		expect(registry.getLifecycleSnapshots()[child.taskId]?.items).toHaveLength(1)
		expect(registry.isLifecycleDegraded(child.taskId)).toBe(true)

		cleanupFinished.resolve()
		await expect(unloading).resolves.toBe(true)
		expect(registry.getTask(child.taskId)).toBeUndefined()
		expect(registry.getOwner(child.taskId)).toBeUndefined()
		expect(registry.getLifecycleSnapshots()[child.taskId]).toBeUndefined()
		expect(registry.isLifecycleDegraded(child.taskId)).toBe(false)
	})

	it("retains the exact owner and full lifecycle cache after cleanup failure for retry", async () => {
		const registry = new TaskSessionRegistry()
		const child = task("failed-cleanup")
		registerTerminal(registry, child)
		const cached = registry.getLifecycleSnapshots()[child.taskId]

		await expect(
			registry.unloadAfterCleanup(child, async () => {
				throw new Error("owned cleanup failed")
			}),
		).rejects.toThrow("owned cleanup failed")

		expect(registry.getTask(child.taskId)).toBe(child)
		expect(registry.ownsTask(child.taskId)).toBe(true)
		expect(registry.getLifecycleSnapshots()[child.taskId]).toEqual(cached)
		await expect(registry.unloadAfterCleanup(child, async () => undefined)).resolves.toBe(true)
	})

	it("refuses selected tasks across views, live tasks, foreign owners, and stale Task objects", async () => {
		const { owner, borrower } = hostViews()
		const selected = task("selected")
		const active = task("running")
		const stale = task("stale")
		const replacement = task("stale")
		registerTerminal(owner, selected)
		borrower.focus(selected.taskId)
		owner.register(active, { focus: false })
		owner.markLifecycle(active.taskId, TaskLifecycleState.Running)
		registerTerminal(owner, stale)
		owner.replaceTask(stale, replacement, { focus: false })
		owner.markLifecycle(replacement.taskId, TaskLifecycleState.Completed)
		let cleaned = 0
		const cleanup = async () => {
			cleaned++
		}

		await expect(owner.unloadAfterCleanup(selected, cleanup)).resolves.toBe(false)
		await expect(owner.unloadAfterCleanup(active, cleanup)).resolves.toBe(false)
		await expect(borrower.unloadAfterCleanup(selected, cleanup)).resolves.toBe(false)
		await expect(owner.unloadAfterCleanup(stale, cleanup)).resolves.toBe(false)
		expect(cleaned).toBe(0)
		expect(owner.getTask(selected.taskId)).toBe(selected)
		expect(owner.getTask(stale.taskId)).toBe(replacement)
	})

	it("rechecks the exact generation guard after an asynchronous cleanup boundary", async () => {
		const registry = new TaskSessionRegistry()
		const child = task("guarded")
		registerTerminal(registry, child)
		let generation = "old"
		const started = deferred()
		const finish = deferred()
		const unloading = registry.unloadAfterCleanup(
			child,
			async () => {
				started.resolve()
				await finish.promise
			},
			() => generation === "old",
		)
		await started.promise
		generation = "new"
		finish.resolve()

		await expect(unloading).resolves.toBe(false)
		expect(registry.getTask(child.taskId)).toBe(child)
		expect(registry.getLifecycleSnapshots()[child.taskId]).toBeDefined()
	})

	it("serializes competing unloads so one exact Task cleanup is performed once", async () => {
		const registry = new TaskSessionRegistry()
		const child = task("one-owner")
		registerTerminal(registry, child)
		const started = deferred()
		const finish = deferred()
		let cleanups = 0
		const cleanup = async () => {
			cleanups++
			started.resolve()
			await finish.promise
		}
		const first = registry.unloadAfterCleanup(child, cleanup)
		await started.promise
		const second = registry.unloadAfterCleanup(child, cleanup)
		finish.resolve()

		await expect(first).resolves.toBe(true)
		await expect(second).resolves.toBe(false)
		expect(cleanups).toBe(1)
	})

	it.each(["focused", "live"] as const)("retains a task that becomes %s during awaited cleanup", async (change) => {
		const { owner, borrower } = hostViews()
		const child = task(`late-${change}`)
		registerTerminal(owner, child)
		const started = deferred()
		const finish = deferred()
		const unloading = owner.unloadAfterCleanup(child, async () => {
			started.resolve()
			await finish.promise
		})
		await started.promise
		if (change === "focused") borrower.focus(child.taskId)
		else owner.markLifecycle(child.taskId, TaskLifecycleState.Running)
		finish.resolve()

		await expect(unloading).resolves.toBe(false)
		expect(owner.getTask(child.taskId)).toBe(child)
		expect(owner.getLifecycleSnapshots()[child.taskId]).toBeDefined()
	})

	it("keeps ordinary unregister cache compatibility and restores an unloaded task from durable history", async () => {
		const registry = new TaskSessionRegistry()
		const ordinary = task("ordinary")
		registerTerminal(registry, ordinary)
		const ordinarySnapshot = registry.getLifecycleSnapshots()[ordinary.taskId]
		registry.unregister(ordinary.taskId, ordinary)
		expect(registry.getLifecycleSnapshots()[ordinary.taskId]).toEqual(ordinarySnapshot)

		const child = task("restorable")
		registerTerminal(registry, child)
		const durable = structuredClone(registry.getLifecycleSnapshots()[child.taskId])
		await registry.unloadAfterCleanup(child, async () => undefined)
		expect(registry.getLifecycleSnapshots()[child.taskId]).toBeUndefined()
		const restored = task(child.taskId)
		registry.register(restored, { focus: false, lifecycleSnapshot: durable })

		expect(registry.getTask(child.taskId)).toBe(restored)
		expect(registry.getLifecycleSnapshots()[child.taskId]).toEqual(durable)
		expect(durable.items[0]).toMatchObject({ text: "durable transcript restorable" })
	})
})
