// npx vitest run src/integrations/terminal/__tests__/ExecaTerminal.spec.ts

import { AlphaTerminalCallbacks } from "../types"
import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"

describe("ExecaTerminal", () => {
	it("rejects the public command when the runner rejects before emitting an outcome", async () => {
		const failure = new Error("command runner failed")
		const run = Promise.reject(failure)
		// Keep the red test focused on the public outcome, even if the adapter drops the runner promise.
		void run.catch(() => undefined)
		const runner = vi.spyOn(ExecaTerminalProcess.prototype, "run").mockReturnValueOnce(run)
		try {
			const terminal = new ExecaTerminal(1, process.cwd())
			const command = terminal.runCommand("controlled command", {
				onLine: vi.fn(),
				onCompleted: vi.fn(),
				onShellExecutionStarted: vi.fn(),
				onShellExecutionComplete: vi.fn(),
			})
			const outcome = await Promise.race([
				command.catch((error: unknown) => error),
				new Promise((resolve) => setImmediate(() => resolve("command remains pending"))),
			])
			expect(outcome).toBe(failure)
		} finally {
			runner.mockRestore()
		}
	})

	it("should run terminal commands and collect output", async () => {
		// TODO: Run the equivalent test for Windows.
		if (process.platform === "win32") {
			return
		}

		const terminal = new ExecaTerminal(1, "/tmp")
		let result

		const callbacks: AlphaTerminalCallbacks = {
			onLine: vi.fn(),
			onCompleted: (output) => {
				result = output
			},
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}

		const subprocess = terminal.runCommand("ls -al", callbacks)
		await subprocess

		expect(callbacks.onLine).toHaveBeenCalled()
		expect(callbacks.onShellExecutionStarted).toHaveBeenCalled()
		expect(callbacks.onShellExecutionComplete).toHaveBeenCalled()

		expect(result).toBeTypeOf("string")
		expect(result).toContain("total")
	})
})
