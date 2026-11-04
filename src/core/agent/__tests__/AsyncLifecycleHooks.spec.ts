import { describe, expect, it, vi } from "vitest"

import { AsyncLifecycleHooks } from "../AsyncLifecycleHooks"

function barrier<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { promise, resolve }
}

async function settle() {
	// Flush promise continuations; no clock or subprocess timing participates.
	for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe("owned asynchronous lifecycle hooks", () => {
	it("reports ready live context without consuming it or waiting for running work", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const release = barrier()
		const output = { warnings: [], additionalContext: [{ hook_run_id: "review", text: "Review feedback" }] }
		hooks.schedule(
			"PostToolUse",
			async () => {
				await release.promise
				return output
			},
			lifetime.signal,
		)
		expect(hooks.hasPendingContext()).toBe(false)
		release.resolve()
		await settle()
		expect(hooks.hasPendingContext()).toBe(true)
		expect(hooks.hasPendingContext()).toBe(true)
		expect(hooks.drain()).toEqual([{ event: "PostToolUse", outcome: output }])
		expect(hooks.hasPendingContext()).toBe(false)
		await hooks.shutdown()
	})

	it.each([
		{ label: "missing", additionalContext: undefined },
		{ label: "empty", additionalContext: [] },
		{ label: "blank", additionalContext: [{ hook_run_id: "blank", text: "  \n" }] },
	])("does not report warnings or blank context as pending model input ($label)", async ({ additionalContext }) => {
		const hooks = new AsyncLifecycleHooks()
		hooks.schedule(
			"PostToolUse",
			async () => ({ warnings: ["Warning only"], additionalContext }),
			new AbortController().signal,
		)
		await settle()
		expect(hooks.hasPendingContext()).toBe(false)
		await hooks.shutdown()
	})

	it("ignores completed context after its task lifetime is cancelled", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		hooks.schedule(
			"PostToolUse",
			async () => ({ warnings: [], additionalContext: [{ hook_run_id: "cancelled", text: "Late feedback" }] }),
			lifetime.signal,
		)
		await settle()
		expect(hooks.hasPendingContext()).toBe(true)
		lifetime.abort()
		expect(hooks.hasPendingContext()).toBe(false)
		await hooks.shutdown()
	})

	it("starts at most eight commands and releases queued work in admission order", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const releases = Array.from({ length: 10 }, () => barrier())
		const started: number[] = []
		for (let index = 0; index < releases.length; index++) {
			expect(
				hooks.schedule(
					"PostToolUse",
					async () => {
						started.push(index)
						await releases[index].promise
						return { warnings: [`Finished ${index}`] }
					},
					lifetime.signal,
				),
			).toBe(true)
		}
		expect(started).toEqual([])
		await settle()
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
		releases[3].resolve()
		await settle()
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
		releases[2].resolve()
		await settle()
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		for (const release of releases) release.resolve()
		await settle()
		expect(hooks.drain()).toHaveLength(10)
		expect(hooks.drain()).toEqual([])
		await hooks.shutdown()
	})

	it("bounds queued, running, and undrained results together until the caller drains", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const release = barrier()
		const run = vi.fn(async () => {
			await release.promise
			return { warnings: [] }
		})
		for (let index = 0; index < 32; index++) expect(hooks.schedule("Stop", run, lifetime.signal)).toBe(true)
		expect(hooks.schedule("Stop", run, lifetime.signal)).toBe(false)
		release.resolve()
		await settle()
		await settle()
		await settle()
		await settle()
		expect(run).toHaveBeenCalledTimes(32)
		expect(hooks.schedule("Stop", run, lifetime.signal)).toBe(false)
		expect(hooks.drain()).toHaveLength(32)
		expect(hooks.schedule("Stop", run, lifetime.signal)).toBe(true)
		await hooks.shutdown()
	})

	it("returns only advisory output and copies the retained fragments", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const output = {
			warnings: ["A hook warning"],
			additionalContext: [{ hook_run_id: "hook-run", text: "Context for the next boundary" }],
			shouldStop: true,
			prompt: "This must not wake or control a turn",
		}
		hooks.schedule("SessionStart", async () => output, lifetime.signal)
		await settle()
		output.additionalContext[0].text = "Changed after settlement"
		output.warnings[0] = "Changed warning"
		expect(hooks.drain()).toEqual([
			{
				event: "SessionStart",
				outcome: {
					warnings: ["A hook warning"],
					additionalContext: [{ hook_run_id: "hook-run", text: "Context for the next boundary" }],
				},
			},
		])
		await hooks.shutdown()
	})

	it("rejects pre-cancelled work and drops results cancelled before delivery", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const run = vi.fn(async () => ({ warnings: ["Late context"] }))
		hooks.schedule("PostToolUse", run, lifetime.signal)
		await settle()
		lifetime.abort()
		expect(hooks.schedule("PostToolUse", run, lifetime.signal)).toBe(false)
		expect(hooks.drain()).toEqual([])
		await hooks.shutdown()
	})

	it("cancels queued commands without starting them and releases their capacity", async () => {
		const hooks = new AsyncLifecycleHooks()
		const activeLifetime = new AbortController()
		const queuedLifetime = new AbortController()
		const release = barrier()
		for (let index = 0; index < 8; index++) {
			hooks.schedule(
				"Stop",
				async () => {
					await release.promise
					return { warnings: [] }
				},
				activeLifetime.signal,
			)
		}
		const queued = vi.fn(async () => ({ warnings: [] }))
		hooks.schedule("Stop", queued, queuedLifetime.signal)
		queuedLifetime.abort()
		release.resolve()
		await settle()
		expect(queued).not.toHaveBeenCalled()
		expect(hooks.drain()).toHaveLength(8)
		await hooks.shutdown()
	})

	it("joins physical cleanup, discards late results, and shuts down only once", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const started = barrier()
		const terminated = barrier()
		let executionSignal: AbortSignal | undefined
		hooks.schedule(
			"Stop",
			async (signal) => {
				executionSignal = signal
				started.resolve()
				await terminated.promise
				return { warnings: ["Must not be delivered"] }
			},
			lifetime.signal,
		)
		await started.promise
		const stopped = vi.fn()
		const shutdown = hooks.shutdown()
		void shutdown.then(stopped)
		expect(hooks.shutdown()).toBe(shutdown)
		expect(executionSignal?.aborted).toBe(true)
		expect(hooks.schedule("Stop", async () => ({ warnings: [] }), lifetime.signal)).toBe(false)
		await settle()
		expect(stopped).not.toHaveBeenCalled()
		terminated.resolve()
		await shutdown
		expect(stopped).toHaveBeenCalledOnce()
		expect(hooks.drain()).toEqual([])
	})

	it("removes lifetime cancellation listeners after completed work", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const added = vi.spyOn(lifetime.signal, "addEventListener")
		const removed = vi.spyOn(lifetime.signal, "removeEventListener")
		hooks.schedule("Stop", async () => ({ warnings: [] }), lifetime.signal)
		await settle()
		expect(added).toHaveBeenCalledOnce()
		expect(removed).toHaveBeenCalledExactlyOnceWith("abort", added.mock.calls[0][1])
		await hooks.shutdown()
		expect(removed).toHaveBeenCalledOnce()
	})

	it("retains rejected cleanup for the next boundary without an unhandled rejection", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const failure = new Error("Physical process cleanup is unconfirmed")
		hooks.schedule(
			"PostToolUse",
			async () => {
				throw failure
			},
			lifetime.signal,
		)
		await settle()
		expect(() => hooks.drain()).toThrow(failure)
		expect(hooks.drain()).toEqual([])
		await hooks.shutdown()
	})

	it("propagates undrained cleanup failures after joining shutdown", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const failure = new Error("Physical process cleanup is unconfirmed")
		hooks.schedule(
			"Stop",
			async () => {
				throw failure
			},
			lifetime.signal,
		)
		await settle()
		await expect(hooks.shutdown()).rejects.toBe(failure)
	})

	it("keeps admission closed after draining a failure while sibling physical cleanup is held", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const failFirst = barrier()
		const siblingCleanup = barrier()
		const failure = new Error("Cleanup failed before a sibling process closed")
		let siblingSignal: AbortSignal | undefined
		hooks.schedule(
			"Stop",
			async () => {
				await failFirst.promise
				throw failure
			},
			lifetime.signal,
		)
		hooks.schedule(
			"Stop",
			async (signal) => {
				siblingSignal = signal
				await siblingCleanup.promise
				return { warnings: ["Late sibling output"] }
			},
			lifetime.signal,
		)
		await settle()
		failFirst.resolve()
		await settle()
		expect(siblingSignal?.aborted).toBe(true)
		expect(() => hooks.drain()).toThrow(failure)
		const replacement = vi.fn(async () => ({ warnings: [] }))
		expect(hooks.schedule("Stop", replacement, lifetime.signal)).toBe(false)
		const stopped = vi.fn()
		const shutdown = hooks.shutdown()
		void shutdown.then(stopped)
		await settle()
		expect(stopped).not.toHaveBeenCalled()
		expect(replacement).not.toHaveBeenCalled()
		siblingCleanup.resolve()
		await shutdown
		expect(stopped).toHaveBeenCalledOnce()
		expect(hooks.drain()).toEqual([])
		expect(hooks.schedule("Stop", replacement, lifetime.signal)).toBe(false)
	})

	it("joins rejected siblings, prevents queued execution, and retains every cleanup failure", async () => {
		const hooks = new AsyncLifecycleHooks()
		const lifetime = new AbortController()
		const release = barrier()
		const failures = [new Error("First failed cleanup"), new Error("Second failed cleanup")]
		const signals: AbortSignal[] = []
		for (let index = 0; index < 8; index++) {
			hooks.schedule(
				"Stop",
				async (signal) => {
					signals.push(signal)
					await release.promise
					if (index < 2) throw failures[index]
					return { warnings: [] }
				},
				lifetime.signal,
			)
		}
		const queued = vi.fn(async () => ({ warnings: [] }))
		hooks.schedule("Stop", queued, lifetime.signal)
		await settle()
		release.resolve()
		await settle()
		expect(queued).not.toHaveBeenCalled()
		expect(signals.every((signal) => signal.aborted)).toBe(true)
		expect(hooks.schedule("Stop", queued, lifetime.signal)).toBe(false)
		try {
			hooks.drain()
			throw new Error("Missing failed-cleanup owner")
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError)
			expect((error as AggregateError).errors).toEqual(failures)
		}
		await hooks.shutdown()
	})
})
