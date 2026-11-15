import * as assert from "assert"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as vscode from "vscode"

import {
	retiredProviderNames,
	type AlphaCodeSettings,
	type AlphaMessage,
	type HistoryItem,
	type LiveTaskMetadata,
	type WebviewMessage,
} from "@alpha-code/types"

import { assertRequestedHostVersion, setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

suite("Alpha Extension", function () {
	setDefaultSuiteTimeout(this)

	test("Runs on the requested VS Code version", () => {
		assertRequestedHostVersion(vscode.version, process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION)
	})

	test("saves interleaved assistant text as one completed row", async () => {
		const api = globalThis.api
		const host = (
			api as unknown as {
				sidebarProvider: {
					getLiveTask(id: string): { didComplete: boolean; alphaMessages: AlphaMessage[] } | undefined
					getTaskWithId(id: string): Promise<{ taskDirPath: string }>
				}
			}
		).sidebarProvider
		const answer = "I checked the ticket."
		let previewTimestamp: number | undefined
		const model = {
			id: "interleaved-assistant-text",
			async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
				assert.ok(metadata?.taskId)
				const id = metadata.taskId
				yield { type: "reasoning" as const, text: "Checking the request." }
				yield { type: "text" as const, text: "I" }
				await waitFor(
					() => {
						previewTimestamp = host
							.getLiveTask(id)
							?.alphaMessages.find(({ say, text }) => say === "text" && text === "I")?.ts
						return previewTimestamp !== undefined
					},
					{ timeout: 10_000, description: "the first assistant text chunk" },
				)
				yield { type: "reasoning" as const, text: "The ticket is available." }
				yield { type: "text" as const, text: answer.slice(1) }
				yield { type: "usage" as const, inputTokens: 12, outputTokens: 8 }
			},
			getModel() {
				return { id: this.id, info: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false } }
			},
			async countTokens() {
				return 1
			},
			async completePrompt() {
				return ""
			},
		}
		const id = await api.startNewTask({
			text: "Check the disposable ticket fixture.",
			presentationModelCalls: false,
			configuration: {
				...api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				enableCheckpoints: false,
				postTurnCondenseContextPercent: 0,
			},
		})
		try {
			await waitFor(() => host.getLiveTask(id)?.didComplete === true, { timeout: 20_000 })
			const { taskDirPath } = await host.getTaskWithId(id)
			const saved: AlphaMessage[] = JSON.parse(await readFile(join(taskDirPath, "ui_messages.json"), "utf8"))
			// The first saved text row represents the opening user prompt.
			assert.equal(saved[0]?.text, "Check the disposable ticket fixture.")
			const textRows = saved.slice(1).filter(({ say }) => say === "text" || say === "completion_result")
			assert.deepStrictEqual(
				textRows.map(({ ts, text, partial }) => ({ ts, text, partial })),
				[{ ts: previewTimestamp, text: answer, partial: false }],
			)
			assert.ok(saved.some(({ say, text }) => say === "reasoning" && text?.includes("The ticket is available.")))
		} finally {
			await api.clearCurrentTask()
		}
	})

	test("bulk deletes saved chats in this workspace and leaves other projects alone", async () => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace)
		const host = (
			globalThis.api as unknown as {
				sidebarProvider: {
					setWebviewMessageListener(webview: Pick<vscode.Webview, "onDidReceiveMessage">): void
					updateTaskHistory(item: HistoryItem, options: { broadcast: boolean }): Promise<unknown>
					getTaskWithId(
						id: string,
						options: { includeApiConversationHistory: boolean },
					): Promise<{ historyItem: HistoryItem }>
					deleteTaskWithId(id: string): Promise<void>
				}
			}
		).sidebarProvider
		let receive: ((message: WebviewMessage) => Promise<void>) | undefined
		const subscription = new vscode.Disposable(() => {
			receive = undefined
		})
		host.setWebviewMessageListener({
			onDidReceiveMessage(handler) {
				receive = handler
				return subscription
			},
		})
		assert.ok(receive)
		const prefix = `host-delete-${randomUUID()}`
		const parentId = `${prefix}-parent`
		const childId = `${prefix}-child`
		const foreignId = `${prefix}-foreign`
		const keptId = `${prefix}-kept`
		const fixture = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
			id,
			workspace,
			ts: Date.now(),
			number: 1,
			task: "Disposable bulk-delete fixture",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			...extra,
		})
		const lookup = (id: string) => host.getTaskWithId(id, { includeApiConversationHistory: false })
		try {
			for (const item of [
				fixture(parentId, { childIds: [childId] }),
				fixture(childId, { parentTaskId: parentId }),
				fixture(foreignId, { workspace: `${workspace}-other` }),
				fixture(keptId),
			])
				await host.updateTaskHistory(item, { broadcast: false })

			await receive({ type: "deleteMultipleTasksWithIds", ids: [parentId, childId, parentId, foreignId] })

			await assert.rejects(lookup(parentId), /Task not found/)
			await assert.rejects(lookup(childId), /Task not found/)
			assert.equal((await lookup(foreignId)).historyItem.id, foreignId)
			assert.equal((await lookup(keptId)).historyItem.id, keptId)
		} finally {
			subscription.dispose()
			for (const id of [parentId, childId, foreignId, keptId]) await host.deleteTaskWithId(id)
		}
	})

	test("opens a conversation fork and continuations inherit the saved context", async () => {
		const api = globalThis.api
		const original = api.getConfiguration()
		const host = (
			api as unknown as {
				sidebarProvider: {
					setWebviewMessageListener(webview: {
						onDidReceiveMessage(receive: (message: WebviewMessage) => Promise<void>): vscode.Disposable
					}): void
					getCurrentTask(): { taskId: string } | undefined
					getLiveTask(taskId: string): { didComplete: boolean; alphaMessages: AlphaMessage[] } | undefined
					getLiveTaskMetadata(): Record<string, LiveTaskMetadata>
					getTaskWithId(
						taskId: string,
					): Promise<{ historyItem: HistoryItem; apiConversationHistory: unknown[] }>
					deleteTaskWithId(taskId: string): Promise<void>
				}
			}
		).sidebarProvider
		let receive: ((message: WebviewMessage) => Promise<void>) | undefined
		const subscription = new vscode.Disposable(() => {
			receive = undefined
		})
		host.setWebviewMessageListener({
			onDidReceiveMessage(listener) {
				receive = listener
				return subscription
			},
		})
		assert.ok(receive)

		const requests: Array<{ taskId?: string; history: string }> = []
		const model = {
			id: "chat-fork-fixture",
			async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
				requests.push({ taskId: metadata?.taskId, history: JSON.stringify(messages) })
				yield {
					type: "text" as const,
					text: requests.length === 1 ? "The parser issue is understood." : "The fork continued.",
				}
				yield { type: "usage" as const, inputTokens: 100, outputTokens: 10 }
			},
			getModel() {
				return { id: this.id, info: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false } }
			},
			async countTokens() {
				return 100
			},
			async completePrompt() {
				return ""
			},
		}
		const taskIds: string[] = []
		try {
			const sourceId = await api.startNewTask({
				text: "Analyze the parser fixture.",
				presentationModelCalls: false,
				configuration: {
					...original,
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "code",
					enableCheckpoints: false,
					postTurnCondenseContextPercent: 0,
				},
			})
			taskIds.push(sourceId)
			await waitFor(() => host.getLiveTask(sourceId)?.didComplete === true, { timeout: 20_000 })
			const source = await host.getTaskWithId(sourceId)

			await receive({ type: "forkChat", taskId: sourceId, displayName: "Alternate parser investigation" })
			const forkId = host.getCurrentTask()?.taskId
			assert.ok(forkId)
			assert.notEqual(forkId, sourceId)
			taskIds.push(forkId)
			const fork = await host.getTaskWithId(forkId)
			assert.equal(fork.historyItem.forkedFromId, sourceId)
			assert.equal(fork.historyItem.displayName, "Alternate parser investigation")
			assert.ok(JSON.stringify(fork.apiConversationHistory).includes("The parser issue is understood."))
			const assertIdleFork = async () => {
				await waitFor(() => host.getLiveTask(forkId)?.didComplete === true, {
					description: "the fork to finish loading and become idle",
					timeout: 15_000,
				})
				const live = host.getLiveTask(forkId)
				assert.ok(live)
				assert.ok(live.alphaMessages.some((message) => message.text === "The parser issue is understood."))
				assert.ok(
					!live.alphaMessages.some(({ ask }) => ask === "resume_task" || ask === "resume_completed_task"),
				)
				assert.equal(host.getLiveTaskMetadata()[forkId]?.isTurnActive, false)
				assert.equal(host.getLiveTaskMetadata()[forkId]?.isWaitingForInput, false)
				assert.equal((await host.getTaskWithId(forkId)).historyItem.forkSessionStarted, false)
				assert.equal(requests.length, 1, "Opening a fork must wait for the user's next message")
			}
			await assertIdleFork()
			await api.clearCurrentTask()
			assert.equal(host.getLiveTask(forkId), undefined)
			await receive({ type: "showTaskWithId", text: forkId })
			assert.equal(host.getCurrentTask()?.taskId, forkId)
			await assertIdleFork()

			await receive({
				type: "resumeCompletedTask",
				taskId: forkId,
				requestId: randomUUID(),
				text: "Explore a different fix.",
			})
			await waitFor(() => host.getLiveTask(forkId)?.didComplete === true, { timeout: 20_000 })
			assert.equal(requests.length, 2)
			const continuation = requests[1]
			assert.ok(continuation)
			assert.equal(continuation.taskId, forkId)
			assert.ok(continuation.history.includes("The parser issue is understood."))
			assert.ok(continuation.history.includes("Explore a different fix."))
			assert.equal((await host.getTaskWithId(forkId)).historyItem.forkSessionStarted, true)
			assert.deepEqual((await host.getTaskWithId(sourceId)).apiConversationHistory, source.apiConversationHistory)
		} finally {
			subscription.dispose()
			for (const taskId of taskIds.reverse()) await host.deleteTaskWithId(taskId)
			await api.setConfiguration(original)
		}
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
			for (const retiredSettings of [
				...["default", "friendly", "pragmatic", "none"].map((personality) => ({ personality })),
				{ enhancementApiConfigId: "retired-profile" },
				{ includeTaskHistoryInEnhance: true },
			]) {
				const legacy = { ...original, ...retiredSettings }
				await api.setConfiguration(legacy)
				for (const key of Object.keys(retiredSettings)) {
					assert.ok(!(key in api.getConfiguration()))
					assert.ok(!(key in (await host.getState())))
					assert.ok(!(key in (await host.getStateToPostToWebview())))
				}
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
		// VS Code 1.141.0 title-menu mouse actions forward this focus context.
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
			"alpha.plusButtonClicked",
			"alpha.settingsButtonClicked",
			"alpha.openTickets",
			"alpha.historyButtonClicked",
			"alpha.openIncidents",
			"alpha.scheduledTasksButtonClicked",
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
		])
		for (const command of ["alpha.sidebarNewChat", "alpha.sidebarSettings", "alpha.sidebarScheduledTasks"]) {
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
			"popoutButtonClicked",
			"openInNewTab",
			"settingsButtonClicked",
			"historyButtonClicked",
			"scheduledTasksButtonClicked",
			"openTickets",
			"openIncidents",
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
		]

		const commands = new Set((await vscode.commands.getCommands(true)).filter((cmd) => cmd.startsWith("alpha")))

		for (const command of expectedCommands) {
			assert.ok(commands.has(`alpha.${command}`), `Command ${command} should be registered`)
		}

		const retiredCommands = [
			"sidebarMarketplace",
			"marketplaceButtonClicked",
			"goalSeekButtonClicked",
			"explainCode",
			"fixCode",
			"improveCode",
			"addToContext",
			"terminalAddToContext",
			"terminalFixCommand",
			"terminalExplainCommand",
		]
		for (const command of retiredCommands) {
			assert.ok(!commands.has(`alpha.${command}`), `Retired command ${command} must not be registered`)
		}
		const extensionId = process.env.ALPHA_E2E_EXTENSION_ID
		assert.ok(extensionId, "The E2E runner should provide the extension ID")
		const extension = vscode.extensions.getExtension(extensionId)
		assert.ok(extension, "Alpha extension should be installed")
		const contributions = JSON.stringify(extension.packageJSON.contributes)
		for (const command of retiredCommands) {
			assert.ok(!contributions.includes(`alpha.${command}`), `Retired command ${command} must not be contributed`)
		}
	})
})
