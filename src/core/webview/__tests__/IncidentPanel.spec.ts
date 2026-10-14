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
	const snapshot = { generatedAt: 1, tasks: [], alerts: [], turns: [] }
	const provider = {
		isIncidentDashboardEnabled: vi.fn(() => enabled),
		subscribeIncidentDashboard: vi.fn((handler) => {
			onChange = handler
			return vi.fn()
		}),
		getIncidentDashboardSnapshot: vi.fn().mockResolvedValue(snapshot),
		getIncidentDashboardTurnDetail: vi.fn().mockResolvedValue(undefined),
		startIncidentDebuggingTask: vi.fn().mockResolvedValue({}),
		startIncidentDebuggingTurnTask: vi.fn().mockResolvedValue({}),
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

	it("loads details and starts investigations only for opaque turn IDs", async () => {
		const turnId = "a".repeat(64)
		const unavailableTurnId = "b".repeat(64)
		const detail = { turn: { id: turnId }, events: [] }
		const { panel, provider, webview, receive } = setup()
		vi.mocked(provider.getIncidentDashboardTurnDetail).mockImplementation(async (requestedTurnId) =>
			requestedTurnId === turnId ? (detail as never) : undefined,
		)
		await panel.open()

		receive({ type: "incidentDashboardRequestTurnDetail", turnId })
		receive({ type: "incidentDashboardRequestTurnDetail", turnId: unavailableTurnId })
		receive({ type: "incidentDashboardRequestTurnDetail", turnId: "raw-turn-id" })
		receive({ type: "startDebuggingTurn", turnId })
		receive({ type: "startDebuggingTurn", turnId: "raw-turn-id" })

		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({
				type: "incidentDashboardTurnDetail",
				turnId,
				detail,
			}),
		)
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({
				type: "incidentDashboardTurnDetail",
				turnId: unavailableTurnId,
			}),
		)
		expect(provider.getIncidentDashboardTurnDetail).toHaveBeenCalledTimes(2)
		expect(provider.getIncidentDashboardTurnDetail).toHaveBeenNthCalledWith(1, turnId)
		expect(provider.getIncidentDashboardTurnDetail).toHaveBeenNthCalledWith(2, unavailableTurnId)
		expect(provider.startIncidentDebuggingTurnTask).toHaveBeenCalledExactlyOnceWith(turnId)
	})

	it("omits stale snapshots when a newer request finishes first", async () => {
		const { panel, provider, webview, receive } = setup()
		const pending: Array<(snapshot: unknown) => void> = []
		vi.mocked(provider.getIncidentDashboardSnapshot).mockImplementation(
			() => new Promise((resolve) => pending.push(resolve as (snapshot: unknown) => void)),
		)
		await panel.open()

		receive({ type: "incidentDashboardReady" })
		receive({ type: "incidentDashboardReady" })
		const stale = { generatedAt: 2, tasks: [], alerts: [], turns: [] }
		const latest = { generatedAt: 3, tasks: [], alerts: [], turns: [] }
		pending[1]!(latest)
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "incidentDashboardUpdate", snapshot: latest }),
		)
		pending[0]!(stale)
		await Promise.resolve()
		expect(webview.postMessage).toHaveBeenCalledTimes(1)
	})

	it("does not open when debug mode is disabled", async () => {
		const { panel } = setup(false)
		await panel.open()
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
	})
})
