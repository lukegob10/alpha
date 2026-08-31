import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"

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

vi.mock("../../core/webview/ClineProvider")

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
		const mockProvider = {} as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

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

	it("backgrounds the active task instead of aborting it when the plus button starts a blank task", async () => {
		const startBlankTask = vi.fn().mockResolvedValue(undefined)
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const visibleProvider = {
			startBlankTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
		} as unknown as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(visibleProvider)

		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		registerCommands({ context, outputChannel: mockOutputChannel, provider: visibleProvider })

		const plusRegistration = (vscode.commands.registerCommand as Mock).mock.calls.find(
			([command]) => command === "alpha.plusButtonClicked",
		)
		expect(plusRegistration).toBeTruthy()

		await plusRegistration![1]()

		expect(visibleProvider.startBlankTask).toHaveBeenCalledTimes(1)
		expect(visibleProvider.removeClineFromStack).not.toHaveBeenCalled()
		expect(visibleProvider.refreshWorkspace).toHaveBeenCalledTimes(1)
		expect(visibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
			values: { force: true },
		})
		expect(visibleProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
		expect(postMessageToWebview.mock.invocationCallOrder[0]).toBeLessThan(
			startBlankTask.mock.invocationCallOrder[0],
		)
	})
})
