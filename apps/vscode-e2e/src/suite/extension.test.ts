import * as assert from "assert"
import * as vscode from "vscode"

import { setDefaultSuiteTimeout } from "./test-utils"

suite("Alpha Extension", function () {
	setDefaultSuiteTimeout(this)

	test("Runs on the requested VS Code version", function () {
		const expectedVersion = process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION
		if (!expectedVersion) this.skip()
		assert.equal(vscode.version, expectedVersion)
	})

	test("Commands should be registered", async () => {
		const expectedCommands = [
			"SidebarProvider.open",
			"SidebarProvider.focus",
			"SidebarProvider.resetViewLocation",
			"SidebarProvider.toggleVisibility",
			"SidebarProvider.removeView",
			"activationCompleted",
			"plusButtonClicked",
			"popoutButtonClicked",
			"openInNewTab",
			"settingsButtonClicked",
			"historyButtonClicked",
			"scheduledTasksButtonClicked",
			"goalSeekButtonClicked",
			"marketplaceButtonClicked",
			"newTask",
			"setCustomStoragePath",
			"importSettings",
			"focusInput",
			"focusPanel",
			"acceptInput",
			"toggleAutoApprove",
			"explainCode",
			"fixCode",
			"improveCode",
			"addToContext",
			"terminalAddToContext",
			"terminalFixCommand",
			"terminalExplainCommand",
		]

		const commands = new Set((await vscode.commands.getCommands(true)).filter((cmd) => cmd.startsWith("alpha")))

		for (const command of expectedCommands) {
			assert.ok(commands.has(`alpha.${command}`), `Command ${command} should be registered`)
		}
	})
})
