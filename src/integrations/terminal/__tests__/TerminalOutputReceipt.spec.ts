import * as vscode from "vscode"

import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import { Terminal } from "../Terminal"
import { TerminalProcess } from "../TerminalProcess"
import { MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS } from "../types"
import type { RooTerminal } from "../types"

function makeVscodeProcess(): TerminalProcess {
	const terminal = new Terminal(
		1,
		{
			shellIntegration: undefined,
			exitStatus: undefined,
		} as unknown as vscode.Terminal,
		"/test",
	)
	return new TerminalProcess(terminal)
}

function makeExecaProcess(): ExecaTerminalProcess {
	const terminal = {
		provider: "execa",
		id: 1,
		busy: false,
		running: false,
		getCurrentWorkingDirectory: () => "/test",
		isClosed: () => false,
	} as unknown as RooTerminal
	return new ExecaTerminalProcess(terminal)
}

function setVscodeStreamClosed(process: TerminalProcess, closed: boolean): void {
	;(process.terminal as any).streamClosed = closed
}

function collectCommittedOutput(process: TerminalProcess | ExecaTerminalProcess, maxCharacters: number): string {
	const internal = process as any
	let output = ""

	for (let attempt = 0; internal.lastRetrievedIndex < internal.fullOutput.length; attempt++) {
		if (attempt >= 1_000) throw new Error("receipt collection did not advance the unread cursor")

		const previousIndex = internal.lastRetrievedIndex
		const receipt = process.captureUnretrievedOutput(maxCharacters)
		if (receipt.output.length > maxCharacters + MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS)
			throw new Error("receipt exceeded its bounded rendered output allowance")
		output += receipt.output
		receipt.commit()

		if (internal.lastRetrievedIndex <= previousIndex) {
			throw new Error("receipt commit did not advance the unread cursor")
		}
		if (internal.lastRetrievedIndex - previousIndex > maxCharacters) {
			throw new Error("receipt commit advanced beyond its raw character cap")
		}
	}

	return output
}

describe("terminal output receipts", () => {
	it.each([
		["VS Code", makeVscodeProcess],
		["Execa", makeExecaProcess],
	])("does not consume output until commit for %s processes", (_name, createProcess) => {
		const process = createProcess()
		;(process as any).fullOutput = "A"
		if (process instanceof TerminalProcess) setVscodeStreamClosed(process, true)
		if (process instanceof ExecaTerminalProcess) process.emit("completed")

		const receipt = process.captureUnretrievedOutput()
		expect(receipt.output).toBe("A")
		expect((process as any).lastRetrievedIndex).toBe(0)
		;(process as any).fullOutput += "B"
		receipt.commit()
		receipt.commit()
		expect((process as any).lastRetrievedIndex).toBe(1)

		const next = process.captureUnretrievedOutput()
		expect(next.output).toBe("B")
		next.commit()
		next.release()
	})

	it.each([
		["VS Code", makeVscodeProcess],
		["Execa", makeExecaProcess],
	])("releases a receipt without losing output for %s processes", (_name, createProcess) => {
		const process = createProcess()
		;(process as any).fullOutput = "A"
		if (process instanceof TerminalProcess) setVscodeStreamClosed(process, true)
		if (process instanceof ExecaTerminalProcess) process.emit("completed")

		const receipt = process.captureUnretrievedOutput()
		;(process as any).fullOutput += "B"
		receipt.release()
		receipt.release()

		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("AB")
		retry.release()
	})

	it("allows only one active receipt reservation", () => {
		const process = makeExecaProcess()
		;(process as any).fullOutput = "output"
		process.emit("completed")

		const first = process.captureUnretrievedOutput()
		const overlapping = process.captureUnretrievedOutput()

		expect(first.output).toBe("output")
		expect(overlapping.output).toBe("")
		overlapping.commit()
		first.release()

		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("output")
		retry.commit()
	})

	it("returns an empty non-reserving receipt for a zero character budget", () => {
		const process = makeExecaProcess()
		;(process as any).fullOutput = "output"
		process.emit("completed")

		const empty = process.captureUnretrievedOutput(0)
		expect(empty.output).toBe("")
		;(process as any).fullOutput += " later"
		empty.commit()

		const receipt = process.captureUnretrievedOutput()
		expect(receipt.output).toBe("output later")
		receipt.release()
	})

	it("caps raw output and preserves the remainder for a later receipt", () => {
		const process = makeExecaProcess()
		const output = "x".repeat(50_003)
		;(process as any).fullOutput = output
		process.emit("completed")

		const first = process.captureUnretrievedOutput(50_000)
		expect(first.output).toHaveLength(50_000)
		expect((process as any).lastRetrievedIndex).toBe(0)
		first.commit()

		const remainder = process.captureUnretrievedOutput(50_000)
		expect(remainder.output).toBe("x".repeat(3))
		remainder.commit()
	})

	it("includes a completed VS Code trailing line without a newline", () => {
		const process = makeVscodeProcess()
		;(process as any).fullOutput = "complete output"
		setVscodeStreamClosed(process, false)
		process.emit("completed")

		const receipt = process.captureUnretrievedOutput()
		expect(receipt.output).toBe("complete output")
		receipt.commit()
	})

	it("keeps Execa line consumption unchanged while receipts include completed trailing output", () => {
		const process = makeExecaProcess()
		;(process as any).fullOutput = "complete line\ntrailing output"
		process.emit("completed")

		expect(process.getUnretrievedOutput()).toBe("complete line\n")
		const receipt = process.captureUnretrievedOutput()
		expect(receipt.output).toBe("trailing output")
		receipt.release()
	})

	it("keeps an active VS Code partial line for a later capture", () => {
		const process = makeVscodeProcess()
		;(process as any).fullOutput = "complete line\npartial"
		setVscodeStreamClosed(process, false)

		const active = process.captureUnretrievedOutput()
		expect(active.output).toBe("complete line\n")
		active.release()
		setVscodeStreamClosed(process, true)
		const completed = process.captureUnretrievedOutput()
		expect(completed.output).toBe("complete line\npartial")
		completed.release()
	})

	it("makes a receipt stale when trim resets the output buffer", () => {
		const process = makeExecaProcess()
		;(process as any).fullOutput = "old"
		process.emit("completed")

		const stale = process.captureUnretrievedOutput()
		;(process as any).fullOutput = ""
		process.trimRetrievedOutput()
		;(process as any).fullOutput = "new"
		stale.commit()

		const current = process.captureUnretrievedOutput()
		expect(current.output).toBe("new")
		current.release()
	})

	it("matches legacy cleanup when a VS Code shell marker crosses receipt caps", () => {
		const process = makeVscodeProcess()
		const raw = "x".repeat(31_996) + "\x1b]633;P;Cwd=/hidden/working/directory\x07" + "important final line\n"
		;(process as any).fullOutput = raw
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const internal = process as any
		const expected = internal.stripCursorSequences(internal.removeVSCodeShellIntegration(raw))
		const output = collectCommittedOutput(process, 32_000)

		expect(output).toBe(expected)
		expect(output).toBe("x".repeat(31_996) + "important final line\n")
	})

	it("matches legacy cleanup when an OSC 8 hyperlink crosses receipt caps", () => {
		const process = makeVscodeProcess()
		const raw = "before\n\x1b]8;;https://example.test\x07linked text\x1b]8;;\x07\n"
		;(process as any).fullOutput = raw
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const internal = process as any
		const expected = internal.stripCursorSequences(internal.removeVSCodeShellIntegration(raw))
		const output = collectCommittedOutput(process, "before\n\x1b]".length)

		expect(output).toBe(expected)
		expect(output).toBe("before\nlinked text\n")
	})

	it("strips split cursor CSI sequences while preserving split SGR sequences", () => {
		const process = makeVscodeProcess()
		const raw = "prefix\x1b[31mcolor\x1b]8;;https://example.test\x07linked\x1b]8;;\x07\x1b[?25lvisible\n"
		;(process as any).fullOutput = raw
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const internal = process as any
		const expected = internal.stripCursorSequences(internal.removeVSCodeShellIntegration(raw))
		const output = collectCommittedOutput(process, 1)

		expect(output).toBe(expected)
		expect(output).toBe("prefix\x1b[31mcolorlinkedvisible\n")
	})

	it("does not mutate cleanup state or the cursor when a split marker receipt is released", () => {
		const process = makeVscodeProcess()
		const raw = "before\n\x1b]8;;https://example.test\x07linked text\x1b]8;;\x07"
		;(process as any).fullOutput = raw
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const internal = process as any
		const beforeState = internal.outputCleanupState
		const receipt = process.captureUnretrievedOutput("before\n\x1b]".length)
		receipt.release()

		expect(internal.outputCleanupState).toBe(beforeState)
		expect(internal.lastRetrievedIndex).toBe(0)

		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("before\nlinked text")
		retry.commit()
	})

	it("does not retain an oversized OSC marker or starve later output", () => {
		const process = makeVscodeProcess()
		const raw = "\x1b]8;;" + "u".repeat(100_000) + "\x07visible\n"
		;(process as any).fullOutput = raw
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const internal = process as any
		const expected = internal.stripCursorSequences(internal.removeVSCodeShellIntegration(raw))
		const output = collectCommittedOutput(process, 1_024)

		expect(output).toBe(expected)
		expect(output).toBe("visible\n")
		expect(internal.outputCleanupState.pending).toBe("")
	})

	it("preserves a final lone escape byte on a completed stream", () => {
		const process = makeVscodeProcess()
		;(process as any).fullOutput = "visible\x1b"
		setVscodeStreamClosed(process, true)
		process.emit("completed")

		const receipt = process.captureUnretrievedOutput()
		expect(receipt.output).toBe("visible\x1b")
		receipt.commit()
	})
})
