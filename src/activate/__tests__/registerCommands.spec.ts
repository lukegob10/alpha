import type { Mock } from "vitest"
import * as vscode from "vscode"
import { readFileSync } from "node:fs"
import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { registerCodeActions } from "../registerCodeActions"

import { getPanel, getVisibleProviderOrLog, registerCommands, setPanel } from "../registerCommands"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
		},
	},
}))

vi.mock("vscode", () => ({
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		registerCommand: vi.fn((command, callback) => ({ command, callback, dispose: vi.fn() })),
		executeCommand: vi.fn(),
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
	},
}))

vi.mock("../../core/webview/AlphaProvider")

describe("getVisibleProviderOrLog", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
	})

	it("returns the visible provider if found", () => {
		const mockProvider = {} as AlphaProvider
		;(AlphaProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(AlphaProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Alpha instances.")
	})
})

describe("panel ownership", () => {
	beforeEach(() => {
		setPanel(undefined, "tab")
		setPanel(undefined, "sidebar")
	})

	it("restores the existing sidebar as active when a tab panel closes", () => {
		const sidebar = {} as vscode.WebviewView
		const tab = {} as vscode.WebviewPanel

		setPanel(sidebar, "sidebar")
		setPanel(tab, "tab")
		expect(getPanel()).toBe(tab)

		setPanel(undefined, "tab")
		expect(getPanel()).toBe(sidebar)
	})
})

describe("registerCommands", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
	})

	it("registers exactly one handler for every contributed keyboard shortcut", () => {
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: {} as AlphaProvider })
		registerCodeActions(context)
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			contributes: { keybindings: Array<{ command: string }>; commands: Array<{ command: string }> }
		}
		const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id)
		for (const { command } of manifest.contributes.keybindings) {
			expect(
				registered.filter((id) => id === command),
				command,
			).toHaveLength(1)
			expect(
				manifest.contributes.commands.some((item) => item.command === command),
				command,
			).toBe(true)
		}
	})

	it.each(["In", "Out"])("routes diagram zoom %s to the native preview", async (direction) => {
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: {} as AlphaProvider })
		const registration = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([command]) => command === `alpha.diagramZoom${direction}`)
		expect(registration).toBeDefined()

		await registration![1]()

		expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(`imagePreview.zoom${direction}`)
	})

	it.each([undefined, "/user/settings.json"])("routes settings import %s through its provider", async (filePath) => {
		const importSettings = vi.fn().mockResolvedValue(undefined)
		const visibleProvider = { importSettings } as unknown as AlphaProvider
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(visibleProvider)
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: visibleProvider })
		const callback = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([command]) => command === "alpha.importSettings")![1]

		await callback(filePath)

		expect(importSettings).toHaveBeenCalledExactlyOnceWith(filePath)
	})

	it("routes New Chat through the UI guard before changing the active task", async () => {
		const startBlankTask = vi.fn().mockResolvedValue(undefined)
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const visibleProvider = {
			startBlankTask,
			removeTaskFromStack: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
		} as unknown as AlphaProvider
		;(AlphaProvider.getVisibleInstance as Mock).mockReturnValue(visibleProvider)

		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: visibleProvider })

		const plusRegistration = (vscode.commands.registerCommand as Mock).mock.calls.find(
			([command]) => command === "alpha.plusButtonClicked",
		)
		expect(plusRegistration).toBeTruthy()

		await plusRegistration![1]()

		expect(visibleProvider.startBlankTask).not.toHaveBeenCalled()
		expect(visibleProvider.removeTaskFromStack).not.toHaveBeenCalled()
		expect(visibleProvider.refreshWorkspace).not.toHaveBeenCalled()
		expect(visibleProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "action",
			action: "newChatButtonClicked",
		})
	})

	it("does not register the removed Goal Seek command", () => {
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: {} as AlphaProvider })
		const commands = vi.mocked(vscode.commands.registerCommand).mock.calls.map(([command]) => command)
		expect(commands).not.toContain("alpha.goalSeekButtonClicked")
		expect(commands).toContain("alpha.scheduledTasksButtonClicked")
	})

	it.each([
		["sidebarNewChat", [{ type: "action", action: "newChatButtonClicked" }]],
		[
			"sidebarSettings",
			[
				{ type: "action", action: "settingsButtonClicked" },
				{ type: "action", action: "didBecomeVisible" },
			],
		],
		["sidebarScheduledTasks", [{ type: "action", action: "switchTab", tab: "scheduledTasks" }]],
		["sidebarMarketplace", [{ type: "action", action: "marketplaceButtonClicked" }]],
	])(
		"keeps the native %s action on its sidebar owner for keyboard and pointer activation",
		async (command, messages) => {
			const sidebar = {
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
				startBlankTask: vi.fn(),
				refreshWorkspace: vi.fn(),
			} as unknown as AlphaProvider
			const editor = { postMessageToWebview: vi.fn(), startBlankTask: vi.fn() } as unknown as AlphaProvider
			vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(editor)
			registerCommands({
				context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
				outputChannel: mockOutputChannel,
				provider: sidebar,
			})
			const callback = vi
				.mocked(vscode.commands.registerCommand)
				.mock.calls.find(([id]) => id === `alpha.${command}`)![1]
			for (const activationContext of [undefined, { preserveFocus: false }, { preserveFocus: true }]) {
				vi.mocked(sidebar.postMessageToWebview).mockClear()
				await callback(activationContext)
				expect(vi.mocked(sidebar.postMessageToWebview).mock.calls.map(([message]) => message)).toEqual(messages)
			}
			expect(AlphaProvider.getVisibleInstance).not.toHaveBeenCalled()
			expect(AlphaProvider.getInstance).not.toHaveBeenCalled()
			expect(editor.postMessageToWebview).not.toHaveBeenCalled()
			// New chat stays behind App's unsaved Settings guard rather than mutating host state first.
			expect(sidebar.startBlankTask).not.toHaveBeenCalled()
			expect(sidebar.refreshWorkspace).not.toHaveBeenCalled()
			expect(editor.startBlankTask).not.toHaveBeenCalled()
		},
	)

	it.each([
		["decreaseReasoningEffort", "adjustTaskReasoningEffort", ["sidebar-task", -1]],
		["increaseReasoningEffort", "adjustTaskReasoningEffort", ["sidebar-task", 1]],
		["previousTask", "navigateTask", [-1]],
		["nextTask", "navigateTask", [1]],
		["nextTaskNeedingInput", "navigateTask", [1, true]],
	] as const)("routes the %s sidebar hotkey to its originating view", async (command, method, args) => {
		const sidebar = {
			getActiveTaskId: vi.fn(() => "sidebar-task"),
			adjustTaskReasoningEffort: vi.fn(),
			navigateTask: vi.fn(),
		} as unknown as AlphaProvider
		const editor = { adjustTaskReasoningEffort: vi.fn(), navigateTask: vi.fn() }
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(editor as unknown as AlphaProvider)
		registerCommands({
			context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: sidebar,
		})
		const callback = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === `alpha.${command}`)![1]
		await callback("sidebar")
		expect(sidebar[method]).toHaveBeenCalledWith(...args)
		expect(editor[method]).not.toHaveBeenCalled()
	})

	it.each(["editor", "sidebar"])(
		"captures the %s task identity when requesting a steering submission",
		async (surface) => {
			const editor = {
				getActiveTaskId: vi.fn(() => "editor-task"),
				postMessageToWebview: vi.fn(),
			} as unknown as AlphaProvider
			const sidebar = {
				getActiveTaskId: vi.fn(() => "sidebar-task"),
				postMessageToWebview: vi.fn(),
			} as unknown as AlphaProvider
			vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(editor)
			registerCommands({
				context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
				outputChannel: mockOutputChannel,
				provider: sidebar,
			})
			const callback = vi
				.mocked(vscode.commands.registerCommand)
				.mock.calls.find(([id]) => id === "alpha.sendAndSteer")![1]
			await callback(surface === "sidebar" ? "sidebar" : undefined)
			const target = surface === "sidebar" ? sidebar : editor
			const other = surface === "sidebar" ? editor : sidebar
			expect(target.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "steerNextQueuedMessage",
				taskId: `${surface}-task`,
			})
			expect(other.postMessageToWebview).not.toHaveBeenCalled()
		},
	)

	it("reveals Alpha when starting a new chat without a visible view", async () => {
		const sidebar = {
			startBlankTask: vi.fn(),
			refreshWorkspace: vi.fn(),
			postMessageToWebview: vi.fn(),
		} as unknown as AlphaProvider
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(undefined)
		vi.mocked(AlphaProvider.getInstance).mockResolvedValue(sidebar)
		registerCommands({
			context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: sidebar,
		})
		const callback = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === "alpha.plusButtonClicked")![1]
		await callback()
		expect(AlphaProvider.getInstance).toHaveBeenCalledTimes(1)
		expect(sidebar.startBlankTask).not.toHaveBeenCalled()
		expect(sidebar.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "action",
			action: "newChatButtonClicked",
		})
	})

	it("focuses the visible provider's composer even when it is an editor chat", async () => {
		const editor = { focusInput: vi.fn() } as unknown as AlphaProvider
		vi.mocked(AlphaProvider.getInstance).mockResolvedValue(editor)
		const sidebar = { focusInput: vi.fn() } as unknown as AlphaProvider
		registerCommands({
			context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: sidebar,
		})
		const callback = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === "alpha.focusInput")![1]
		await callback()
		expect(editor.focusInput).toHaveBeenCalledExactlyOnceWith()
		expect(sidebar.focusInput).not.toHaveBeenCalled()
	})
})
