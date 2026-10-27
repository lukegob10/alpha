import * as assert from "assert"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import { retiredProviderNames, type AlphaCodeSettings } from "@alpha-code/types"

import { assertRequestedHostVersion, setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

suite("Alpha Extension", function () {
	setDefaultSuiteTimeout(this)

	test("Runs on the requested VS Code version", () => {
		assertRequestedHostVersion(vscode.version, process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION)
	})

	test("New Chat commands leave Quick Open and open a draft through the extension UI", async () => {
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (
			api as unknown as {
				sidebarProvider: {
					startBlankTask(): Promise<void>
					getStateToPostToWebview(): Promise<{ currentView?: { type: string }; activeTaskId?: string }>
				}
			}
		).sidebarProvider
		const startBlankTask = host.startBlankTask
		let draftsOpened = 0
		host.startBlankTask = async () => {
			await startBlankTask.call(host)
			draftsOpened++
		}

		try {
			// The composer is intentionally unavailable before provider onboarding.
			await api.setConfiguration({ ...originalConfiguration, apiProvider: "fake-ai" })
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			for (const [command, args] of [
				["alpha.newTask", undefined],
				["alpha.plusButtonClicked", undefined],
				["alpha.plusButtonClicked", "sidebar"],
				["alpha.sidebarNewChat", undefined],
			] as const) {
				const expectedDrafts = draftsOpened + 1
				await vscode.commands.executeCommand("workbench.action.quickOpen")
				await vscode.commands.executeCommand(command, args)
				await waitFor(() => draftsOpened === expectedDrafts, {
					description: `${command} to open one draft through the rendered Alpha view`,
					timeout: 10_000,
				})
				const state = await host.getStateToPostToWebview()
				assert.equal(state.currentView?.type, "newTaskDraft")
				assert.equal(state.activeTaskId, undefined)
			}
			assert.equal(draftsOpened, 4)
		} finally {
			host.startBlankTask = startBlankTask
			await vscode.commands.executeCommand("workbench.action.closeQuickOpen")
			await api.setConfiguration(originalConfiguration)
		}
	})

	test("opens a vector diagram with visible native zoom controls", async () => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
		assert.ok(workspace)
		const image = vscode.Uri.joinPath(workspace, `alpha-mermaid-${randomUUID()}.svg`)
		await vscode.workspace.fs.writeFile(
			image,
			Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200" viewBox="0 0 1200 200"><rect width="1200" height="200" fill="#ffffff"/><text x="20" y="40" fill="#202020">Source records → Workbook</text></svg>',
			),
		)
		const imageTab = () =>
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.find(
					(tab) =>
						tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === image.toString(),
				)
		try {
			await vscode.commands.executeCommand("vscode.openWith", image, "imagePreview.previewEditor")
			await waitFor(() => imageTab() !== undefined, { timeout: 10_000 })
			const input = imageTab()?.input
			assert.ok(input instanceof vscode.TabInputCustom)
			assert.equal(input.viewType, "imagePreview.previewEditor")
			const extension = vscode.extensions.getExtension(process.env.ALPHA_E2E_EXTENSION_ID!)
			assert.ok(extension)
			const toolbar = extension.packageJSON.contributes.menus["editor/title"] as Array<{
				command: string
				when?: string
			}>
			const commands = await vscode.commands.getCommands(true)
			for (const direction of ["In", "Out"]) {
				const command = `alpha.diagramZoom${direction}`
				assert.ok(commands.includes(command))
				assert.ok(commands.includes(`imagePreview.zoom${direction}`))
				assert.equal(
					toolbar.find((item) => item.command === command)?.when,
					"activeCustomEditorId == 'imagePreview.previewEditor' && resourceExtname == '.svg'",
				)
				await vscode.commands.executeCommand(command)
			}
		} finally {
			const tab = imageTab()
			if (tab) await vscode.window.tabGroups.close(tab)
			await vscode.workspace.fs.delete(image)
		}
	})

	test("Retired settings do not reappear in configuration or host projections", async () => {
		const api = globalThis.api
		const original = api.getConfiguration()
		const host = (
			api as unknown as {
				sidebarProvider: {
					getState(): Promise<object>
					getStateToPostToWebview(): Promise<object>
				}
			}
		).sidebarProvider
		try {
			for (const personality of ["default", "friendly", "pragmatic", "none"]) {
				const legacy = { ...original, personality }
				await api.setConfiguration(legacy)
				assert.ok(!("personality" in api.getConfiguration()))
				assert.ok(!("personality" in (await host.getState())))
				assert.ok(!("personality" in (await host.getStateToPostToWebview())))
			}
		} finally {
			await api.setConfiguration(original)
		}
	})

	test("Ticket editor opens once and can be closed", async () => {
		const activeColumn = vscode.window.tabGroups.activeTabGroup.viewColumn
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
		// VS Code 1.138.0 title-menu mouse actions forward this focus context.
		await vscode.commands.executeCommand("alpha.openTickets", { preserveFocus: false })
		await opened
		const ticketTab = ticketTabs()[0]
		assert.ok(ticketTab)
		const ticketGroup = vscode.window.tabGroups.all.find((group) => group.tabs.includes(ticketTab))
		assert.equal(ticketGroup?.viewColumn, activeColumn, "Ticket editor should reuse the active editor group")
		await vscode.commands.executeCommand("alpha.openTickets", { preserveFocus: false })
		await vscode.commands.executeCommand("alpha.openTickets")
		const tabs = ticketTabs()
		assert.equal(tabs.length, 1)
		await vscode.window.tabGroups.close(tabs)
	})

	test("Native sidebar actions are scoped and incident commands open one dashboard tab", async () => {
		const extension = vscode.extensions.getExtension(process.env.ALPHA_E2E_EXTENSION_ID!)
		assert.ok(extension)
		const menus = extension.packageJSON.contributes?.menus as
			| Record<string, Array<{ command: string; group?: string; when?: string }>>
			| undefined
		const paletteAction = menus?.commandPalette?.find((item) => item.command === "alpha.openIncidents")
		assert.equal(paletteAction?.when, "config.alpha.debug")
		const toolbarCommands = new Set([
			"alpha.sidebarNewChat",
			"alpha.sidebarSettings",
			"alpha.sidebarScheduledTasks",
			"alpha.sidebarMarketplace",
			"alpha.plusButtonClicked",
			"alpha.settingsButtonClicked",
			"alpha.openTickets",
			"alpha.historyButtonClicked",
			"alpha.openIncidents",
			"alpha.scheduledTasksButtonClicked",
			"alpha.marketplaceButtonClicked",
			"alpha.popoutButtonClicked",
		])
		assert.deepEqual(menus?.["view/title"], [
			{ command: "alpha.sidebarNewChat", group: "navigation@1", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.sidebarSettings", group: "navigation@2", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.openTickets", group: "navigation@3", when: "view == alpha.SidebarProvider" },
			{
				command: "alpha.openIncidents",
				group: "overflow@0",
				when: "view == alpha.SidebarProvider && config.alpha.debug",
			},
			{ command: "alpha.sidebarScheduledTasks", group: "overflow@1", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.sidebarMarketplace", group: "overflow@2", when: "view == alpha.SidebarProvider" },
		])
		for (const command of [
			"alpha.sidebarNewChat",
			"alpha.sidebarSettings",
			"alpha.sidebarScheduledTasks",
			"alpha.sidebarMarketplace",
		]) {
			assert.deepEqual(
				menus?.commandPalette?.find((item) => item.command === command),
				{ command, when: "false" },
			)
		}
		assert.ok(
			!menus?.["editor/title"]?.some((item) => toolbarCommands.has(item.command)),
			"Editor title must not duplicate the webview fallback controls",
		)

		const configuration = vscode.workspace.getConfiguration("alpha")
		const priorDebug = configuration.inspect<boolean>("debug")?.globalValue
		const incidentTabs = () =>
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter(
					(tab) =>
						tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("alpha.incidents"),
				)
		try {
			await configuration.update("debug", true, vscode.ConfigurationTarget.Global)
			assert.equal(vscode.workspace.getConfiguration("alpha").get("debug"), true)
			const opened = new Promise<void>((resolve, reject) => {
				const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
					if (incidentTabs().length > 0) {
						clearTimeout(timeout)
						listener.dispose()
						resolve()
					}
				})
				const timeout = setTimeout(() => {
					listener.dispose()
					reject(new Error("Incident dashboard tab did not open"))
				}, 10000)
			})
			await vscode.commands.executeCommand("alpha.openIncidents")
			await opened
			await vscode.commands.executeCommand("alpha.openIncidents")
			assert.equal(incidentTabs().length, 1)
		} finally {
			await configuration.update("debug", priorDebug, vscode.ConfigurationTarget.Global)
			const tabs = incidentTabs()
			if (tabs.length > 0) await vscode.window.tabGroups.close(tabs)
		}
	})

	test("legacy provider setups remain readable and reject execution without disrupting the host", async () => {
		const api = globalThis.api
		const original = api.getConfiguration()
		const stack = api.getCurrentTaskStack()
		try {
			await api.setConfiguration({ apiProvider: "openrouter" })
			assert.equal(api.getConfiguration().apiProvider, "openrouter")
			for (const provider of [...retiredProviderNames, "future-provider"]) {
				await assert.rejects(
					api.startNewTask({
						configuration: { apiProvider: provider } as AlphaCodeSettings,
						text: "This legacy configuration must not execute.",
					}),
					{ message: `Unsupported API provider: ${provider}` },
				)
				assert.deepEqual(api.getCurrentTaskStack(), stack)
			}
			await api.setConfiguration({ apiProvider: "vscode-lm" })
			assert.equal(api.getConfiguration().apiProvider, "vscode-lm")
			assert.ok(vscode.extensions.getExtension(process.env.ALPHA_E2E_EXTENSION_ID!)?.isActive)
		} finally {
			await api.setConfiguration(original)
		}
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
			"sidebarNewChat",
			"sidebarSettings",
			"sidebarScheduledTasks",
			"sidebarMarketplace",
			"popoutButtonClicked",
			"openInNewTab",
			"settingsButtonClicked",
			"historyButtonClicked",
			"scheduledTasksButtonClicked",
			"openTickets",
			"openIncidents",
			"marketplaceButtonClicked",
			"newTask",
			"setCustomStoragePath",
			"importSettings",
			"focusInput",
			"focusPanel",
			"acceptInput",
			"sendAndSteer",
			"decreaseReasoningEffort",
			"increaseReasoningEffort",
			"previousTask",
			"nextTask",
			"nextTaskNeedingInput",
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

		assert.ok(!commands.has("alpha.goalSeekButtonClicked"), "Goal Seek must not be registered")
		const extensionId = process.env.ALPHA_E2E_EXTENSION_ID
		assert.ok(extensionId, "The E2E runner should provide the extension ID")
		const extension = vscode.extensions.getExtension(extensionId)
		assert.ok(extension, "Alpha extension should be installed")
		assert.ok(
			!JSON.stringify(extension.packageJSON.contributes).includes("alpha.goalSeekButtonClicked"),
			"Goal Seek must not be contributed to the command palette or title menus",
		)
	})
})
