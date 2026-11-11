import { describe, expect, it, vi } from "vitest"

import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"

describe("terminal shell completion", () => {
	it("preserves the replacement command installed by an exit observer", () => {
		const terminal = new ExecaTerminal(1, "/test")
		const outgoing = new ExecaTerminalProcess(terminal)
		const replacement = new ExecaTerminalProcess(terminal)
		terminal.process = outgoing
		terminal.busy = true
		terminal.running = true
		vi.spyOn(outgoing, "hasUnretrievedOutput").mockReturnValue(true)
		outgoing.once("shell_execution_complete", () => {
			terminal.process = replacement
			terminal.busy = true
			terminal.running = true
		})

		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.process).toBe(replacement)
		expect(terminal.busy).toBe(true)
		expect(terminal.running).toBe(true)
		expect(terminal.getProcessesWithOutput()).toEqual([outgoing])
	})

	it("releases the completed command when an exit observer throws", () => {
		const terminal = new ExecaTerminal(1, "/test")
		const outgoing = new ExecaTerminalProcess(terminal)
		terminal.process = outgoing
		terminal.busy = true
		terminal.running = true
		const failure = new Error("exit observer failed")
		outgoing.once("shell_execution_complete", () => {
			throw failure
		})

		expect(() => terminal.shellExecutionComplete({ exitCode: 0 })).toThrow(failure)
		expect(terminal.process).toBeUndefined()
		expect(terminal.busy).toBe(false)
		expect(terminal.running).toBe(false)
	})
})
