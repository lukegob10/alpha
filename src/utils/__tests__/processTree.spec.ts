import { terminateProcessTree } from "../processTree"
import type { MockInstance } from "vitest"

const execFile = vi.hoisted(() => vi.fn())
const psTree = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", () => ({ execFile }))
vi.mock("ps-tree", () => ({ default: psTree }))

describe("owned detached POSIX process groups", () => {
	let platform: PropertyDescriptor | undefined
	let kill: MockInstance<typeof process.kill>

	beforeEach(() => {
		vi.useFakeTimers()
		vi.stubEnv("SystemRoot", "C:\\Windows")
		platform = Object.getOwnPropertyDescriptor(process, "platform")
		Object.defineProperty(process, "platform", { value: "linux" })
		kill = vi.spyOn(process, "kill").mockReturnValue(true)
		psTree.mockReset().mockImplementation((_pid, callback) => callback(null, []))
		execFile.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, "", ""))
	})

	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform)
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		vi.useRealTimers()
	})

	it("rejects unsafe PIDs and groups outside the captured owned roots", async () => {
		await expect(terminateProcessTree([0])).rejects.toThrow("Invalid owned process PID")
		await expect(terminateProcessTree([-123])).rejects.toThrow("Invalid owned process PID")
		await expect(terminateProcessTree([123], { detachedProcessGroup: 456 })).rejects.toThrow(
			"Detached process group must be an owned root",
		)
		expect(kill).not.toHaveBeenCalled()
		expect(execFile).not.toHaveBeenCalled()
		expect(psTree).not.toHaveBeenCalled()
	})

	it("exposes unverifiable Windows orphan cleanup while retaining explicit terminal missing-root compatibility", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		kill.mockImplementation(() => {
			throw Object.assign(new Error("not found"), { code: "ESRCH" })
		})
		execFile.mockImplementation((_file, _args, _options, callback) => {
			callback(Object.assign(new Error("root process not found"), { code: 128 }), "", "")
		})
		await expect(terminateProcessTree([123])).rejects.toThrow(
			"Could not verify process-tree cleanup for exited Windows root PID 123",
		)
		await expect(terminateProcessTree([123], { allowMissingWindowsRoots: true })).resolves.toBeUndefined()
		expect(execFile).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\taskkill.exe",
			["/PID", "123", "/T", "/F"],
			expect.anything(),
			expect.any(Function),
		)
	})

	it("rejects a missing or relative Windows system root without searching PATH", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		vi.stubEnv("SystemRoot", undefined)
		vi.stubEnv("windir", undefined)
		await expect(terminateProcessTree([123])).rejects.toThrow("Windows system root is unavailable")
		vi.stubEnv("SystemRoot", ".\\attacker-controlled")
		await expect(terminateProcessTree([123])).rejects.toThrow("Windows system root is unavailable")
		expect(execFile).not.toHaveBeenCalled()
	})

	it("escalates the original group after a TERM-aware parent exits and observes newly orphaned members", async () => {
		psTree.mockImplementation((_pid, callback) => callback(null, [{ PID: "124" }]))
		kill.mockImplementation((pid) => {
			if (pid > 0) throw Object.assign(new Error("parent and old child exited"), { code: "ESRCH" })
			return true
		})
		execFile
			.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, "125 123 R\n999 999 R\n", "")
			})
			.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, "125 123 Z\n999 999 R\n", "")
			})
		let settled = false
		const stopping = terminateProcessTree([123], { detachedProcessGroup: 123, graceful: true }).then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(kill.mock.calls).toEqual([[-123, "SIGTERM"]])
		await vi.advanceTimersByTimeAsync(100)
		expect(settled).toBe(false)
		expect(kill.mock.calls).toEqual([
			[-123, "SIGTERM"],
			[124, "SIGKILL"],
			[123, "SIGKILL"],
			[-123, "SIGKILL"],
		])
		expect(execFile).toHaveBeenCalledWith(
			"ps",
			["-eo", "pid=,pgid=,stat="],
			expect.objectContaining({ timeout: 5_000 }),
			expect.any(Function),
		)
		await vi.advanceTimersByTimeAsync(25)
		await stopping
		expect(settled).toBe(true)
		expect(kill).not.toHaveBeenCalledWith(999, expect.anything())
		expect(vi.getTimerCount()).toBe(0)
	})

	it("preserves group signal failures while attempting all known process targets", async () => {
		kill.mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("group permission denied"), { code: "EPERM" })
			return true
		})
		await expect(terminateProcessTree([123], { detachedProcessGroup: 123 })).rejects.toThrow(
			"Failed to signal owned process group 123",
		)
		expect(kill).toHaveBeenCalledWith(123, "SIGKILL")
	})

	it.each([false, true])("confirms a Darwin zombie-only group after EPERM (graceful: %s)", async (graceful) => {
		Object.defineProperty(process, "platform", { value: "darwin" })
		psTree.mockImplementation((_pid, callback) => callback(null, [{ PID: "124" }]))
		kill.mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("no signalable group members"), { code: "EPERM" })
			return true
		})
		execFile.mockImplementation((_file, _args, _options, callback) => {
			callback(null, "123 123 Z\n124 123 Z\n999 999 R\n", "")
		})
		await expect(terminateProcessTree([123], { detachedProcessGroup: 123, graceful })).resolves.toBeUndefined()
		expect(kill.mock.calls).toEqual([
			...(graceful ? [[-123, "SIGTERM"]] : []),
			[124, "SIGKILL"],
			[123, "SIGKILL"],
			[-123, "SIGKILL"],
		])
		expect(execFile).toHaveBeenCalledExactlyOnceWith(
			"ps",
			["-eo", "pid=,pgid=,stat="],
			expect.objectContaining({ timeout: 5_000 }),
			expect.any(Function),
		)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("retains Darwin EPERM when an owned group still has a living member", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" })
		kill.mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("group permission denied"), { code: "EPERM" })
			return true
		})
		execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "124 123 R\n", ""))
		const rejected = expect(terminateProcessTree([123], { detachedProcessGroup: 123 })).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "Failed to signal owned process group 123" }),
				expect.objectContaining({ message: "Timed out waiting for the terminated process tree to stop" }),
			],
		})
		await vi.advanceTimersByTimeAsync(5_000)
		await rejected
		expect(vi.getTimerCount()).toBe(0)
	})

	it("retains Darwin EPERM when physical process state cannot be inspected", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" })
		kill.mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("group permission denied"), { code: "EPERM" })
			return true
		})
		execFile.mockImplementation((_file, _args, _options, callback) => {
			callback(Object.assign(new Error("ps unavailable"), { code: "EACCES" }), "", "")
		})
		await expect(terminateProcessTree([123], { detachedProcessGroup: 123 })).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "Failed to signal owned process group 123" }),
				expect.objectContaining({ message: "Failed to inspect terminated process-tree state" }),
			],
		})
	})

	it("bounds settlement of a group whose surviving member does not stop", async () => {
		execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "124 123 R\n", ""))
		const rejected = expect(terminateProcessTree([123], { detachedProcessGroup: 123 })).rejects.toThrow(
			"Timed out waiting for the terminated process tree to stop",
		)
		await vi.advanceTimersByTimeAsync(5_000)
		await rejected
		expect(vi.getTimerCount()).toBe(0)
	})
})
