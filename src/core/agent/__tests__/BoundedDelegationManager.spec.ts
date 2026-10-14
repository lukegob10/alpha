import {
	BoundedDelegationManager,
	InternalTaskCancellationError,
	type InternalTaskRunner,
} from "../BoundedDelegationManager"
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

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

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

	it("holds capacity until a cancelled runner settles and preserves its late mutation evidence", async () => {
		const entered = barrier()
		const cleanup = barrier()
		const nextStarted = barrier()
		let cancelledSignal: AbortSignal | undefined
		const runner = vi.fn<InternalTaskRunner>(async (item, signal) => {
			if (item.id === "cancelled") {
				cancelledSignal = signal
				entered.resolve()
				await cleanup.promise
				return {
					...result(item.id),
					changedFiles: ["src/partially-written.ts"],
					evidence: [{ kind: "file", reference: "src/partially-written.ts", outcome: "changed" }],
				}
			}
			if (item.id === "queued") nextStarted.resolve()
			return result(item.id)
		})
		const manager = new BoundedDelegationManager(runner, 1)
		const cancelled = manager.run(envelope("cancelled"))
		await entered.promise
		const queued = manager.run(envelope("queued"))
		let settled = false
		void cancelled.then(() => (settled = true))

		try {
			expect(manager.cancel("cancelled", "User stopped the child")).toBe(true)
			expect(manager.cancel("cancelled")).toBe(false)
			expect(cancelledSignal?.aborted).toBe(true)
			expect(cancelledSignal?.reason).toMatchObject({ kind: "user_cancelled" })
			await expect(
				manager.run({ ...envelope("independent"), rootTaskId: "independent-root" }),
			).resolves.toMatchObject({ taskId: "independent", status: "completed" })
			expect(settled).toBe(false)
			expect(runner.mock.calls.map(([item]) => item.id)).toEqual(["cancelled", "independent"])
		} finally {
			cleanup.resolve()
		}

		await expect(cancelled).resolves.toMatchObject({
			taskId: "cancelled",
			status: "cancelled",
			stopReason: "cancelled",
			changedFiles: ["src/partially-written.ts"],
			evidence: [{ kind: "file", reference: "src/partially-written.ts", outcome: "changed" }],
			requiresParentVerification: true,
		})
		await nextStarted.promise
		await expect(queued).resolves.toMatchObject({ taskId: "queued", status: "completed" })
		expect(runner.mock.calls.map(([item]) => item.id)).toEqual(["cancelled", "independent", "queued"])
	})

	it("joins an active blocking run until owned cleanup settles, then releases its join handle", async () => {
		const entered = barrier()
		const cleanup = barrier()
		const manager = new BoundedDelegationManager(async (item, signal) => {
			entered.resolve()
			await cleanup.promise
			throw signal.reason
		})
		const run = manager.run(envelope("child"))
		await entered.promise
		const join = manager.waitForResult("child")
		let settled = false
		void join?.then(() => (settled = true))
		try {
			expect(join).toBeDefined()
			expect(manager.cancel("child")).toBe(true)
			expect(settled).toBe(false)
			cleanup.resolve()
			await expect(join).resolves.toMatchObject({ status: "cancelled", stopReason: "cancelled" })
			await run
			expect(manager.waitForResult("child")).toBeUndefined()
		} finally {
			cleanup.resolve()
			await run
		}
	})

	it.each(["returned", "thrown"] as const)(
		"preserves a %s shutdown failure and its parent cancellation cause",
		async (outcome) => {
			const entered = barrier()
			const finishCleanup = barrier()
			const parent = new AbortController()
			const manager = new BoundedDelegationManager(async (item) => {
				entered.resolve()
				await finishCleanup.promise
				if (outcome === "thrown") throw new Error("Owned process shutdown could not be confirmed")
				return {
					...result(item.id),
					status: "failed" as const,
					stopReason: "failed" as const,
					summary: "Owned process shutdown could not be confirmed",
					remainingRisks: ["Owned process may still be running"],
					changedFiles: ["src/partial.ts"],
				}
			}, 1)
			const run = manager.run(envelope("child"), parent.signal)
			try {
				await entered.promise
				parent.abort(new Error("Parent requested cancellation"))
				finishCleanup.resolve()
				const terminal = await run
				expect(terminal).toMatchObject({
					status: "failed",
					stopReason: "parent_cancelled",
					summary: "Owned process shutdown could not be confirmed",
				})
				if (outcome === "returned") {
					expect(terminal.remainingRisks).toEqual(["Owned process may still be running"])
					expect(terminal.requiresParentVerification).toBe(true)
				}
			} finally {
				finishCleanup.resolve()
				await run
			}
		},
	)

	it("retains each queued child's admission limit when the live resolver changes", async () => {
		const releases = [barrier(), barrier(), barrier()]
		const starts = [barrier(), barrier(), barrier()]
		const ids = ["first", "second", "third"]
		const runner = vi.fn<InternalTaskRunner>(async (item) => {
			const index = ids.indexOf(item.id)
			starts[index].resolve()
			await releases[index].promise
			return result(item.id)
		})
		const liveLimit = { value: 1 }
		const resolver = vi.fn(() => liveLimit.value)
		const manager = new BoundedDelegationManager(runner, resolver)
		const first = manager.run(envelope(ids[0]))
		await starts[0].promise
		const second = manager.run(envelope(ids[1]))
		const third = manager.run(envelope(ids[2]))

		try {
			liveLimit.value = 3
			releases[0].resolve()
			await first
			await starts[1].promise
			expect(runner.mock.calls.map(([item]) => item.id)).toEqual(["first", "second"])
			expect(resolver).toHaveBeenCalledTimes(3)

			releases[1].resolve()
			await second
			await starts[2].promise
		} finally {
			for (const release of releases) release.resolve()
			await Promise.allSettled([first, second, third])
		}

		await expect(third).resolves.toMatchObject({ taskId: "third", status: "completed" })
		expect(runner.mock.calls.map(([item]) => item.id)).toEqual(ids)
		expect(resolver).toHaveBeenCalledTimes(3)
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
