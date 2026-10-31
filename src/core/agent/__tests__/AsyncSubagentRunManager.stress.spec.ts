import { getEventListeners } from "events"
import { describe, expect, it } from "vitest"

import type { SubagentLifecycleEvent, SubagentSpawnHandle } from "@alpha-code/types"

import { AsyncSubagentRunManager } from "../AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskResult } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../InternalTaskEnvelope"

const CONCURRENCY = 30
const WAVES = 10
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
		rootTaskId: "root",
		depth: 1,
		parentTaskId: "root",
		objective: `Inspect ${id}`,
		agentKind: "review",
		parentPolicy: policy,
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
		budget: { maxConcurrency: CONCURRENCY },
	})

const launchOptions = (id: string) => ({
	groupId: "stress-group",
	path: `/root/${id}` as const,
	nickname: id,
	role: "review" as const,
})

const result = (taskId: string, status: "completed" | "blocked" = "completed"): InternalTaskResult => ({
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

const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

interface RunGate {
	parent: AbortController
	started: ReturnType<typeof deferred<void>>
	finish: ReturnType<typeof deferred<InternalTaskResult>>
	signal?: AbortSignal
}

describe("bounded thirty-child lifecycle workload", () => {
	it("reuses capacity across mixed terminal waves and releases runtime records, events, and abort listeners", async () => {
		const gates = new Map<string, RunGate>()
		const active = new Set<string>()
		const observed = new Map<string, SubagentLifecycleEvent[]>()
		let invocations = 0
		let peak = 0
		const bounded = new BoundedDelegationManager(async (item, signal) => {
			const gate = gates.get(item.id)!
			gate.signal = signal
			invocations++
			active.add(item.id)
			peak = Math.max(peak, active.size)
			const cancel = () => gate.finish.reject(signal.reason)
			signal.addEventListener("abort", cancel, { once: true })
			gate.started.resolve()
			try {
				return await gate.finish.promise
			} finally {
				signal.removeEventListener("abort", cancel)
				active.delete(item.id)
			}
		}, CONCURRENCY)
		const manager = new AsyncSubagentRunManager(bounded)
		const unsubscribe = manager.subscribe((event) => {
			const events = observed.get(event.runId) ?? []
			events.push(event)
			observed.set(event.runId, events)
		})
		const launch = (id: string) => {
			const gate: RunGate = {
				parent: new AbortController(),
				started: deferred<void>(),
				finish: deferred<InternalTaskResult>(),
			}
			gates.set(id, gate)
			return manager.launch(envelope(id), launchOptions(id), gate.parent.signal)
		}
		const previous = new Map<string, SubagentSpawnHandle>()
		try {
			for (let wave = 0; wave < WAVES; wave++) {
				const handles = Array.from({ length: CONCURRENCY }, (_, index) => launch(`child-${index}`))
				// Real runner entry is the barrier; wall-clock timing cannot establish overlap.
				await Promise.all(handles.map(({ taskId }) => gates.get(taskId)!.started.promise))
				expect(active.size).toBe(CONCURRENCY)
				expect(invocations).toBe((wave + 1) * CONCURRENCY)
				for (const handle of handles) {
					const stale = previous.get(handle.taskId)
					if (!stale) continue
					expect(handle.runId).not.toBe(stale.runId)
					expect(manager.resolveRunTaskId(stale.runId)).toBeUndefined()
					expect(manager.acknowledgeEvents(stale.taskId, stale.runId)).toBe(false)
					expect(manager.unload(stale.taskId, stale.runId)).toBe(false)
				}

				const queued = launch("overflow")
				expect(manager.getSnapshot(queued.taskId)?.status).toBe("pending")
				expect(gates.get(queued.taskId)!.signal).toBeUndefined()
				expect(manager.cancel(queued.taskId, "cancel queued overflow")).toBe(true)
				await expect(manager.waitForResult(queued.taskId)).resolves.toMatchObject({
					status: "cancelled",
					stopReason: "cancelled",
				})
				expect(active.size).toBe(CONCURRENCY)
				expect(gates.get(queued.taskId)!.signal).toBeUndefined()

				for (const [index, { taskId }] of handles.entries()) {
					const gate = gates.get(taskId)!
					switch (index % 5) {
						case 0:
							expect(manager.cancel(taskId, "explicit stop")).toBe(true)
							expect(manager.cancel(taskId, "duplicate stop")).toBe(false)
							break
						case 1:
							gate.parent.abort(new Error("parent stop"))
							break
						case 2:
							gate.finish.reject(new Error("fixture runner failed"))
							break
						default:
							gate.finish.resolve(result(taskId, index % 5 === 4 ? "blocked" : "completed"))
					}
				}
				const results = await Promise.all(handles.map(({ taskId }) => manager.waitForResult(taskId)))
				expect(results.map((item) => item?.status)).toEqual(
					Array.from({ length: CONCURRENCY }, (_, index) =>
						["cancelled", "cancelled", "failed", "completed", "blocked"].at(index % 5),
					),
				)
				expect(results.map((item) => item?.stopReason)).toEqual(
					Array.from({ length: CONCURRENCY }, (_, index) =>
						["cancelled", "parent_cancelled", "failed", "completed", "completed"].at(index % 5),
					),
				)
				expect(active.size).toBe(0)
				for (const handle of [...handles, queued]) {
					const events = observed.get(handle.runId)!
					expect(events.filter(({ type }) => type === "completed")).toHaveLength(1)
					expect(new Set(events.map(({ eventId }) => eventId)).size).toBe(events.length)
					expect(events.map(({ sequence }) => sequence)).toEqual(
						events.map(({ sequence }) => sequence).sort((left, right) => left - right),
					)
					expect(getEventListeners(gates.get(handle.taskId)!.parent.signal, "abort")).toHaveLength(0)
					const signal = gates.get(handle.taskId)!.signal
					if (signal) expect(getEventListeners(signal, "abort")).toHaveLength(0)
					expect(bounded.waitForResult(handle.taskId)).toBeUndefined()
					expect(manager.acknowledgeEvents(handle.taskId, handle.runId)).toBe(true)
					expect(manager.unload(handle.taskId, handle.runId)).toBe(true)
					expect(manager.waitForResult(handle.taskId)).toBeUndefined()
					expect(manager.getResult(handle.taskId)).toBeUndefined()
					previous.set(handle.taskId, handle)
				}
				expect(manager.listSnapshots()).toEqual([])
				expect(manager.getEvents()).toEqual([])
			}
			expect(peak).toBe(CONCURRENCY)
			expect(invocations).toBe(WAVES * CONCURRENCY)
			expect(observed.size).toBe(WAVES * (CONCURRENCY + 1))
		} finally {
			for (const [taskId, gate] of gates) {
				gate.parent.abort()
				gate.finish.resolve(result(taskId))
			}
			await Promise.all([...gates.keys()].map((taskId) => manager.waitForResult(taskId)))
			unsubscribe()
		}
	})
})
