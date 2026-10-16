import { afterEach, describe, expect, it, vi } from "vitest"

import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import type { InternalTaskResult } from "../../agent/BoundedDelegationManager"
import type { Task } from "../../task/Task"
import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type ControlRecord = NonNullable<ReturnType<Harness["store"]["getAgent"]>>
type CapturedTarget = Readonly<{
	record: ControlRecord
	asyncRunId: string | undefined
	asyncCompletion: Promise<InternalTaskResult> | undefined
}>
type CancellationInternals = {
	captureManagedTaskDescendantCancellations(taskId: string, rootTaskId: string): readonly CapturedTarget[]
	cancelManagedTaskDescendants(
		taskId: string,
		rootTaskId: string,
		reason: string,
		isCurrent: () => boolean,
		captured: readonly CapturedTarget[],
	): Promise<string[]>
}

const fixtures: Harness[] = []
const releases: Array<() => void> = []
const pending: Promise<unknown>[] = []

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	try {
		await Promise.allSettled(pending.splice(0))
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function fixture() {
	const value = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(value)
	const internals = value.provider as unknown as CancellationInternals
	if (
		typeof internals.captureManagedTaskDescendantCancellations !== "function" ||
		typeof internals.cancelManagedTaskDescendants !== "function" ||
		typeof value.runs.getRunId !== "function"
	) {
		throw new Error("Invalid baseline: this regression requires the sealed f5bb Provider and WS08 manager")
	}
	const parentSignal = value.root.getTaskLifetimeCancellationSignal()
	const isCurrent = () =>
		value.provider.getLiveTask(value.root.taskId) === value.root &&
		value.root.getTaskLifetimeCancellationSignal() === parentSignal &&
		!parentSignal.aborted
	return { value, internals, parentSignal, isCurrent }
}

describe("AlphaProvider native async cancellation ownership with the actual run manager", () => {
	it("explicitly cancels and journals unchanged async A despite fresh completion wrappers, without parent abort propagation", async () => {
		const { value, internals, parentSignal, isCurrent } = await fixture()
		expect(value.runs).toBeInstanceOf(AsyncSubagentRunManager)
		const child = await value.spawnChild("async_wrapper_owner")
		releases.push(child.turn.release)
		const captured = internals.captureManagedTaskDescendantCancellations(value.root.taskId, value.root.taskId)
		const target = captured.find(({ record }) => record.taskId === child.taskId)
		if (!target?.asyncCompletion || !target.asyncRunId)
			throw new Error("Invalid baseline: actual A was not captured")
		const fresh = value.runs.waitForResult(child.taskId)
		expect(fresh).toBeDefined()
		expect(fresh).not.toBe(target.asyncCompletion)
		expect(parentSignal.aborted).toBe(false)
		expect(isCurrent()).toBe(true)
		const entered = deferred()
		const held = deferred()
		releases.push(held.resolve)
		const actualFlush = child.task.flushApiConversationHistoryPersistence.bind(child.task)
		vi.spyOn(child.task, "flushApiConversationHistoryPersistence").mockImplementation(
			async (...args: Parameters<Task["flushApiConversationHistoryPersistence"]>) => {
				await actualFlush(...args)
				entered.resolve()
				await held.promise
			},
		)
		const cancel = vi.spyOn(value.runs, "cancel")
		const append = vi.spyOn(value.store, "appendEvent")
		const reason = "Explicit original async descendant cancellation"
		let settled = false
		const stopping = internals.cancelManagedTaskDescendants(
			value.root.taskId,
			value.root.taskId,
			reason,
			isCurrent,
			captured,
		)
		pending.push(stopping)
		void stopping.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		// On f5bb, fresh wrapper inequality denies this existing explicit cancel before any await.
		expect(cancel).toHaveBeenCalledWith(child.taskId, reason, "parent_cancelled")
		expect(parentSignal.aborted).toBe(false)
		await entered.promise
		expect(settled).toBe(false)
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "cancel_requested",
				recipient: child.taskId,
				payload: { reason, stopReason: "parent_cancelled" },
			}),
		)
		held.resolve()
		await expect(stopping).resolves.toEqual([child.taskId])
		await child.finalization
		await expect(target.asyncCompletion).resolves.toMatchObject({ taskId: child.taskId, status: "cancelled" })
		expect(parentSignal.aborted).toBe(false)
		expect(isCurrent()).toBe(true)
	})

	it("joins captured A after an actual same-ID async relaunch without reading, cancelling or journaling B", async () => {
		const { value, internals, parentSignal, isCurrent } = await fixture()
		const original = await value.spawnChild("async_generation_owner")
		releases.push(original.turn.release)
		const captured = internals.captureManagedTaskDescendantCancellations(value.root.taskId, value.root.taskId)
		const target = captured.find(({ record }) => record.taskId === original.taskId)
		if (!target?.asyncCompletion || !target.asyncRunId)
			throw new Error("Invalid baseline: actual A was not captured")
		original.turn.release()
		await target.asyncCompletion
		await original.finalization
		await original.task.waitForTermination()
		const successorTurn = value.queueTurn(original.taskId, "Verified actual successor generation")
		releases.push(successorTurn.release)
		const following = value.provider.followupAgentTask(value.root, original.path, "Recheck the retained report.")
		pending.push(following)
		await following
		await successorTurn.entered
		const successor = value.provider.getLiveTask(original.taskId)
		const successorSignal = successorTurn.request?.signal
		const successorRunId = value.runs.getRunId(original.taskId)
		if (!successor || !successorSignal || !successorRunId)
			throw new Error("Invalid baseline: actual B did not enter")
		expect(successorRunId).not.toBe(target.asyncRunId)
		expect(value.runs.getSnapshot(original.taskId)?.status).toBe("running")
		expect(parentSignal.aborted).toBe(false)
		const read = deferred<"manager-read">()
		const cancelled = deferred<"manager-cancel">()
		const actualWait = value.runs.waitForResult.bind(value.runs)
		const lookup = vi.spyOn(value.runs, "waitForResult").mockImplementation((id) => {
			if (id === original.taskId) read.resolve("manager-read")
			return actualWait(id)
		})
		const actualCancel = value.runs.cancel.bind(value.runs)
		const cancel = vi.spyOn(value.runs, "cancel").mockImplementation((id, ...args) => {
			if (id === original.taskId) cancelled.resolve("manager-cancel")
			return actualCancel(id, ...args)
		})
		const append = vi.spyOn(value.store, "appendEvent")
		const stopping = internals.cancelManagedTaskDescendants(
			value.root.taskId,
			value.root.taskId,
			"Stale A cancellation",
			isCurrent,
			captured,
		)
		pending.push(stopping)
		// A mistaken live B lookup/cancel is itself an existing-method oracle, not a timeout.
		const next = await Promise.race([
			stopping.then(
				() => "joined-a",
				() => "failure",
			),
			read.promise,
			cancelled.promise,
		])
		expect(next).toBe("joined-a")
		await expect(stopping).resolves.toEqual([original.taskId])
		expect(lookup).not.toHaveBeenCalled()
		expect(cancel).not.toHaveBeenCalled()
		expect(append.mock.calls.filter(([event]) => event.name === "cancel_requested")).toEqual([])
		expect(successorSignal.aborted).toBe(false)
		expect(successor.getTaskLifetimeCancellationSignal().aborted).toBe(false)
		expect(value.runs.getRunId(original.taskId)).toBe(successorRunId)
		expect(value.runs.getSnapshot(original.taskId)?.status).toBe("running")
		expect(parentSignal.aborted).toBe(false)
		const completion = actualWait(original.taskId)
		successorTurn.release()
		await expect(completion).resolves.toMatchObject({ taskId: original.taskId, status: "completed" })
		await value.settleFinalizations()
	})
})
