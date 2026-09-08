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

	test("Ticket editor opens once and can be closed", async () => {
		const ticketTabs = () =>
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter(
					(tab) =>
						tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("alpha.tickets"),
				)
		const opened = new Promise<void>((resolve, reject) => {
			const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
				if (ticketTabs().length) {
					clearTimeout(timeout)
					listener.dispose()
					resolve()
				}
			})
			const timeout = setTimeout(() => {
				listener.dispose()
				reject(new Error("Ticket tab did not open"))
			}, 10000)
		})
		await vscode.commands.executeCommand("alpha.openTickets")
		await opened
		await vscode.commands.executeCommand("alpha.openTickets")
		const tabs = ticketTabs()
		assert.equal(tabs.length, 1)
		await vscode.window.tabGroups.close(tabs)
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
			"openTickets",
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
