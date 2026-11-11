import * as vscode from "vscode"

import i18n from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"
import { Terminal } from "../Terminal"
import type { AlphaTerminalCallbacks } from "../types"

const { integrationListeners } = vi.hoisted(() => ({
	integrationListeners: new Set<(event: vscode.TerminalShellIntegrationChangeEvent) => unknown>(),
}))

vi.mock("vscode", () => ({
	window: {
		onDidChangeTerminalShellIntegration: vi.fn((listener) => {
			integrationListeners.add(listener)
			return { dispose: () => integrationListeners.delete(listener) }
		}),
	},
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
	ThemeIcon: vi.fn(),
}))

function createTerminal() {
	const host = {
		shellIntegration: undefined as vscode.TerminalShellIntegration | undefined,
		exitStatus: undefined,
		sendText: vi.fn(),
		dispose: vi.fn(),
	}
	const terminal = new Terminal(91_001, host as unknown as vscode.Terminal, process.cwd())
	const executeCommand = vi.fn(() => {
		terminal.setActiveStream(
			(async function* () {
				yield "\x1b]633;C\x07command output\n"
				terminal.shellExecutionComplete({ exitCode: 0 })
			})(),
		)
	})
	const callbacks: AlphaTerminalCallbacks = {
		onLine: vi.fn(),
		onCompleted: vi.fn(),
		onShellExecutionStarted: vi.fn(),
		onShellExecutionComplete: vi.fn(),
		onNoShellIntegration: vi.fn(),
	}
	function activate(eventTerminal = terminal.terminal) {
		const shellIntegration = { executeCommand } as unknown as vscode.TerminalShellIntegration
		if (eventTerminal === terminal.terminal) host.shellIntegration = shellIntegration
		for (const listener of integrationListeners) {
			listener({ terminal: eventTerminal, shellIntegration })
		}
	}
	return { host, terminal, executeCommand, callbacks, activate }
}

describe("terminal shell integration startup", () => {
	let originalTimeout: number
	beforeAll(() => i18n.addResourceBundle("en", "common", common))
	afterAll(() => i18n.removeResourceBundle("en", "common"))
	beforeEach(() => {
		vi.useFakeTimers()
		originalTimeout = Terminal.getShellIntegrationTimeout()
		Terminal.setShellIntegrationTimeout(2_000)
	})
	afterEach(() => {
		Terminal.setShellIntegrationTimeout(originalTimeout)
		integrationListeners.clear()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("accepts readiness immediately before the deadline without waiting for another poll", async () => {
		const { terminal, callbacks, activate, executeCommand } = createTerminal()
		const running = terminal.runCommand("echo ready", callbacks)
		await vi.advanceTimersByTimeAsync(1_999)
		activate()
		await vi.advanceTimersByTimeAsync(1)
		await running
		await running.waitForOutputFinalization?.()

		expect(executeCommand).toHaveBeenCalledExactlyOnceWith("echo ready")
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(callbacks.onCompleted).toHaveBeenCalledOnce()
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not report a late timeout or rerun a command cancelled during startup", async () => {
		const { terminal, callbacks, activate, executeCommand, host } = createTerminal()
		const running = terminal.runCommand("echo cancelled", callbacks)
		await running.terminate?.()
		await running
		await vi.advanceTimersByTimeAsync(2_000)
		activate()
		await vi.advanceTimersByTimeAsync(50)
		await running.waitForOutputFinalization?.()

		expect(callbacks.onCompleted).toHaveBeenCalledOnce()
		expect(callbacks.onShellExecutionComplete).toHaveBeenCalledExactlyOnceWith(
			{ exitCode: 130, signalName: "SIGINT" },
			running,
		)
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
		expect(host.sendText).not.toHaveBeenCalled()
		expect(host.dispose).not.toHaveBeenCalled()
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("allows a slow shell to start within its configured timeout", async () => {
		Terminal.setShellIntegrationTimeout(10_000)
		const { terminal, callbacks, activate, executeCommand } = createTerminal()
		const running = terminal.runCommand("echo slow-start", callbacks)
		await vi.advanceTimersByTimeAsync(2_500)
		expect(executeCommand).not.toHaveBeenCalled()
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		activate()
		await running
		await running.waitForOutputFinalization?.()
		expect(executeCommand).toHaveBeenCalledExactlyOnceWith("echo slow-start")
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("ignores other terminals, reports the captured deadline, and permits an explicit retry", async () => {
		const { terminal, callbacks, activate, executeCommand, host } = createTerminal()
		const running = terminal.runCommand("echo expired", callbacks)
		await vi.advanceTimersByTimeAsync(1_000)
		Terminal.setShellIntegrationTimeout(10_000)
		activate({} as vscode.Terminal)
		await vi.advanceTimersByTimeAsync(999)
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await running
		await running.waitForOutputFinalization?.()

		expect(callbacks.onNoShellIntegration).toHaveBeenCalledExactlyOnceWith(
			common.errors.command_shell_integration_timeout.replace("{{seconds}}", "2"),
			running,
		)
		expect(running.hasSubmittedCommand).toBe(false)
		expect(host.sendText).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
		expect(terminal.busy).toBe(false)
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)

		activate()
		await vi.advanceTimersByTimeAsync(50)
		expect(executeCommand).not.toHaveBeenCalled()
		const retry = terminal.runCommand("echo retry", callbacks)
		await retry
		await retry.waitForOutputFinalization?.()
		expect(executeCommand).toHaveBeenCalledExactlyOnceWith("echo retry")
		expect(callbacks.onNoShellIntegration).toHaveBeenCalledOnce()
		expect(callbacks.onCompleted).toHaveBeenCalledTimes(2)
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not register a startup wait for an already integrated terminal", async () => {
		const { terminal, callbacks, activate, executeCommand } = createTerminal()
		activate()
		const running = terminal.runCommand("echo ready", callbacks)
		expect(integrationListeners.size).toBe(0)
		await running
		await running.waitForOutputFinalization?.()
		expect(executeCommand).toHaveBeenCalledExactlyOnceWith("echo ready")
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("cleans up startup when the terminal closes without reporting an integration timeout", async () => {
		const { terminal, callbacks, activate, executeCommand } = createTerminal()
		const running = terminal.runCommand("echo closed", callbacks)
		const rejected = expect(running).rejects.toThrow(common.errors.command_terminal_closed)
		terminal.notifyTerminalClosed()
		await rejected
		await running.waitForOutputFinalization?.()
		await vi.advanceTimersByTimeAsync(2_000)
		activate()
		expect(callbacks.onCompleted).not.toHaveBeenCalled()
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
		expect(terminal.busy).toBe(false)
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("releases startup resources even when a cancellation observer throws", async () => {
		const { terminal, callbacks, executeCommand } = createTerminal()
		const failure = new Error("completion observer failed")
		callbacks.onCompleted = vi.fn(() => {
			throw failure
		})
		const running = terminal.runCommand("echo cancelled", callbacks)
		await expect(running.terminate?.()).rejects.toBe(failure)
		await running
		await running.waitForOutputFinalization?.()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(callbacks.onCompleted).toHaveBeenCalledOnce()
		expect(callbacks.onNoShellIntegration).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
		expect(integrationListeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})
})
