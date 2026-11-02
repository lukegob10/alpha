import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"
import type { TicketTransferEntry } from "@alpha-code/types"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { TicketPanel } from "../TicketPanel"
import { TicketStore } from "../TicketStore"
import { decodeTicketArchive, decodeTicketMarkdown, encodeTicketArchive } from "../TicketArchive"
import { readTicketTransferFile, writeTicketExport } from "../TicketTransferFiles"

vi.mock("../TicketTaskLink", () => ({ workOnTicket: vi.fn() }))
vi.mock("../TicketArchive", () => ({
	decodeTicketArchive: vi.fn(),
	decodeTicketMarkdown: vi.fn(),
	encodeTicketArchive: vi.fn(),
}))
vi.mock("../TicketTransferFiles", () => ({ readTicketTransferFile: vi.fn(), writeTicketExport: vi.fn() }))
vi.mock("../../../core/webview/webviewHtml", () => ({ resolveWebviewHtml: vi.fn(async () => "<tickets>") }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, stat: vi.fn(actual.stat) }
})
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
	window: {
		registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
		createWebviewPanel: vi.fn(),
		showSaveDialog: vi.fn(),
		showOpenDialog: vi.fn(),
	},
	ExtensionMode: { Production: 1 },
	ViewColumn: { Active: 1 },
	env: { language: "en" },
	Uri: { file: vi.fn((fsPath: string) => ({ scheme: "file", fsPath })) },
	RelativePattern: vi.fn(),
}))

const id = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"
const secondId = "62159723-ac39-46a2-8a34-c7d4f3ee9ccd"
const entry: TicketTransferEntry = { path: `backlog/${id}.md`, markdown: "native Markdown", status: "backlog" }
const secondEntry: TicketTransferEntry = {
	path: `complete/${secondId}.md`,
	markdown: "other native Markdown",
	status: "complete",
}
const bytes = new Uint8Array([80, 75, 1, 2])
const plan = {
	preview: {
		tickets: [{ id, name: "Imported ticket", status: "backlog", disposition: "new" }],
		warnings: [],
	},
}
type Reply = { type: string; requestId?: string; result?: { kind?: string; token?: string }; error?: string }

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function mockStore(projectId = "project") {
	return {
		projectId,
		workspace: path.resolve(projectId),
		directory: path.resolve("tickets", projectId),
		prepareReferences: vi.fn().mockResolvedValue(undefined),
		exportTickets: vi.fn().mockResolvedValue([entry]),
		previewImport: vi.fn().mockResolvedValue(plan),
		importTickets: vi.fn().mockResolvedValue({ imported: 1, skipped: 0 }),
		overview: vi.fn().mockResolvedValue({ total: 1, complete: 0, inProgress: 0, backlog: 1, points: [] }),
	}
}

async function setup(twoProjects = false) {
	const store = mockStore()
	const other = mockStore("other")
	vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue(
		[store, ...(twoProjects ? [other] : [])].map((item, index) => ({
			name: item.projectId,
			index,
			uri: vscode.Uri.file(item.workspace),
		})),
	)
	vi.spyOn(TicketStore, "initializeWorkspace").mockResolvedValue(undefined)
	vi.spyOn(TicketStore, "forWorkspace").mockImplementation(async (workspace) => {
		return (workspace === other.workspace ? other : store) as unknown as TicketStore
	})
	const panels: ReturnType<typeof makeNativePanel>[] = []
	function makeNativePanel() {
		let receive: (message: unknown) => void = () => {}
		let close: () => void = () => {}
		const webview = {
			options: {},
			html: "",
			postMessage: vi.fn(),
			onDidReceiveMessage: vi.fn((callback) => {
				receive = callback
				return { dispose: vi.fn() }
			}),
		}
		const native = {
			webview,
			reveal: vi.fn(),
			dispose: vi.fn(() => close()),
			onDidDispose: vi.fn((callback) => {
				close = callback
				return { dispose: vi.fn() }
			}),
		}
		return { native, webview, receive: (message: unknown) => receive(message) }
	}
	vi.mocked(vscode.window.createWebviewPanel).mockImplementation(() => {
		const next = makeNativePanel()
		panels.push(next)
		return next.native as unknown as vscode.WebviewPanel
	})
	const panel = new TicketPanel(
		{ subscriptions: [], extensionUri: "extension", extensionMode: 1 } as unknown as vscode.ExtensionContext,
		{} as AlphaProvider,
	)
	async function ready() {
		await panel.open()
		const current = panels.at(-1)!
		current.receive({ type: "ticketsReady" })
		await vi.waitFor(() =>
			expect(current.webview.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "ticketProjects" }),
			),
		)
		return current
	}
	const current = await ready()
	function send(requestId: string, operation: unknown, project = "project") {
		panels.at(-1)!.receive({ type: "ticketRequest", requestId, project, operation })
	}
	async function reply(requestId: string): Promise<Reply> {
		const target = panels.at(-1)!
		await vi.waitFor(() =>
			expect(target.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId })),
		)
		return target.webview.postMessage.mock.calls.find(([message]) => message.requestId === requestId)![0]
	}
	async function preview() {
		send("preview", { action: "previewImport" })
		const response = await reply("preview")
		expect(response.result?.kind).toBe("importPreview")
		return response.result!.token!
	}
	return { panel, current, store, other, ready, send, reply, preview }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(vscode.window.showSaveDialog)
		.mockReset()
		.mockResolvedValue(vscode.Uri.file(path.resolve("export.zip")))
	vi.mocked(vscode.window.showOpenDialog)
		.mockReset()
		.mockResolvedValue([vscode.Uri.file(path.resolve("import.zip"))])
	vi.mocked(fs.stat)
		.mockReset()
		.mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>)
	vi.mocked(readTicketTransferFile).mockReset().mockResolvedValue(bytes)
	vi.mocked(writeTicketExport).mockReset().mockResolvedValue(undefined)
	vi.mocked(encodeTicketArchive).mockReset().mockResolvedValue(bytes)
	vi.mocked(decodeTicketArchive).mockReset().mockResolvedValue([entry])
	vi.mocked(decodeTicketMarkdown).mockReset().mockReturnValue(secondEntry)
})
afterEach(() => vi.restoreAllMocks())

describe("TicketPanel transfer boundary", () => {
	it.each([
		{ ids: [id], includeDescendants: false },
		{ filter: { query: "sharing", type: "feature", offset: 0, limit: 50 }, includeDescendants: true },
		{ includeDescendants: true },
	])("exports the complete requested scope %j through a native save dialog", async (input) => {
		const task = await setup()
		task.send("export", { action: "export", input })
		expect(await task.reply("export")).toMatchObject({
			result: { kind: "exported", count: 1, fileName: "export.zip" },
		})
		expect(task.store.exportTickets).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
		expect(writeTicketExport).toHaveBeenCalledExactlyOnceWith(
			path.resolve("export.zip"),
			bytes,
			expect.any(AbortSignal),
		)
		expect(task.current.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "ticketChanged" }),
		)
		task.panel.dispose()
	})

	it.each([true, false])("suggests Downloads when available: %s", async (downloadsAvailable) => {
		vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => downloadsAvailable } as Awaited<
			ReturnType<typeof fs.stat>
		>)
		const task = await setup()
		task.send("export", { action: "export", input: {} })
		await task.reply("export")
		expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultUri: vscode.Uri.file(
					path.join(os.homedir(), ...(downloadsAvailable ? ["Downloads"] : []), "project-tickets.zip"),
				),
			}),
		)
		task.panel.dispose()
	})

	it("does not encode or write an export when Save is canceled", async () => {
		vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined)
		const task = await setup()
		task.send("export", { action: "export", input: {} })
		expect(await task.reply("export")).toMatchObject({ result: { kind: "cancelled" } })
		expect(encodeTicketArchive).not.toHaveBeenCalled()
		expect(writeTicketExport).not.toHaveBeenCalled()
		task.panel.dispose()
	})

	it("previews multiple native selections without importing until the token is committed", async () => {
		const selected = [vscode.Uri.file(path.resolve("one.zip")), vscode.Uri.file(path.resolve("two.md"))]
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(selected)
		vi.mocked(readTicketTransferFile).mockResolvedValueOnce(bytes).mockResolvedValueOnce(Buffer.from("markdown"))
		const task = await setup()
		const token = await task.preview()
		expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(
			expect.objectContaining({ canSelectMany: true, canSelectFolders: false }),
		)
		expect(task.store.previewImport).toHaveBeenCalledExactlyOnceWith([entry, secondEntry], expect.any(AbortSignal))
		expect(task.store.importTickets).not.toHaveBeenCalled()
		expect(task.current.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "ticketChanged" }),
		)
		task.send("commit", { action: "import", token, mode: "update", resetStatus: false })
		expect(await task.reply("commit")).toMatchObject({ result: { kind: "imported", imported: 1, skipped: 0 } })
		expect(task.store.importTickets).toHaveBeenCalledExactlyOnceWith(
			plan,
			{ mode: "update", resetStatus: false },
			expect.any(AbortSignal),
		)
		expect(task.current.webview.postMessage.mock.calls.slice(-2)).toEqual([
			[{ type: "ticketResponse", requestId: "commit", result: { kind: "imported", imported: 1, skipped: 0 } }],
			[{ type: "ticketChanged", project: "project" }],
		])
		task.send("replay", { action: "import", token, mode: "copy", resetStatus: true })
		expect(await task.reply("replay")).toMatchObject({ error: "common:ticketTransfer.expired" })
		expect(task.store.importTickets).toHaveBeenCalledOnce()
		task.panel.dispose()
	})

	it("binds previews to their project and releases discarded tokens", async () => {
		const task = await setup(true)
		const token = await task.preview()
		task.send("foreign", { action: "import", token, mode: "copy", resetStatus: true }, "other")
		expect(await task.reply("foreign")).toMatchObject({ error: "common:ticketTransfer.expired" })
		expect(task.other.importTickets).not.toHaveBeenCalled()
		task.send("discard", { action: "discardImport", token })
		await task.reply("discard")
		task.send("discarded", { action: "import", token, mode: "copy", resetStatus: true })
		expect(await task.reply("discarded")).toMatchObject({ error: "common:ticketTransfer.expired" })
		expect(task.store.importTickets).not.toHaveBeenCalled()
		task.panel.dispose()
	})

	it("expires old previews and does not publish a committed change", async () => {
		const task = await setup()
		const token = await task.preview()
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000)
		task.send("expired", { action: "import", token, mode: "copy", resetStatus: true })
		expect(await task.reply("expired")).toMatchObject({ error: "common:ticketTransfer.expired" })
		expect(task.store.importTickets).not.toHaveBeenCalled()
		expect(task.current.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "ticketChanged" }),
		)
		task.panel.dispose()
	})

	it("only reads paths selected in the native picker", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined)
		const task = await setup()
		task.send("untrusted", { action: "previewImport", path: "/untrusted/file.md" })
		expect(await task.reply("untrusted")).toMatchObject({ result: { kind: "cancelled" } })
		expect(readTicketTransferFile).not.toHaveBeenCalled()
		expect(task.store.previewImport).not.toHaveBeenCalled()
		task.panel.dispose()
	})

	it("serializes native transfers and ignores a late dialog after the panel reopens", async () => {
		const dialog = deferred<vscode.Uri[] | undefined>()
		vi.mocked(vscode.window.showOpenDialog).mockReturnValueOnce(dialog.promise)
		const task = await setup()
		task.send("old-preview", { action: "previewImport" })
		await vi.waitFor(() => expect(vscode.window.showOpenDialog).toHaveBeenCalledOnce())
		task.send("second", { action: "previewImport" })
		expect(await task.reply("second")).toMatchObject({ error: "common:ticketTransfer.busy" })
		task.current.native.dispose()
		const next = await task.ready()
		dialog.resolve([vscode.Uri.file(path.resolve("late.zip"))])
		task.send("fresh", { action: "previewImport" })
		expect(await task.reply("fresh")).toMatchObject({ result: { kind: "importPreview" } })
		expect(readTicketTransferFile).toHaveBeenCalledOnce()
		expect(next.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: "old-preview" }))
		expect(task.store.importTickets).not.toHaveBeenCalled()
		task.panel.dispose()
	})

	it("drops a previous token when a replacement preview fails", async () => {
		const task = await setup()
		const token = await task.preview()
		vi.mocked(decodeTicketArchive).mockRejectedValueOnce(new Error("Malformed archive"))
		task.send("bad-preview", { action: "previewImport" })
		expect(await task.reply("bad-preview")).toMatchObject({ error: "Malformed archive" })
		task.send("old-token", { action: "import", token, mode: "copy", resetStatus: true })
		expect(await task.reply("old-token")).toMatchObject({ error: "common:ticketTransfer.expired" })
		expect(task.store.importTickets).not.toHaveBeenCalled()
		task.panel.dispose()
	})

	it("coalesces watcher bursts and clears a pending refresh when the panel closes", async () => {
		const task = await setup()
		const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[0].value
		const created = vi.mocked(watcher.onDidCreate).mock.calls[0][0]
		const changed = vi.mocked(watcher.onDidChange).mock.calls[0][0]
		const deleted = vi.mocked(watcher.onDidDelete).mock.calls[0][0]
		const file = vscode.Uri.file(path.join(task.store.directory, entry.path))
		task.current.webview.postMessage.mockClear()
		vi.useFakeTimers()
		try {
			for (let index = 0; index < 100; index++) {
				created(file)
				changed(file)
				deleted(file)
			}
			vi.advanceTimersByTime(100)
			expect(task.current.webview.postMessage).not.toHaveBeenCalled()
			changed(file)
			vi.advanceTimersByTime(149)
			expect(task.current.webview.postMessage).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1)
			expect(task.current.webview.postMessage).toHaveBeenCalledExactlyOnceWith({
				type: "ticketChanged",
				project: "project",
			})

			task.current.webview.postMessage.mockClear()
			created(file)
			task.panel.dispose()
			expect(vi.getTimerCount()).toBe(0)
			vi.advanceTimersByTime(150)
			expect(task.current.webview.postMessage).not.toHaveBeenCalled()
		} finally {
			task.panel.dispose()
			vi.useRealTimers()
		}
	})
})
