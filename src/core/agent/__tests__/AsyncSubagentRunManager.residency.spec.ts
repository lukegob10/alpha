import { describe, expect, it } from "vitest"

import { AsyncSubagentRunManager } from "../AsyncSubagentRunManager"
import type { InternalTaskResult } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../InternalTaskEnvelope"

const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: true,
}

const envelope = (id: string) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "parent",
		objective: `Inspect ${id}`,
		agentKind: "review",
		parentPolicy: policy,
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
	})

const result = (taskId: string): InternalTaskResult => ({
	taskId,
	status: "completed",
	summary: `${taskId} completed`,
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1, inputTokens: 2, outputTokens: 3, cost: 0.01 },
	modelRouteId: "balanced",
	requiresParentVerification: false,
	stopReason: "completed",
})

const launchOptions = {
	groupId: "group",
	path: "/root/review" as const,
	nickname: "Review",
	role: "review" as const,
}

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("async sub-agent runtime residency", () => {
	it("keeps a stable generation after persisted events are released", async () => {
		const manager = new AsyncSubagentRunManager(async (item) => result(item.id))
		const handle = manager.launch(envelope("retained"), launchOptions)
		await manager.waitForResult(handle.taskId)
		expect(manager.getEvents(handle.taskId)).toHaveLength(3)

		manager.acknowledgeEvents(handle.taskId, handle.runId)

		expect(manager.getEvents(handle.taskId)).toEqual([])
		expect(manager.getRunId(handle.taskId)).toBe(handle.runId)
		expect(manager.getSnapshot(handle.taskId)?.status).toBe("completed")
		expect(manager.getResult(handle.taskId)).toMatchObject({ summary: "retained completed" })
		expect(manager.resolveRunTaskId(handle.runId)).toBe(handle.taskId)
	})

	it("does not let a stale acknowledgment or unload remove a new running generation", async () => {
		const started = deferred<void>()
		const finish = deferred<InternalTaskResult>()
		let invocation = 0
		const manager = new AsyncSubagentRunManager(async (item) => {
			if (++invocation === 1) return result(item.id)
			started.resolve()
			return finish.promise
		})
		const first = manager.launch(envelope("same-id"), launchOptions)
		await manager.waitForResult(first.taskId)
		manager.acknowledgeEvents(first.taskId, first.runId)
		const second = manager.relaunch(envelope(first.taskId), launchOptions)
		await started.promise
		const eventsBefore = manager.getEvents(first.taskId)

		manager.acknowledgeEvents(first.taskId, first.runId)
		expect(manager.unload(first.taskId, first.runId)).toBe(false)
		expect(manager.unload(second.taskId, second.runId)).toBe(false)
		expect(manager.getRunId(first.taskId)).toBe(second.runId)
		expect(manager.getSnapshot(first.taskId)?.status).toBe("running")
		expect(manager.getEvents(first.taskId)).toEqual(eventsBefore)
		expect(manager.resolveRunTaskId(first.runId)).toBeUndefined()
		expect(manager.resolveRunTaskId(second.runId)).toBe(first.taskId)

		finish.resolve(result(first.taskId))
		await manager.waitForResult(first.taskId)
		expect(manager.unload(first.taskId, first.runId)).toBe(false)
		expect(manager.getResult(first.taskId)?.status).toBe("completed")
		expect(manager.unload(second.taskId, second.runId)).toBe(true)
		expect(manager.getSnapshot(first.taskId)).toBeUndefined()
		expect(manager.getResult(first.taskId)).toBeUndefined()
		expect(manager.waitForResult(first.taskId)).toBeUndefined()
		expect(manager.getRunId(first.taskId)).toBeUndefined()
		expect(manager.getEvents(first.taskId)).toEqual([])
	})

	it("releases completed result, promise, event, and identity bookkeeping without dropping other active runs", async () => {
		const activeStarted = deferred<void>()
		const activeFinish = deferred<InternalTaskResult>()
		const manager = new AsyncSubagentRunManager(async (item) => {
			if (item.id !== "active") return result(item.id)
			activeStarted.resolve()
			return activeFinish.promise
		})
		const retained = manager.launch(envelope("finished"), launchOptions)
		await manager.waitForResult(retained.taskId)
		const active = manager.launch(envelope("active"), launchOptions)
		await activeStarted.promise

		expect(manager.unload(retained.taskId, retained.runId)).toBe(true)
		expect(manager.unload(retained.taskId, retained.runId)).toBe(false)
		expect(manager.listSnapshots().map(({ taskId }) => taskId)).toEqual([active.taskId])
		expect(manager.getEvents().every(({ taskId }) => taskId === active.taskId)).toBe(true)

		const restored = manager.launch(envelope(retained.taskId), launchOptions)
		await manager.waitForResult(restored.taskId)
		expect(restored.runId).not.toBe(retained.runId)
		expect(manager.getRunId(restored.taskId)).toBe(restored.runId)
		activeFinish.resolve(result(active.taskId))
		await manager.waitForResult(active.taskId)
	})

	it("bounds a fixed 64-child sequential lifecycle workload after durable publication", async () => {
		const durableResults = new Map<string, InternalTaskResult>()
		const manager = new AsyncSubagentRunManager(async (item) => result(item.id))
		const sampleSizes = new Set([4, 8, 16, 32, 64])
		const samples: Array<{ runs: number; events: number; durable: number }> = []

		for (let index = 0; index < 64; index++) {
			const taskId = `child-${index}`
			const handle = manager.launch(envelope(taskId), {
				...launchOptions,
				groupId: `group-${index}`,
				path: `/root/child-${index}`,
			})
			const completion = await manager.waitForResult(taskId)
			expect(completion).toBeDefined()
			durableResults.set(taskId, structuredClone(completion!))
			manager.acknowledgeEvents(taskId, handle.runId)
			expect(manager.unload(taskId, handle.runId)).toBe(true)
			if (sampleSizes.has(index + 1)) {
				samples.push({
					runs: manager.listSnapshots().length,
					events: manager.getEvents().length,
					durable: durableResults.size,
				})
			}
		}

		expect(samples).toEqual([4, 8, 16, 32, 64].map((durable) => ({ runs: 0, events: 0, durable })))
		expect(durableResults.get("child-0")).toMatchObject({
			status: "completed",
			usage: { inputTokens: 2, outputTokens: 3, cost: 0.01 },
		})
	})
})
