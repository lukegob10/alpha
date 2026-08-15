import { AsyncSubagentRunManager } from "../AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskResult } from "../BoundedDelegationManager"
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

const envelope = (id: string) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "parent-1",
		objective: `Inspect ${id}`,
		agentKind: "explore",
		parentPolicy: policy,
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
	})

const result = (taskId: string, status: InternalTaskResult["status"] = "completed"): InternalTaskResult => ({
	taskId,
	status,
	summary: `${taskId} ${status}`,
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1 },
	modelRouteId: "balanced",
	requiresParentVerification: false,
})

const launchOptions = {
	groupId: "group-1",
	nickname: "Ada",
	role: "explore" as const,
}

describe("AsyncSubagentRunManager", () => {
	it("returns a stable handle before starting and publishes ordered lifecycle snapshots", async () => {
		let finish!: (value: Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">) => void
		const runner = vi.fn(
			async () =>
				await new Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>(
					(resolve) => (finish = resolve),
				),
		)
		const manager = new AsyncSubagentRunManager(runner)
		const observed: string[] = []
		manager.subscribe((event) => observed.push(`${event.type}:${event.snapshot.status}`))

		const handle = manager.launch(envelope("child-1"), launchOptions)

		expect(handle).toMatchObject({
			taskId: "child-1",
			groupId: "group-1",
			parentTaskId: "parent-1",
			nickname: "Ada",
			role: "explore",
			status: "pending",
		})
		expect(Object.isFrozen(handle)).toBe(true)
		expect(runner).not.toHaveBeenCalled()
		expect(manager.getSnapshot("child-1")).toMatchObject({ status: "pending", phase: "queued" })

		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
		expect(manager.getSnapshot("child-1")).toMatchObject({ status: "running", phase: "starting" })
		finish(result("child-1"))

		await expect(manager.waitForResult("child-1")).resolves.toMatchObject({ status: "completed" })
		expect(manager.getSnapshot("child-1")).toMatchObject({
			status: "completed",
			summary: "child-1 completed",
		})
		expect(observed).toEqual(["status:pending", "started:running", "completed:completed"])
		expect(manager.getEvents("child-1")).toHaveLength(3)
	})

	it("shares a bounded manager and queues launches beyond its concurrency", async () => {
		let active = 0
		let peak = 0
		const releases = new Map<
			string,
			(value: Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">) => void
		>()
		const bounded = new BoundedDelegationManager(
			async (item) =>
				await new Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>(
					(resolve) => {
						active++
						peak = Math.max(peak, active)
						releases.set(item.id, (value) => {
							active--
							resolve(value)
						})
					},
				),
			1,
		)
		const manager = new AsyncSubagentRunManager(bounded)

		manager.launch(envelope("first"), launchOptions)
		manager.launch(envelope("second"), { ...launchOptions, nickname: "Bea" })
		await vi.waitFor(() => expect(releases.has("first")).toBe(true))

		expect(manager.getSnapshot("first")?.status).toBe("running")
		expect(manager.getSnapshot("second")?.status).toBe("pending")
		releases.get("first")!(result("first"))
		await vi.waitFor(() => expect(releases.has("second")).toBe(true))
		expect(manager.getSnapshot("second")?.status).toBe("running")
		releases.get("second")!(result("second"))

		await expect(manager.waitForResult("second")).resolves.toMatchObject({ status: "completed" })
		expect(peak).toBe(1)
	})

	it("shares capacity with a legacy run on the supplied bounded manager", async () => {
		const releases = new Map<
			string,
			(value: Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">) => void
		>()
		const bounded = new BoundedDelegationManager(
			async (item) =>
				await new Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>((resolve) =>
					releases.set(item.id, resolve),
				),
			1,
		)
		const manager = new AsyncSubagentRunManager(bounded)

		const legacy = bounded.run(envelope("legacy"))
		await vi.waitFor(() => expect(releases.has("legacy")).toBe(true))
		manager.launch(envelope("async"), launchOptions)
		expect(manager.getSnapshot("async")?.status).toBe("pending")

		releases.get("legacy")!(result("legacy"))
		await legacy
		await vi.waitFor(() => expect(releases.has("async")).toBe(true))
		releases.get("async")!(result("async"))
		await expect(manager.waitForResult("async")).resolves.toMatchObject({ status: "completed" })
	})

	it("cancels a queued launch without invoking its runner", async () => {
		let finishFirst!: (value: Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">) => void
		const invoked: string[] = []
		const manager = new AsyncSubagentRunManager(
			async (item) => {
				invoked.push(item.id)
				if (item.id === "first") {
					return await new Promise((resolve) => (finishFirst = resolve))
				}
				return result(item.id)
			},
			{ maxConcurrency: 1 },
		)

		manager.launch(envelope("first"), launchOptions)
		await vi.waitFor(() => expect(invoked).toEqual(["first"]))
		manager.launch(envelope("queued"), { ...launchOptions, nickname: "Bea" })

		expect(manager.cancel("queued", "cancel queued run")).toBe(true)
		expect(manager.getSnapshot("queued")?.status).toBe("cancelling")
		await expect(manager.waitForResult("queued")).resolves.toMatchObject({
			taskId: "queued",
			status: "cancelled",
			summary: "cancel queued run",
		})
		expect(invoked).toEqual(["first"])

		finishFirst(result("first"))
		await manager.waitForResult("first")
	})

	it("can be cancelled synchronously from its first pending notification", async () => {
		const runner = vi.fn(async (item) => result(item.id))
		const manager = new AsyncSubagentRunManager(runner)
		manager.subscribe((event) => {
			if (event.type === "status" && event.snapshot.status === "pending") {
				expect(manager.cancel(event.taskId, "cancel at acknowledgement")).toBe(true)
			}
		})

		manager.launch(envelope("child-1"), launchOptions)

		await expect(manager.waitForResult("child-1")).resolves.toMatchObject({
			status: "cancelled",
			summary: "cancel at acknowledgement",
		})
		expect(runner).not.toHaveBeenCalled()
	})

	it("propagates parent cancellation and records cancelling before completion", async () => {
		const parent = new AbortController()
		const manager = new AsyncSubagentRunManager(
			async (_item, signal) =>
				await new Promise((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				),
		)
		manager.launch(envelope("child-1"), launchOptions, parent.signal)
		await vi.waitFor(() => expect(manager.getSnapshot("child-1")?.status).toBe("running"))

		parent.abort(new Error("parent stopped"))
		expect(manager.getSnapshot("child-1")?.status).toBe("cancelling")
		await expect(manager.waitForResult("child-1")).resolves.toMatchObject({ status: "cancelled" })
		expect(manager.getEvents("child-1").map((event) => event.snapshot.status)).toEqual([
			"pending",
			"running",
			"cancelling",
			"cancelled",
		])
	})

	it("absorbs a rejected background runner and retains its terminal result", async () => {
		const manager = new AsyncSubagentRunManager(async () => {
			throw new Error("runner exploded")
		})
		manager.subscribe(() => {
			throw new Error("observer exploded")
		})

		manager.launch(envelope("child-1"), launchOptions)
		await vi.waitFor(() => expect(manager.getResult("child-1")).toBeDefined())

		expect(manager.getResult("child-1")).toMatchObject({
			taskId: "child-1",
			status: "failed",
			summary: "runner exploded",
		})
		expect(manager.getSnapshot("child-1")).toMatchObject({
			status: "failed",
			error: "runner exploded",
		})
		expect(manager.getEvents("child-1").at(-1)?.type).toBe("completed")
	})

	it("never reuses a stable task ID, including after its retained result is forgotten", async () => {
		const runner = vi.fn(async (item) => result(item.id))
		const manager = new AsyncSubagentRunManager(runner)
		manager.launch(envelope("child-1"), launchOptions)

		expect(() => manager.launch(envelope("child-1"), launchOptions)).toThrow("already registered")
		await manager.waitForResult("child-1")
		expect(() => manager.launch(envelope("child-1"), launchOptions)).toThrow("already registered")
		expect(manager.forget("child-1")).toBe(true)
		expect(manager.getEvents("child-1")).toEqual([])
		expect(() => manager.launch(envelope("child-1"), launchOptions)).toThrow("already registered")
		expect(runner).toHaveBeenCalledOnce()
	})

	it("turns a mismatched runner result into a failure for the stable handle", async () => {
		const manager = new AsyncSubagentRunManager(async () => result("different-child"))
		manager.launch(envelope("child-1"), launchOptions)

		await expect(manager.waitForResult("child-1")).resolves.toMatchObject({
			taskId: "child-1",
			status: "failed",
			summary: "Sub-agent runner returned task different-child for handle child-1",
		})
	})

	it("validates construction and launch metadata without consuming capacity", () => {
		expect(() => new AsyncSubagentRunManager(async (item) => result(item.id), { maxConcurrency: 0 })).toThrow(
			"positive integer",
		)
		const runner = vi.fn(async (item) => result(item.id))
		const manager = new AsyncSubagentRunManager(runner)

		expect(() => manager.launch(envelope("child-1"), { ...launchOptions, groupId: " " })).toThrow("group ID")
		expect(runner).not.toHaveBeenCalled()
		expect(manager.waitForResult("missing")).toBeUndefined()
	})
})
