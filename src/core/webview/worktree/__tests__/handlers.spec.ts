import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import * as path from "path"

import type { AlphaProvider } from "../../AlphaProvider"
import { handleGetWorktreeDefaults, handleSwitchWorktree } from "../handlers"
import { getGlobalConfigDirectory } from "../../../../services/config-paths/index.js"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((filePath: string) => ({ fsPath: filePath })) },
	commands: { executeCommand: vi.fn() },
	workspace: { workspaceFolders: [{ name: "example" }] },
}))

vi.mock("@alpha-code/core", () => ({ worktreeService: {}, worktreeIncludeService: {} }))
vi.mock("../../../../services/config-paths/index.js", () => ({
	getGlobalConfigDirectory: vi.fn(() => "/home/alpha/.alpha"),
}))

describe("handleGetWorktreeDefaults", () => {
	it("keeps worktrees under the canonical global configuration directory", async () => {
		const defaults = await handleGetWorktreeDefaults({} as AlphaProvider)

		expect(path.dirname(defaults.suggestedPath)).toBe(path.join(getGlobalConfigDirectory(), "worktrees"))
		const worktreeName = path.basename(defaults.suggestedPath)
		expect(worktreeName).toMatch(/^example-[a-z0-9]{5}$/)
		expect(defaults.suggestedBranch).toBe(`worktree/alpha-${worktreeName.slice("example-".length)}`)
	})
})

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
