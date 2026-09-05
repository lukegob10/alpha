// npx vitest run integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts

const mockPid = 12345
const execFileMock = vitest.hoisted(() => vitest.fn())

vitest.mock("node:child_process", () => ({ execFile: execFileMock }))

vitest.mock("execa", () => {
	const mockKill = vitest.fn()
	const execa = vitest.fn((options: any) => {
		return (_template: TemplateStringsArray, ...args: any[]) => ({
			pid: mockPid,
			iterable: (_opts: any) =>
				(async function* () {
					yield "test output\n"
				})(),
			kill: mockKill,
		})
	})
	return { execa, ExecaError: class extends Error {} }
})

vitest.mock("ps-tree", () => ({
	default: vitest.fn((_: number, cb: any) => cb(null, [])),
}))

import { execa } from "execa"
import psTree from "ps-tree"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { BaseTerminal } from "../BaseTerminal"
import type { RooTerminal } from "../types"

describe("ExecaTerminalProcess", () => {
	let mockTerminal: RooTerminal
	let terminalProcess: ExecaTerminalProcess
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		originalEnv = { ...process.env }
		execFileMock.mockReset()
		execFileMock.mockImplementation((_file, _args, _options, callback) => {
			callback(null, "", "")
			return {}
		})
		vitest.mocked(psTree).mockReset()
		vitest.mocked(psTree).mockImplementation((_, callback) => callback(null, []))
		BaseTerminal.setExecaShellPath(undefined)
		mockTerminal = {
			provider: "execa",
			id: 1,
			busy: false,
			running: false,
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/cwd"),
			isClosed: vitest.fn().mockReturnValue(false),
			runCommand: vitest.fn(),
			setActiveStream: vitest.fn(),
			shellExecutionComplete: vitest.fn(),
			getProcessesWithOutput: vitest.fn().mockReturnValue([]),
			getUnretrievedOutput: vitest.fn().mockReturnValue(""),
			getLastCommand: vitest.fn().mockReturnValue(""),
			cleanCompletedProcessQueue: vitest.fn(),
		} as unknown as RooTerminal
		terminalProcess = new ExecaTerminalProcess(mockTerminal)
	})

	afterEach(() => {
		process.env = originalEnv
		vitest.clearAllMocks()
	})

	describe("UTF-8 encoding fix", () => {
		it("runs the original command and environment when optional pytest instrumentation cannot be represented", async () => {
			process.env.PYTHONPATH = "original python path"
			process.env.PYTEST_PLUGINS = "existing_plugin"
			process.env.PYTEST_ADDOPTS = "--ignore=tests/unit"
			const unavailable = vitest.fn()
			const outcome = vitest.fn()
			terminalProcess.on("shell_execution_complete", outcome)
			await terminalProcess.run(
				"python -m pytest",
				{
					pytestVerification: {
						executionId: "environment-unavailable",
						moduleName: "observer",
						moduleDirectory: "relative-path-is-not-a-host-descriptor",
						reportPath: "relative-report.json",
					},
				},
				unavailable,
			)
			expect(unavailable).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining("without verification evidence"),
			)
			expect(execa).toHaveBeenCalledTimes(1)
			expect(execa).toHaveBeenCalledWith(
				expect.objectContaining({
					env: expect.objectContaining({
						PYTHONPATH: "original python path",
						PYTEST_PLUGINS: "existing_plugin",
						PYTEST_ADDOPTS: "--ignore=tests/unit",
					}),
				}),
			)
			expect(terminalProcess.command).toBe("python -m pytest")
			expect(outcome).toHaveBeenCalledWith({ exitCode: 0 })
		})

		it("should set LANG and LC_ALL to en_US.UTF-8", async () => {
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: true,
					cwd: "/test/cwd",
					all: true,
					env: expect.objectContaining({
						LANG: "en_US.UTF-8",
						LC_ALL: "en_US.UTF-8",
					}),
				}),
			)
		})

		it("should preserve existing environment variables", async () => {
			process.env.EXISTING_VAR = "existing"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			const calledOptions = execaMock.mock.calls[0][0] as any
			expect(calledOptions.env.EXISTING_VAR).toBe("existing")
		})

		it("should override existing LANG and LC_ALL values", async () => {
			process.env.LANG = "C"
			process.env.LC_ALL = "POSIX"
			terminalProcess = new ExecaTerminalProcess(mockTerminal)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			const calledOptions = execaMock.mock.calls[0][0] as any
			expect(calledOptions.env.LANG).toBe("en_US.UTF-8")
			expect(calledOptions.env.LC_ALL).toBe("en_US.UTF-8")
		})

		it("should use execaShellPath when set", async () => {
			BaseTerminal.setExecaShellPath("/bin/bash")
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: "/bin/bash",
				}),
			)
		})

		it("should fall back to shell=true when execaShellPath is undefined", async () => {
			BaseTerminal.setExecaShellPath(undefined)
			await terminalProcess.run("echo test")
			const execaMock = vitest.mocked(execa)
			expect(execaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: true,
				}),
			)
		})
	})

	describe("basic functionality", () => {
		it("should create instance with terminal reference", () => {
			expect(terminalProcess).toBeInstanceOf(ExecaTerminalProcess)
			expect(terminalProcess.terminal).toBe(mockTerminal)
		})

		it("should emit shell_execution_complete with exitCode 0", async () => {
			const spy = vitest.fn()
			terminalProcess.on("shell_execution_complete", spy)
			await terminalProcess.run("echo test")
			expect(spy).toHaveBeenCalledWith({ exitCode: 0 })
		})

		it("does not report a cancelled command as a successful execution", async () => {
			const spy = vitest.fn()
			terminalProcess.on("shell_execution_complete", spy)
			;(terminalProcess as any).aborted = true

			await terminalProcess.run("echo test")

			expect(spy).toHaveBeenCalledWith({ exitCode: 137, signalName: "SIGKILL" })
			expect(spy).not.toHaveBeenCalledWith({ exitCode: 0 })
		})

		it("should emit completed event with full output", async () => {
			const spy = vitest.fn()
			terminalProcess.on("completed", spy)
			await terminalProcess.run("echo test")
			expect(spy).toHaveBeenCalledWith("test output\n")
		})

		it("should set and clear active stream", async () => {
			await terminalProcess.run("echo test")
			expect(mockTerminal.setActiveStream).toHaveBeenCalledWith(expect.any(Object), mockPid)
			expect(mockTerminal.setActiveStream).toHaveBeenLastCalledWith(undefined)
		})
	})

	describe("trimRetrievedOutput", () => {
		it("clears buffer when all output has been retrieved", () => {
			// Set up a scenario where all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 16 // Same as fullOutput.length

			// Access the protected method through type casting
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("does not clear buffer when there is unretrieved output", () => {
			// Set up a scenario where not all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 5 // Less than fullOutput.length
			;(terminalProcess as any).trimRetrievedOutput()

			// Buffer should NOT be cleared - there's still unretrieved content
			expect(terminalProcess["fullOutput"]).toBe("test output data")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(5)
		})

		it("does nothing when buffer is already empty", () => {
			terminalProcess["fullOutput"] = ""
			terminalProcess["lastRetrievedIndex"] = 0
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("clears buffer when lastRetrievedIndex exceeds fullOutput length", () => {
			// Edge case: index is greater than current length (could happen if output was modified)
			terminalProcess["fullOutput"] = "short"
			terminalProcess["lastRetrievedIndex"] = 100
			;(terminalProcess as any).trimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})
	})

	describe("abort", () => {
		let originalPlatform: PropertyDescriptor | undefined

		beforeEach(() => {
			originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32" })
		})

		afterEach(() => {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
		})

		it("uses native taskkill with tree and force flags on Windows", async () => {
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			await terminalProcess.abort()

			expect(execFileMock).toHaveBeenCalledOnce()
			expect(execFileMock.mock.calls[0].slice(0, 3)).toEqual([
				"taskkill.exe",
				["/PID", "12345", "/T", "/F"],
				{ windowsHide: true, timeout: 5_000 },
			])
			expect(psTree).not.toHaveBeenCalled()
		})

		it("returns one shared promise for repeated aborts", async () => {
			let finishTaskkill!: () => void
			execFileMock.mockImplementation((_file, _args, _options, callback) => {
				finishTaskkill = () => callback(null, "", "")
				return {}
			})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			const first = terminalProcess.abort()
			const second = terminalProcess.abort()

			expect(second).toBe(first)
			await vitest.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())
			finishTaskkill()
			await expect(first).resolves.toBeUndefined()
		})

		it("rejects a taskkill failure while the root process is still alive", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => true)
			const taskkillError = Object.assign(new Error("access denied"), { code: 1 })
			execFileMock.mockImplementation((_file, _args, _options, callback) => {
				callback(taskkillError, "", "")
				return {}
			})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).rejects.toThrow("taskkill failed for PID 12345: access denied")
				expect(processKill).toHaveBeenCalledWith(12_345, 0)
			} finally {
				warning.mockRestore()
				processKill.mockRestore()
			}
		})

		it("allows a failed process-tree termination to be retried", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockReturnValue(true)
			execFileMock
				.mockImplementationOnce((_file, _args, _options, callback) => {
					callback(Object.assign(new Error("access denied"), { code: 5 }), "", "")
					return {}
				})
				.mockImplementationOnce((_file, _args, _options, callback) => {
					callback(null, "", "")
					return {}
				})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).rejects.toThrow("access denied")
				await expect(terminalProcess.abort()).resolves.toBeUndefined()
				expect(execFileMock).toHaveBeenCalledTimes(2)
			} finally {
				warning.mockRestore()
				processKill.mockRestore()
			}
		})

		it("treats an already-exited taskkill root as successful", async () => {
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("not found"), { code: "ESRCH" })
			})
			execFileMock.mockImplementation((_file, _args, _options, callback) => {
				callback(Object.assign(new Error("not found"), { code: 128 }), "", "")
				return {}
			})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).resolves.toBeUndefined()
			} finally {
				processKill.mockRestore()
			}
		})

		it("keeps a missing taskkill executable observable", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("not found"), { code: "ESRCH" })
			})
			execFileMock.mockImplementation((_file, _args, _options, callback) => {
				callback(Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }), "", "")
				return {}
			})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).rejects.toThrow("spawn taskkill ENOENT")
			} finally {
				warning.mockRestore()
				processKill.mockRestore()
			}
		})

		it("keeps a taskkill timeout observable after the root exits", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("not found"), { code: "ESRCH" })
			})
			execFileMock.mockImplementation((_file, _args, _options, callback) => {
				callback(
					Object.assign(new Error("taskkill timed out"), {
						code: null,
						killed: true,
						signal: "SIGTERM",
					}),
					"",
					"",
				)
				return {}
			})
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).rejects.toThrow("taskkill timed out")
				expect(processKill).not.toHaveBeenCalled()
			} finally {
				warning.mockRestore()
				processKill.mockRestore()
			}
		})

		it("snapshots and kills POSIX descendants before their command shell", async () => {
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => true)
			Object.defineProperty(process, "platform", { value: "linux" })
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 23_456
			;(terminalProcess as any).pidUpdatePromise = Promise.resolve()
			vitest
				.mocked(psTree)
				.mockImplementation((pid, callback) =>
					callback(
						null,
						pid === 23_456 ? [{ PID: "34567", PPID: "23456", COMMAND: "powershell.exe", STAT: "" }] : [],
					),
				)

			try {
				await terminalProcess.abort()
				expect(processKill.mock.calls).toEqual([
					[34_567, "SIGKILL"],
					[23_456, "SIGKILL"],
					[12_345, "SIGKILL"],
				])
				expect(Math.max(...vitest.mocked(psTree).mock.invocationCallOrder)).toBeLessThan(
					Math.min(...processKill.mock.invocationCallOrder),
				)
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				processKill.mockRestore()
			}
		})

		it("keeps POSIX process-tree discovery failures observable", async () => {
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => true)
			Object.defineProperty(process, "platform", { value: "linux" })
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345
			vitest.mocked(psTree).mockImplementation((_pid, callback) => callback(new Error("ps failed"), []))

			try {
				await expect(terminalProcess.abort()).rejects.toThrow(
					"Failed to get process tree for PID 12345: ps failed",
				)
				expect(processKill).toHaveBeenCalledWith(12_345, "SIGKILL")
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				processKill.mockRestore()
			}
		})

		it("bounds POSIX process-tree discovery", async () => {
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => true)
			vitest.useFakeTimers()
			Object.defineProperty(process, "platform", { value: "linux" })
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345
			vitest.mocked(psTree).mockImplementation(() => undefined as any)

			try {
				const abort = terminalProcess.abort()
				const rejected = expect(abort).rejects.toThrow("Timed out discovering the process tree for PID 12345")
				await vitest.advanceTimersByTimeAsync(5_000)
				await rejected
				expect(processKill).toHaveBeenCalledWith(12_345, "SIGKILL")
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				vitest.useRealTimers()
				processKill.mockRestore()
			}
		})

		it("attempts every known POSIX root when an earlier kill fails", async () => {
			const processKill = vitest
				.spyOn(process, "kill")
				.mockImplementationOnce(() => {
					throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
				})
				.mockImplementation(() => true)
			Object.defineProperty(process, "platform", { value: "linux" })
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 23_456
			vitest.mocked(psTree).mockImplementation((_pid, callback) => callback(null, []))

			try {
				await expect(terminalProcess.abort()).rejects.toThrow("Failed to kill process 23456")
				expect(processKill.mock.calls).toEqual([
					[23_456, "SIGKILL"],
					[12_345, "SIGKILL"],
				])
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				processKill.mockRestore()
			}
		})

		it("bounds the optional POSIX PID refinement before abort discovery", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => true)
			vitest.useFakeTimers()
			Object.defineProperty(process, "platform", { value: "linux" })
			let releaseStream!: () => void
			const subprocess = {
				pid: 12_345,
				iterable: () =>
					(async function* () {
						yield await new Promise<string>((resolve) => (releaseStream = () => resolve("")))
					})(),
				kill: vitest.fn(),
			}
			vitest.mocked(execa).mockImplementationOnce((() => () => subprocess) as any)
			let discoveryCalls = 0
			vitest.mocked(psTree).mockImplementation((_pid, callback) => {
				discoveryCalls++
				if (discoveryCalls > 1) callback(null, [])
			})

			const run = terminalProcess.run("long-running-command")
			const abort = terminalProcess.abort()

			try {
				await vitest.advanceTimersByTimeAsync(1_100)
				await expect(abort).resolves.toBeUndefined()
				expect(discoveryCalls).toBe(2)
				releaseStream()
				await run
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				vitest.useRealTimers()
				warning.mockRestore()
				processKill.mockRestore()
			}
		})

		it("keeps non-benign POSIX kill failures observable", async () => {
			const warning = vitest.spyOn(console, "warn").mockImplementation(() => undefined)
			const processKill = vitest.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
			})
			Object.defineProperty(process, "platform", { value: "linux" })
			;(terminalProcess as any).subprocess = { pid: 12_345 }
			;(terminalProcess as any).pid = 12_345

			try {
				await expect(terminalProcess.abort()).rejects.toThrow(
					"Failed to kill process 12345: operation not permitted",
				)
			} finally {
				Object.defineProperty(process, "platform", { value: "win32" })
				warning.mockRestore()
				processKill.mockRestore()
			}
		})
	})
})
