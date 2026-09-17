import { BoundedDelegationManager, InternalTaskCancellationError } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../InternalTaskEnvelope"
const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: false,
}
const envelope = (id: string, dependencies: string[] = []) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "p",
		objective: id,
		parentPolicy: policy,
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
		dependencies,
	})
const result = (taskId: string) => ({
	taskId,
	status: "completed" as const,
	summary: taskId,
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1 },
})
describe("bounded delegation", () => {
	it("notifies an observer only after capacity is acquired", async () => {
		const order: string[] = []
		const manager = new BoundedDelegationManager(async (item) => {
			order.push(`runner:${item.id}`)
			return result(item.id)
		})

		const run = manager.run(envelope("a"), undefined, () => order.push("started:a"))
		expect(order).toEqual([])
		await run
		expect(order).toEqual(["started:a", "runner:a"])
	})

	it("limits concurrency and preserves requested result order", async () => {
		let active = 0,
			peak = 0
		const manager = new BoundedDelegationManager(async (item) => {
			active++
			peak = Math.max(peak, active)
			await new Promise((r) => setTimeout(r, 5))
			active--
			return result(item.id)
		})
		const output = await manager.runBatch([envelope("a"), envelope("b"), envelope("c", ["a"])])
		expect(peak).toBe(2)
		expect(output.map((item) => item.taskId)).toEqual(["a", "b", "c"])
	})
	it("marks child mutation for parent verification", async () => {
		const manager = new BoundedDelegationManager(async (item) => ({
			...result(item.id),
			changedFiles: ["src/a.ts"],
		}))
		expect((await manager.run(envelope("a"))).requiresParentVerification).toBe(true)
	})
	it("allows explicitly bounded children to retain narrowed delegation authority", async () => {
		const manager = new BoundedDelegationManager(async (item) => result(item.id))
		const nestedReady = buildInternalTaskEnvelope({
			id: "a",
			rootTaskId: "p",
			parentTaskId: "p",
			depth: 1,
			objective: "a",
			agentKind: "review",
			parentPolicy: { ...policy, delegate: true },
			requestedPolicy: { delegate: true },
			workspaceRoots: ["F:/workspace"],
			budget: { maxDepth: 2 },
		})
		await expect(manager.run(nestedReady)).resolves.toMatchObject({
			taskId: "a",
			status: "completed",
			stopReason: "completed",
		})
	})

	it("returns a timed-out structured result instead of corrupting the parent", async () => {
		let cancellationKind: string | undefined
		const manager = new BoundedDelegationManager(
			async (_item, signal) =>
				await new Promise((_, reject) =>
					signal.addEventListener(
						"abort",
						() => {
							cancellationKind =
								signal.reason instanceof InternalTaskCancellationError ? signal.reason.kind : undefined
							reject(signal.reason)
						},
						{ once: true },
					),
				),
		)
		const timed = { ...envelope("a"), budget: { ...envelope("a").budget, timeoutMs: 1 } }
		await expect(manager.run(timed)).resolves.toMatchObject({ taskId: "a", status: "timed_out" })
		expect(cancellationKind).toBe("timed_out")
	})

	it("cancels a queued child with a structured result without invoking its runner", async () => {
		const invoked: string[] = []
		let releaseFirst!: () => void
		const manager = new BoundedDelegationManager(async (item) => {
			invoked.push(item.id)
			if (item.id === "a") await new Promise<void>((resolve) => (releaseFirst = resolve))
			return result(item.id)
		}, 1)

		const first = manager.run(envelope("a"))
		await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"))
		const queued = manager.run(envelope("b"))

		expect(manager.cancel("b", "cancel queued child")).toBe(true)
		await expect(queued).resolves.toMatchObject({
			taskId: "b",
			status: "cancelled",
			summary: "cancel queued child",
		})
		expect(invoked).toEqual(["a"])

		releaseFirst()
		await expect(first).resolves.toMatchObject({ taskId: "a", status: "completed" })
	})

	it("does not invoke a capacity-ready child cancelled before its runner starts", async () => {
		const runner = vi.fn(async (item) => result(item.id))
		const manager = new BoundedDelegationManager(runner, 1)

		const run = manager.run(envelope("a"))
		expect(manager.cancel("a")).toBe(true)

		await expect(run).resolves.toMatchObject({ taskId: "a", status: "cancelled" })
		expect(runner).not.toHaveBeenCalled()
	})

	it("cancels only the selected active child with a typed user cancellation", async () => {
		const cancellationKinds = new Map<string, string>()
		let releaseSibling!: () => void
		const manager = new BoundedDelegationManager(async (item, signal) => {
			if (item.id === "b") {
				await new Promise<void>((resolve) => (releaseSibling = resolve))
				return result(item.id)
			}
			return await new Promise((_, reject) =>
				signal.addEventListener(
					"abort",
					() => {
						if (signal.reason instanceof InternalTaskCancellationError) {
							cancellationKinds.set(item.id, signal.reason.kind)
						}
						reject(signal.reason)
					},
					{ once: true },
				),
			)
		})

		const selected = manager.run(envelope("a"))
		const sibling = manager.run(envelope("b"))
		await vi.waitFor(() => expect(releaseSibling).toBeTypeOf("function"))

		expect(manager.cancel("a")).toBe(true)
		await expect(selected).resolves.toMatchObject({ taskId: "a", status: "cancelled" })
		expect(cancellationKinds.get("a")).toBe("user_cancelled")

		releaseSibling()
		await expect(sibling).resolves.toMatchObject({ taskId: "b", status: "completed" })
	})

	it("rejects duplicate task IDs before launching a batch", async () => {
		const runner = vi.fn(async (item) => result(item.id))
		const manager = new BoundedDelegationManager(runner)

		await expect(manager.runBatch([envelope("a"), envelope("a")])).rejects.toThrow("Duplicate child task ID")
		expect(runner).not.toHaveBeenCalled()
	})

	it("rejects a task ID that is already registered as active", async () => {
		let releaseFirst!: () => void
		const manager = new BoundedDelegationManager(async (item) => {
			await new Promise<void>((resolve) => (releaseFirst = resolve))
			return result(item.id)
		})

		const first = manager.run(envelope("a"))
		await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"))
		await expect(manager.run(envelope("a"))).rejects.toThrow("already running")

		releaseFirst()
		await expect(first).resolves.toMatchObject({ taskId: "a", status: "completed" })
	})

	it("propagates parent cancellation to every active child", async () => {
		let started = 0
		let releaseStarted!: () => void
		const bothStarted = new Promise<void>((resolve) => (releaseStarted = resolve))
		const cancellationKinds: string[] = []
		const manager = new BoundedDelegationManager(
			async (item, signal) =>
				await new Promise((_, reject) => {
					started++
					if (started === 2) releaseStarted()
					signal.addEventListener(
						"abort",
						() => {
							if (signal.reason instanceof InternalTaskCancellationError) {
								cancellationKinds.push(signal.reason.kind)
							}
							reject(signal.reason)
						},
						{ once: true },
					)
				}),
		)
		const parent = new AbortController()
		const run = manager.runBatch([envelope("a"), envelope("b")], parent.signal)

		await bothStarted
		parent.abort(new Error("parent cancelled"))

		await expect(run).resolves.toEqual([
			expect.objectContaining({ taskId: "a", status: "cancelled" }),
			expect.objectContaining({ taskId: "b", status: "cancelled" }),
		])
		expect(cancellationKinds).toEqual(["parent_cancelled", "parent_cancelled"])
	})

	it("cleans capacity, queued waiters, and run registrations exactly once", async () => {
		let releaseFirst!: () => void
		const manager = new BoundedDelegationManager(async (item) => {
			if (item.id === "a") await new Promise<void>((resolve) => (releaseFirst = resolve))
			return result(item.id)
		}, 1)

		const first = manager.run(envelope("a"))
		await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"))
		const queued = manager.run(envelope("b"))
		expect(manager.cancel("b")).toBe(true)
		expect(manager.cancel("b")).toBe(false)
		await queued
		releaseFirst()
		await first

		expect((manager as any).activeByRoot.size).toBe(0)
		expect((manager as any).pending).toHaveLength(0)
		expect((manager as any).activeRuns.size).toBe(0)

		await expect(manager.run(envelope("b"))).resolves.toMatchObject({ taskId: "b", status: "completed" })
		expect((manager as any).activeByRoot.size).toBe(0)
		expect((manager as any).activeRuns.size).toBe(0)
	})
})
