//
// Tests the ExecuteCommand tool itself vs calling the tool where the tool is mocked.
//
import * as path from "path"
import * as fs from "fs/promises"
import { EventEmitter } from "events"

import { ExecuteCommandOptions } from "../ExecuteCommandTool"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { ExecaTerminal } from "../../../integrations/terminal/ExecaTerminal"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { ToolRegistry } from "../ToolRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

const fsMocks = vitest.hoisted(() => ({ access: vitest.fn(), realpath: vitest.fn() }))

// Mock fs to control directory and managed-worktree checks.
vitest.mock("fs/promises", () => ({
	default: fsMocks,
	...fsMocks,
}))

// Mock TerminalRegistry to control terminal creation
vitest.mock("../../../integrations/terminal/TerminalRegistry")

// Mock Terminal and ExecaTerminal classes
vitest.mock("../../../integrations/terminal/Terminal")
vitest.mock("../../../integrations/terminal/ExecaTerminal")

// Import the actual executeCommand function (not mocked)
import { executeCommandInTerminal, executeCommandTool } from "../ExecuteCommandTool"

// Tests for the executeCommand function
describe("executeCommand", () => {
	let mockTask: any
	let mockTerminal: any
	let mockProcess: any
	let mockProvider: any
	let taskLifetimeController: AbortController

	beforeEach(() => {
		vitest.clearAllMocks()
		taskLifetimeController = new AbortController()

		// Mock fs.access to simulate directory existence
		;(fs.access as any).mockResolvedValue(undefined)
		;(fs.realpath as any).mockImplementation(async (value: string) => value)

		// Create mock provider
		mockProvider = {
			postMessageToWebview: vitest.fn(),
			getValue: vitest.fn((key: string) => (key === "terminalShellIntegrationDisabled" ? false : undefined)),
			getState: vitest.fn().mockResolvedValue({
				terminalShellIntegrationDisabled: false,
			}),
		}

		// Create mock task
		let presentationTimestamp = Date.now()
		mockTask = {
			cwd: "/test/project",
			taskId: "test-task-123",
			providerRef: {
				deref: vitest.fn().mockResolvedValue(mockProvider),
			},
			say: vitest.fn().mockResolvedValue(undefined),
			alphaMessages: [],
			presentApprovedCommand: vitest.fn(async function (this: Task, command: string) {
				presentationTimestamp = Math.max(Date.now(), presentationTimestamp + 1, (this.lastMessageTs ?? 0) + 1)
				this.alphaMessages.push({
					ts: presentationTimestamp,
					type: "ask",
					ask: "command",
					text: command,
					isAnswered: true,
				})
				return presentationTimestamp.toString()
			}),
			terminalProcess: undefined,
			abort: false,
			getTaskLifetimeCancellationSignal: vitest.fn(() => taskLifetimeController.signal),
			supersedePendingAsk: vitest.fn(),
			completeCommandExecution: vitest.fn(),
			markCommandExecutionBackgrounded: vitest.fn(),
			failCommandExecution: vitest.fn(),
		}

		// Create mock process that resolves immediately
		const promise = Promise.resolve()
		mockProcess = Object.assign(new EventEmitter(), {
			then: promise.then.bind(promise),
			catch: promise.catch.bind(promise),
			finally: promise.finally.bind(promise),
		})
		mockProcess.continue = vitest.fn()

		// Create mock terminal with getCurrentWorkingDirectory method
		mockTerminal = {
			provider: "vscode",
			id: 1,
			initialCwd: "/test/project",
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/project"),
			runCommand: vitest.fn().mockReturnValue(mockProcess),
			terminal: {
				show: vitest.fn(),
			},
		}

		// Mock TerminalRegistry.getOrCreateTerminal
		;(TerminalRegistry.getOrCreateTerminal as any).mockResolvedValue(mockTerminal)
	})

	describe("Working Directory Behavior", () => {
		it("should use terminal.getCurrentWorkingDirectory() in the output message for completed commands", async () => {
			// Setup: Mock terminal to return a different current working directory
			const initialCwd = "/test/project"
			const currentCwd = "/test/project/subdirectory"

			mockTask.cwd = initialCwd
			mockTerminal.initialCwd = initialCwd
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue(currentCwd)

			// Mock the terminal process to complete successfully
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				// Simulate command completion
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(mockTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
			expect(result).toContain(`within working directory '${currentCwd}'`)
			expect(result).not.toContain(`within working directory '${initialCwd}'`)
		})

		it("should use terminal.getCurrentWorkingDirectory() for VSCode Terminal with shell integration", async () => {
			// Setup: Mock VSCode Terminal instance
			const vscodeTerminal = new Terminal(1, undefined, "/test/project")
			const mockVSCodeTerminal = vscodeTerminal as any

			// Mock shell integration providing different cwd
			mockVSCodeTerminal.terminal = {
				show: vitest.fn(),
				shellIntegration: {
					cwd: { fsPath: "/test/project/changed-dir" },
				},
			}
			mockVSCodeTerminal.getCurrentWorkingDirectory = vitest.fn().mockReturnValue("/test/project/changed-dir")
			mockVSCodeTerminal.runCommand = vitest
				.fn()
				.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
					setTimeout(() => {
						callbacks.onCompleted("Command output", mockProcess)
						callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
					}, 0)
					return mockProcess
				})
			;(TerminalRegistry.getOrCreateTerminal as any).mockResolvedValue(mockVSCodeTerminal)

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(result).toContain("within working directory '/test/project/changed-dir'")
		})

		it("should use terminal.getCurrentWorkingDirectory() for ExecaTerminal (always returns initialCwd)", async () => {
			// Setup: Mock ExecaTerminal instance
			const execaTerminal = new ExecaTerminal(1, "/test/project")
			const mockExecaTerminal = execaTerminal as any

			// ExecaTerminal always returns initialCwd
			mockExecaTerminal.getCurrentWorkingDirectory = vitest.fn().mockReturnValue("/test/project")
			mockExecaTerminal.runCommand = vitest
				.fn()
				.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
					setTimeout(() => {
						callbacks.onCompleted("Command output", mockProcess)
						callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
					}, 0)
					return mockProcess
				})
			;(TerminalRegistry.getOrCreateTerminal as any).mockResolvedValue(mockExecaTerminal)

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				terminalShellIntegrationDisabled: true, // Forces ExecaTerminal
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(mockExecaTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
			expect(result).toContain("within working directory '/test/project'")
		})
	})

	describe("Custom Working Directory", () => {
		it("should handle absolute custom cwd and use terminal.getCurrentWorkingDirectory() in output", async () => {
			const customCwd = "/custom/absolute/path"

			mockTerminal.getCurrentWorkingDirectory.mockReturnValue(customCwd)
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				customCwd,
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(customCwd, mockTask.taskId, "vscode")
			expect(result).toContain(`within working directory '${customCwd}'`)
		})

		it("should handle relative custom cwd and use terminal.getCurrentWorkingDirectory() in output", async () => {
			const relativeCwd = "subdirectory"
			const resolvedCwd = path.resolve(mockTask.cwd, relativeCwd)

			mockTerminal.getCurrentWorkingDirectory.mockReturnValue(resolvedCwd)
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				customCwd: relativeCwd,
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(resolvedCwd, mockTask.taskId, "vscode")
			expect(result).toContain(`within working directory '${resolvedCwd.toPosix()}'`)
		})

		it("should return error when custom working directory does not exist", async () => {
			const nonExistentCwd = "/non/existent/path"

			// Mock fs.access to throw error for non-existent directory
			;(fs.access as any).mockRejectedValue(new Error("Directory does not exist"))

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				customCwd: nonExistentCwd,
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(result).toBe(`Working directory '${nonExistentCwd}' does not exist.`)
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		})
	})

	describe("Terminal Provider Selection", () => {
		it("should use vscode provider when shell integration is enabled", async () => {
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(mockTask.cwd, mockTask.taskId, "vscode")
		})

		it("should use execa provider when shell integration is disabled", async () => {
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo test",
				terminalShellIntegrationDisabled: true,
			}

			// Execute
			await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(mockTask.cwd, mockTask.taskId, "execa")
		})

		it("forces managed workers to execa when shell integration is enabled", async () => {
			mockTask.taskKind = "subagent"
			mockTask.subagentRole = "worker"
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command output", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			await executeCommandInTerminal(mockTask, {
				executionId: "managed-worker",
				command: "pnpm test",
				terminalShellIntegrationDisabled: false,
			})

			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(mockTask.cwd, mockTask.taskId, "execa")
		})
	})

	describe("Task cancellation", () => {
		it("does not acquire a terminal after task cancellation", async () => {
			taskLifetimeController.abort(new Error("cancelled"))

			const result = await executeCommandInTerminal(mockTask, {
				executionId: "cancelled-before-terminal",
				toolCallId: "cancelled-call",
				command: "long-running-command",
			})

			expect(result).toEqual([false, "Command was not started because the task was cancelled."])
			expect(mockTask.failCommandExecution).toHaveBeenCalledWith("cancelled-call", "cancelled")
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		})

		it("does not launch when cancellation wins terminal acquisition", async () => {
			let resolveTerminal!: (terminal: typeof mockTerminal) => void
			;(TerminalRegistry.getOrCreateTerminal as any).mockImplementation(
				() => new Promise((resolve) => (resolveTerminal = resolve)),
			)

			const execution = executeCommandInTerminal(mockTask, {
				executionId: "cancelled-during-terminal",
				toolCallId: "cancelled-call",
				command: "long-running-command",
			})
			await vitest.waitFor(() => expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledOnce())
			mockTask.abort = true
			resolveTerminal(mockTerminal)

			await expect(execution).resolves.toEqual([false, "Command was not started because the task was cancelled."])
			expect(mockTerminal.runCommand).not.toHaveBeenCalled()
			expect(TerminalRegistry.releaseTerminalReservation).toHaveBeenCalledWith(mockTerminal, mockTask.taskId)
			expect(mockTask.failCommandExecution).toHaveBeenCalledWith("cancelled-call", "cancelled")
		})

		it("releases the terminal when command admission is cancelled", async () => {
			let finishAdmission!: () => void
			mockTask.admitCommandExecution = vitest.fn(
				() => new Promise<void>((resolve) => (finishAdmission = resolve)),
			)
			const execution = executeCommandInTerminal(mockTask, {
				executionId: "cancelled-during-admission",
				toolCallId: "cancelled-call",
				command: "long-running-command",
			})
			await vitest.waitFor(() => expect(mockTask.admitCommandExecution).toHaveBeenCalledOnce())
			mockTask.abort = true
			finishAdmission()

			await expect(execution).resolves.toEqual([false, "Command was not started because the task was cancelled."])
			expect(mockTerminal.runCommand).not.toHaveBeenCalled()
			expect(TerminalRegistry.releaseTerminalReservation).toHaveBeenCalledWith(mockTerminal, mockTask.taskId)
		})
	})

	describe("Managed Worker background commands", () => {
		it("returns after an explicit agent timeout while the Execa process remains registry-owned", async () => {
			vitest.useFakeTimers()
			vitest.mocked(Terminal.compressTerminalOutput).mockImplementation((output) => output)
			mockTask.taskKind = "subagent"
			mockTask.subagentRole = "worker"
			let resolveProcess!: () => void
			const promise = new Promise<void>((resolve) => (resolveProcess = resolve))
			const backgroundProcess = Object.assign(new EventEmitter(), {
				then: promise.then.bind(promise),
				catch: promise.catch.bind(promise),
				finally: promise.finally.bind(promise),
			}) as any
			backgroundProcess.continue = vitest.fn()
			backgroundProcess.isSettled = false
			backgroundProcess.hasUnretrievedOutput = vitest.fn(() => true)
			backgroundProcess.captureUnretrievedOutput = vitest.fn(() => ({
				output: "PID_READY=12345\n",
				commit: vitest.fn(),
				release: vitest.fn(),
			}))
			backgroundProcess.writeInput = vitest.fn()
			mockProvider.runWorkspaceMutation = async (_task: unknown, _name: string, run: () => Promise<void>) => run()
			mockTask.providerRef.deref.mockReturnValue(mockProvider)
			mockTask.getCommandExecutionEvidence = () => [
				{ executionId: backgroundProcess.executionId, status: "running" },
			]
			mockTerminal.provider = "execa"
			mockTerminal.busy = true
			mockTerminal.running = true
			mockTerminal.taskId = mockTask.taskId
			mockTerminal.process = backgroundProcess
			vitest.mocked(TerminalRegistry.getTerminals).mockReturnValue([mockTerminal])
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
				void callbacks.onLine("PID_READY=12345\n", backgroundProcess)
				return backgroundProcess
			})
			const onCommandResult = vitest.fn()

			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "managed-worker-background",
					toolCallId: "background-call",
					command: "long-running-command",
					terminalShellIntegrationDisabled: false,
					agentTimeout: 1_000,
					onCommandResult,
				})

				await vitest.advanceTimersByTimeAsync(1_000)
				// executeCommand schedules its final UI-ordering delay after the
				// agent-timeout continuation resumes.
				await vitest.advanceTimersByTimeAsync(100)
				const [rejected, result] = await execution

				expect(rejected).toBe(false)
				expect(result).toContain("Command is still running")
				expect(result).toContain("PID_READY=12345")
				const sessionId = Number((result as string).match(/session_id: (\d+)/)?.[1])
				expect(Number.isSafeInteger(sessionId)).toBe(true)
				expect(commandSessionRegistry.resolve(mockTask, sessionId)?.process).toBe(backgroundProcess)
				const writeStdin = new ToolRegistry().resolve("write_stdin")!
				const toolCallbacks = {
					askApproval: vitest.fn().mockResolvedValue(true),
					handleError: vitest.fn(),
					pushToolResult: vitest.fn(),
					setResultMetadata: vitest.fn(),
				}
				await writeStdin.execute({
					task: mockTask,
					call: {
						type: "tool_use",
						id: "poll-call",
						name: "write_stdin",
						params: {},
						partial: false,
						nativeArgs: { session_id: sessionId, yield_time_ms: 0 },
					},
					callbacks: toolCallbacks,
				})
				expect(toolCallbacks.pushToolResult).toHaveBeenCalledWith(
					expect.stringContaining(`Process running with session ID ${sessionId}`),
				)
				await writeStdin.execute({
					task: mockTask,
					call: {
						type: "tool_use",
						id: "input-call",
						name: "write_stdin",
						params: {},
						partial: false,
						nativeArgs: { session_id: sessionId, chars: "yes\n", yield_time_ms: 0 },
					},
					callbacks: toolCallbacks,
				})
				expect(backgroundProcess.writeInput).toHaveBeenCalledExactlyOnceWith("yes\n")
				expect(toolCallbacks.handleError).not.toHaveBeenCalled()
				expect(mockTask.markCommandExecutionBackgrounded).toHaveBeenCalledWith(
					"background-call",
					expect.stringMatching(/^managed-worker-background:[\da-f-]+$/),
				)
				const [, physicalExecutionId] = mockTask.markCommandExecutionBackgrounded.mock.calls[0]
				expect(result).toContain(`execution_id: ${physicalExecutionId}`)
				expect(result).toContain(`session_id: ${sessionId}`)
				expect(onCommandResult).toHaveBeenCalledWith(
					expect.objectContaining({
						output: "PID_READY=12345\n",
						session_id: sessionId,
					}),
				)
				expect(backgroundProcess.continue).toHaveBeenCalledOnce()
				expect(mockTask.supersedePendingAsk).toHaveBeenCalledOnce()
				expect(mockTask.terminalProcess).toBeUndefined()
				expect(mockTerminal).toMatchObject({
					busy: true,
					taskId: mockTask.taskId,
					process: backgroundProcess,
				})
			} finally {
				resolveProcess()
				vitest.useRealTimers()
			}
		})

		it("keeps the user command timeout as a hard ceiling after backgrounding", async () => {
			vitest.useFakeTimers()
			mockTask.taskKind = "subagent"
			mockTask.subagentRole = "worker"
			const emitter = new EventEmitter()
			let resolveProcess!: () => void
			const promise = new Promise<void>((resolve) => (resolveProcess = resolve))
			const backgroundProcess = Object.assign(emitter, {
				isSettled: false,
				then: promise.then.bind(promise),
				catch: promise.catch.bind(promise),
				finally: promise.finally.bind(promise),
				continue: vitest.fn(),
				abort: vitest.fn(async () => {
					backgroundProcess.isSettled = true
					resolveProcess()
					backgroundProcess.emit("shell_execution_complete", { exitCode: 130, signalName: "SIGINT" })
					backgroundProcess.emit("completed")
				}),
			})
			mockTerminal.provider = "execa"
			mockTerminal.busy = true
			mockTerminal.taskId = mockTask.taskId
			mockTerminal.process = backgroundProcess
			mockTerminal.runCommand.mockReturnValue(backgroundProcess)

			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "managed-worker-hard-timeout",
					toolCallId: "hard-timeout-call",
					command: "long-running-command",
					terminalShellIntegrationDisabled: false,
					agentTimeout: 1_000,
					commandExecutionTimeout: 2_000,
				})

				await vitest.advanceTimersByTimeAsync(1_100)
				await execution
				expect(backgroundProcess.abort).not.toHaveBeenCalled()

				await vitest.advanceTimersByTimeAsync(900)
				expect(backgroundProcess.abort).toHaveBeenCalledOnce()
				expect(mockTask.failCommandExecution).toHaveBeenCalledWith(
					"hard-timeout-call",
					"timed_out",
					expect.stringMatching(/^managed-worker-hard-timeout:/),
				)
			} finally {
				if (!backgroundProcess.isSettled) await backgroundProcess.abort()
				vitest.useRealTimers()
			}
		})
	})

	describe("user deadline physical settlement", () => {
		function pendingCommand() {
			const pending = new Promise<void>(() => {})
			const command = Object.assign(new EventEmitter(), {
				isSettled: false,
				then: pending.then.bind(pending),
				catch: pending.catch.bind(pending),
				finally: pending.finally.bind(pending),
				continue: vitest.fn(),
				abort: vitest.fn(),
			})
			mockTerminal.process = command
			mockTerminal.running = true
			mockTerminal.busy = true
			mockTerminal.runCommand.mockReturnValue(command)
			return command
		}

		it("does not report termination after a void interrupt until physical exit arrives", async () => {
			vitest.useFakeTimers()
			const command = pendingCommand()
			const projectionFailure = new Error("terminal status projection failed")
			command.on("shell_execution_complete", () => {
				throw projectionFailure
			})
			const settled = vitest.fn()
			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "void-interrupt",
					command: "controlled command",
					terminalShellIntegrationDisabled: false,
					commandExecutionTimeout: 100,
				}).then((result) => {
					settled()
					return result
				})
				await vitest.advanceTimersByTimeAsync(100)
				expect(command.abort).toHaveBeenCalledOnce()
				expect(settled).not.toHaveBeenCalled()
				expect(mockTerminal.process).toBe(command)
				expect(() => command.emit("shell_execution_complete", { exitCode: 130, signalName: "SIGINT" })).toThrow(
					projectionFailure,
				)
				await expect(execution).resolves.toEqual([false, expect.stringContaining("command was terminated")])
				expect(command.listenerCount("terminal_closed")).toBe(0)
				expect(vitest.getTimerCount()).toBe(0)
			} finally {
				vitest.useRealTimers()
			}
		})

		it("rejects unconfirmed termination without releasing the original process handle", async () => {
			vitest.useFakeTimers()
			const command = pendingCommand()
			vitest.spyOn(console, "error").mockImplementation(() => undefined)
			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "unconfirmed-interrupt",
					command: "controlled command",
					terminalShellIntegrationDisabled: false,
					commandExecutionTimeout: 100,
				})
				const rejected = expect(execution).rejects.toThrow("process cleanup failed")
				await vitest.advanceTimersByTimeAsync(11_100)
				await rejected
				expect(command.abort).toHaveBeenCalledOnce()
				expect(mockTerminal.process).toBe(command)
				expect(mockTerminal.running).toBe(true)
				expect(command.isSettled).toBe(false)
				expect(command.listenerCount("terminal_closed")).toBe(0)
				expect(vitest.getTimerCount()).toBe(0)
			} finally {
				vitest.restoreAllMocks()
				vitest.useRealTimers()
			}
		})

		it("uses the adapter hard stop and still joins its physical close acknowledgement", async () => {
			vitest.useFakeTimers()
			const command = Object.assign(pendingCommand(), { terminate: vitest.fn(async () => undefined) })
			const settled = vitest.fn()
			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "owned-hard-stop",
					command: "controlled command",
					terminalShellIntegrationDisabled: false,
					commandExecutionTimeout: 100,
				}).then((result) => {
					settled()
					return result
				})
				await vitest.advanceTimersByTimeAsync(100)
				expect(command.terminate).toHaveBeenCalledOnce()
				expect(command.abort).not.toHaveBeenCalled()
				expect(settled).not.toHaveBeenCalled()
				command.emit("terminal_closed")
				await expect(execution).resolves.toEqual([false, expect.stringContaining("command was terminated")])
				expect(vitest.getTimerCount()).toBe(0)
			} finally {
				vitest.useRealTimers()
			}
		})
	})

	describe("Command Execution States", () => {
		it("should handle completed command with exit code 0", async () => {
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue("/test/project")
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command completed successfully", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "echo success",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(result).toContain("Exit code: 0")
			expect(result).toContain("within working directory '/test/project'")
		})

		it("records terminal exit evidence independently of model-facing output", async () => {
			const onCommandResult = vitest.fn()
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
					callbacks.onCompleted("output without an exit-code string", mockProcess)
				}, 0)
				return mockProcess
			})

			await executeCommandInTerminal(mockTask, {
				executionId: "evidence-execution",
				toolCallId: "evidence-call",
				command: "pnpm test",
				terminalShellIntegrationDisabled: false,
				onCommandResult,
			})

			expect(mockTask.completeCommandExecution).toHaveBeenCalledWith(
				"evidence-call",
				{ exitCode: 0 },
				expect.stringMatching(/^evidence-execution:[\da-f-]+$/),
			)
			expect(onCommandResult).toHaveBeenCalledWith(
				expect.objectContaining({ output: "output without an exit-code string", exit_code: 0 }),
			)
			expect(onCommandResult.mock.calls[0][0]).not.toHaveProperty("session_id")
			expect(mockTask.markCommandExecutionBackgrounded).not.toHaveBeenCalled()
		})

		it("should handle completed command with non-zero exit code", async () => {
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue("/test/project")
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command failed", mockProcess)
					callbacks.onShellExecutionComplete({ exitCode: 1 }, mockProcess)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "exit 1",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(result).toContain("Command execution was not successful")
			expect(result).toContain("Exit code: 1")
			expect(result).toContain("within working directory '/test/project'")
		})

		it("should handle command terminated by signal", async () => {
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue("/test/project")
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
				setTimeout(() => {
					callbacks.onCompleted("Command interrupted", mockProcess)
					callbacks.onShellExecutionComplete(
						{
							exitCode: undefined,
							signalName: "SIGINT",
							coreDumpPossible: false,
						},
						mockProcess,
					)
				}, 0)
				return mockProcess
			})

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "long-running-command",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify
			expect(rejected).toBe(false)
			expect(result).toContain("Process terminated by signal SIGINT")
			expect(result).toContain("within working directory '/test/project'")
		})
	})

	describe("Terminal Working Directory Updates", () => {
		it("should update working directory when terminal returns different cwd", async () => {
			// Setup: Terminal initially at project root, but getCurrentWorkingDirectory returns different path
			const initialCwd = "/test/project"
			const updatedCwd = "/test/project/src"

			mockTask.cwd = initialCwd
			mockTerminal.initialCwd = initialCwd

			// Mock Terminal instance behavior
			const mockTerminalInstance = {
				...mockTerminal,
				terminal: { show: vitest.fn() },
				getCurrentWorkingDirectory: vitest.fn().mockReturnValue(updatedCwd),
				runCommand: vitest.fn().mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
					setTimeout(() => {
						callbacks.onCompleted("Directory changed", mockProcess)
						callbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
					}, 0)
					return mockProcess
				}),
			}

			;(TerminalRegistry.getOrCreateTerminal as any).mockResolvedValue(mockTerminalInstance)

			const options: ExecuteCommandOptions = {
				executionId: "test-123",
				command: "cd src && pwd",
				terminalShellIntegrationDisabled: false,
			}

			// Execute
			const [rejected, result] = await executeCommandInTerminal(mockTask, options)

			// Verify the result uses the updated working directory
			expect(rejected).toBe(false)
			expect(result).toContain(`within working directory '${updatedCwd}'`)
			expect(result).not.toContain(`within working directory '${initialCwd}'`)

			// Verify the terminal's getCurrentWorkingDirectory was called
			expect(mockTerminalInstance.getCurrentWorkingDirectory).toHaveBeenCalled()
		})
	})

	it("does not fabricate user feedback for an offscreen command-output response", async () => {
		let resolveProcess!: () => void
		const promise = new Promise<void>((resolve) => (resolveProcess = resolve))
		const backgroundProcess = Object.assign(new EventEmitter(), {
			then: promise.then.bind(promise),
			catch: promise.catch.bind(promise),
			finally: promise.finally.bind(promise),
		}) as any
		backgroundProcess.continue = vitest.fn()
		mockTask.ask = vitest.fn().mockResolvedValue({ response: "messageResponse" })
		mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
			setTimeout(async () => {
				await callbacks.onLine("untracked output", backgroundProcess)
				resolveProcess()
			}, 0)
			return backgroundProcess
		})

		const [rejected, result] = await executeCommandInTerminal(mockTask, {
			executionId: "offscreen-output",
			toolCallId: "offscreen-call",
			command: "git status --short",
			terminalShellIntegrationDisabled: false,
		})

		expect(rejected).toBe(false)
		expect(backgroundProcess.continue).toHaveBeenCalledOnce()
		expect(mockTask.markCommandExecutionBackgrounded).toHaveBeenCalledWith(
			"offscreen-call",
			expect.stringMatching(/^offscreen-output:[\da-f-]+$/),
		)
		expect(result).not.toContain("<user_message>")
		expect(result).not.toContain("undefined")
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
	})

	describe("approved command output correlation", () => {
		function controlledCommand() {
			let commandCallbacks!: AlphaTerminalCallbacks
			let notifyLaunch!: () => void
			const launched = new Promise<void>((resolve) => (notifyLaunch = resolve))
			let settleProcess!: () => void
			const processSettlement = new Promise<void>((resolve) => (settleProcess = resolve))
			let notifyPartial!: () => void
			const partialPublished = new Promise<void>((resolve) => (notifyPartial = resolve))
			mockProcess = Object.assign(new EventEmitter(), {
				then: processSettlement.then.bind(processSettlement),
				catch: processSettlement.catch.bind(processSettlement),
				finally: processSettlement.finally.bind(processSettlement),
				continue: vitest.fn(),
				isSettled: false,
			})
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
				commandCallbacks = callbacks
				notifyLaunch()
				return mockProcess
			})
			mockTask.lastMessageTs = 1000
			mockTask.alphaMessages = [{ ts: 999, type: "ask", ask: "command", text: "earlier command" }]
			mockTask.ask = vitest.fn(async () => ({ response: "yesButtonClicked" }))
			mockTask.say = vitest.fn<Task["say"]>(async (type, _text, _images, partial) => {
				if (type === "command_output" && partial === true) notifyPartial()
				return undefined
			})
			mockTask.recordToolError = vitest.fn()
			mockTask.getTaskCommandDenialReason = vitest.fn(async () => undefined)
			mockTask.getTaskMode = vitest.fn(async () => "code")
			mockTask.presentApprovedCommand = vitest.fn(async (command: string) => {
				mockTask.alphaMessages.push({ ts: 1001, type: "ask", ask: "command", text: command, isAnswered: true })
				return "1001"
			})
			vitest.mocked(Terminal.compressTerminalOutput).mockImplementation((output) => output)
			const callbacks = {
				askApproval: vitest.fn(async () => true),
				askCommandApproval: vitest
					.fn<NonNullable<ToolCallbacks["askCommandApproval"]>>()
					.mockResolvedValue({ approved: true, commandExecutionId: "1001" }),
				handleError: vitest.fn(async () => {}),
				pushToolResult: vitest.fn(),
				setResultMetadata: vitest.fn(),
				toolCallId: "correlated-command",
			}
			return {
				callbacks,
				async finish(execution: Promise<void>) {
					try {
						await launched
						commandCallbacks.onShellExecutionStarted(42, mockProcess)
						commandCallbacks.onLine("owned output\n", mockProcess)
						await partialPublished
						commandCallbacks.onShellExecutionComplete({ exitCode: 0 }, mockProcess)
						await commandCallbacks.onCompleted("owned output\n", mockProcess)
						mockProcess.isSettled = true
						settleProcess()
						await execution
					} finally {
						settleProcess()
						commandSessionRegistry.releaseForTask(mockTask)
					}
				},
				assertCorrelation() {
					const outputs = vitest
						.mocked(mockTask.say)
						.mock.calls.filter((args: Parameters<Task["say"]>) => args[0] === "command_output")
					expect(outputs.map((args: Parameters<Task["say"]>) => args[3])).toEqual([true, false])
					for (const args of outputs) expect(args[6]?.commandExecutionId).toBe("1001")
					const updates = mockProvider.postMessageToWebview.mock.calls
						.map(([message]: [{ type: string; text: string }]) => message)
						.filter((message: { type: string }) => message.type === "commandExecutionStatus")
						.map((message: { text: string }) => JSON.parse(message.text))
					expect(updates.map(({ status }: { status: string }) => status)).toEqual([
						"started",
						"output",
						"exited",
					])
					for (const update of updates) expect(update.executionId).toBe("1001")
					expect(mockProcess.executionId).toMatch(/^1001:[\da-f-]+$/)
					expect(mockTask.completeCommandExecution).toHaveBeenCalledWith(
						"correlated-command",
						{ exitCode: 0 },
						mockProcess.executionId,
					)
					expect(callbacks.handleError).not.toHaveBeenCalled()
				},
			}
		}

		it.each(["creation hook", "legacy post-return fallback"] as const)(
			"tracks the original archive through actual Execute admission: %s",
			async (route) => {
				const fixture = controlledCommand()
				let releaseArchive!: () => void
				const archiveCompletion = new Promise<void>((resolve) => (releaseArchive = resolve))
				mockProcess.waitForOutputFinalization = vitest.fn(() => archiveCompletion)
				mockProcess.isOutputFinalized = false
				vitest.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
				fixture.callbacks.askCommandApproval.mockImplementation(async () => {
					mockTask.alphaMessages.push({
						ts: 1001,
						type: "ask",
						ask: "command",
						text: "echo owned",
						isAnswered: true,
					})
					mockTask.lastMessageTs = 1003
					return { approved: true, commandExecutionId: "1001" }
				})
				type Snapshot = ReturnType<typeof commandSessionRegistry.capturePendingTaskOutput>
				const beforeReturn: { executionId?: string; captured: Snapshot }[] = []
				let inRunCommand = false
				let installedCreationHook: AlphaTerminalCallbacks["onProcessCreated"]
				mockProvider.postMessageToWebview.mockImplementation((message: { type: string; text?: string }) => {
					if (
						inRunCommand &&
						message.type === "commandExecutionStatus" &&
						JSON.parse(message.text ?? "{}").status === "started"
					) {
						beforeReturn.push({
							executionId: mockProcess.executionId,
							// The baseline has no capture API. Its observable empty ownership
							// assertion is the RED oracle, never a missing-method exception.
							captured: commandSessionRegistry.capturePendingTaskOutput?.(mockTask) ?? [],
						})
					}
				})
				const originalRun = mockTerminal.runCommand.getMockImplementation()!
				mockTerminal.runCommand.mockImplementation((command: string, callbacks: AlphaTerminalCallbacks) => {
					inRunCommand = true
					installedCreationHook = callbacks.onProcessCreated
					if (route === "creation hook") callbacks.onProcessCreated?.(mockProcess)
					callbacks.onShellExecutionStarted(42, mockProcess)
					const returned = originalRun(command, callbacks)
					inRunCommand = false
					return returned
				})
				try {
					await fixture.finish(
						executeCommandTool.execute({ command: "echo owned" }, mockTask, fixture.callbacks),
					)
					expect(beforeReturn).toHaveLength(1)
					if (route === "creation hook") {
						expect(beforeReturn[0]!.captured).toHaveLength(1)
						expect(beforeReturn[0]!.executionId).toMatch(/^1001:[\da-f-]+$/)
					} else {
						expect(beforeReturn[0]!.captured).toHaveLength(0)
					}
					expect(installedCreationHook).toBeTypeOf("function")
					const captured = commandSessionRegistry.capturePendingTaskOutput?.(mockTask) ?? []
					expect(captured).toHaveLength(1)
					expect(captured[0]!.process).toBe(mockProcess)
					expect(captured[0]!.executionId).toBe(mockProcess.executionId)
					expect(captured[0]!.executionId).toMatch(/^1001:[\da-f-]+$/)
					expect(captured[0]!.archiveExecutionId).toBe("1001")
					expect(captured[0]!.archiveExecutionId).not.toBe(captured[0]!.executionId)
					expect(captured[0]!.archiveExecutionId).not.toBe("1000")
					expect(captured[0]!.completion).toBe(archiveCompletion)
					expect(captured[0]!.isCleanupSafe()).toBe(false)
					expect(mockProcess.waitForOutputFinalization).toHaveBeenCalledOnce()
					expect(mockProcess.outputArtifactId).toBeUndefined()
					expect(commandSessionRegistry.ownsOutput(mockProcess)).toBe(false)
					expect(fixture.callbacks.handleError).not.toHaveBeenCalled()
				} finally {
					releaseArchive()
					await archiveCompletion
					commandSessionRegistry.releaseForTask(mockTask)
				}
			},
		)

		it("uses the request-owned approval row after feedback and another ask change the latest message", async () => {
			const fixture = controlledCommand()
			fixture.callbacks.askCommandApproval.mockImplementation(async () => {
				mockTask.alphaMessages.push(
					{ ts: 1001, type: "ask", ask: "command", text: "echo owned" },
					{ ts: 1002, type: "say", say: "user_feedback", text: "accepted feedback" },
					{ ts: 1003, type: "ask", ask: "followup", text: "another question" },
				)
				mockTask.lastMessageTs = 1003
				return { approved: true, commandExecutionId: "1001" }
			})
			await fixture.finish(executeCommandTool.execute({ command: "echo owned" }, mockTask, fixture.callbacks))
			fixture.assertCorrelation()
			expect(mockTask.presentApprovedCommand).not.toHaveBeenCalled()
			expect(fixture.callbacks.askApproval).not.toHaveBeenCalled()
		})

		it.each(["owned callback", "legacy callback"] as const)(
			"presents approved output without a prompt receipt after authority checks through %s",
			async (route) => {
				const fixture = controlledCommand()
				fixture.callbacks.askCommandApproval.mockResolvedValue({ approved: true })
				const callbacks =
					route === "legacy callback"
						? { ...fixture.callbacks, askCommandApproval: undefined }
						: fixture.callbacks
				mockTask.presentApprovedCommand.mockImplementation(async (command: string) => {
					expect(mockTask.getTaskCommandDenialReason).toHaveBeenCalledTimes(2)
					expect(mockTask.getTaskMode).toHaveBeenCalledOnce()
					expect(mockTerminal.runCommand).not.toHaveBeenCalled()
					mockTask.alphaMessages.push({
						ts: 1001,
						type: "ask",
						ask: "command",
						text: command,
						isAnswered: true,
					})
					return "1001"
				})
				await fixture.finish(executeCommandTool.execute({ command: "echo owned" }, mockTask, callbacks))
				fixture.assertCorrelation()
				expect(mockTask.presentApprovedCommand).toHaveBeenCalledExactlyOnceWith("echo owned", undefined)
			},
		)

		it("does not present or launch an approved command when authority is revoked", async () => {
			const fixture = controlledCommand()
			fixture.callbacks.askCommandApproval.mockResolvedValue({ approved: true })
			mockTask.getTaskCommandDenialReason
				.mockResolvedValueOnce(undefined)
				.mockResolvedValueOnce("Command authority was revoked")
			await executeCommandTool.execute({ command: "echo owned" }, mockTask, fixture.callbacks)
			expect(mockTask.presentApprovedCommand).not.toHaveBeenCalled()
			expect(mockTerminal.runCommand).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(fixture.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(fixture.callbacks.handleError).not.toHaveBeenCalled()
		})

		it("does not launch or reserve a command when approved presentation persistence rejects", async () => {
			const fixture = controlledCommand()
			const persistenceFailure = new Error("Approved command presentation could not be saved")
			fixture.callbacks.askCommandApproval.mockResolvedValue({ approved: true })
			mockTask.presentApprovedCommand.mockRejectedValue(persistenceFailure)
			mockTask.taskKind = "primary"
			mockTask.admitCommandExecution = vitest.fn()
			mockProvider.reservePrimaryMutation = vitest.fn()
			await executeCommandTool.execute({ command: "echo owned" }, mockTask, fixture.callbacks)
			expect(mockTask.presentApprovedCommand).toHaveBeenCalledOnce()
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(mockTerminal.runCommand).not.toHaveBeenCalled()
			expect(mockTask.admitCommandExecution).not.toHaveBeenCalled()
			expect(mockProvider.reservePrimaryMutation).not.toHaveBeenCalled()
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(fixture.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(fixture.callbacks.handleError).toHaveBeenCalledExactlyOnceWith(
				"executing command",
				persistenceFailure,
			)
			expect(fixture.callbacks.setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({ failure: expect.objectContaining({ effectsStarted: "no" }) }),
			)
		})

		it("does not present or launch a denied command even if the host supplies a row receipt", async () => {
			const fixture = controlledCommand()
			fixture.callbacks.askApproval.mockResolvedValue(false)
			fixture.callbacks.askCommandApproval.mockResolvedValue({ approved: false, commandExecutionId: "1001" })
			await executeCommandTool.execute({ command: "echo owned" }, mockTask, fixture.callbacks)
			expect(mockTask.presentApprovedCommand).not.toHaveBeenCalled()
			expect(mockTerminal.runCommand).not.toHaveBeenCalled()
			expect(mockTask.say).not.toHaveBeenCalled()
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			expect(fixture.callbacks.handleError).not.toHaveBeenCalled()
		})
	})

	it.each([
		{ image: "bad-image", published: false },
		{ image: "data:image/png;base64,aA==", published: true },
	])(
		"retains command output ownership only after feedback result publication: $published",
		async ({ image, published }) => {
			vitest.useFakeTimers()
			let finishForeground!: () => void
			const foreground = new Promise<void>((resolve) => (finishForeground = resolve))
			const backgroundProcess = Object.assign(new EventEmitter(), {
				then: foreground.then.bind(foreground),
				catch: foreground.catch.bind(foreground),
				finally: foreground.finally.bind(foreground),
				isSettled: false,
				continue: vitest.fn(() => finishForeground()),
				hasUnretrievedOutput: () => true,
				captureUnretrievedOutput: vitest.fn(() => ({
					output: "READY\n",
					commit: vitest.fn(),
					release: vitest.fn(),
				})),
			})
			const otherTask = { taskId: "other-task" } as Task
			const otherProcess = Object.assign(new EventEmitter(), {
				executionId: "other-execution",
				isSettled: true,
			}) as AlphaTerminalProcess
			const otherSessionId = commandSessionRegistry.register(otherTask, otherProcess)
			const evidence = { toolCallId: "feedback-result-call", executionId: "", status: "running" }
			mockTask.ask = vitest
				.fn()
				.mockResolvedValue({ response: "messageResponse", text: "Continue", images: [image] })
			mockTask.beginCommandExecution = vitest.fn((_toolCallId: string, executionId: string) => {
				evidence.executionId = executionId
			})
			mockTask.failCommandExecution.mockImplementation(() => {
				evidence.status = "failed"
			})
			mockTask.recordToolError = vitest.fn()
			mockTask.getCommandExecutionEvidence = () => [evidence]
			mockProvider.getValue.mockImplementation((key: string) =>
				key === "terminalShellIntegrationDisabled" ? false : undefined,
			)
			vitest.mocked(Terminal.compressTerminalOutput).mockImplementation((output) => output)
			Object.assign(mockTerminal, {
				busy: true,
				running: true,
				taskId: mockTask.taskId,
				process: backgroundProcess,
			})
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: AlphaTerminalCallbacks) => {
				void callbacks.onLine("READY\n", backgroundProcess as never)
				return backgroundProcess
			})
			const callbacks = {
				askApproval: vitest.fn().mockResolvedValue(true),
				handleError: vitest.fn(),
				pushToolResult: vitest.fn(),
				setResultMetadata: vitest.fn(),
				toolCallId: "feedback-result-call",
				commandResultMaxOutputTokens: 1000,
				commandResultFormat: "codex" as const,
			}
			try {
				const execution = executeCommandTool.execute({ command: "node server.cjs" }, mockTask, callbacks)
				await vitest.advanceTimersByTimeAsync(100)
				await execution
				expect(callbacks.pushToolResult).toHaveBeenCalledTimes(published ? 1 : 0)
				expect(callbacks.handleError).toHaveBeenCalledTimes(published ? 0 : 1)
				if (!published)
					expect(callbacks.handleError).toHaveBeenCalledWith("executing command", expect.any(TypeError))
				expect(
					callbacks.setResultMetadata.mock.calls.some(
						([metadata]) => metadata.commandResult?.session_id !== undefined,
					),
				).toBe(published)
				expect(commandSessionRegistry.ownsOutput(backgroundProcess as never)).toBe(published)
				expect(backgroundProcess.hasUnretrievedOutput()).toBe(true)
				expect(backgroundProcess.captureUnretrievedOutput).not.toHaveBeenCalled()
				expect(commandSessionRegistry.resolve(otherTask, otherSessionId)?.process).toBe(otherProcess)
				expect(commandSessionRegistry.ownsOutput(otherProcess)).toBe(true)
			} finally {
				finishForeground()
				commandSessionRegistry.releaseForTask(mockTask)
				commandSessionRegistry.releaseForTask(otherTask)
				vitest.useRealTimers()
			}
		},
	)
})
