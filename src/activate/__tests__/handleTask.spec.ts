import * as vscode from "vscode"

import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { handleNewTask } from "../handleTask"

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn() },
	window: { showInputBox: vi.fn() },
}))

vi.mock("../../core/webview/AlphaProvider", () => ({
	AlphaProvider: { handleCodeAction: vi.fn() },
}))

describe("New Chat command", () => {
	beforeEach(() => vi.resetAllMocks())

	it.each([undefined, null, {}, { prompt: undefined }, { prompt: "" }])(
		"opens the guarded extension composer for an empty invocation %j",
		async (params) => {
			await handleNewTask(params)

			expect(vscode.window.showInputBox).not.toHaveBeenCalled()
			expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("alpha.plusButtonClicked")
			expect(AlphaProvider.handleCodeAction).not.toHaveBeenCalled()
		},
	)

	it("preserves an explicitly supplied task prompt", async () => {
		const prompt = "Inspect this file.\nExplain the failing assertion."

		await handleNewTask({ prompt })

		expect(vscode.window.showInputBox).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(AlphaProvider.handleCodeAction).toHaveBeenCalledTimes(1)
		expect(AlphaProvider.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", { userInput: prompt })
	})

	it("propagates a failed composer command without starting a task", async () => {
		const error = new Error("Alpha view could not open")
		vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(error)

		await expect(handleNewTask(undefined)).rejects.toBe(error)
		expect(vscode.window.showInputBox).not.toHaveBeenCalled()
		expect(AlphaProvider.handleCodeAction).not.toHaveBeenCalled()
	})
})
