import * as vscode from "vscode"

import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"

function runningCommand() {
	let releaseOutput!: () => void
	const output = new Promise<void>((resolve) => (releaseOutput = resolve))
	const host = {
		shellIntegration: { executeCommand: vi.fn() },
		sendText: vi.fn(),
		dispose: vi.fn(),
	}
	const terminal = new Terminal(90_001, host as unknown as vscode.Terminal, process.cwd())
	const command = new TerminalProcess(terminal)
	terminal.process = command
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

describe("VS Code command hard termination", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("joins physical terminal close after an ignored interrupt and owned disposal", async () => {
		const fixture = runningCommand()
		const settled = vi.fn()
		try {
			const stopping = fixture.command.terminate().then(settled)
			expect(fixture.host.sendText).toHaveBeenCalledExactlyOnceWith("\x03")
			await vi.advanceTimersByTimeAsync(249)
			expect(fixture.host.dispose).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(fixture.host.dispose).toHaveBeenCalledOnce()
			expect(settled).not.toHaveBeenCalled()
			expect(fixture.terminal.process).toBe(fixture.command)
			fixture.command.notifyTerminalClosed()
			await stopping
			expect(settled).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			await fixture.finish()
		}
	})

	it("accepts shell exit during the interrupt grace without disposing a reusable terminal", async () => {
		const fixture = runningCommand()
		try {
			const stopping = fixture.command.terminate()
			fixture.terminal.shellExecutionComplete({ exitCode: 130, signalName: "SIGINT" })
			await stopping
			expect(fixture.host.dispose).not.toHaveBeenCalled()
		} finally {
			await fixture.finish()
		}
	})

	it("does not dispose a replacement command after ownership changes during the grace", async () => {
		const fixture = runningCommand()
		try {
			const stopping = fixture.command.terminate()
			const rejected = expect(stopping).rejects.toThrow("Command ownership changed")
			const replacement = new TerminalProcess(fixture.terminal)
			fixture.terminal.process = replacement
			await vi.advanceTimersByTimeAsync(250)
			await rejected
			expect(fixture.host.dispose).not.toHaveBeenCalled()
			expect(fixture.terminal.process).toBe(replacement)
		} finally {
			await fixture.finish()
		}
	})

	it("retains an unconfirmed owner after a close deadline and permits an explicit cleanup retry", async () => {
		const fixture = runningCommand()
		try {
			const stopping = fixture.command.terminate()
			const rejected = expect(stopping).rejects.toThrow("Timed out waiting for the owned terminal to close")
			await vi.advanceTimersByTimeAsync(5_250)
			await rejected
			expect(fixture.terminal.process).toBe(fixture.command)
			expect(fixture.terminal.running).toBe(true)
			expect(fixture.command.isSettled).toBe(false)
			const retry = fixture.command.terminate()
			fixture.command.notifyTerminalClosed()
			await retry
			expect(fixture.host.sendText).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			await fixture.finish()
		}
	})

	it("retries failed disposal against the same owner", async () => {
		const fixture = runningCommand()
		fixture.host.dispose.mockImplementationOnce(() => {
			throw new Error("terminal transport failed")
		})
		try {
			const stopping = fixture.command.terminate()
			const rejected = expect(stopping).rejects.toThrow("terminal transport failed")
			await vi.advanceTimersByTimeAsync(250)
			await rejected
			const retry = fixture.command.terminate()
			await vi.advanceTimersByTimeAsync(250)
			fixture.command.notifyTerminalClosed()
			await retry
			expect(fixture.host.dispose).toHaveBeenCalledTimes(2)
			expect(fixture.host.sendText).toHaveBeenCalledOnce()
		} finally {
			await fixture.finish()
		}
	})

	it("settles a cancelled prelaunch once without submitting work or disposing its shell", async () => {
		const host = { shellIntegration: { executeCommand: vi.fn() }, sendText: vi.fn(), dispose: vi.fn() }
		const terminal = new Terminal(90_002, host as unknown as vscode.Terminal, process.cwd())
		const command = new TerminalProcess(terminal)
		terminal.process = command
		const completed = vi.fn()
		const exited = vi.fn()
		command.on("completed", completed)
		command.on("shell_execution_complete", exited)
		await command.terminate()
		await command.run("must not launch")
		expect(completed).toHaveBeenCalledOnce()
		expect(exited).toHaveBeenCalledExactlyOnceWith({ exitCode: 130, signalName: "SIGINT" })
		expect(host.shellIntegration.executeCommand).not.toHaveBeenCalled()
		expect(host.sendText).not.toHaveBeenCalled()
		expect(host.dispose).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
