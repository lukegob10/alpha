import type { TaskGoal, TaskGoalStatus } from "@alpha-code/types"

import type { GoalStateStore, TaskGoalEnvelope } from "../../../task-persistence/TaskGoalStore"
import { GoalController, type GoalIdleBoundary, type GoalToolStatus } from "../GoalController"

const idle: GoalIdleBoundary = {
	isIdle: true,
	hasPendingInput: false,
	isPaused: false,
	isCancelled: false,
	mode: "code",
}

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

class MemoryStore implements GoalStateStore {
	state: TaskGoalEnvelope
	beforeNextTransaction: (() => Promise<void>) | undefined

	constructor(taskId = "task-1") {
		this.state = { schemaVersion: 1, taskId, usageReceipts: [] }
	}

	async read(): Promise<TaskGoalEnvelope> {
		return structuredClone(this.state)
	}

	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const before = this.beforeNextTransaction
		this.beforeNextTransaction = undefined
		await before?.()
		const working = structuredClone(this.state)
		const result = operation(working)
		this.state = working
		return structuredClone(result)
	}
}

function controller(store = new MemoryStore(), options: { maxUsageReceipts?: number } = {}) {
	let id = 0
	return new GoalController({
		taskId: store.state.taskId,
		store,
		now: () => 10,
		newId: () => `${store.state.taskId}-${++id}`,
		...options,
	})
}

async function admit(goal: GoalController): Promise<TaskGoal | undefined> {
	const reservation = await goal.reserveContinuation(idle)
	return reservation ? goal.consumeContinuation(reservation, idle) : undefined
}

describe("native goal state and idle admission", () => {
	it("ordinary work does not silently create an objective", async () => {
		const store = new MemoryStore()
		const goal = controller(store)
		expect(await goal.get()).toBeUndefined()
		expect(await goal.reserveContinuation(idle)).toBeUndefined()
		expect(await goal.systemStop("paused")).toBeUndefined()
		expect(store.state).toEqual({ schemaVersion: 1, taskId: "task-1", usageReceipts: [] })
	})

	it("creates a goal only after explicit authority and validates its input", async () => {
		const goal = controller()
		await expect(goal.create({ objective: "Ship" }, "model" as "user")).rejects.toThrow("explicit user")
		expect(await goal.get()).toBeUndefined()
		const created = await goal.create({ objective: " Ship ", tokenBudget: 100 }, "tool-approved")
		expect(created).toMatchObject({
			objective: "Ship",
			status: "active",
			tokenBudget: 100,
			maxContinuations: 20,
			continuationCount: 0,
			recoveryDeferred: false,
		})
	})

	it.each<TaskGoalStatus>(["active", "paused", "blocked", "budget_limited", "usage_limited"])(
		"does not replace an unfinished %s goal",
		async (status) => {
			const store = new MemoryStore()
			const goal = controller(store)
			const created = await goal.create({ objective: "Ship" }, "user")
			store.state.goal!.status = status
			await expect(goal.create({ objective: "Different work" }, "user")).rejects.toThrow("unfinished")
			expect((await goal.get())?.goalId).toBe(created.goalId)
		},
	)

	it("replaces only a completed goal and rejects late usage from its old owner", async () => {
		const goal = controller()
		const old = await goal.create({ objective: "First" }, "user")
		await goal.recordUsage("old-step", 10, 5, old.goalId)
		await goal.updateStatus("complete")
		const next = await goal.create({ objective: "Second" }, "user")
		expect(next.goalId).not.toBe(old.goalId)
		await goal.recordUsage("late-old-child", 100, 100, old.goalId)
		expect(await goal.get()).toMatchObject({ goalId: next.goalId, tokensUsed: 0, timeUsedMs: 0 })
	})

	it("rejects tool attempts to resume or set system limit statuses", async () => {
		const goal = controller()
		await goal.create({ objective: "Ship" }, "user")
		for (const status of ["active", "usage_limited", "budget_limited"]) {
			await expect(goal.updateStatus(status as GoalToolStatus)).rejects.toThrow("cannot resume")
		}
		expect((await goal.get())?.status).toBe("active")
	})

	it("keeps proven completion terminal and requires an explicit new objective", async () => {
		const goal = controller()
		await goal.create({ objective: "Ship" }, "user")
		await goal.updateStatus("complete")
		await expect(goal.updateStatus("paused")).rejects.toThrow("completed")
		await expect(goal.updateStatus("blocked")).rejects.toThrow("completed")
		await expect(goal.resume()).rejects.toThrow("new goal")
		expect((await goal.get())?.status).toBe("complete")
	})

	it("binds goal creation consent to the reviewed absent or completed goal", async () => {
		const goal = controller()
		const completed = await goal.create({ objective: "First" }, "user", { goalId: null })
		await goal.updateStatus("complete")
		await expect(goal.create({ objective: "Second" }, "tool-approved", { goalId: null })).rejects.toThrow(
			"Goal changed",
		)
		await expect(
			goal.create({ objective: "Second" }, "tool-approved", {
				goalId: completed.goalId,
				version: completed.version,
			}),
		).rejects.toThrow("Goal changed")
		const approved = await goal.get()
		const second = await goal.create({ objective: "Second" }, "tool-approved", {
			goalId: approved!.goalId,
			version: approved!.version,
		})
		expect(second.goalId).not.toBe(completed.goalId)
	})

	it.each(["create", "update", "resume", "clear", "pause"])(
		"checks %s authority after queued storage work",
		async (action) => {
			const store = new MemoryStore()
			const goal = controller(store)
			if (action === "update") await goal.create({ objective: "Ship" }, "user")
			if (action === "resume" || action === "clear" || action === "pause") {
				await goal.create({ objective: "Ship" }, "user")
			}
			if (action === "resume") await goal.pause()
			const entered = barrier()
			const release = barrier()
			let authorized = true
			store.beforeNextTransaction = async () => {
				entered.resolve()
				await release.promise
			}
			const pending = (() => {
				switch (action) {
					case "create":
						return goal.create({ objective: "Ship" }, "tool-approved", { goalId: null }, () => authorized)
					case "resume":
						return goal.resume({}, undefined, () => authorized)
					case "clear":
						return goal.clear(undefined, () => authorized)
					case "pause":
						return goal.pause(undefined, undefined, () => authorized)
					default:
						return goal.updateStatus("complete", undefined, () => authorized)
				}
			})()
			await entered.promise
			authorized = false
			release.resolve()
			await expect(pending).rejects.toThrow("authorization changed")
			expect((await goal.get())?.status).toBe(
				action === "create" ? undefined : action === "resume" ? "paused" : "active",
			)
		},
	)

	it("accounts duplicate provider checkpoints once, including after recovery", async () => {
		const store = new MemoryStore()
		const goal = controller(store)
		const created = await goal.create({ objective: "Ship" }, "user")
		await Promise.all([
			goal.recordUsage("step-1", 12, 30, created.goalId),
			goal.recordUsage("step-1", 12, 30, created.goalId),
			goal.recordUsage("child-step", 8, 0, created.goalId),
		])
		const recovered = controller(store)
		const before = await recovered.get()
		await recovered.recordUsage("step-1", 12, 30, created.goalId)
		expect(await recovered.get()).toEqual(before)
		expect(before).toMatchObject({ tokensUsed: 20, timeUsedMs: 30, recoveryDeferred: true })
		expect(store.state.usageReceipts).toHaveLength(2)
	})

	it("rejects a conflicting usage receipt without losing previously accounted work", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship" }, "user")
		await goal.recordUsage("step", 1, 2, created.goalId)
		const before = await goal.get()
		await expect(goal.recordUsage("step", 2, 2, created.goalId)).rejects.toThrow("conflicts")
		expect(await goal.get()).toEqual(before)
		await goal.recordUsage("next", 2, 3, created.goalId)
		expect(await goal.get()).toMatchObject({ tokensUsed: 3, timeUsedMs: 5 })
	})

	it("stops at the budget and accounts in-flight drain without letting a pause hide exhaustion", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 10 }, "user")
		await goal.recordUsage("step", 10, 2, created.goalId)
		await goal.pause("cancelled")
		await goal.updateStatus("blocked")
		expect((await goal.get())?.status).toBe("budget_limited")
		await goal.recordUsage("late-child", 3, 0, created.goalId)
		expect(await goal.get()).toMatchObject({ status: "budget_limited", tokensUsed: 13 })
		expect(await admit(goal)).toBeUndefined()
	})

	it("accounts paused and completed in-flight work while preserving proven completion", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 10 }, "user")
		await goal.pause()
		await goal.recordUsage("late-paused", 6, 4, created.goalId)
		expect(await goal.get()).toMatchObject({ status: "paused", tokensUsed: 6, timeUsedMs: 4 })
		await goal.updateStatus("complete")
		const before = await goal.get()
		await goal.updateStatus("complete")
		expect(await goal.get()).toEqual(before)
		await goal.recordUsage("late-completed", 6, 4, created.goalId)
		expect(await goal.get()).toMatchObject({ status: "complete", tokensUsed: 12, timeUsedMs: 8 })
		await goal.systemStop("paused")
		expect((await goal.get())?.status).toBe("complete")
	})

	it("ignores Plan usage and refuses Plan admission", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship" }, "user")
		await goal.recordUsage("plan-step", 20, 3, created.goalId, "architect")
		expect(await goal.get()).toMatchObject({ tokensUsed: 0, timeUsedMs: 0 })
		expect(await goal.reserveContinuation({ ...idle, mode: "architect" })).toBeUndefined()
	})

	it("keeps admitted child requests valid across harmless accounting and ordinary steering", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 10 }, "user")
		const generation = goal.getRequestGeneration()
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(true)
		goal.invalidateContinuation()
		await goal.recordUsage("child-step", 2, 0, created.goalId)
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(true)
		goal.invalidateRequests()
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(false)
	})

	it("revokes child sampling synchronously while pause storage is pending and never restarts old bindings", async () => {
		const store = new MemoryStore()
		const goal = controller(store)
		const created = await goal.create({ objective: "Ship" }, "user")
		const oldGeneration = goal.getRequestGeneration()
		const entered = barrier()
		const release = barrier()
		store.beforeNextTransaction = async () => {
			entered.resolve()
			await release.promise
		}
		const pendingPause = goal.pause()
		expect(goal.isRequestCurrent(created.goalId, oldGeneration)).toBe(false)
		await entered.promise
		expect(goal.isRequestCurrent(created.goalId, goal.getRequestGeneration())).toBe(false)
		release.resolve()
		await pendingPause
		await goal.recordUsage("in-flight-child", 4, 0, created.goalId)
		await goal.resume()
		expect(goal.isRequestCurrent(created.goalId, oldGeneration)).toBe(false)
		expect(goal.isRequestCurrent(created.goalId, goal.getRequestGeneration())).toBe(true)
		expect((await goal.get())?.tokensUsed).toBe(4)
	})

	it.each(
		(["create", "update", "pause", "resume", "clear"] as const).flatMap((action) =>
			(["stale", "authorization"] as const).map((reason) => ({ action, reason })),
		),
	)("preserves child bindings and idle reservations after a rejected $reason $action", async ({ action, reason }) => {
		const store = new MemoryStore()
		const goal = controller(store)
		const created = await goal.create({ objective: "Ship" }, "user")
		const resumed = await goal.resume()
		const generation = goal.getRequestGeneration()
		const reservation = await goal.reserveContinuation(idle)
		const entered = barrier()
		const release = barrier()
		store.beforeNextTransaction = async () => {
			entered.resolve()
			await release.promise
		}
		const expected = {
			goalId: created.goalId,
			controlVersion: reason === "stale" ? created.controlVersion : resumed.controlVersion,
		}
		const guard = reason === "authorization" ? () => false : undefined
		const pending =
			action === "create"
				? goal.create({ objective: "Replacement" }, "tool-approved", expected, guard)
				: action === "update"
					? goal.updateStatus("paused", expected, guard)
					: action === "pause"
						? goal.pause(undefined, expected, guard)
						: action === "resume"
							? goal.resume({}, expected, guard)
							: goal.clear(expected, guard)
		const settled = pending.then(
			() => undefined,
			(error: unknown) => error,
		)
		await entered.promise
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(false)
		release.resolve()
		const failure = await settled
		if (action === "pause" && reason === "stale") expect(failure).toBeUndefined()
		else expect(failure).toBeInstanceOf(Error)
		expect(await goal.get()).toEqual(resumed)
		expect(goal.getRequestGeneration()).toBe(generation)
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(true)
		expect(await goal.consumeContinuation(reservation!, idle)).toMatchObject({
			goalId: created.goalId,
			controlVersion: resumed.controlVersion,
			continuationCount: 1,
		})
	})

	it.each(["reserve", "consume"])(
		"preserves a %s waiting on storage when a queued stale control rejects",
		async (stage) => {
			const store = new MemoryStore()
			const goal = controller(store)
			const created = await goal.create({ objective: "Ship" }, "user")
			const resumed = await goal.resume()
			const reservation = stage === "consume" ? await goal.reserveContinuation(idle) : undefined
			const entered = barrier()
			const release = barrier()
			store.beforeNextTransaction = async () => {
				entered.resolve()
				await release.promise
			}
			const pendingReservation = stage === "reserve" ? goal.reserveContinuation(idle) : undefined
			const pendingConsumption = stage === "consume" ? goal.consumeContinuation(reservation!, idle) : undefined
			await entered.promise
			const rejected = goal
				.updateStatus("paused", { goalId: created.goalId, controlVersion: created.controlVersion })
				.then(
					() => undefined,
					(error: unknown) => error,
				)
			release.resolve()
			const admitted = await (pendingReservation ?? pendingConsumption)
			expect(await rejected).toBeInstanceOf(Error)
			expect(admitted).toBeDefined()
			if (pendingReservation) {
				expect(await goal.consumeContinuation((await pendingReservation)!, idle)).toMatchObject({
					continuationCount: 1,
				})
			}
			expect(await goal.get()).toMatchObject({
				goalId: created.goalId,
				controlVersion: resumed.controlVersion,
				status: "active",
				continuationCount: 1,
			})
		},
	)

	it("revokes an old reservation only when a host resume commits and allows a fresh reservation", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship" }, "user")
		const old = await goal.reserveContinuation(idle)
		const resumed = await goal.resume()
		const current = await goal.reserveContinuation(idle)
		expect(current).toMatchObject({ goalId: created.goalId, controlVersion: resumed.controlVersion })
		expect(await goal.consumeContinuation(old!, idle)).toBeUndefined()
		expect(await goal.consumeContinuation(current!, idle)).toMatchObject({ continuationCount: 1 })
	})

	it.each(["budget", "usage", "continuations"])("revokes outstanding requests at the %s limit", async (limit) => {
		const goal = controller(new MemoryStore(), limit === "usage" ? { maxUsageReceipts: 1 } : {})
		const created = await goal.create({ objective: "Ship", tokenBudget: 5, maxContinuations: 1 }, "user")
		const generation = goal.getRequestGeneration()
		if (limit === "continuations") {
			await admit(goal)
			await goal.reserveContinuation(idle)
		} else {
			await goal.recordUsage("last-admitted-step", limit === "budget" ? 5 : 1, 0, created.goalId)
		}
		expect(goal.isRequestCurrent(created.goalId, generation)).toBe(false)
		expect(goal.isRequestCurrent(created.goalId, goal.getRequestGeneration())).toBe(false)
		await goal.recordUsage("in-flight-drain", 1, 0, created.goalId)
		expect((await goal.get())?.tokensUsed).toBe(limit === "budget" ? 6 : limit === "usage" ? 2 : 1)
	})

	it("restores an active goal without starting hidden work until the host resumes", async () => {
		const store = new MemoryStore()
		const first = controller(store)
		const created = await first.create({ objective: "Ship", tokenBudget: 100 }, "user")
		await first.recordUsage("step", 12, 10, created.goalId)
		const reloaded = controller(store)
		expect(await reloaded.get()).toMatchObject({ status: "active", recoveryDeferred: true, tokensUsed: 12 })
		expect(await admit(reloaded)).toBeUndefined()
		await reloaded.resume()
		expect(await admit(reloaded)).toMatchObject({ goalId: created.goalId, continuationCount: 1, tokensUsed: 12 })
	})

	it("requires a sufficient explicit budget update to resume an exhausted goal", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 5 }, "user")
		await goal.recordUsage("step", 5, 0, created.goalId)
		expect((await goal.resume()).status).toBe("budget_limited")
		expect(await admit(goal)).toBeUndefined()
		expect((await goal.resume({ tokenBudget: 20 })).status).toBe("active")
		expect(await admit(goal)).toMatchObject({ tokensUsed: 5, tokenBudget: 20 })
		await goal.pause()
		expect((await goal.resume({ tokenBudget: null })).tokenBudget).toBeUndefined()
	})

	it("rejects stale approved status changes and ignores old owner shutdown after host resume", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship" }, "user")
		await goal.recordUsage("step", 1, 0, created.goalId)
		await expect(goal.updateStatus("paused", { goalId: created.goalId, version: created.version })).rejects.toThrow(
			"Goal changed",
		)
		const previous = await goal.get()
		await goal.resume()
		await goal.systemStop("paused", { goalId: previous!.goalId, version: previous!.version })
		expect((await goal.get())?.status).toBe("active")
	})

	it("keeps pause consent valid during in-flight usage but revokes it on an explicit host resume", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 10 }, "user")
		await goal.recordUsage("child-drain", 10, 0, created.goalId)
		const paused = await goal.updateStatus("paused", {
			goalId: created.goalId,
			controlVersion: created.controlVersion,
		})
		expect(paused.status).toBe("budget_limited")
		await goal.resume({ tokenBudget: 20 })
		await expect(
			goal.updateStatus("paused", { goalId: created.goalId, controlVersion: created.controlVersion }),
		).rejects.toThrow("Goal changed")
		await goal.systemStop("paused", { goalId: created.goalId, controlVersion: created.controlVersion })
		expect((await goal.get())?.status).toBe("active")
	})

	it.each([
		{ isIdle: false },
		{ hasPendingInput: true },
		{ isPaused: true },
		{ isCancelled: true },
		{ isStillAdmissible: () => false },
	])("rejects a non-idle or human-owned boundary %j", async (boundary) => {
		const goal = controller()
		await goal.create({ objective: "Ship" }, "user")
		expect(await goal.reserveContinuation({ ...idle, ...boundary })).toBeUndefined()
		expect((await goal.get())?.continuationCount).toBe(0)
	})

	it("rejects cancellation between reservation and consumption", async () => {
		const goal = controller()
		await goal.create({ objective: "Ship" }, "user")
		const reservation = await goal.reserveContinuation(idle)
		const cancelled = new AbortController()
		cancelled.abort()
		expect(await goal.consumeContinuation(reservation!, { ...idle, signal: cancelled.signal })).toBeUndefined()
		await goal.pause()
		expect(await goal.get()).toMatchObject({ status: "paused", continuationCount: 0 })
	})

	it.each(["reserve", "consume"])("human steering invalidates a %s waiting on storage", async (stage) => {
		const store = new MemoryStore()
		const goal = controller(store)
		await goal.create({ objective: "Ship" }, "user")
		const reservation = stage === "consume" ? await goal.reserveContinuation(idle) : undefined
		const entered = barrier()
		const release = barrier()
		store.beforeNextTransaction = async () => {
			entered.resolve()
			await release.promise
		}
		const pending =
			stage === "reserve" ? goal.reserveContinuation(idle) : goal.consumeContinuation(reservation!, idle)
		await entered.promise
		goal.invalidateContinuation()
		release.resolve()
		expect(await pending).toBeUndefined()
		expect((await goal.get())?.continuationCount).toBe(0)
	})

	it("consumes a reservation once, admits harmless accounting and rejects budget exhaustion", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship", tokenBudget: 10 }, "user")
		const first = await goal.reserveContinuation(idle)
		expect(await goal.reserveContinuation(idle)).toBeUndefined()
		expect(await goal.consumeContinuation(first!, idle)).toMatchObject({ continuationCount: 1 })
		expect(await goal.consumeContinuation(first!, idle)).toBeUndefined()
		const second = await goal.reserveContinuation(idle)
		await goal.recordUsage("new-step", 2, 0, created.goalId)
		expect(await goal.consumeContinuation(second!, idle)).toMatchObject({ continuationCount: 2 })
		const third = await goal.reserveContinuation(idle)
		await goal.recordUsage("budget-step", 8, 0, created.goalId)
		expect(await goal.consumeContinuation(third!, idle)).toBeUndefined()
		expect((await goal.get())?.continuationCount).toBe(2)
	})

	it("bounds autonomous continuations and resets their allowance only on host resume", async () => {
		const goal = controller()
		await goal.create({ objective: "Ship", maxContinuations: 2 }, "user")
		expect(await admit(goal)).toMatchObject({ continuationCount: 1 })
		expect(await admit(goal)).toMatchObject({ continuationCount: 2 })
		expect(await admit(goal)).toBeUndefined()
		expect(await goal.get()).toMatchObject({ status: "usage_limited", continuationCount: 2 })
		expect(await admit(goal)).toBeUndefined()
		await goal.resume({ maxContinuations: 1 })
		expect(await admit(goal)).toMatchObject({ continuationCount: 1, maxContinuations: 1 })
	})

	it("stops new admission before the receipt ledger fills and preserves in-flight drain", async () => {
		const store = new MemoryStore()
		const goal = controller(store, { maxUsageReceipts: 2 })
		const created = await goal.create({ objective: "Ship" }, "user")
		await goal.recordUsage("one", 1, 0, created.goalId)
		await goal.recordUsage("two", 2, 0, created.goalId)
		expect(await goal.get()).toMatchObject({ status: "usage_limited", tokensUsed: 3 })
		await goal.recordUsage("one", 1, 0, created.goalId)
		expect((await goal.get())?.tokensUsed).toBe(3)
		await goal.recordUsage("three", 3, 0, created.goalId)
		expect(await goal.get()).toMatchObject({ status: "usage_limited", tokensUsed: 6 })
		expect(await admit(goal)).toBeUndefined()
		await expect(goal.resume()).rejects.toThrow("capacity")
		expect(store.state.usageReceipts).toHaveLength(3)
	})

	it("keeps separate tasks and event names isolated", async () => {
		const first = controller(new MemoryStore("task-a"))
		const second = controller(new MemoryStore("task-b"))
		const [a, b] = await Promise.all([
			first.create({ objective: "A" }, "user"),
			second.create({ objective: "B" }, "user"),
		])
		await first.recordUsage("step", 12, 1, a.goalId)
		await second.recordUsage("step", 5, 2, b.goalId)
		await first.pause()
		expect(await first.get()).toMatchObject({ taskId: "task-a", status: "paused", tokensUsed: 12 })
		expect(await second.get()).toMatchObject({ taskId: "task-b", status: "active", tokensUsed: 5 })
	})

	it("clear is idempotent and fences previously reserved work", async () => {
		const goal = controller()
		const created = await goal.create({ objective: "Ship" }, "user")
		const reservation = await goal.reserveContinuation(idle)
		await expect(goal.clear({ goalId: "wrong" })).rejects.toThrow("Goal changed")
		await goal.clear({ goalId: created.goalId })
		await goal.clear()
		expect(await goal.consumeContinuation(reservation!, idle)).toBeUndefined()
		expect(await goal.get()).toBeUndefined()
	})
})
