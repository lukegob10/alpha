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
import type { RooTerminalCallbacks } from "../../../integrations/terminal/types"

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
import { executeCommandInTerminal } from "../ExecuteCommandTool"

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
			getState: vitest.fn().mockResolvedValue({
				terminalShellIntegrationDisabled: false,
			}),
		}

		// Create mock task
		mockTask = {
			cwd: "/test/project",
			taskId: "test-task-123",
			providerRef: {
				deref: vitest.fn().mockResolvedValue(mockProvider),
			},
			say: vitest.fn().mockResolvedValue(undefined),
			terminalProcess: undefined,
			abort: false,
			getTaskLifetimeCancellationSignal: vitest.fn(() => taskLifetimeController.signal),
			supersedePendingAsk: vitest.fn(),
			completeCommandExecution: vitest.fn(),
			failCommandExecution: vitest.fn(),
		}

		// Create mock process that resolves immediately
		mockProcess = Promise.resolve()
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
				.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
				.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
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
			expect(mockTask.failCommandExecution).toHaveBeenCalledWith("cancelled-call", "cancelled")
		})
	})

	describe("Managed Worker background commands", () => {
		it("returns after an explicit agent timeout while the Execa process remains registry-owned", async () => {
			vitest.useFakeTimers()
			vitest.mocked(Terminal.compressTerminalOutput).mockImplementation((output) => output)
			mockTask.taskKind = "subagent"
			mockTask.subagentRole = "worker"
			let resolveProcess!: () => void
			const backgroundProcess = new Promise<void>((resolve) => (resolveProcess = resolve)) as any
			backgroundProcess.continue = vitest.fn()
			mockTerminal.provider = "execa"
			mockTerminal.busy = true
			mockTerminal.taskId = mockTask.taskId
			mockTerminal.process = backgroundProcess
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
				void callbacks.onLine("PID_READY=12345\n", backgroundProcess)
				return backgroundProcess
			})

			try {
				const execution = executeCommandInTerminal(mockTask, {
					executionId: "managed-worker-background",
					command: "long-running-command",
					terminalShellIntegrationDisabled: false,
					agentTimeout: 1_000,
				})

				await vitest.advanceTimersByTimeAsync(1_000)
				// executeCommand schedules its final UI-ordering delay after the
				// agent-timeout continuation resumes.
				await vitest.advanceTimersByTimeAsync(100)
				const [rejected, result] = await execution

				expect(rejected).toBe(false)
				expect(result).toContain("Command is still running")
				expect(result).toContain("PID_READY=12345")
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
				expect(mockTask.failCommandExecution).toHaveBeenCalledWith("hard-timeout-call", "timed_out")
			} finally {
				if (!backgroundProcess.isSettled) await backgroundProcess.abort()
				vitest.useRealTimers()
			}
		})
	})

	describe("Command Execution States", () => {
		it("should handle completed command with exit code 0", async () => {
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue("/test/project")
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
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
			})

			expect(mockTask.completeCommandExecution).toHaveBeenCalledWith("evidence-call", {
				exitCode: 0,
				signalName: undefined,
			})
		})

		it("should handle completed command with non-zero exit code", async () => {
			mockTerminal.getCurrentWorkingDirectory.mockReturnValue("/test/project")
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
			mockTerminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
				runCommand: vitest.fn().mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
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
		const backgroundProcess = new Promise<void>((resolve) => (resolveProcess = resolve)) as any
		backgroundProcess.continue = vitest.fn()
		mockTask.ask = vitest.fn().mockResolvedValue({ response: "messageResponse" })
		mockTerminal.runCommand.mockImplementation((_command: string, callbacks: RooTerminalCallbacks) => {
			setTimeout(async () => {
				await callbacks.onLine("untracked output", backgroundProcess)
				resolveProcess()
			}, 0)
			return backgroundProcess
		})

		const [rejected, result] = await executeCommandInTerminal(mockTask, {
			executionId: "offscreen-output",
			command: "git status --short",
			terminalShellIntegrationDisabled: false,
		})

		expect(rejected).toBe(false)
		expect(backgroundProcess.continue).toHaveBeenCalledOnce()
		expect(result).not.toContain("<user_message>")
		expect(result).not.toContain("undefined")
		expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
	})
})
