import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { runScheduledCommand } from "../runScheduledCommand"

const spawn = vi.hoisted(() => vi.fn())
const terminateProcessTree = vi.hoisted(() => vi.fn<() => Promise<void>>())

vi.mock("node:child_process", () => ({ spawn }))
vi.mock("../../../utils/processTree", () => ({ terminateProcessTree }))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

describe("scheduled command lifecycle", () => {
	let controller: AbortController
	let child: EventEmitter & { pid: number | undefined; stdout: PassThrough; stderr: PassThrough }

	beforeEach(() => {
		vi.useFakeTimers()
		controller = new AbortController()
		child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() })
		spawn.mockReset().mockReturnValue(child)
		terminateProcessTree.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		child.stdout.destroy()
		child.stderr.destroy()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	function run() {
		return runScheduledCommand("approved command", {
			cwd: "/owned/workspace",
			signal: controller.signal,
			timeoutMs: 100,
		})
	}

	it("preserves separate UTF-8 streams and the already-approved shell command", async () => {
		const running = run()
		const unicode = Buffer.from("snowman: ☃")
		child.stdout.emit("data", unicode.subarray(0, unicode.length - 1))
		child.stdout.emit("data", unicode.subarray(unicode.length - 1))
		child.stderr.emit("data", Buffer.from("warning"))
		child.emit("close", 0, null)

		await expect(running).resolves.toEqual({ stdout: "snowman: ☃", stderr: "warning" })
		expect(spawn).toHaveBeenCalledWith("approved command", {
			cwd: "/owned/workspace",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: true,
			detached: process.platform !== "win32",
		})
		expect(terminateProcessTree).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("joins tree cleanup after cancellation even when a late close reports success", async () => {
		const cleanup = deferred()
		terminateProcessTree.mockReturnValue(cleanup.promise)
		let settled = false
		const running = run().finally(() => {
			settled = true
		})
		const rejected = expect(running).rejects.toMatchObject({
			message: "Command aborted during shutdown",
			stdout: "",
		})
		controller.abort()
		child.stdout.emit("data", Buffer.from("late output"))
		child.emit("close", 0, null)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		expect(terminateProcessTree).toHaveBeenCalledOnce()
		expect(terminateProcessTree).toHaveBeenCalledWith([123], {
			detachedProcessGroup: process.platform !== "win32" ? 123 : undefined,
			graceful: true,
		})
		cleanup.resolve()
		await rejected
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps the first deadline outcome and waits for process close after tree acknowledgement", async () => {
		let settled = false
		const running = run().finally(() => {
			settled = true
		})
		const rejected = expect(running).rejects.toThrow("Command timed out")
		await vi.advanceTimersByTimeAsync(100)
		expect(settled).toBe(false)
		controller.abort()
		child.emit("close", 0, null)
		await rejected
		expect(terminateProcessTree).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reports cleanup failures without converting a late successful close to success", async () => {
		terminateProcessTree.mockRejectedValue(new Error("tree termination denied"))
		const running = run()
		const rejected = expect(running).rejects.toThrow(
			"Command aborted during shutdown; process cleanup failed: Error: tree termination denied",
		)
		controller.abort()
		child.emit("close", 0, null)
		await rejected
	})

	it("bounds shutdown when process pipes never close", async () => {
		const running = run()
		const rejected = expect(running).rejects.toThrow("timed out waiting for the scheduled command process to close")
		controller.abort()
		await vi.advanceTimersByTimeAsync(11_000)
		await rejected
		expect(child.stdout.destroyed).toBe(true)
		expect(child.stderr.destroyed).toBe(true)
		child.emit("close", 0, null)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("terminates the owned tree when an output stream fails", async () => {
		const running = run()
		const rejected = expect(running).rejects.toThrow("output reader failed")
		child.stdout.emit("error", new Error("output reader failed"))
		child.emit("close", 0, null)
		await rejected
		expect(terminateProcessTree).toHaveBeenCalledOnce()
	})

	it("caps each raw stream before stopping a command that exceeds its buffer", async () => {
		const running = run()
		const rejected = expect(running).rejects.toMatchObject({
			message: "Command output exceeded its buffer limit",
			stdout: "x".repeat(2 * 1024 * 1024),
		})
		child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024, "x"))
		child.stdout.emit("data", Buffer.from("overflow"))
		child.emit("close", 0, null)
		await rejected
		expect(terminateProcessTree).toHaveBeenCalledOnce()
	})

	it("preserves nonzero exit codes and captured output", async () => {
		const running = run()
		const rejected = expect(running).rejects.toMatchObject({ code: 17, stderr: "failure" })
		child.stderr.emit("data", Buffer.from("failure"))
		child.emit("close", 17, null)
		await rejected
	})

	it("does not spawn a command after cancellation", async () => {
		controller.abort()
		await expect(run()).rejects.toThrow("Command aborted during shutdown")
		expect(spawn).not.toHaveBeenCalled()
	})

	it("handles cancellation that arrives while spawn is returning", async () => {
		spawn.mockImplementationOnce(() => {
			controller.abort()
			return child
		})
		const running = run()
		const rejected = expect(running).rejects.toThrow("Command aborted during shutdown")
		child.emit("close", 0, null)
		await rejected
		expect(terminateProcessTree).toHaveBeenCalledOnce()
	})

	it("keeps cleanup ownership when close arrives synchronously during termination setup", async () => {
		const cleanup = deferred()
		terminateProcessTree.mockImplementationOnce(() => {
			child.emit("close", 0, null)
			return cleanup.promise
		})
		let settled = false
		const running = run().finally(() => {
			settled = true
		})
		const rejected = expect(running).rejects.toThrow("Command aborted during shutdown")
		controller.abort()
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		cleanup.resolve()
		await rejected
	})

	it("releases timers after a spawn failure and tolerates its later close", async () => {
		child.pid = undefined
		const running = run()
		const rejected = expect(running).rejects.toMatchObject({ code: "ENOENT" })
		child.emit("error", Object.assign(new Error("shell unavailable"), { code: "ENOENT" }))
		child.emit("close", -1, null)
		await rejected
		expect(terminateProcessTree).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
