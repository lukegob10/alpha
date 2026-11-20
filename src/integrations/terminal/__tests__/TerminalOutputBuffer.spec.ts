import { describe, expect, it, vi } from "vitest"

import { TerminalOutputBuffer } from "../TerminalOutputBuffer"
import { MAX_TERMINAL_OUTPUT_BUFFER_BYTES } from "../types"

const halfBudget = MAX_TERMINAL_OUTPUT_BUFFER_BYTES / 2

describe("TerminalOutputBuffer", () => {
	it("clips the retained tail on UTF-8 boundaries and reports the exact omitted bytes", () => {
		const buffer = new TerminalOutputBuffer()
		const head = "h".repeat(halfBudget - 1)
		const middle = "a".repeat(halfBudget - 4)
		buffer.append(head)
		buffer.append("🚀")
		buffer.append(middle)
		buffer.append("é")
		buffer.append("水")

		expect(buffer.parts()).toEqual([
			{ output: head, omitted: false },
			{ output: "\n[...5 bytes omitted...]\n", omitted: true },
			{ output: middle.slice(1) + "é水", omitted: false },
		])

		buffer.clear()
		buffer.append("new output")
		expect(buffer.parts()).toEqual([
			{ output: "new output", omitted: false },
			{ output: "", omitted: false },
		])
	})

	it("joins a surrogate pair split across output chunks before truncation", () => {
		const buffer = new TerminalOutputBuffer()
		const head = "h".repeat(halfBudget)
		const tail = "x".repeat(halfBudget - 4)
		buffer.append(head)
		buffer.append(tail + "\ud83d")
		buffer.append("\ude80")

		expect(buffer.parts()).toEqual([
			{ output: head, omitted: false },
			{ output: tail + "🚀", omitted: false },
		])
	})

	it("avoids re-encoding the retained tail for a small append", () => {
		const buffer = new TerminalOutputBuffer()
		buffer.append("h".repeat(halfBudget) + "x".repeat(halfBudget))
		const chunk = ("stdout: " + "x".repeat(100) + " å水🚀\n").repeat(32)
		const encode = vi.spyOn(Buffer, "from")
		try {
			buffer.append(chunk)
			buffer.append(chunk.slice(0, -2))
			buffer.append(chunk.slice(-2))
			expect(encode.mock.calls.some(([input]) => typeof input === "string" && input.length > 16_384)).toBe(false)
		} finally {
			encode.mockRestore()
		}
		expect(buffer.parts().at(-1)?.output.endsWith("\ufffd\ufffd\n")).toBe(true)
	})
})
