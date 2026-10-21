import { EventEmitter } from "node:events"
import * as vscode from "vscode"

import type { Task, CommandExecutionEvidence } from "../../task/Task"
import { createToolPolicySnapshot, resolveCommandTimeoutMs } from "../../agent/ToolPolicy"
import { compareWorkspaceMutationState, createWorkspaceMutationDiffs } from "../../agent/VerificationScope"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { ToolCallbacks } from "../BaseTool"
import { executeCommandTool } from "../ExecuteCommandTool"
import { ToolRegistry } from "../ToolRegistry"
import { commandSessionRegistry } from "../CommandSessionRegistry"

vi.mock("fs/promises", () => ({
	default: {
		access: vi.fn(async () => undefined),
		realpath: vi.fn(async (value: string) => value),
	},
}))
vi.mock("../../agent/VerificationScope", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/VerificationScope")>()),
	captureWorkspaceMutationState: vi.fn(async () => ({})),
	captureWorkspaceMutationDiffBaseline: vi.fn(async () => ({})),
	compareWorkspaceMutationState: vi.fn(async () => ({ changedPaths: [], files: {} })),
	createWorkspaceMutationDiffs: vi.fn(async () => []),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function fixture() {
	const cwd = process.cwd()
	const lifetime = new AbortController()
	const step = new AbortController()
	const launched = deferred<void>()
	const outcome = deferred<void>()
	let terminalCallbacks!: AlphaTerminalCallbacks
	const commandProcess = Object.assign(new EventEmitter(), {
		isSettled: false,
		then: outcome.promise.then.bind(outcome.promise),
		catch: outcome.promise.catch.bind(outcome.promise),
		finally: outcome.promise.finally.bind(outcome.promise),
		continue: vi.fn(),
		abort: vi.fn(async () => finish(130)),
	})
	const terminal = {
		id: 1,
		provider: "execa" as const,
		taskId: "captured-command-policy",
		process: commandProcess,
		running: true,
		getCurrentWorkingDirectory: () => cwd,
		runCommand: vi.fn((_command: string, callbacks: AlphaTerminalCallbacks) => {
			terminalCallbacks = callbacks
			launched.resolve()
			return commandProcess
		}),
	}
	const provider = {
		getValue: (key: string) => (key === "terminalShellIntegrationDisabled" ? true : undefined),
		postMessageToWebview: vi.fn(),
		runWorkspaceMutation: async (_task: Task, _name: string, run: () => Promise<void>) => run(),
		reservePrimaryMutation: vi.fn(async () => undefined),
		releasePrimaryMutation: vi.fn(async () => undefined),
		recordPrimaryMutation: vi.fn(async () => true),
	}
	const evidence = new Map<string, CommandExecutionEvidence>()
	const taskState = {
		taskId: terminal.taskId,
		taskKind: "primary",
		cwd,
		abort: false,
		clineMessages: [],
		providerRef: { deref: () => provider },
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		getTaskMode: vi.fn(async () => "code"),
		presentApprovedCommand: vi.fn(async () => "approved-command"),
		beginCommandExecution: vi.fn((toolCallId: string, executionId: string) => {
			evidence.set(toolCallId, { toolCallId, executionId, status: "running", startedAt: 0 })
		}),
		admitCommandExecution: vi.fn(async () => undefined),
		completeCommandExecution: vi.fn((toolCallId: string, details: { exitCode?: number }) => {
			const entry = evidence.get(toolCallId)
			if (entry) Object.assign(entry, { status: details.exitCode === 0 ? "succeeded" : "failed", ...details })
		}),
		failCommandExecution: vi.fn((toolCallId: string, status = "failed") => {
			const entry = evidence.get(toolCallId)
			if (entry) Object.assign(entry, { status })
		}),
		getCommandExecutionEvidence: () => [...evidence.values()],
		markCommandExecutionBackgrounded: vi.fn(),
		recordToolError: vi.fn(),
		say: vi.fn(async (_kind: string, _text?: string) => undefined),
		supersedePendingAsk: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
	}
	const task = taskState as unknown as Task
	const callbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		toolCallId: "captured-call",
		signal: step.signal,
	} satisfies ToolCallbacks
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockResolvedValue(terminal as never)
	vi.spyOn(TerminalRegistry, "releaseTerminalReservation").mockImplementation(() => undefined)
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	async function finish(exitCode = 0) {
		terminalCallbacks.onShellExecutionComplete({ exitCode }, commandProcess as unknown as AlphaTerminalProcess)
		await terminalCallbacks.onCompleted("finished", commandProcess as unknown as AlphaTerminalProcess)
		commandProcess.isSettled = true
		terminal.running = false
		commandProcess.emit("completed")
		outcome.resolve()
	}
	return { task, taskState, terminal, process: commandProcess, provider, callbacks, step, lifetime, launched, finish }
}

async function runCommand(test: ReturnType<typeof fixture>, prepared: boolean, callbacks: ToolCallbacks) {
	const params = { command: "echo owned", timeout: 1 }
	if (!prepared) return executeCommandTool.execute(params, test.task, callbacks)
	const read = await executeCommandTool.prepareApprovedRead(params, test.task, callbacks, {
		directCommand: { executable: "audited-reader", args: [], env: {} },
		beforeLaunch: async () => undefined,
	})
	if (!read) throw new Error("Prepared read was not admitted")
	const finalize = await read.run(callbacks)
	await finalize()
	read.commit()
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("ordinary command captured policy", () => {
	it.each(["exec_command", "execute_command"])(
		"does not launch %s when only the step signal aborts during terminal acquisition",
		async (name) => {
			const test = fixture()
			const terminal = deferred<Awaited<ReturnType<typeof TerminalRegistry.getOrCreateTerminal>>>()
			const acquiring = deferred<void>()
			vi.mocked(TerminalRegistry.getOrCreateTerminal).mockImplementation(async () => {
				acquiring.resolve()
				return terminal.promise
			})
			const execution = new ToolRegistry().resolve(name)!.execute({
				task: test.task,
				call: {
					type: "tool_use",
					id: "captured-call",
					name: "exec_command",
					params: {},
					nativeArgs: { cmd: "echo owned" },
					partial: false,
				},
				callbacks: test.callbacks,
			})
			await Promise.race([
				acquiring.promise,
				execution.then(() => {
					throw new Error(
						`Command returned before terminal acquisition: ${test.callbacks.handleError.mock.calls}`,
					)
				}),
			])
			test.step.abort(new Error("new user steering"))
			terminal.resolve(test.terminal as never)
			// A defective dispatch must also settle, without launching a real process.
			void test.launched.promise.then(() => test.finish())
			await execution

			expect(test.terminal.runCommand).not.toHaveBeenCalled()
			expect(TerminalRegistry.releaseTerminalReservation).toHaveBeenCalledOnce()
			expect(test.provider.reservePrimaryMutation).not.toHaveBeenCalled()
			expect(test.taskState.failCommandExecution).toHaveBeenCalledExactlyOnceWith("captured-call", "cancelled")
			expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(test.callbacks.setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({ status: "cancelled" }),
			)
		},
	)

	it("releases its mutation reservation when only step cancellation wins command admission", async () => {
		const test = fixture()
		const admitted = deferred<void>()
		const admission = deferred<void>()
		test.taskState.admitCommandExecution.mockImplementation(async () => {
			admitted.resolve()
			await admission.promise
		})
		const execution = executeCommandTool.execute({ command: "echo owned" }, test.task, test.callbacks)
		await admitted.promise
		test.step.abort()
		admission.resolve()
		void test.launched.promise.then(() => test.finish())
		await execution

		expect(test.terminal.runCommand).not.toHaveBeenCalled()
		expect(test.provider.reservePrimaryMutation).toHaveBeenCalledOnce()
		expect(test.provider.releasePrimaryMutation).toHaveBeenCalledExactlyOnceWith(test.task, expect.any(String))
		expect(test.taskState.failCommandExecution).toHaveBeenCalledExactlyOnceWith("captured-call", "cancelled")
	})

	it.each([false, true])(
		"uses the captured hard timeout after live settings change (prepared: %s)",
		async (prepared) => {
			const test = fixture()
			const policy = createToolPolicySnapshot({
				visibleTools: ["exec_command"],
				execution: { command: { userTimeoutMs: 2_000 } },
			})
			const resolver = vi.fn((requested: number | null | undefined, command: string) =>
				resolveCommandTimeoutMs(policy, requested ?? 0, command),
			)
			vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
				get: (_key: string, fallback: unknown) => fallback,
			} as vscode.WorkspaceConfiguration)
			vi.useFakeTimers()
			const execution = runCommand(test, prepared, {
				...test.callbacks,
				resolveCommandTimeoutMs: resolver,
			})
			try {
				await test.launched.promise
				await vi.advanceTimersByTimeAsync(1_100)
				await execution
				await vi.advanceTimersByTimeAsync(900)

				expect(resolver).toHaveBeenCalledExactlyOnceWith(0, "echo owned")
				expect(test.process.abort).toHaveBeenCalledOnce()
				expect(test.taskState.failCommandExecution).toHaveBeenCalledExactlyOnceWith(
					"captured-call",
					"timed_out",
					expect.any(String),
				)
			} finally {
				if (!test.process.isSettled) await test.finish()
			}
		},
	)

	it.each([false, true])("keeps a launched command task-owned after handoff (prepared: %s)", async (prepared) => {
		const test = fixture()
		vi.mocked(compareWorkspaceMutationState).mockResolvedValueOnce({
			changedPaths: ["owned.txt"],
			files: { "owned.txt": "changed" },
		})
		vi.mocked(createWorkspaceMutationDiffs).mockResolvedValueOnce([
			{
				path: "owned.txt",
				diff: "owned diff",
				diffStats: { added: 1, removed: 0 },
				originalContent: "",
				finalContent: "changed",
			},
		])
		vi.useFakeTimers()
		const execution = runCommand(test, prepared, test.callbacks)
		await test.launched.promise
		// Ordinary resumable commands transfer at launch; speculative reads wait
		// until scheduler presentation commits before their step can release them.
		if (!prepared) test.step.abort(new Error("new user steering"))
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		if (prepared) test.step.abort(new Error("new user steering"))
		const result = test.callbacks.pushToolResult.mock.calls[0][0] as string
		const sessionId = Number(result.match(/session ID (\d+)/)?.[1])
		expect(commandSessionRegistry.resolve(test.task, sessionId)?.process).toBe(test.process)
		expect(test.process.abort).not.toHaveBeenCalled()
		await test.finish()
		await vi.advanceTimersByTimeAsync(0)
		expect(test.taskState.completeCommandExecution).toHaveBeenCalledOnce()
		expect(test.taskState.say).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"path":"owned.txt"'),
			undefined,
			false,
			undefined,
			undefined,
			expect.objectContaining({ isNonInteractive: true }),
		)
		commandSessionRegistry.release(test.task, sessionId)
	})
})
