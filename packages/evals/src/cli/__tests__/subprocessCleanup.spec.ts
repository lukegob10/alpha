import { afterEach, expect, it, vi } from "vitest"
import type { ResultPromise } from "execa"
import { Logger, waitForSubprocessWithTimeout } from "../utils"

afterEach(() => vi.useRealTimers())
const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger

it("clears the cleanup timer when a subprocess settles", async () => {
	vi.useFakeTimers()
	await waitForSubprocessWithTimeout({ subprocess: Promise.resolve({}) as ResultPromise, logger })
	expect(vi.getTimerCount()).toBe(0)
})

it("kills a nonsettling process and rejects instead of claiming cleanup succeeded", async () => {
	vi.useFakeTimers()
	const kill = vi.fn(() => true)
	const subprocess = Object.assign(new Promise(() => {}), { kill }) as unknown as ResultPromise
	const pending = waitForSubprocessWithTimeout({ subprocess, logger, timeoutMs: 100 })
	const rejection = expect(pending).rejects.toThrow("Subprocess timeout")
	await vi.advanceTimersByTimeAsync(100)
	await rejection
	expect(kill).toHaveBeenCalledWith("SIGKILL")
	expect(vi.getTimerCount()).toBe(0)
})
