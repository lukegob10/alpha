import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import type { AlphaProvider } from "../../AlphaProvider"
import { handleSwitchWorktree } from "../handlers"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((filePath: string) => ({ fsPath: filePath })) },
	commands: { executeCommand: vi.fn() },
}))

vi.mock("@alpha-code/core", () => ({ worktreeService: {}, worktreeIncludeService: {} }))

describe("handleSwitchWorktree", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined)
	})

	it.each([true, false])("persists the sidebar path before opening with newWindow=%s", async (newWindow) => {
		let finishSaving!: () => void
		const saved = new Promise<void>((resolve) => {
			finishSaving = resolve
		})
		const setValue = vi.fn(() => saved)
		const provider = { contextProxy: { setValue } } as unknown as AlphaProvider
		const worktreePath = "/workspace/worktree"

		const switching = handleSwitchWorktree(provider, worktreePath, newWindow)
		expect(setValue).toHaveBeenCalledExactlyOnceWith("worktreeAutoOpenPath", worktreePath)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()

		finishSaving()
		await expect(switching).resolves.toEqual({ success: true, message: `Opened worktree at ${worktreePath}` })
		expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
			"vscode.openFolder",
			{ fsPath: worktreePath },
			{ forceNewWindow: newWindow },
		)
	})

	it("keeps the current folder open when saving the sidebar path fails", async () => {
		const provider = {
			contextProxy: { setValue: vi.fn().mockRejectedValue(new Error("State unavailable")) },
		} as unknown as AlphaProvider

		await expect(handleSwitchWorktree(provider, "/workspace/worktree", false)).resolves.toEqual({
			success: false,
			message: "Failed to switch worktree: State unavailable",
		})
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})
})
