import * as vscode from "vscode"

import { handleNewTask } from "../handleTask"

const { createTask, getInstance } = vi.hoisted(() => ({ createTask: vi.fn(), getInstance: vi.fn() }))

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn() },
	window: { showInputBox: vi.fn() },
}))

vi.mock("../../core/webview/AlphaProvider", () => ({
	AlphaProvider: { getInstance },
}))

describe("New Chat command", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		getInstance.mockResolvedValue({ createTask })
	})

	it.each([undefined, null, {}, { prompt: undefined }, { prompt: "" }])(
		"opens the guarded extension composer for an empty invocation %j",
		async (params) => {
			await handleNewTask(params)

			expect(vscode.window.showInputBox).not.toHaveBeenCalled()
			expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked")
			expect(getInstance).not.toHaveBeenCalled()
			expect(createTask).not.toHaveBeenCalled()
		},
	)

	it("preserves an explicitly supplied task prompt", async () => {
		const prompt = "Inspect this file.\nExplain the failing assertion."

		await handleNewTask({ prompt })

		expect(vscode.window.showInputBox).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(getInstance).toHaveBeenCalledOnce()
		expect(createTask).toHaveBeenCalledExactlyOnceWith(prompt)
	})

	it("leaves the task unopened when no Alpha view is available", async () => {
		getInstance.mockResolvedValueOnce(undefined)
		await handleNewTask({ prompt: "Inspect this file" })
		expect(createTask).not.toHaveBeenCalled()
	})

	it("propagates task creation errors", async () => {
		const error = new Error("Task creation failed")
		createTask.mockRejectedValueOnce(error)
		await expect(handleNewTask({ prompt: "Inspect this file" })).rejects.toBe(error)
	})

	it("propagates a failed composer command without starting a task", async () => {
		const error = new Error("Alpha view could not open")
		vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(error)

		await expect(handleNewTask(undefined)).rejects.toBe(error)
		expect(vscode.window.showInputBox).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
	})
})
