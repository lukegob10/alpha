import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { TicketPanel } from "../TicketPanel"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { TicketStore } from "../TicketStore"
vi.mock("../TicketTaskLink", () => ({ workOnTicket: vi.fn() }))
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
		createFileSystemWatcher: vi.fn(() => ({
			dispose: vi.fn(),
			onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
		})),
	},
	window: { registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })), createWebviewPanel: vi.fn() },
	ViewColumn: { Beside: 2 },
	env: { language: "en" },
	Uri: { joinPath: vi.fn(() => "asset"), file: vi.fn((fsPath) => ({ scheme: "file", fsPath })) },
	RelativePattern: vi.fn(),
}))
beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([])
	vi.spyOn(TicketStore, "initializeWorkspace").mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
function setupProject() {
	vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
		{ name: "Project", index: 0, uri: { scheme: "file", fsPath: "/project" } as vscode.Uri },
	])
	const result = { tickets: [{ id: "ticket", name: "Still here" }], total: 1, invalidFiles: [] }
	const store = {
		projectId: "project",
		workspace: "/project",
		directory: "/tickets/project",
		prepareReferences: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue(result),
		delete: vi.fn(),
	}
	vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store as unknown as TicketStore)
	return { store, result }
}
function createPanel() {
	let receive: (message: unknown) => void = () => {}
	let close: () => void = () => {}
	const webview = {
		options: {},
		html: "",
		cspSource: "test",
		asWebviewUri: vi.fn(),
		postMessage: vi.fn(),
		onDidReceiveMessage: vi.fn((callback) => {
			receive = callback
			return { dispose: vi.fn() }
		}),
	}
	const nativePanel = {
		webview,
		reveal: vi.fn(),
		dispose: vi.fn(() => close()),
		onDidDispose: vi.fn((callback) => {
			close = callback
			return { dispose: vi.fn() }
		}),
	}
	vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(nativePanel as unknown as vscode.WebviewPanel)
	const panel = new TicketPanel(
		{ subscriptions: [], extensionUri: "extension" } as unknown as vscode.ExtensionContext,
		{} as ClineProvider,
	)
	return { panel, webview, receive: (message: unknown) => receive(message), nativePanel }
}
const listRequest = (requestId: string, project = "project") => ({
	type: "ticketRequest",
	requestId,
	project,
	operation: { action: "list", input: {} },
})

describe("ticket panel navigation", () => {
	it.each([undefined, null, { preserveFocus: false }, { preserveFocus: true }])(
		"opens and reveals the ticket board with command menu context %j",
		async (context) => {
			const { panel, nativePanel, webview, receive } = createPanel()
			await panel.open(context)
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce()
			receive({ type: "ticketsReady" })
			await vi.waitFor(() =>
				expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
			)
			await panel.open(context)
			expect(nativePanel.reveal).toHaveBeenCalledOnce()
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce()
			expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ticketOpen" }))
			panel.dispose()
		},
	)

	it.each([{}, { project: "project" }, { preserveFocus: false, project: "project", id: "invalid" }])(
		"still rejects malformed ticket targets %j",
		async (target) => {
			const { panel, nativePanel } = createPanel()
			await panel.open(target)
			expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
			await panel.open()
			await panel.open(target)
			expect(nativePanel.reveal).not.toHaveBeenCalled()
			panel.dispose()
		},
	)

	it("publishes deletion and refresh only after the selected store commits", async () => {
		const { store } = setupProject()
		const pending = deferred()
		const ticket = { id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f", revision: "revision", name: "Delete this" }
		store.delete.mockImplementation(async () => {
			await pending.promise
			return ticket
		})
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		receive({
			type: "ticketRequest",
			requestId: "delete",
			project: "project",
			operation: { action: "delete", input: { id: ticket.id, expectedRevision: ticket.revision } },
		})
		await vi.waitFor(() =>
			expect(store.delete).toHaveBeenCalledExactlyOnceWith({ id: ticket.id, expectedRevision: ticket.revision }),
		)
		expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ticketChanged" }))
		pending.resolve()
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "ticketChanged", project: "project" }),
		)
		expect(webview.postMessage.mock.calls.slice(-2)).toEqual([
			[{ type: "ticketResponse", requestId: "delete", result: ticket }],
			[{ type: "ticketChanged", project: "project" }],
		])
		panel.dispose()
	})

	it("returns a failed deletion without reporting a committed change", async () => {
		const { store } = setupProject()
		store.delete.mockRejectedValue(new Error("Ticket changed; reload before deleting"))
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		receive({
			type: "ticketRequest",
			requestId: "stale-delete",
			project: "project",
			operation: { action: "delete", input: { id: "PRO-01", expectedRevision: "stale" } },
		})
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({
				type: "ticketResponse",
				requestId: "stale-delete",
				error: "Ticket changed; reload before deleting",
			}),
		)
		expect(store.delete).toHaveBeenCalledExactlyOnceWith({ id: "PRO-01", expectedRevision: "stale" })
		expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ticketChanged" }))
		panel.dispose()
	})

	it("rejects unknown projects and revision-free delete requests", async () => {
		const { store } = setupProject()
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		receive({
			type: "ticketRequest",
			requestId: "invalid-delete",
			project: "project",
			operation: { action: "delete", input: { id: "PRO-01" } },
		})
		receive({
			type: "ticketRequest",
			requestId: "foreign-delete",
			project: "other-project",
			operation: { action: "delete", input: { id: "PRO-01", expectedRevision: "revision" } },
		})
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({
				type: "ticketResponse",
				requestId: "foreign-delete",
				error: "Open the ticket's project workspace first",
			}),
		)
		expect(store.delete).not.toHaveBeenCalled()
		expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ticketChanged" }))
		panel.dispose()
	})

	it("keeps the latest discovery snapshot when an older load fails late", async () => {
		const { store, result } = setupProject()
		const previous = deferred()
		store.prepareReferences.mockReturnValueOnce(previous.promise)
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() => expect(store.prepareReferences).toHaveBeenCalledOnce())
		receive(listRequest("waiting"))
		vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mock.calls.at(-1)![0]({ added: [], removed: [] })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		previous.reject(new Error("Obsolete discovery failed"))
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "ticketResponse", requestId: "waiting", result }),
		)
		expect(webview.postMessage.mock.calls.filter(([message]) => message.error)).toEqual([])
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledOnce()
		panel.dispose()
	})
	it("does not publish a late result into a reopened panel", async () => {
		const { store, result } = setupProject()
		let complete!: (value: typeof result) => void
		store.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve
				}),
		)
		const { panel, webview, receive, nativePanel } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		receive(listRequest("old"))
		await vi.waitFor(() => expect(store.list).toHaveBeenCalledOnce())
		nativePanel.dispose()
		const nextWebview = { ...webview, postMessage: vi.fn() }
		vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
			...nativePanel,
			webview: nextWebview,
		} as unknown as vscode.WebviewPanel)
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(nextWebview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		complete(result)
		receive(listRequest("new"))
		await vi.waitFor(() =>
			expect(nextWebview.postMessage).toHaveBeenCalledWith({ type: "ticketResponse", requestId: "new", result }),
		)
		expect(nextWebview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "old" }))
		panel.dispose()
	})
	it("waits for project initialization before handling a restored list request", async () => {
		const { store, result } = setupProject()
		const preparation = deferred()
		store.prepareReferences.mockReturnValue(preparation.promise)
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() => expect(store.prepareReferences).toHaveBeenCalled())
		receive(listRequest("restored"))
		expect(webview.postMessage.mock.calls.filter(([message]) => message.type === "ticketResponse")).toEqual([])
		preparation.resolve()
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "ticketResponse", requestId: "restored", result }),
		)
		panel.dispose()
	})
	it("waits for workspace refresh and rejects projects actually removed from the workspace", async () => {
		const { store, result } = setupProject()
		const { panel, webview, receive } = createPanel()
		await panel.open()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ticketProjects" })),
		)
		const preparation = deferred()
		store.prepareReferences.mockReturnValue(preparation.promise)
		const workspaceChanged = vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mock.calls.at(-1)![0]
		workspaceChanged({ added: [], removed: [] })
		await vi.waitFor(() => expect(store.prepareReferences).toHaveBeenCalledTimes(2))
		receive(listRequest("refresh"))
		expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "refresh" }))
		preparation.resolve()
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith({ type: "ticketResponse", requestId: "refresh", result }),
		)
		vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([])
		workspaceChanged({ added: [], removed: [] })
		receive(listRequest("removed"))
		await vi.waitFor(() =>
			expect(webview.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ requestId: "removed", error: "Open the ticket's project workspace first" }),
			),
		)
		panel.dispose()
	})
	it("delivers a selected ticket after initial loading and immediately when already open", async () => {
		let receive: (message: unknown) => void = () => {}
		const webview = {
			options: {},
			html: "",
			cspSource: "test",
			asWebviewUri: vi.fn(),
			postMessage: vi.fn(),
			onDidReceiveMessage: vi.fn((callback) => {
				receive = callback
				return { dispose: vi.fn() }
			}),
		}
		const nativePanel = {
			webview,
			reveal: vi.fn(),
			dispose: vi.fn(),
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
		}
		vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(nativePanel as unknown as vscode.WebviewPanel)
		const panel = new TicketPanel(
			{ subscriptions: [], extensionUri: "extension" } as unknown as vscode.ExtensionContext,
			{} as ClineProvider,
		)
		const target = { project: "project", id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f" }
		await panel.open(target)
		expect(webview.postMessage).not.toHaveBeenCalled()
		receive({ type: "ticketsReady" })
		await vi.waitFor(() => expect(webview.postMessage).toHaveBeenCalledWith({ type: "ticketOpen", target }))
		webview.postMessage.mockClear()
		await panel.open(target)
		expect(nativePanel.reveal).toHaveBeenCalledOnce()
		expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ticketOpen", target })
		panel.dispose()
	})
})
