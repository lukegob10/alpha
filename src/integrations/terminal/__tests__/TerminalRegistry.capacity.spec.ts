import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { TerminalRegistry } from "../TerminalRegistry"
import { MAX_RETAINED_TERMINAL_PROCESSES } from "../types"
import { resolveRipgrepBinary } from "../../../services/ripgrep"
import i18n from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"

vi.mock("../../../services/ripgrep", () => ({ resolveRipgrepBinary: vi.fn() }))

beforeEach(() => {
	i18n.addResourceBundle("en", "common", common)
	vi.mocked(resolveRipgrepBinary).mockResolvedValue(undefined)
	vi.spyOn(vscode.window, "createTerminal").mockImplementation(() => ({ exitStatus: undefined }) as vscode.Terminal)
})

afterEach(() => {
	for (const terminal of [...TerminalRegistry.getTerminals(true), ...TerminalRegistry.getTerminals(false)]) {
		terminal.running = false
		terminal.process = undefined
		TerminalRegistry.releaseTerminalReservation(terminal, terminal.taskId)
	}
	vi.restoreAllMocks()
	i18n.removeResourceBundle("en", "common")
})

async function reserve(count: number) {
	const terminals = []
	for (let index = 0; index < count; index++) {
		terminals.push(
			await TerminalRegistry.getOrCreateTerminal(
				`/capacity/${index}`,
				`task-${index}`,
				index % 2 ? "vscode" : "execa",
			),
		)
	}
	return terminals
}

describe("active command admission", () => {
	it("bounds pending launches across tasks and terminal providers without evicting owners", async () => {
		const terminals = await reserve(MAX_RETAINED_TERMINAL_PROCESSES)
		await expect(TerminalRegistry.getOrCreateTerminal("/overflow", "another-task", "execa")).rejects.toThrow(/64/)
		expect(TerminalRegistry.getTerminals(true)).toEqual(terminals)
		expect(terminals.map((terminal) => terminal.taskId)).toEqual(
			terminals.map((_terminal, index) => `task-${index}`),
		)
	})

	it("rechecks capacity after concurrent environment resolution", async () => {
		await reserve(MAX_RETAINED_TERMINAL_PROCESSES - 1)
		let release!: (value: undefined) => void
		vi.mocked(resolveRipgrepBinary).mockReturnValue(new Promise((resolve) => (release = resolve)))
		const pending = Promise.allSettled([
			TerminalRegistry.getOrCreateTerminal("/concurrent-one", "one", "execa"),
			TerminalRegistry.getOrCreateTerminal("/concurrent-two", "two", "vscode"),
		])
		release(undefined)
		const outcomes = await pending
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
		expect(TerminalRegistry.getTerminals(true)).toHaveLength(MAX_RETAINED_TERMINAL_PROCESSES)
	})

	it("reuses a released reservation at capacity without resolving another environment", async () => {
		const [first] = await reserve(MAX_RETAINED_TERMINAL_PROCESSES)
		TerminalRegistry.releaseTerminalReservation(first, first.taskId)
		vi.mocked(resolveRipgrepBinary).mockClear()
		const reused = await TerminalRegistry.getOrCreateTerminal("/capacity/0", "replacement", "execa")
		expect(reused).toBe(first)
		expect(reused.taskId).toBe("replacement")
		expect(resolveRipgrepBinary).not.toHaveBeenCalled()
	})

	it("counts physical processes even when their output readers have settled", async () => {
		const [first] = await reserve(MAX_RETAINED_TERMINAL_PROCESSES)
		first.busy = false
		first.running = true
		await expect(TerminalRegistry.getOrCreateTerminal("/physical-overflow", "other", "execa")).rejects.toThrow(/64/)
		expect(first.running).toBe(true)
		first.running = false
		const admitted = await TerminalRegistry.getOrCreateTerminal("/capacity/0", "after-exit", "execa")
		expect(admitted).toBe(first)
	})
})
