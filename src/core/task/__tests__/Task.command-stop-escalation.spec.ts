import * as vscode from "vscode"

import { Terminal } from "../../../integrations/terminal/Terminal"
import { TerminalProcess } from "../../../integrations/terminal/TerminalProcess"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { Task } from "../Task"

function runningCommand() {
	let releaseOutput!: () => void
	const output = new Promise<void>((resolve) => (releaseOutput = resolve))
	const host = {
		shellIntegration: { executeCommand: vi.fn() },
		sendText: vi.fn(),
		dispose: vi.fn(),
	}
	const terminal = new Terminal(90_010, host as unknown as vscode.Terminal, process.cwd())
	const command = new TerminalProcess(terminal)
	command.executionId = "owned-execution"
	terminal.process = command
	terminal.taskId = "cancelled-task"
	host.shellIntegration.executeCommand.mockImplementation(() =>
		terminal.setActiveStream(
			(async function* () {
				yield "\x1b]633;C\x07ready\n"
				await output
			})(),
		),
	)
	const run = command.run("controlled command").catch(() => undefined)
	return {
		host,
		terminal,
		command,
		async finish() {
			command.notifyTerminalClosed()
			releaseOutput()
			await run
		},
	}
}

describe("task cancellation of owned VS Code commands", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it.each([
		{ background: false, outputReaderFailed: false },
		{ background: true, outputReaderFailed: false },
		{ background: true, outputReaderFailed: true },
	])(
		"joins terminal close after an ignored interrupt (background=$background, outputReaderFailed=$outputReaderFailed)",
		async ({ background, outputReaderFailed }) => {
			const fixture = runningCommand()
			if (outputReaderFailed) {
				fixture.command.emit("error", new Error("Output reader failed"))
				expect(fixture.command.isSettled).toBe(true)
				expect(fixture.terminal.running).toBe(true)
			}
			const foreign = {
				executionId: "another-execution",
				abort: vi.fn(),
				terminate: vi.fn(),
			}
			vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([
				fixture.terminal,
				{ process: foreign, running: true },
			] as never)
			const task = Object.assign(Object.create(Task.prototype), {
				taskId: "cancelled-task",
				taskKind: "primary",
				providerRef: { deref: () => undefined },
				terminalProcess: background ? undefined : fixture.command,
				commandExecutionEvidence: new Map(),
			}) as Task
			task.beginCommandExecution("owned-call", fixture.command.executionId!)
			const settled = vi.fn()
			const stopping = (
				task as unknown as { stopActiveTaskCommands(includeUntrackedTaskProcesses: boolean): Promise<void> }
			)
				.stopActiveTaskCommands(false)
				.then(settled)
			try {
				expect(fixture.host.sendText).toHaveBeenCalledExactlyOnceWith("\x03")
				await vi.advanceTimersByTimeAsync(250)
				expect(fixture.host.dispose).toHaveBeenCalledOnce()
				expect(settled).not.toHaveBeenCalled()
				expect(fixture.terminal.process).toBe(fixture.command)
				expect(foreign.abort).not.toHaveBeenCalled()
				expect(foreign.terminate).not.toHaveBeenCalled()
				fixture.command.notifyTerminalClosed()
				await vi.advanceTimersByTimeAsync(0)
				expect(settled).toHaveBeenCalledOnce()
				await stopping
				expect(task.getCommandExecutionEvidence()).toEqual([
					expect.objectContaining({ toolCallId: "owned-call", status: "cancelled" }),
				])
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				await fixture.finish()
				const cleanup = stopping.catch(() => undefined)
				await vi.runAllTimersAsync()
				await cleanup
			}
		},
	)
})
