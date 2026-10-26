import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"

import { joinWorktreeProcess, WorktreeProcessCleanupError } from "../worktree-process.js"

afterEach(() => vi.useRealTimers())

describe("owned worktree process joins", () => {
	it("does not terminate a numeric PID after its original process has closed", async () => {
		const cancellation = new AbortController()
		const child = Object.assign(new EventEmitter(), { pid: 12345 })
		const terminateProcessTree = vi.fn(async () => undefined)
		const run = joinWorktreeProcess(Promise.resolve("exited"), child, {
			signal: cancellation.signal,
			terminateProcessTree,
		})
		child.emit("close", 0)
		const reason = new Error("Stopped after process close")
		cancellation.abort(reason)
		await expect(run).rejects.toBe(reason)
		expect(terminateProcessTree).not.toHaveBeenCalled()
	})

	it("bounds waiting for the original process after successful tree termination", async () => {
		vi.useFakeTimers()
		const cancellation = new AbortController()
		const terminateProcessTree = vi.fn(async () => undefined)
		const execution = new Promise<never>(() => undefined)
		const run = joinWorktreeProcess(execution, Object.assign(new EventEmitter(), { pid: 12345 }), {
			signal: cancellation.signal,
			terminateProcessTree,
		})
		const failure = expect(run).rejects.toThrow(WorktreeProcessCleanupError)
		cancellation.abort()
		await vi.advanceTimersByTimeAsync(5_000)
		await failure
		expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith([12345], { allowMissingWindowsRoots: true })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reports unconfirmed cleanup even when the original process never settles", async () => {
		const cancellation = new AbortController()
		const execution = new Promise<never>(() => undefined)
		const run = joinWorktreeProcess(execution, Object.assign(new EventEmitter(), { pid: 12345 }), {
			signal: cancellation.signal,
			terminateProcessTree: async () => {
				throw new Error("Cleanup unavailable")
			},
		})
		const failure = expect(run).rejects.toThrow("Worktree process-tree cleanup failed")
		cancellation.abort()
		await failure
	})

	it("terminates a process admitted just before its signal was cancelled", async () => {
		const cancellation = new AbortController()
		const reason = new Error("Stopped at launch")
		cancellation.abort(reason)
		const terminateProcessTree = vi.fn(async () => undefined)
		await expect(
			joinWorktreeProcess(Promise.resolve("exited"), Object.assign(new EventEmitter(), { pid: 12345 }), {
				signal: cancellation.signal,
				terminateProcessTree,
			}),
		).rejects.toBe(reason)
		expect(terminateProcessTree).toHaveBeenCalledOnce()
	})
})
