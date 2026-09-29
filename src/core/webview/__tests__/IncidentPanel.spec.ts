import * as vscode from "vscode"

import type { AlphaProvider } from "../AlphaProvider"
import { IncidentPanel } from "../IncidentPanel"

vi.mock("../webviewHtml", () => ({ resolveWebviewHtml: vi.fn().mockResolvedValue("<html></html>") }))
vi.mock("vscode", () => ({
	window: {
		registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
		createWebviewPanel: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: { onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })) },
	ExtensionMode: { Production: 1 },
	ViewColumn: { Active: 1 },
}))

function setup(enabled = true) {
	let receive: (message: unknown) => void = () => undefined
	let onChange: () => void = () => undefined
	let onDispose: () => void = () => undefined
	const webview = {
		options: {},
		html: "",
		postMessage: vi.fn().mockResolvedValue(true),
		onDidReceiveMessage: vi.fn((handler) => {
			receive = handler
			return { dispose: vi.fn() }
		}),
	}
	const nativePanel = {
		webview,
		reveal: vi.fn(),
		dispose: vi.fn(() => onDispose()),
		onDidDispose: vi.fn((handler) => {
			onDispose = handler
			return { dispose: vi.fn() }
		}),
	}
	vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(nativePanel as unknown as vscode.WebviewPanel)
	const snapshot = { generatedAt: 1, tasks: [], alerts: [] }
	const provider = {
		isIncidentDashboardEnabled: vi.fn(() => enabled),
		subscribeIncidentDashboard: vi.fn((handler) => {
			onChange = handler
			return vi.fn()
		}),
		getIncidentDashboardSnapshot: vi.fn().mockResolvedValue(snapshot),
		startIncidentDebuggingTask: vi.fn().mockResolvedValue({}),
		log: vi.fn(),
	} as unknown as AlphaProvider
	const panel = new IncidentPanel(
		{
			subscriptions: [],
			extensionUri: {} as vscode.Uri,
			extensionMode: vscode.ExtensionMode.Production,
		} as unknown as vscode.ExtensionContext,
		provider,
	)
	return {
		panel,
		provider,
		webview,
		nativePanel,
		snapshot,
		receive: (value: unknown) => receive(value),
		onChange: () => onChange(),
	}
}

describe("IncidentPanel", () => {
	afterEach(() => vi.clearAllMocks())

	it("opens the built extension panel and sends a snapshot when the webview is ready", async () => {
		const { panel, webview, receive, snapshot } = setup()
		await panel.open()
		expect(webview.html).toBe("<html></html>")
		receive({ type: "incidentDashboardReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "incidentDashboardUpdate", snapshot }),
		)
	})

	it("only forwards a bounded alert identity from the user click", async () => {
		const { panel, provider, receive } = setup()
		await panel.open()
		receive({ type: "startDebuggingTask", alertId: "alert-one" })
		receive({ type: "startDebuggingTask", alertId: 3 })
		expect(provider.startIncidentDebuggingTask).toHaveBeenCalledExactlyOnceWith("alert-one")
	})

	it("does not open when debug mode is disabled", async () => {
		const { panel } = setup(false)
		await panel.open()
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
	})
})
