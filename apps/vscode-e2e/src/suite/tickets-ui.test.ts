import * as assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"

suite("Alpha Tickets rendered landing", function () {
	this.timeout(240_000)
	test("opens the seeded workspace tickets across host themes", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.122.1")
		assert.equal(os.homedir(), process.env.ALPHA_UI_TICKETS_HOME)
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace)
		assert.equal(path.basename(workspace), "Alpha Tickets UI")

		const workbench = vscode.workspace.getConfiguration("workbench")
		const originalTheme = workbench.get<string>("colorTheme")
		try {
			for (const [stage, theme] of [
				["tickets-dark", "Default Dark Modern"],
				["tickets-light", "Default Light Modern"],
				["tickets-contrast", "Default High Contrast"],
			] as const) {
				await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global)
				if (stage === "tickets-dark") {
					await vscode.commands.executeCommand("alpha.openTickets")
					await vscode.commands.executeCommand("workbench.action.closeSidebar")
					await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar")
				}
				if (stage === "tickets-contrast") {
					await vscode.commands.executeCommand("workbench.action.editorLayoutThreeColumns")
					await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup")
				}
				await uiFixtureBarrier(stage, { version: vscode.version })
			}
		} finally {
			await Promise.resolve(vscode.commands.executeCommand("workbench.action.closeActiveEditor")).catch(
				() => undefined,
			)
			if (originalTheme)
				await Promise.resolve(
					workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global),
				).catch(() => undefined)
		}
	})
})
