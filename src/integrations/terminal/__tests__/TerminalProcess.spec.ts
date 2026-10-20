// npx vitest run src/integrations/terminal/__tests__/TerminalProcess.spec.ts

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import type { MockInstance } from "vitest"

import { mergePromise } from "../mergePromise"
import { TerminalProcess } from "../TerminalProcess"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"
import type { AlphaTerminalCallbacks } from "../types"
import { t } from "../../../i18n"

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
	let nextTerminalId = 1
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

		mockTerminalInfo = new Terminal(nextTerminalId++, mockTerminal, "./")

		// Create a process for testing
		terminalProcess = new TestTerminalProcess(mockTerminalInfo)

		TerminalRegistry["terminals"].push(mockTerminalInfo)

		// Reset event listeners
		terminalProcess.removeAllListeners()
	})
	afterEach(() => {
		TerminalRegistry["terminals"] = TerminalRegistry["terminals"].filter(
			(terminal) => terminal !== mockTerminalInfo,
		)
	})

	describe("run", () => {
		it.each(
			["\x1b]633;C\x07", "\x1b]133;C\x07"].flatMap((marker) =>
				Array.from({ length: marker.length - 1 }, (_, index) => ({ marker, split: index + 1 })),
			),
		)("preserves output when the command start marker is split at $split in $marker", async ({ marker, split }) => {
			const completed = vi.fn()
			const integrationFailure = vi.fn()
			terminalProcess.on("completed", completed)
			terminalProcess.on("no_shell_integration", integrationFailure)
			const stream = (async function* () {
				yield "shell prompt" + marker.slice(0, split)
				yield marker.slice(split) + "command output\n"
				terminalProcess.emit("shell_execution_complete", { exitCode: 0 })
			})()
			const run = terminalProcess.run("echo test")
			terminalProcess.emit("stream_available", stream)
			await run
			expect(integrationFailure).not.toHaveBeenCalled()
			expect(completed).toHaveBeenCalledExactlyOnceWith("command output\n")
		})

		it("does not submit a command cancelled before shell integration becomes available", async () => {
			const outcome = vi.fn()
			terminalProcess.on("shell_execution_complete", outcome)
			terminalProcess.abort()
			await terminalProcess.run("echo test")
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
				await expect(terminalProcess.run("echo test")).rejects.toThrow("submission failed")
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
		let closeTerminal!: (terminal: vscode.Terminal) => void
		let closeRegistration: MockInstance<typeof vscode.window.onDidCloseTerminal>
		beforeAll(() => {
			closeRegistration = vi.spyOn(vscode.window, "onDidCloseTerminal").mockImplementation((listener) => {
				closeTerminal = listener
				return { dispose: vi.fn() }
			})
			TerminalRegistry.initialize()
		})
		afterAll(() => {
			TerminalRegistry.cleanup()
			closeRegistration.mockRestore()
		})

		const callbacks = (): AlphaTerminalCallbacks => ({
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
			onNoShellIntegration: vi.fn(),
		})

		function barrier() {
			let release!: () => void
			const promise = new Promise<void>((resolve) => (release = resolve))
			return { promise, release }
		}

		it("fails a closed terminal while waiting for its output stream and clears pending resources", async () => {
			vi.useFakeTimers()
			const submitted = barrier()
			const closeEntered = barrier()
			const finishClose = barrier()
			const observed = {
				...callbacks(),
				onOutputClosed: vi.fn(async () => {
					closeEntered.release()
					await finishClose.promise
				}),
			}
			mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => submitted.release())
			const running = mockTerminalInfo.runCommand("echo test", observed)
			const outcome = running.then(
				() => ({ status: "success" as const }),
				(error: unknown) => ({ status: "error" as const, error }),
			)
			if (!(running instanceof TerminalProcess)) throw new Error("Expected a VS Code terminal process")
			try {
				await submitted.promise
				mockTerminal.exitStatus = { code: 0 }
				closeTerminal(mockTerminal)
				expect(running.isSettled).toBe(true)
				expect(await outcome).toEqual({
					status: "error",
					error: expect.objectContaining({ message: t("common:errors.command_terminal_closed") }),
				})
				await closeEntered.promise
				expect(running.isOutputFinalized).toBe(false)
				expect(observed.onCompleted).not.toHaveBeenCalled()
				expect(observed.onShellExecutionComplete).not.toHaveBeenCalled()
				expect(running.listenerCount("stream_available")).toBe(0)
				expect(running.listenerCount("shell_execution_complete")).toBe(0)
				expect(mockTerminalInfo.running).toBe(false)
				expect(mockTerminalInfo.busy).toBe(false)
				expect(mockTerminalInfo.process).toBeUndefined()
				finishClose.release()
				await running.finalizeOutput()
				expect(running.isOutputFinalized).toBe(true)
				expect(observed.onOutputClosed).toHaveBeenCalledOnce()
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				finishClose.release()
				mockTerminalInfo.notifyTerminalClosed()
				await running.finalizeOutput()
				vi.useRealTimers()
			}
		})

		it.each([false, true])(
			"settles a closed terminal with a stalled reader (shell exit already reported: %s)",
			async (reportedExit) => {
				let finishRead!: (value: IteratorResult<string>) => void
				let readerWaiting!: () => void
				const waiting = new Promise<void>((resolve) => (readerWaiting = resolve))
				const pendingRead = new Promise<IteratorResult<string>>((resolve) => (finishRead = resolve))
				const returnRequested = barrier()
				const closeEntered = barrier()
				const finishClose = barrier()
				const iterator = {
					next: vi
						.fn()
						.mockResolvedValueOnce({ done: false, value: "\x1b]633;C\x07output\n" })
						.mockImplementationOnce(() => {
							readerWaiting()
							return pendingRead
						}),
					return: vi.fn(async () => {
						returnRequested.release()
						return { done: true as const, value: undefined }
					}),
				}
				mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
					mockTerminalInfo.setActiveStream({ [Symbol.asyncIterator]: () => iterator })
				})
				const observed = {
					...callbacks(),
					onOutputClosed: vi.fn(async () => {
						closeEntered.release()
						await finishClose.promise
					}),
				}
				const running = mockTerminalInfo.runCommand("echo test", observed)
				const outcome = running.then(
					() => ({ status: "success" as const }),
					(error: unknown) => ({ status: "error" as const, error }),
				)
				if (!(running instanceof TerminalProcess)) throw new Error("Expected a VS Code terminal process")
				try {
					await waiting
					const error = vi.fn()
					running.on("error", error)
					if (reportedExit) mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
					mockTerminal.exitStatus = { code: 0 }
					closeTerminal(mockTerminal)
					expect(running.isSettled).toBe(true)
					expect(await outcome).toEqual({
						status: "error",
						error: expect.objectContaining({
							message: t(
								reportedExit
									? "common:errors.command_terminal_closed_output"
									: "common:errors.command_terminal_closed",
							),
						}),
					})
					await closeEntered.promise
					await returnRequested.promise
					expect(running.isOutputFinalized).toBe(false)
					closeTerminal(mockTerminal)
					finishRead({ done: false, value: "late output\n" })
					await pendingRead
					mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
					finishClose.release()
					await running.finalizeOutput()
					expect(error).toHaveBeenCalledOnce()
					expect(iterator.return).toHaveBeenCalledOnce()
					expect(observed.onCompleted).not.toHaveBeenCalled()
					expect(observed.onShellExecutionComplete).toHaveBeenCalledTimes(reportedExit ? 1 : 0)
					expect(observed.onOutputClosed).toHaveBeenCalledOnce()
					expect(running.isOutputFinalized).toBe(true)
					expect(running.isHot).toBe(false)
					expect(mockTerminalInfo.running).toBe(false)
					expect(mockTerminalInfo.busy).toBe(false)
					expect(mockTerminalInfo.process).toBeUndefined()
				} finally {
					finishRead({ done: true, value: undefined })
					finishClose.release()
					mockTerminalInfo.notifyTerminalClosed()
					await running.finalizeOutput()
				}
			},
		)

		it.each(["fulfilled", "rejected"] as const)(
			"settles the public command after host close while a completed observer is %s",
			async (observerOutcome) => {
				const completedEntered = barrier()
				const finishCompleted = barrier()
				const closeEntered = barrier()
				const finishClose = barrier()
				const observerFailure = new Error("completed observer failed after terminal close")
				const observed = {
					...callbacks(),
					onCompleted: vi.fn(async () => {
						completedEntered.release()
						await finishCompleted.promise
						if (observerOutcome === "rejected") throw observerFailure
					}),
					onOutputClosed: vi.fn(async () => {
						closeEntered.release()
						await finishClose.promise
					}),
				}
				mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
					mockTerminalInfo.setActiveStream(
						(async function* () {
							yield "\x1b]633;C\x07complete output\n\x1b]633;D\x07"
							mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
						})(),
					)
				})
				const running = mockTerminalInfo.runCommand("echo test", observed)
				if (!(running instanceof TerminalProcess)) throw new Error("Expected a VS Code terminal process")
				const settled = vi.fn()
				void running.then(
					() => settled({ status: "fulfilled" }),
					(error: unknown) => settled({ status: "rejected", error }),
				)
				const errors = vi.fn()
				running.on("error", errors)
				const continued = vi.fn()
				running.on("continue", continued)
				try {
					await completedEntered.promise
					expect(running.isSettled).toBe(true)
					expect(running.isOutputFinalized).toBe(false)
					expect(continued).not.toHaveBeenCalled()
					expect(settled).not.toHaveBeenCalled()
					mockTerminal.exitStatus = { code: 0 }
					closeTerminal(mockTerminal)
					expect(settled).not.toHaveBeenCalled()
					expect(running.listenerCount("continue")).toBe(0)
					finishCompleted.release()
					// The adapter enters this finalizer only after the real run has unwound.
					await closeEntered.promise
					expect(settled).toHaveBeenCalledExactlyOnceWith(
						observerOutcome === "fulfilled"
							? { status: "fulfilled" }
							: { status: "rejected", error: observerFailure },
					)
					if (observerOutcome === "rejected") expect(settled.mock.calls[0][0].error).toBe(observerFailure)
					expect(errors).not.toHaveBeenCalled()
					expect(observed.onCompleted).toHaveBeenCalledExactlyOnceWith("complete output\n", running)
					expect(observed.onShellExecutionComplete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 }, running)
					expect(running.isOutputFinalized).toBe(false)
					expect(mockTerminalInfo.running).toBe(false)
					finishClose.release()
					await running.finalizeOutput()
					closeTerminal(mockTerminal)
					expect(settled).toHaveBeenCalledOnce()
					expect(observed.onOutputClosed).toHaveBeenCalledExactlyOnceWith(running)
					expect(running.isOutputFinalized).toBe(true)
					expect(running.outputArchiveInterrupted).toBe(observerOutcome === "rejected")
					expect(mockTerminalInfo.process).toBeUndefined()
				} finally {
					finishCompleted.release()
					finishClose.release()
					mockTerminalInfo.notifyTerminalClosed()
					await running.finalizeOutput()
					running.off("continue", continued)
				}
			},
		)

		it.each(["completes", "fails"] as const)(
			"keeps a replacement command's stream and reservation when the old reader %s",
			async (readerOutcome) => {
				const oldReading = barrier()
				const finishOldReader = barrier()
				const replacementReading = barrier()
				const finishReplacementReader = barrier()
				const readerFailure = new Error("old output reader failed")
				mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
					mockTerminalInfo.setActiveStream(
						(async function* () {
							yield "\x1b]633;C\x07old output\n"
							oldReading.release()
							await finishOldReader.promise
							if (readerOutcome === "fails") throw readerFailure
						})(),
					)
				})
				const original = mockTerminalInfo.runCommand("echo old", callbacks())
				const originalOutcome = original.then(
					() => undefined,
					(error: unknown) => error,
				)
				await oldReading.promise
				mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
				mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
					mockTerminalInfo.setActiveStream(
						(async function* () {
							yield "\x1b]633;C\x07new output\n"
							replacementReading.release()
							await finishReplacementReader.promise
						})(),
					)
				})
				const replacement = mockTerminalInfo.runCommand("echo replacement", callbacks())
				try {
					await replacementReading.promise
					finishOldReader.release()
					expect(await originalOutcome).toBe(readerOutcome === "fails" ? readerFailure : undefined)
					await original.waitForOutputFinalization?.()
					expect(mockTerminalInfo.process).toBe(replacement)
					expect(mockTerminalInfo.running).toBe(true)
					expect(mockTerminalInfo.busy).toBe(true)
					expect(mockTerminalInfo.isStreamClosed).toBe(false)
				} finally {
					finishOldReader.release()
					mockTerminalInfo.shellExecutionComplete({ exitCode: 0 })
					finishReplacementReader.release()
					await originalOutcome
					await replacement
					await replacement.waitForOutputFinalization?.()
				}
			},
		)

		it("propagates process failures without reporting a shell integration timeout", async () => {
			const failure = new Error("stream reader failed")
			const run = vi.spyOn(TerminalProcess.prototype, "run").mockRejectedValueOnce(failure)
			const observed = callbacks()
			try {
				await expect(mockTerminalInfo.runCommand("echo test", observed)).rejects.toBe(failure)
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
				await mockTerminalInfo.runCommand("echo test", observed)
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
				await expect(mockTerminalInfo.runCommand("echo test", callbacks())).rejects.toThrow(
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
			const running = mockTerminalInfo.runCommand("echo test", callbacks())
			await expect(running).rejects.toThrow("active stream failed")
			expect(running.isSettled).toBe(true)
			expect(mockTerminalInfo.running).toBe(true)
			running.abort()
			running.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledExactlyOnceWith("\x03")
			mockTerminalInfo.shellExecutionComplete({ exitCode: 130, signalName: "SIGINT" })
		})

		it("retries a failed interrupt without repeating an accepted interrupt", async () => {
			mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
				mockTerminalInfo.setActiveStream(
					(async function* () {
						yield "\x1b]633;C\x07output before failure\n"
						throw new Error("active stream failed")
					})(),
				)
			})
			const running = mockTerminalInfo.runCommand("echo test", callbacks())
			await expect(running).rejects.toThrow("active stream failed")
			mockTerminal.sendText.mockImplementationOnce(() => {
				throw new Error("interrupt transport unavailable")
			})
			expect(() => running.abort()).toThrow("interrupt transport unavailable")
			running.abort()
			running.abort()
			expect(mockTerminal.sendText).toHaveBeenCalledTimes(2)
			expect(mockTerminal.sendText).toHaveBeenLastCalledWith("\x03")
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
			const running = mockTerminalInfo.runCommand("echo test", callbacks())
			await running
			expect(running.isSettled).toBe(true)
			expect(mockTerminalInfo.running).toBe(false)
			running.abort()
			expect(mockTerminal.sendText).not.toHaveBeenCalled()
		})

		it("can send input and stop after a command is backgrounded", async () => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			mockTerminal.shellIntegration.executeCommand.mockImplementationOnce(() => {
				mockTerminalInfo.setActiveStream(
					(async function* () {
						yield "\x1b]633;C\x07server ready\n"
						await gate
					})(),
				)
			})
			const running = mockTerminalInfo.runCommand("node server.cjs", callbacks())
			await vi.waitFor(() => expect(mockTerminal.shellIntegration.executeCommand).toHaveBeenCalled())
			running.continue()
			await running
			try {
				expect(running.isSettled).toBe(false)
				running.writeInput!("hello\n")
				running.abort()
				expect(mockTerminal.sendText).toHaveBeenNthCalledWith(1, "hello\n", false)
				expect(mockTerminal.sendText).toHaveBeenNthCalledWith(2, "\x03")
			} finally {
				mockTerminalInfo.shellExecutionComplete({ exitCode: 130, signalName: "SIGINT" })
				release()
			}
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
