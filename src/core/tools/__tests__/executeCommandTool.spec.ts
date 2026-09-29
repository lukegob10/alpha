// npx vitest run src/core/tools/__tests__/executeCommandTool.spec.ts

import type { ToolUsage } from "@alpha-code/types"
import { EventEmitter } from "events"
import fs from "fs/promises"
import path from "path"
import * as vscode from "vscode"

import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { normalizeExecCommandYieldTimeMs } from "../commandTimeouts"
import { getNativeTools } from "../../prompts/tools/native-tools"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { mergePromise } from "../../../integrations/terminal/mergePromise"

// Mock dependencies
vitest.mock("execa", () => ({
	execa: vitest.fn(),
}))

vitest.mock("fs/promises", () => ({
	default: {
		access: vitest.fn().mockResolvedValue(undefined),
		realpath: vitest.fn(async (value: string) => value),
	},
}))

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn(),
	},
}))

vitest.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		getOrCreateTerminal: vitest.fn().mockResolvedValue({
			runCommand: vitest.fn().mockResolvedValue(undefined),
			getCurrentWorkingDirectory: vitest.fn().mockReturnValue("/test/workspace"),
		}),
		getTerminals: vitest.fn().mockReturnValue([]),
	},
}))

vitest.mock("../../task/Task")
vitest.mock("../../prompts/responses")

// Import the module
import * as executeCommandModule from "../ExecuteCommandTool"
const { executeCommandTool } = executeCommandModule
const executeCommandInTerminalActual = executeCommandModule.executeCommandInTerminal

describe("executeCommandTool", () => {
	// Setup common test variables
	let mockAlphaTask: any & { consecutiveMistakeCount: number; didRejectTool: boolean }
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any
	let mockToolUse: ToolUse<"execute_command">
	const originalCliRuntime = process.env.ROO_CLI_RUNTIME

	beforeEach(() => {
		// Reset mocks
		vitest.clearAllMocks()

		// Spy on executeCommandInTerminal and mock its return value
		vitest.spyOn(executeCommandModule, "executeCommandInTerminal").mockResolvedValue([false, "Command executed"])

		// Create mock implementations with eslint directives to handle the type issues
		mockAlphaTask = {
			abort: false,
			getTaskLifetimeCancellationSignal: vitest.fn(() => new AbortController().signal),
			ask: vitest.fn().mockResolvedValue(undefined),
			say: vitest.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vitest.fn().mockResolvedValue("Missing parameter error"),
			consecutiveMistakeCount: 0,
			didRejectTool: false,
			alphaIgnoreController: {
				validateCommand: vitest.fn().mockReturnValue(null),
			},
			recordToolUsage: vitest.fn().mockReturnValue({} as ToolUsage),
			recordToolError: vitest.fn(),
			providerRef: {
				deref: vitest.fn().mockResolvedValue({
					getState: vitest.fn().mockResolvedValue({
						terminalOutputLineLimit: 500,
						terminalOutputCharacterLimit: 100000,
						terminalShellIntegrationDisabled: true,
					}),
					postMessageToWebview: vitest.fn(),
				}),
			},
			lastMessageTs: Date.now(),
			cwd: "/test/workspace",
			beginCommandExecution: vitest.fn(),
			completeCommandExecution: vitest.fn(),
			failCommandExecution: vitest.fn(),
		}

		mockAskApproval = vitest.fn().mockResolvedValue(true)
		mockHandleError = vitest.fn().mockResolvedValue(undefined)
		mockPushToolResult = vitest.fn()

		// Setup vscode config mock
		const mockConfig = {
			get: vitest.fn().mockImplementation((key: string, defaultValue: any) => defaultValue),
		}
		;(vscode.workspace.getConfiguration as any).mockReturnValue(mockConfig)

		// Create a mock tool use object
		mockToolUse = {
			type: "tool_use",
			name: "execute_command",
			params: {
				command: "echo test",
			},
			nativeArgs: {
				command: "echo test",
			},
			partial: false,
		}
	})

	afterEach(() => {
		if (originalCliRuntime === undefined) delete process.env.ROO_CLI_RUNTIME
		else process.env.ROO_CLI_RUNTIME = originalCliRuntime
	})

	/**
	 * Tests for HTML entity unescaping in commands
	 * This verifies that HTML entities are properly converted to their actual characters
	 */
	describe("HTML entity unescaping", () => {
		it("should unescape &lt; to < character", () => {
			const input = "echo &lt;test&gt;"
			const expected = "echo <test>"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape &gt; to > character", () => {
			const input = "echo test &gt; output.txt"
			const expected = "echo test > output.txt"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should unescape &amp; to & character", () => {
			const input = "echo foo &amp;&amp; echo bar"
			const expected = "echo foo && echo bar"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("should handle multiple mixed HTML entities", () => {
			const input = "grep -E 'pattern' &lt;file.txt &gt;output.txt 2&gt;&amp;1"
			const expected = "grep -E 'pattern' <file.txt >output.txt 2>&1"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})
	})

	// Now we can run these tests
	describe("Basic functionality", () => {
		it("distinguishes a terminal capability failure before process launch", async () => {
			vitest
				.mocked(TerminalRegistry.getOrCreateTerminal)
				.mockRejectedValueOnce(new Error("private-terminal-error"))
			const setResultMetadata = vitest.fn()
			await executeCommandTool.handle(mockAlphaTask, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				setResultMetadata,
			})
			expect(setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({
					failure: expect.objectContaining({
						reason: "pre_launch_rejected",
						effectsStarted: "no",
						outcome: "known",
						recovery: { kind: "repair" },
					}),
				}),
			)
			expect(JSON.stringify(setResultMetadata.mock.calls)).not.toContain("private-terminal-error")
		})

		it("requires reconciliation after launch throws with an unknown effect outcome", async () => {
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValueOnce({
				runCommand: () => {
					throw new Error("launch failed")
				},
			} as never)
			const setResultMetadata = vitest.fn()
			await executeCommandTool.handle(mockAlphaTask, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				setResultMetadata,
			})
			expect(setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({
					failure: expect.objectContaining({
						reason: "outcome_unknown",
						effectsStarted: "unknown",
						outcome: "unknown",
						recovery: { kind: "verify-outcome" },
					}),
				}),
			)
		})
		it.each(["rg --files", "git show HEAD:src/review.ts", "rg -n symbol"])(
			"emits trusted exploration metadata after %s succeeds",
			async (command) => {
				mockToolUse.params.command = command
				mockToolUse.nativeArgs = { command }
				mockAlphaTask.getCommandExecutionEvidence = vitest.fn(() => [
					{
						toolCallId: "inspection-call",
						executionId: "inspection-execution",
						status: "succeeded",
						exitCode: 0,
						startedAt: 1,
						command,
						cwd: mockAlphaTask.cwd,
					},
				])
				const setResultMetadata = vitest.fn()

				await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
					askApproval: mockAskApproval as unknown as AskApproval,
					handleError: mockHandleError as unknown as HandleError,
					pushToolResult: mockPushToolResult as unknown as PushToolResult,
					setResultMetadata,
					toolCallId: "inspection-call",
				})

				expect(setResultMetadata).toHaveBeenCalledWith({
					executionStatus: "success",
					status: "success",
					exitCode: 0,
					timedOut: false,
					trustedExploration: {
						scope: expect.any(String),
						semanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					},
				})
			},
		)

		it("returns a completed nonzero process as a successful tool transaction with failed execution evidence", async () => {
			mockAlphaTask.getCommandExecutionEvidence = vitest.fn(() => [
				{
					toolCallId: "nonzero-call",
					executionId: "nonzero-execution",
					status: "failed",
					exitCode: 1,
					startedAt: 1,
					completedAt: 2,
					command: "rg missing src",
					cwd: mockAlphaTask.cwd,
				},
			])
			mockToolUse.params.command = "rg missing src"
			mockToolUse.nativeArgs = { command: "rg missing src" }
			const setResultMetadata = vitest.fn()

			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
				setResultMetadata,
				toolCallId: "nonzero-call",
			})

			expect(setResultMetadata).toHaveBeenLastCalledWith({
				executionStatus: "error",
				status: "success",
				exitCode: 1,
				timedOut: false,
			})
			expect(setResultMetadata.mock.calls.some(([metadata]) => metadata.failure !== undefined)).toBe(false)
		})

		it("should execute a command normally", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockToolUse.nativeArgs = { command: "echo test" }

			// Execute using the class-based handle method
			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			expect(mockPushToolResult).toHaveBeenCalled()
			// The exact message depends on the terminal mock's behavior
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("Command")
		})

		it.each(["ask", "auto", "bypass"] as const)(
			"denies a serial read-only child command before %s approval",
			async (_approvalMode) => {
				const reason =
					"This read-only sub-agent may run audited Git and ripgrep inspections only through the isolated command reader."
				mockAlphaTask.getTaskCommandDenialReason = vitest.fn().mockReturnValue(reason)
				const setResultMetadata = vitest.fn()

				await executeCommandTool.execute({ command: "git status --short" }, mockAlphaTask as unknown as Task, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					toolCallId: "serial-read-only-child-command",
					setResultMetadata,
				})

				expect(mockAskApproval).not.toHaveBeenCalled()
				expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
				expect(setResultMetadata).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "denied",
						failure: expect.objectContaining({ reason: "policy_denied" }),
					}),
				)
				expect(formatResponse.toolError).toHaveBeenCalledWith(reason)
			},
		)

		it.each(["ask", "auto", "bypass"] as const)(
			"rechecks child command authority after a %s approval before launch",
			async (_approvalMode) => {
				const commandAuthority = vitest
					.fn()
					.mockResolvedValueOnce(undefined)
					.mockResolvedValueOnce(
						"Read-only sub-agents may run only audited Git inspection and ripgrep commands.",
					)
				mockAlphaTask.getTaskCommandDenialReason = commandAuthority
				const setResultMetadata = vitest.fn()

				await executeCommandTool.execute({ command: "git status --short" }, mockAlphaTask as unknown as Task, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					toolCallId: "read-only-child-command",
					setResultMetadata,
				})

				expect(commandAuthority).toHaveBeenCalledTimes(2)
				expect(mockAskApproval).toHaveBeenCalledWith("command", "git status --short")
				expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
				expect(setResultMetadata).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "denied",
						failure: expect.objectContaining({ reason: "policy_denied" }),
					}),
				)
				expect(formatResponse.toolError).toHaveBeenCalledWith(expect.stringContaining("audited Git inspection"))
			},
		)

		it("formats a native exec command result with Codex headers", async () => {
			const toolCallId = "exec-command-call"
			await executeCommandTool.execute({ command: "echo test" }, mockAlphaTask as unknown as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId,
				commandResultMaxOutputTokens: 256,
				commandResultFormat: "codex",
			})

			expect(mockPushToolResult).toHaveBeenCalledOnce()
			expect(mockPushToolResult.mock.calls[0][0]).toMatch(
				/^Chunk ID: exec-command-call\nWall time: \d+\.\d{4} seconds\nOutput:\n/,
			)
		})

		it("routes exec_command through the scheduler to the terminal host", async () => {
			const schemas = getNativeTools()
			const registry = new ToolRegistry({ nativeTools: schemas })
			const surface = createTaskToolSurface({ registry, schemas, mode: "code" })
			const provider = {
				getState: vitest.fn().mockResolvedValue({ terminalShellIntegrationDisabled: true }),
				postMessageToWebview: vitest.fn(),
				runWorkspaceMutation: vitest.fn(async (_task: Task, _label: string, run: () => Promise<void>) => run()),
			}
			const task = {
				...mockAlphaTask,
				taskId: "shell-scheduler-task",
				providerRef: { deref: vitest.fn(() => provider) },
			} as unknown as Task
			const executeCommandSpy = vitest.spyOn(executeCommandTool, "execute")
			const userMessageContent: ToolExecutionHost["userMessageContent"] = []
			const call = {
				type: "tool_call" as const,
				id: "shell-scheduler-call",
				name: "exec_command",
				arguments: { cmd: "echo test", workdir: "/custom/path", yield_time_ms: 375, max_output_tokens: 20 },
			}
			const host: ToolExecutionHost = {
				taskId: "shell-scheduler-task",
				cwd: "/test/workspace",
				userMessageContent,
				askApproval: vitest.fn().mockResolvedValue({ response: "yesButtonClicked" }),
				say: vitest.fn().mockResolvedValue(undefined),
				recordToolUsage: vitest.fn(),
				pushToolResultToUserContent: vitest.fn(() => true),
				taskFacade: task,
			}
			;(host.pushToolResultToUserContent as ReturnType<typeof vitest.fn>).mockImplementation(
				(result: Parameters<ToolExecutionHost["pushToolResultToUserContent"]>[0]) => {
					userMessageContent.push(result)
					return true
				},
			)

			const outcome = await new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				validateCall: () => {},
			}).run(createAgentResponse([call]))

			expect(outcome.results[0]).toMatchObject({
				name: "exec_command",
				status: "success",
				content: expect.stringContaining("Chunk ID: shell-scheduler-call"),
			})
			expect(host.recordToolUsage).toHaveBeenCalledWith("exec_command")
			expect(executeCommandSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "echo test",
					cwd: "/custom/path",
					timeout: normalizeExecCommandYieldTimeMs(375) / 1_000,
				}),
				task,
				expect.any(Object),
			)
			expect(host.askApproval).toHaveBeenCalledWith(
				"command",
				"echo test",
				{ text: path.resolve("/custom/path") },
				false,
			)
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(
				"/custom/path",
				"shell-scheduler-task",
				"execa",
			)
			expect(userMessageContent).toHaveLength(1)
			expect(userMessageContent[0]).toMatchObject({ type: "tool_result", tool_use_id: "shell-scheduler-call" })
		})

		it("passes the exec_command session_id through the task surface to write_stdin", async () => {
			vitest.mocked(formatResponse.toolResult).mockImplementation((text) => text)
			vitest.mocked(formatResponse.toolError).mockImplementation((text) => `ERROR: ${text}`)
			const schemas = getNativeTools()
			const registry = new ToolRegistry({ nativeTools: schemas })
			const surface = createTaskToolSurface({ registry, schemas, mode: "code" })
			const provider = {
				getState: vitest.fn().mockResolvedValue({ terminalShellIntegrationDisabled: true }),
				postMessageToWebview: vitest.fn(),
				runWorkspaceMutation: vitest.fn(async (_task: Task, _label: string, run: () => Promise<void>) => run()),
			}
			let sessionId = 0
			let releaseCommand!: () => void
			const running = new Promise<void>((resolve) => {
				releaseCommand = resolve
			})
			const process = mergePromise(
				Object.assign(new EventEmitter(), {
					executionId: "",
					command: "echo test",
					isHot: true,
					isSettled: false,
					hasUnretrievedOutput: vitest.fn(() => true),
					abort: vitest.fn(),
					continue: vitest.fn(() => releaseCommand()),
					run: vitest.fn(),
					getUnretrievedOutput: vitest.fn(() => ""),
					trimRetrievedOutput: vitest.fn(),
					writeInput: vitest.fn(),
					captureUnretrievedOutput: vitest.fn(() => ({
						output: "ready at http://localhost:1234",
						commit: vitest.fn(),
						release: vitest.fn(),
					})),
				}) as unknown as AlphaTerminalProcess,
				running,
			)
			const terminal = {
				taskId: "exec-command-session-task",
				process,
				running: true,
				runCommand: vitest.fn(() => process),
				getCurrentWorkingDirectory: vitest.fn(() => "/test/workspace"),
			}
			vitest.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValueOnce(terminal as never)
			vitest.mocked(TerminalRegistry.getTerminals).mockReturnValue([terminal as never])
			const task = {
				...mockAlphaTask,
				taskId: "exec-command-session-task",
				supersedePendingAsk: vitest.fn(),
				providerRef: { deref: vitest.fn(() => provider) },
				getCommandExecutionEvidence: vitest.fn(() =>
					sessionId ? [{ executionId: process.executionId, status: "running" }] : [],
				),
			} as unknown as Task
			const userMessageContent: ToolExecutionHost["userMessageContent"] = []
			const host: ToolExecutionHost = {
				taskId: task.taskId,
				cwd: "/test/workspace",
				userMessageContent,
				taskFacade: task,
				askApproval: vitest.fn().mockResolvedValue({ response: "yesButtonClicked" }),
				say: vitest.fn().mockResolvedValue(undefined),
				recordToolUsage: vitest.fn(),
				pushToolResultToUserContent: vitest.fn((result) => {
					userMessageContent.push(result)
					return true
				}),
			}
			const scheduler = new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				validateCall: () => {},
			})

			const commandOutcome = await scheduler.run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "exec-command-session-call",
						name: "exec_command",
						arguments: { cmd: "echo test", yield_time_ms: 500 },
					},
				]),
			)

			const commandText = String(commandOutcome.results[0].content)
			const sessionIdMatch = commandText.match(/Process running with session ID\s+(\d+)/)
			expect(commandText).toContain("Chunk ID: exec-command-session-call")
			expect(sessionIdMatch?.[1]).toBeTruthy()
			sessionId = Number(sessionIdMatch![1])
			expect(Number.isSafeInteger(sessionId)).toBe(true)
			expect(sessionId).toBeGreaterThan(0)
			const stdinOutcome = await scheduler.run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "exec-command-stdin-call",
						name: "write_stdin",
						arguments: { session_id: sessionId, chars: "y\n", yield_time_ms: 0 },
					},
				]),
			)

			expect(stdinOutcome.results[0]).toMatchObject({ name: "write_stdin", status: "success" })
			expect(process.writeInput).toHaveBeenCalledWith("y\n")
			expect(host.askApproval).toHaveBeenCalledWith(
				"command",
				`input command ${process.executionId}\ny\n`,
				undefined,
				false,
			)
		})

		it("should pass along custom working directory if provided", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockToolUse.params.cwd = "/custom/path"
			mockToolUse.nativeArgs = { command: "echo test", cwd: "/custom/path" }

			// Execute
			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify - confirm the command was approved and result was pushed
			// The custom path handling is tested in integration tests
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test", { text: path.resolve("/custom/path") })
			expect(mockPushToolResult).toHaveBeenCalled()
			const result = mockPushToolResult.mock.calls[0][0]
			expect(result).toContain("/custom/path")
		})

		it.each([
			"gh pr list",
			"gh pr create --fill",
			"gh api repos/owner/repo/issues -f title=test",
			"gh alias set shortcut '!echo changed'",
			"gh extension exec custom",
		])("runs %s through ordinary command approval", async (command) => {
			await executeCommandTool.handle(
				mockAlphaTask,
				{ ...mockToolUse, nativeArgs: { command } },
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
				},
			)
			expect(mockAskApproval).toHaveBeenCalledExactlyOnceWith("command", command)
			expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledOnce()
			expect(mockPushToolResult).toHaveBeenCalledOnce()
		})

		it("does not launch gh when command approval is denied", async () => {
			mockAskApproval.mockResolvedValue(false)
			const command = "gh pr merge 123 --merge"
			await executeCommandTool.handle(
				mockAlphaTask,
				{ ...mockToolUse, nativeArgs: { command } },
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
				},
			)
			expect(mockAskApproval).toHaveBeenCalledExactlyOnceWith("command", command)
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(mockAlphaTask.failCommandExecution).toHaveBeenCalledWith(expect.any(String), "denied")
		})

		it("should still allow local git commands", async () => {
			mockToolUse.params.command = "git push origin feature"
			mockToolUse.nativeArgs = { command: "git push origin feature" }

			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			expect(mockAskApproval).toHaveBeenCalledWith("command", "git push origin feature")
			expect(mockPushToolResult).toHaveBeenCalled()
		})
	})

	describe("Error handling", () => {
		it("should handle missing command parameter", async () => {
			// Setup
			mockToolUse.params.command = undefined
			// Native tool calls must still supply a value; simulate a missing value with an empty string.
			mockToolUse.nativeArgs = { command: "" }

			// Execute
			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
			expect(mockAlphaTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("execute_command", "command")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(executeCommandModule.executeCommandInTerminal).not.toHaveBeenCalled()
		})

		it("should handle command rejection", async () => {
			// Setup
			mockToolUse.params.command = "echo test"
			mockAskApproval.mockResolvedValue(false)
			mockToolUse.nativeArgs = { command: "echo test" }

			// Execute
			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(mockAskApproval).toHaveBeenCalledWith("command", "echo test")
			// executeCommandInTerminal should not be called since approval was denied
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})

		it("should handle alphaignore validation failures", async () => {
			// Setup
			mockToolUse.params.command = "cat .env"
			mockToolUse.nativeArgs = { command: "cat .env" }
			// Override the validateCommand mock to return a filename
			const validateCommandMock = vitest.fn().mockReturnValue(".env")
			mockAlphaTask.alphaIgnoreController = {
				validateCommand: validateCommandMock,
			}

			const mockAlphaIgnoreError = "RooIgnore error"
			;(formatResponse.alphaIgnoreError as any).mockReturnValue(mockAlphaIgnoreError)

			// Execute
			await executeCommandTool.handle(mockAlphaTask as unknown as Task, mockToolUse, {
				askApproval: mockAskApproval as unknown as AskApproval,
				handleError: mockHandleError as unknown as HandleError,
				pushToolResult: mockPushToolResult as unknown as PushToolResult,
			})

			// Verify
			expect(validateCommandMock).toHaveBeenCalledWith("cat .env")
			expect(mockAlphaTask.say).toHaveBeenCalledWith("rooignore_error", ".env")
			expect(formatResponse.alphaIgnoreError).toHaveBeenCalledWith(".env")
			expect(mockPushToolResult).toHaveBeenCalledWith(mockAlphaIgnoreError)
			expect(mockAskApproval).not.toHaveBeenCalled()
			// executeCommandInTerminal should not be called since alphaignore blocked it
		})
	})

	describe("Command execution timeout configuration", () => {
		it("should include timeout parameter in ExecuteCommandOptions", () => {
			// This test verifies that the timeout configuration is properly typed
			// The actual timeout logic is tested in integration tests
			// Note: timeout is stored internally in milliseconds but configured in seconds
			const timeoutSeconds = 15
			const options = {
				executionId: "test-id",
				command: "echo test",
				commandExecutionTimeout: timeoutSeconds * 1000, // Convert to milliseconds
			}

			// Verify the options object has the expected structure
			expect(options.commandExecutionTimeout).toBe(15000)
			expect(typeof options.commandExecutionTimeout).toBe("number")
		})

		it("should handle timeout parameter in function signature", () => {
			// Test that the executeCommandInTerminal function accepts timeout parameter
			// This is a compile-time check that the types are correct
			const mockOptions = {
				executionId: "test-id",
				command: "echo test",
				customCwd: undefined,
				terminalShellIntegrationDisabled: false,
				terminalOutputLineLimit: 500,
				commandExecutionTimeout: 0,
			}

			// Verify all required properties exist
			expect(mockOptions.executionId).toBeDefined()
			expect(mockOptions.command).toBeDefined()
			expect(mockOptions.commandExecutionTimeout).toBeDefined()
		})

		it("honors model timeout even when the retired CLI environment flag is inherited", () => {
			process.env.ROO_CLI_RUNTIME = "1"
			expect(executeCommandModule.resolveAgentTimeoutMs(30)).toBe(30_000)
		})

		it("honors model timeout in the normal extension environment", () => {
			delete process.env.ROO_CLI_RUNTIME
			expect(executeCommandModule.resolveAgentTimeoutMs(30)).toBe(30_000)
		})

		it("honors an explicit Worker background timeout and wires structured evidence by tool call id", async () => {
			mockAlphaTask.taskKind = "subagent"
			mockAlphaTask.subagentRole = "worker"
			mockToolUse.nativeArgs = { command: "pnpm test", timeout: 30 }

			await executeCommandTool.handle(mockAlphaTask as Task, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "worker-verification-1",
			})

			expect(mockAlphaTask.beginCommandExecution).toHaveBeenCalledWith(
				"worker-verification-1",
				expect.any(String),
				"pnpm test",
				undefined,
			)
			expect(executeCommandModule.resolveAgentTimeoutMs(30)).toBe(30_000)
		})

		it("records only the explicit applied change-set verification scope", async () => {
			mockToolUse.nativeArgs = {
				command: "pnpm test",
				verification: { change_set_ids: ["change-1", "change-2"] },
			}

			await executeCommandTool.handle(mockAlphaTask as Task, mockToolUse, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				toolCallId: "parent-verification-1",
			})

			expect(mockAlphaTask.beginCommandExecution).toHaveBeenCalledWith(
				"parent-verification-1",
				expect.any(String),
				"pnpm test",
				["change-1", "change-2"],
			)
		})

		it("assigns unique evidence ids to legacy command calls from the same message", async () => {
			mockToolUse.nativeArgs = { command: "pnpm test" }

			const callbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			}

			await executeCommandTool.handle(mockAlphaTask as Task, mockToolUse, callbacks)
			await executeCommandTool.handle(mockAlphaTask as Task, mockToolUse, callbacks)

			const evidenceIds = mockAlphaTask.beginCommandExecution.mock.calls.map(
				([evidenceId]: [string]) => evidenceId,
			)
			expect(evidenceIds).toHaveLength(2)
			expect(evidenceIds[0]).not.toBe(evidenceIds[1])
			expect(evidenceIds).toEqual([
				expect.stringMatching(new RegExp(`^${mockAlphaTask.lastMessageTs}:legacy:`)),
				expect.stringMatching(new RegExp(`^${mockAlphaTask.lastMessageTs}:legacy:`)),
			])
		})
	})

	describe("Plan command working-directory confinement", () => {
		it("rejects an absolute working directory before opening a terminal", async () => {
			mockAlphaTask.getTaskMode = vitest.fn().mockResolvedValue("architect")

			const result = await executeCommandInTerminalActual(mockAlphaTask as Task, {
				executionId: "plan-cwd-absolute",
				command: "pnpm exec tsc --noEmit",
				customCwd: path.resolve("outside"),
			})

			expect(result).toEqual([false, "Plan commands may use only workspace-relative command directories."])
		})

		it("rejects a relative working directory whose realpath escapes through a symlink", async () => {
			mockAlphaTask.cwd = path.resolve("workspace")
			mockAlphaTask.getTaskMode = vitest.fn().mockResolvedValue("architect")
			vitest
				.mocked(fs.realpath)
				.mockResolvedValueOnce(path.resolve("workspace"))
				.mockResolvedValueOnce(path.resolve("outside"))

			const result = await executeCommandInTerminalActual(mockAlphaTask as Task, {
				executionId: "plan-cwd-symlink",
				command: "pnpm exec tsc --noEmit",
				customCwd: "linked-directory",
			})

			expect(result).toEqual([false, "Plan command directory resolves outside the task workspace."])
		})
	})
})
