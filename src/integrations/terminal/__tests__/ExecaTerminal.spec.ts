// npx vitest run src/integrations/terminal/__tests__/ExecaTerminal.spec.ts

import { RooTerminalCallbacks } from "../types"
import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"

describe("ExecaTerminal", () => {
	it("routes optional instrumentation availability through the existing process callback", async () => {
		const unavailable = vi.fn()
		const callbacks: RooTerminalCallbacks = {
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
			onVerificationUnavailable: unavailable,
		}
		const terminal = new ExecaTerminal(1, ".")
		const run = vi.spyOn(ExecaTerminalProcess.prototype, "run").mockImplementationOnce(async function (
			this: ExecaTerminalProcess,
			_command,
			_options,
			notify,
		) {
			notify?.("observer unavailable")
			this.emit("completed", "original output")
			this.emit("continue")
		})
		try {
			await terminal.runCommand("python -m pytest", callbacks)
			expect(unavailable).toHaveBeenCalledExactlyOnceWith("observer unavailable")
			expect(callbacks.onCompleted).toHaveBeenCalledWith("original output", expect.any(ExecaTerminalProcess))
		} finally {
			run.mockRestore()
		}
	})

	it("should run terminal commands and collect output", async () => {
		// TODO: Run the equivalent test for Windows.
		if (process.platform === "win32") {
			return
		}

		const terminal = new ExecaTerminal(1, "/tmp")
		let result

		const callbacks: RooTerminalCallbacks = {
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
