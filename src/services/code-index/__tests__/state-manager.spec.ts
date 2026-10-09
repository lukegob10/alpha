import { CodeIndexStateManager } from "../state-manager"

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
}))
vi.mock("../../../i18n", () => ({
	t: (_key: string, values: Record<string, unknown>) =>
		`${values.processed}/${values.total} ${values.file}: ${values.detail}`,
}))

it("updates the current file and phase while completion counts stay unchanged", () => {
	const state = new CodeIndexStateManager()
	state.reportFileQueueProgress(0, 1, "first.ts", "Reading")
	const previous = state.getCurrentStatus()
	state.reportFileQueueProgress(0, 1, "second.ts", "Saving")
	const current = state.getCurrentStatus()
	expect(current.message).not.toBe(previous.message)
	expect(current.message).toContain("second.ts")
	expect(current.message).toContain("Saving")
	expect(current.processedItems).toBe(0)
	expect(current.totalItems).toBe(1)
	state.dispose()
})

it("does not replace the stopping state with late file progress", () => {
	const state = new CodeIndexStateManager()
	state.setSystemState("Stopping", "Stopping")
	state.reportFileQueueProgress(1, 1, "first.ts", "Saving")
	expect(state.state).toBe("Stopping")
	state.dispose()
})
