import * as vscode from "vscode"

import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"
import type { AlphaTerminalCallbacks } from "../types"

vi.mock("../../../services/ripgrep", () => ({ resolveRipgrepBinary: vi.fn() }))
vi.mock("vscode", () => ({
	ThemeIcon: vi.fn(),
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
	window: {
		createTerminal: vi.fn(),
		onDidStartTerminalShellExecution: vi.fn(),
		onDidEndTerminalShellExecution: vi.fn(),
		onDidCloseTerminal: vi.fn(),
	},
}))

const cwd = process.cwd()

function barrier() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => (release = resolve))
	return { promise, release }
}

function execution(read: () => AsyncIterable<string>) {
	return {
		commandLine: { value: "same command", isTrusted: true, confidence: 2 },
		cwd: undefined,
		read: vi.fn(read),
	} satisfies vscode.TerminalShellExecution
}

describe("VS Code shell execution ownership", () => {
	let start: (event: vscode.TerminalShellExecutionStartEvent) => unknown
	let end: (event: vscode.TerminalShellExecutionEndEvent) => unknown
	let close: (terminal: vscode.Terminal) => unknown
	const hosts: vscode.Terminal[] = []

	beforeAll(() => {
		vi.mocked(vscode.window.onDidStartTerminalShellExecution).mockImplementation((listener) => {
			start = listener
			return { dispose: vi.fn() }
		})
		vi.mocked(vscode.window.onDidEndTerminalShellExecution).mockImplementation((listener) => {
			end = listener
			return { dispose: vi.fn() }
		})
		vi.mocked(vscode.window.onDidCloseTerminal).mockImplementation((listener) => {
			close = listener
			return { dispose: vi.fn() }
		})
		TerminalRegistry.initialize()
	})

	afterEach(() => {
		for (const host of hosts.splice(0)) close(host)
	})
	afterAll(() => TerminalRegistry.cleanup())

	async function reserve(taskId: string) {
		const executeCommand = vi.fn<(command: string) => vscode.TerminalShellExecution>()
		const host = { exitStatus: undefined, shellIntegration: { executeCommand } } as unknown as vscode.Terminal
		vi.mocked(vscode.window.createTerminal).mockReturnValue(host)
		const terminal = (await TerminalRegistry.getOrCreateTerminal(cwd, taskId)) as Terminal
		hosts.push(terminal.terminal)
		const shellIntegration = terminal.terminal.shellIntegration!
		return {
			terminal,
			executeCommand,
			start: (execution: vscode.TerminalShellExecution) =>
				start({ terminal: terminal.terminal, shellIntegration, execution }),
			end: (execution: vscode.TerminalShellExecution, exitCode = 0) =>
				end({ terminal: terminal.terminal, shellIntegration, execution, exitCode }),
		}
	}

	function callbacks() {
		return {
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		} satisfies AlphaTerminalCallbacks
	}

	it("uses the returned execution when commands match and events arrive during submission", async () => {
		const shell = await reserve("owned")
		const submitted = barrier()
		const foreign = execution(async function* () {
			yield "\x1b]633;C\x07unrelated\n"
		})
		const owned = execution(async function* () {
			yield "\x1b]633;C\x07owned\n"
		})
		shell.executeCommand.mockImplementation(() => {
			shell.start(foreign)
			shell.end(foreign, 9)
			shell.start(owned)
			submitted.release()
			return owned
		})
		const observed = callbacks()
		const command = shell.terminal.runCommand("same command", observed)
		await submitted.promise
		shell.start(owned)
		shell.end(foreign, 9)
		const stillOwned = shell.terminal.process === command && shell.terminal.running
		const earlyCompletions = observed.onShellExecutionComplete.mock.calls.length
		shell.end(owned, 0)
		await command
		await command.waitForOutputFinalization?.()
		expect(stillOwned).toBe(true)
		expect(earlyCompletions).toBe(0)
		expect(foreign.read).not.toHaveBeenCalled()
		expect(owned.read).toHaveBeenCalledOnce()
		expect(observed.onShellExecutionStarted).toHaveBeenCalledOnce()
		expect(observed.onShellExecutionComplete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 }, command)
		expect(observed.onCompleted).toHaveBeenCalledExactlyOnceWith("owned\n", command)
	})

	it.each(["completes", "fails"] as const)("retains a newer reservation when the old reader %s", async (outcome) => {
		const shell = await reserve("old")
		const reading = barrier()
		const drain = barrier()
		const failure = new Error("reader failed")
		const owned = execution(async function* () {
			yield "\x1b]633;C\x07old output\n"
			reading.release()
			await drain.promise
			if (outcome === "fails") throw failure
		})
		shell.executeCommand.mockImplementation(() => {
			shell.start(owned)
			return owned
		})
		const command = shell.terminal.runCommand("same command", callbacks())
		const result = Promise.resolve(command).catch((error: unknown) => error)
		await reading.promise
		shell.end(owned)
		const reserved = await TerminalRegistry.getOrCreateTerminal(cwd, "next")
		expect(reserved).toBe(shell.terminal)
		drain.release()
		expect(await result).toBe(outcome === "fails" ? failure : undefined)
		await command.waitForOutputFinalization?.()
		expect(reserved.busy).toBe(true)
		expect(reserved.taskId).toBe("next")
	})

	it("keeps an accepted command's terminal reserved when the start stream never arrives", async () => {
		const shell = await reserve("missing-stream")
		const owned = execution(async function* () {})
		shell.executeCommand.mockReturnValue(owned)
		const observed = { ...callbacks(), onNoShellIntegration: vi.fn() }
		vi.useFakeTimers()
		try {
			const command = shell.terminal.runCommand("same command", observed)
			await vi.advanceTimersByTimeAsync(Terminal.getShellIntegrationTimeout())
			await command
			expect(observed.onNoShellIntegration).toHaveBeenCalledOnce()
			expect(shell.terminal.busy).toBe(true)
			expect(shell.terminal.running).toBe(true)
			expect(shell.terminal.process).toBe(command)
			shell.start(owned)
			expect(owned.read).not.toHaveBeenCalled()
			shell.end(owned)
			expect(shell.terminal.busy).toBe(false)
			expect(shell.terminal.running).toBe(false)
			expect(observed.onShellExecutionComplete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 }, command)
		} finally {
			vi.useRealTimers()
		}
	})
})
