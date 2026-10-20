import { AlphaCodeEventName } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>

const fixtures: Harness[] = []
const releases: Array<() => void> = []

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	vi.restoreAllMocks()
	for (const fixture of fixtures.splice(0)) {
		// Retire this fixture's synthetic tail after its actual request loop has joined.
		Reflect.set(fixture.root, "ownedLifecyclePromise", undefined)
		await fixture.root.waitForTermination().catch(() => {
			// A failed assertion must not make cleanup reuse the failed native receipt.
			Reflect.set(fixture.root, "abortTaskPromise", undefined)
			Reflect.set(fixture.root, "taskCancellationReceipt", undefined)
		})
		await fixture.cleanup()
	}
})

async function fixtureWithHeldProducer() {
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(fixture)
	const turn = fixture.queueTurn(fixture.root.taskId, "Held original Stop request")
	fixture.root.start()
	await turn.entered
	const held = deferred()
	void held.promise.catch(() => undefined)
	releases.push(held.resolve)
	// The native boundary must join its original producer after abort has settled.
	const originalLifecycle = Reflect.get(fixture.root, "ownedLifecyclePromise") as Promise<void>
	Reflect.set(
		fixture.root,
		"ownedLifecyclePromise",
		originalLifecycle.then(() => held.promise),
	)
	return { ...fixture, releaseProducer: held.resolve, rejectProducer: held.reject }
}

describe("Task Stop finalization retry through native cancellation receipts", () => {
	it("retries a late transcript failure without replaying abort effects or replacing the original rejection", async () => {
		const fixture = await fixtureWithHeldProducer()
		const task = fixture.root
		const aborted = vi.fn()
		task.on(AlphaCodeEventName.TaskAborted, aborted)
		const dispose = vi.spyOn(task, "dispose")
		const terminal = vi.spyOn(fixture.provider, "publishAgentLifecycleEvent")
		const original = task.beginTaskCancellation(true)
		await original.abort
		expect(aborted).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
		const failure = new Error("Controlled final transcript flush failure")
		const actualFlush = task.flushApiConversationHistoryPersistence.bind(task)
		const flush = vi
			.spyOn(task, "flushApiConversationHistoryPersistence")
			.mockRejectedValueOnce(failure)
			.mockImplementation(actualFlush)
		const originalSettlement = expect(original.termination).rejects.toBe(failure)
		fixture.releaseProducer()
		await originalSettlement
		const retryFlushEntered = deferred()
		const retryFlushRelease = deferred()
		releases.push(retryFlushRelease.resolve)
		flush.mockImplementationOnce(async (...args) => {
			retryFlushEntered.resolve()
			await retryFlushRelease.promise
			await actualFlush(...args)
		})
		const retry = task.beginTaskCancellation(true)
		expect(retry).not.toBe(original)
		await retryFlushEntered.promise
		const concurrent = task.beginTaskCancellation(true)
		expect(retry).toBe(concurrent)
		expect(retry.abort).toBe(original.abort)
		retryFlushRelease.resolve()
		await expect(retry.termination).resolves.toBeUndefined()
		await expect(task.waitForTermination()).resolves.toBeUndefined()
		await expect(original.termination).rejects.toBe(failure)
		expect(flush).toHaveBeenCalledTimes(2)
		expect(aborted).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
		expect(
			terminal.mock.calls.filter(
				([event]) =>
					event !== null && typeof event === "object" && "type" in event && event.type === "turn_terminal",
			),
		).toHaveLength(1)
	})

	it("keeps an original producer failure observable when finalization is explicitly retried", async () => {
		const fixture = await fixtureWithHeldProducer()
		const task = fixture.root
		const dispose = vi.spyOn(task, "dispose")
		const original = task.beginTaskCancellation(true)
		await original.abort
		const failure = new Error("Controlled originating producer failure")
		const settlement = expect(original.termination).rejects.toBe(failure)
		fixture.rejectProducer(failure)
		await settlement
		const retry = task.beginTaskCancellation(true)
		expect(retry).not.toBe(original)
		expect(retry.abort).toBe(original.abort)
		await expect(retry.termination).rejects.toBe(failure)
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("does not retry old finalization after its captured turn loses ownership", async () => {
		const fixture = await fixtureWithHeldProducer()
		const task = fixture.root
		const original = task.beginTaskCancellation(true)
		await original.abort
		const failure = new Error("Controlled superseded final transcript failure")
		const flush = vi.spyOn(task, "flushApiConversationHistoryPersistence").mockRejectedValueOnce(failure)
		const settlement = expect(original.termination).rejects.toBe(failure)
		fixture.releaseProducer()
		await settlement
		const runId = Reflect.get(task, "agentRunId")
		Reflect.set(task, "agentRunId", "successor-run")
		try {
			expect(original.isCurrent()).toBe(false)
			const retry = task.beginTaskCancellation(true)
			expect(retry).toBe(original)
			await expect(retry.termination).rejects.toBe(failure)
			expect(flush).toHaveBeenCalledOnce()
		} finally {
			Reflect.set(task, "agentRunId", runId)
		}
	})
})
