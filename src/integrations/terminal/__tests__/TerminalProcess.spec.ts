// npx vitest run src/integrations/terminal/__tests__/TerminalProcess.spec.ts

import * as vscode from "vscode"
import fs from "fs/promises"
import path from "path"
import pWaitFor from "p-wait-for"

import { mergePromise } from "../mergePromise"
import { TerminalProcess } from "../TerminalProcess"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"
import type { RooTerminalCallbacks } from "../types"

class TestTerminalProcess extends TerminalProcess {
	public callTrimRetrievedOutput(): void {
		this.trimRetrievedOutput()
	}
}

vi.mock("execa", () => ({
	execa: vi.fn(),
}))
vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

describe("TerminalProcess", () => {
	let terminalProcess: TestTerminalProcess
	let mockTerminal: any
	type TestVscodeTerminal = vscode.Terminal & {
		shellIntegration: {
			executeCommand: any
		}
	}
	let mockTerminalInfo: Terminal
	let mockExecution: any
	let mockStream: AsyncIterableIterator<string>

	beforeEach(() => {
		// Create properly typed mock terminal
		mockTerminal = {
			shellIntegration: {
				executeCommand: vi.fn(),
			},
			name: "Alpha",
			processId: Promise.resolve(123),
			creationOptions: {},
			exitStatus: undefined,
			state: { isInteractedWith: true },
			dispose: vi.fn(),
			hide: vi.fn(),
			show: vi.fn(),
			sendText: vi.fn(),
		} as unknown as TestVscodeTerminal

		mockTerminalInfo = new Terminal(1, mockTerminal, "./")

		// Create a process for testing
		terminalProcess = new TestTerminalProcess(mockTerminalInfo)

		TerminalRegistry["terminals"].push(mockTerminalInfo)

		// Reset event listeners
		terminalProcess.removeAllListeners()
	})

	describe("run", () => {
		it("does not launch when cancelled while the verification helper is being written", async () => {
			mockTerminal.state.shell = "pwsh"
			let finishPreparation!: () => void
			const write = vi.spyOn(fs, "writeFile").mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishPreparation = resolve
					}),
			)
			const completed = vi.fn()
			const outcome = vi.fn()
			terminalProcess.on("completed", completed)
			terminalProcess.on("shell_execution_complete", outcome)
			try {
				const running = terminalProcess.run("python -m pytest", {
					pytestVerification: {
						executionId: "cancel-during-prepare",
						moduleName: "alpha_receipt_cancel",
						moduleDirectory: path.resolve("receipt-temp"),
						reportPath: path.resolve("receipt-temp/report.json"),
					},
				})
				expect(write).toHaveBeenCalledTimes(1)
				terminalProcess.abort()
				terminalProcess.abort()
				expect(completed).not.toHaveBeenCalled()
				finishPreparation()
				await running
				expect(mockTerminal.shellIntegration.executeCommand).not.toHaveBeenCalled()
				expect(mockTerminal.sendText).not.toHaveBeenCalled()
				expect(outcome).toHaveBeenCalledExactlyOnceWith({ exitCode: 130, signalName: "SIGINT" })
				expect(completed).toHaveBeenCalledExactlyOnceWith("")
			} finally {
				write.mockRestore()
			}
		})

		it("does not submit a command cancelled before shell integration becomes available", async () => {
			const outcome = vi.fn()
			terminalProcess.on("shell_execution_complete", outcome)
			terminalProcess.abort()
			await terminalProcess.run("python -m pytest")
			expect(mockTerminal.shellIntegration.executeCommand).not.toHaveBeenCalled()
			expect(mockTerminal.sendText).not.toHaveBeenCalled()
			expect(outcome).toHaveBeenCalledExactlyOnceWith({ exitCode: 130, signalName: "SIGINT" })
		})

		it("removes pending stream resources when command submission throws", async () => {
			vi.useFakeTimers()
			try {
				mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
					throw new Error("submission failed")
				})
				await expect(terminalProcess.run("python -m pytest")).rejects.toThrow("submission failed")
				expect(vi.getTimerCount()).toBe(0)
				expect(terminalProcess.listenerCount("stream_available")).toBe(0)
				expect(terminalProcess.listenerCount("shell_execution_complete")).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("handles shell integration commands correctly", async () => {
			let lines: string[] = []

			terminalProcess.on("completed", (output) => {
				if (output) {
					lines = output.split("\n")
				}
			})

			// Mock stream data with shell integration sequences.
			mockStream = (async function* () {
				yield "\x1b]633;C\x07" // The first chunk contains the command start sequence with bell character.
				yield "Initial output\n"
				yield "More output\n"
				yield "Final output"
				yield "\x1b]633;D\x07" // The last chunk contains the command end sequence with bell character.
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockExecution = {
				read: vi.fn().mockReturnValue(mockStream),
			}

			mockTerminal.shellIntegration.executeCommand.mockReturnValue(mockExecution)

			const runPromise = terminalProcess.run("test command")
			terminalProcess.emit("stream_available", mockStream)
			await runPromise

			expect(lines).toEqual(["Initial output", "More output", "Final output"])
			expect(terminalProcess.isHot).toBe(false)
		})

		it("handles terminals without shell integration", async () => {
			// Temporarily suppress the expected console.warn for this test
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// Create a terminal without shell integration
			const noShellTerminal = {
				sendText: vi.fn(),
				shellIntegration: undefined,
				name: "No Shell Terminal",
				processId: Promise.resolve(456),
				creationOptions: {},
				exitStatus: undefined,
				state: { isInteractedWith: true },
				dispose: vi.fn(),
				hide: vi.fn(),
				show: vi.fn(),
			} as unknown as vscode.Terminal

			// Create new terminal info with the no-shell terminal
			const noShellTerminalInfo = new Terminal(2, noShellTerminal, "./")

			// Create new process with the no-shell terminal
			const noShellProcess = new TerminalProcess(noShellTerminalInfo)

			// Set up event listeners to verify events are emitted
			const eventPromises = Promise.all([
				new Promise<void>((resolve) =>
					noShellProcess.once("no_shell_integration", (_message: string) => resolve()),
				),
				new Promise<void>((resolve) => noShellProcess.once("completed", (_output?: string) => resolve())),
				new Promise<void>((resolve) => noShellProcess.once("continue", resolve)),
			])

			// Run command and wait for all events
			await noShellProcess.run("test command")
			await eventPromises

			// Verify sendText was called with the command
			expect(noShellTerminal.sendText).toHaveBeenCalledWith("test command", true)

			// Restore the original console.warn
			consoleWarnSpy.mockRestore()
		})

		it("sets hot state for compiling commands", async () => {
			let lines: string[] = []

			terminalProcess.on("completed", (output) => {
				if (output) {
					lines = output.split("\n")
				}
			})

			const completePromise = new Promise<void>((resolve) => {
				terminalProcess.on("shell_execution_complete", () => resolve())
			})

			mockStream = (async function* () {
				yield "\x1b]633;C\x07" // The first chunk contains the command start sequence with bell character.
				yield "compiling...\n"
				yield "still compiling...\n"
				yield "done"
				yield "\x1b]633;D\x07" // The last chunk contains the command end sequence with bell character.
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()

			mockTerminal.shellIntegration.executeCommand.mockReturnValue({
				read: vi.fn().mockReturnValue(mockStream),
			})

			const runPromise = terminalProcess.run("npm run build")
			terminalProcess.emit("stream_available", mockStream)

			expect(terminalProcess.isHot).toBe(true)
			await runPromise

			expect(lines).toEqual(["compiling...", "still compiling...", "done"])

			await completePromise
			expect(terminalProcess.isHot).toBe(false)
		})
	})

	describe("terminal execution errors", () => {
		const callbacks = (): RooTerminalCallbacks => ({
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
			onNoShellIntegration: vi.fn(),
		})

		it("propagates process failures without reporting a shell integration timeout", async () => {
			const failure = new Error("stream reader failed")
			const run = vi.spyOn(TerminalProcess.prototype, "run").mockRejectedValueOnce(failure)
			const observed = callbacks()
			try {
				await expect(mockTerminalInfo.runCommand("python -m pytest", observed)).rejects.toBe(failure)
				expect(observed.onNoShellIntegration).not.toHaveBeenCalled()
				expect(mockTerminalInfo.busy).toBe(false)
				expect(mockTerminalInfo.running).toBe(false)
			} finally {
				run.mockRestore()
			}
		})

		it("retains the shell integration diagnostic when integration itself never becomes available", async () => {
			vi.mocked(pWaitFor).mockRejectedValueOnce(new Error("integration timed out"))
			const run = vi.spyOn(TerminalProcess.prototype, "run")
			const observed = callbacks()
			try {
				await mockTerminalInfo.runCommand("python -m pytest", observed)
				expect(run).not.toHaveBeenCalled()
				expect(observed.onNoShellIntegration).toHaveBeenCalledTimes(1)
			} finally {
				run.mockRestore()
			}
		})

		it("keeps a physically running terminal reserved when its output reader fails", async () => {
			const run = vi.spyOn(TerminalProcess.prototype, "run").mockImplementationOnce(async () => {
				mockTerminalInfo.running = true
				throw new Error("active stream failed")
			})
			try {
				await expect(mockTerminalInfo.runCommand("python -m pytest", callbacks())).rejects.toThrow(
					"active stream failed",
				)
				expect(mockTerminalInfo.running).toBe(true)
				expect(mockTerminalInfo.busy).toBe(true)
			} finally {
				run.mockRestore()
			}
		})

		it("can still cancel a physical command after its output reader has failed", async () => {
			mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
				mockTerminalInfo.setActiveStream(
					(async function* () {
						yield "\x1b]633;C\x07output before failure\n"
						throw new Error("active stream failed")
					})(),
				)
			})
			const running = mockTerminalInfo.runCommand("python -m pytest", callbacks())
			await expect(running).rejects.toThrow("active stream failed")
			expect(running.isSettled).toBe(true)
			expect(mockTerminalInfo.running).toBe(true)
			running.abort()
			running.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledExactlyOnceWith("\x03")
			mockTerminalInfo.shellExecutionComplete({ exitCode: 130, signalName: "SIGINT" })
		})

		it("does not interrupt the shell after the physical command has completed", async () => {
			mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
				mockTerminalInfo.setActiveStream(
					(async function* () {
						yield "\x1b]633;C\x07completed output\n"
						mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
					})(),
				)
			})
			const running = mockTerminalInfo.runCommand("python -m pytest", callbacks())
			await running
			expect(running.isSettled).toBe(true)
			expect(mockTerminalInfo.running).toBe(false)
			running.abort()
			expect(mockTerminal.sendText).not.toHaveBeenCalled()
		})
	})

	describe("continue", () => {
		it("stops listening and emits continue event", () => {
			const continueSpy = vi.fn()
			terminalProcess.on("continue", continueSpy)

			terminalProcess.continue()

			expect(continueSpy).toHaveBeenCalled()
			expect(terminalProcess["isListening"]).toBe(false)
		})
	})

	describe("getUnretrievedOutput", () => {
		it("returns and clears unretrieved output", () => {
			terminalProcess["fullOutput"] = `\x1b]633;C\x07previous\nnew output\x1b]633;D\x07`
			terminalProcess["lastRetrievedIndex"] = 17 // After "previous\n"

			const unretrieved = terminalProcess.getUnretrievedOutput()
			expect(unretrieved).toBe("new output")

			expect(terminalProcess["lastRetrievedIndex"]).toBe(terminalProcess["fullOutput"].length - "previous".length)
		})
	})

	describe("interpretExitCode", () => {
		it("handles undefined exit code", () => {
			const result = TerminalProcess.interpretExitCode(undefined)
			expect(result).toEqual({ exitCode: undefined })
		})

		it("handles normal exit codes (0-128)", () => {
			const result = TerminalProcess.interpretExitCode(0)
			expect(result).toEqual({ exitCode: 0 })

			const result2 = TerminalProcess.interpretExitCode(1)
			expect(result2).toEqual({ exitCode: 1 })

			const result3 = TerminalProcess.interpretExitCode(128)
			expect(result3).toEqual({ exitCode: 128 })
		})

		it("interprets signal exit codes (>128)", () => {
			// SIGTERM (15) -> 128 + 15 = 143
			const result = TerminalProcess.interpretExitCode(143)
			expect(result).toEqual({
				exitCode: 143,
				signal: 15,
				signalName: "SIGTERM",
				coreDumpPossible: false,
			})

			// SIGSEGV (11) -> 128 + 11 = 139
			const result2 = TerminalProcess.interpretExitCode(139)
			expect(result2).toEqual({
				exitCode: 139,
				signal: 11,
				signalName: "SIGSEGV",
				coreDumpPossible: true,
			})
		})

		it("handles unknown signals", () => {
			const result = TerminalProcess.interpretExitCode(255)
			expect(result).toEqual({
				exitCode: 255,
				signal: 127,
				signalName: "Unknown Signal (127)",
				coreDumpPossible: false,
			})
		})
	})

	describe("trimRetrievedOutput", () => {
		it("clears buffer when all output has been retrieved", () => {
			// Set up a scenario where all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 16 // Same as fullOutput.length

			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("does not clear buffer when there is unretrieved output", () => {
			// Set up a scenario where not all output has been retrieved
			terminalProcess["fullOutput"] = "test output data"
			terminalProcess["lastRetrievedIndex"] = 5 // Less than fullOutput.length
			terminalProcess.callTrimRetrievedOutput()

			// Buffer should NOT be cleared - there's still unretrieved content
			expect(terminalProcess["fullOutput"]).toBe("test output data")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(5)
		})

		it("does nothing when buffer is already empty", () => {
			terminalProcess["fullOutput"] = ""
			terminalProcess["lastRetrievedIndex"] = 0
			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})

		it("clears buffer when lastRetrievedIndex exceeds fullOutput length", () => {
			// Edge case: index is greater than current length (could happen if output was modified)
			terminalProcess["fullOutput"] = "short"
			terminalProcess["lastRetrievedIndex"] = 100
			terminalProcess.callTrimRetrievedOutput()

			expect(terminalProcess["fullOutput"]).toBe("")
			expect(terminalProcess["lastRetrievedIndex"]).toBe(0)
		})
	})

	describe("mergePromise", () => {
		it("merges promise methods with terminal process", async () => {
			const process = new TerminalProcess(mockTerminalInfo)
			const promise = Promise.resolve()

			const merged = mergePromise(process, promise)

			expect(merged).toHaveProperty("then")
			expect(merged).toHaveProperty("catch")
			expect(merged).toHaveProperty("finally")
			expect(merged instanceof TerminalProcess).toBe(true)

			await expect(merged).resolves.toBeUndefined()
		})
	})
})
