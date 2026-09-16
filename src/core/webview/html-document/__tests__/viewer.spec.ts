import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { setImmediate as nextTurn, setTimeout as waitForIo } from "node:timers/promises"
import { load } from "cheerio"
import * as vscode from "vscode"
import { HTML_DOCUMENT_LIMITS } from "@alpha-code/types"
import { HtmlDocumentViewer } from "../viewer"

const host = vi.hoisted(() => {
	function event() {
		const listeners = new Set<(value?: any) => void>()
		return {
			listeners,
			subscribe: vi.fn((listener: (value?: any) => void) => {
				listeners.add(listener)
				return { dispose: vi.fn(() => listeners.delete(listener)) }
			}),
			fire: (value?: any) => {
				for (const listener of [...listeners]) listener(value)
			},
		}
	}
	function panel() {
		const messages = event()
		const closed = event()
		return {
			title: "",
			reveal: vi.fn(),
			dispose: vi.fn(() => closed.fire()),
			onDidDispose: closed.subscribe,
			messages,
			closed,
			webview: {
				html: "",
				options: {},
				cspSource: "vscode-webview://test",
				asWebviewUri: (uri: any) => uri,
				onDidReceiveMessage: messages.subscribe,
				postMessage: vi.fn(async (_message: any) => true),
			},
		}
	}
	return {
		event,
		panel,
		changes: event(),
		closes: event(),
		folders: event(),
		panels: [] as ReturnType<typeof panel>[],
		watchers: [] as any[],
	}
})

vi.mock("vscode", async () => {
	const { fileURLToPath, pathToFileURL } = await import("node:url")
	const nodePath = await import("node:path")
	const file = (fsPath: string) => ({ scheme: "file", fsPath, toString: () => pathToFileURL(fsPath).toString() })
	return {
		Uri: {
			file,
			parse: (uri: string) =>
				uri.startsWith("file:")
					? file(fileURLToPath(uri))
					: { scheme: new URL(uri).protocol.slice(0, -1), toString: () => uri },
			joinPath: (uri: any, ...parts: string[]) => file(nodePath.join(uri.fsPath, ...parts)),
		},
		ViewColumn: { Beside: -2, Two: 2 },
		env: { openExternal: vi.fn(async () => true) },
		RelativePattern: class {
			constructor(
				public base: string,
				public pattern: string,
			) {}
		},
		Position: class {
			constructor(
				public line: number,
				public character: number,
			) {}
		},
		Range: class {
			constructor(
				public start: any,
				public end: any,
			) {}
		},
		workspace: {
			workspaceFolders: [],
			textDocuments: [],
			onDidChangeTextDocument: host.changes.subscribe,
			onDidCloseTextDocument: host.closes.subscribe,
			onDidChangeWorkspaceFolders: host.folders.subscribe,
			openTextDocument: vi.fn(async (uri: any) => ({ uri, lineCount: 3 })),
			createFileSystemWatcher: vi.fn(() => {
				const change = host.event(),
					create = host.event(),
					deleted = host.event()
				const watcher = {
					change,
					create,
					deleted,
					onDidChange: change.subscribe,
					onDidCreate: create.subscribe,
					onDidDelete: deleted.subscribe,
					dispose: vi.fn(),
				}
				host.watchers.push(watcher)
				return watcher
			}),
		},
		window: {
			tabGroups: { activeTabGroup: { viewColumn: 3 } },
			createWebviewPanel: vi.fn(() => {
				const panel = host.panel()
				host.panels.push(panel)
				return panel
			}),
			showTextDocument: vi.fn(async () => undefined),
			showErrorMessage: vi.fn(async () => undefined),
		},
	}
})
vi.mock("../../../../i18n", () => ({
	t: (key: string) => key,
	default: { language: "en", getResourceBundle: () => ({}) },
}))
vi.mock("../parser", async () => {
	const { sanitizeDocument } = await import("../sanitize")
	return {
		DocumentParser: class {
			async parse(source: string) {
				return sanitizeDocument(source)
			}
			cancelPending() {}
			dispose() {}
		},
	}
})
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>()
	return { ...actual, open: vi.fn(actual.open) }
})

const documentHtml = (title: string, body = "<p>Evidence</p>") =>
	`<!doctype html><html><head><meta name="alpha-document" content="1"><title>${title}</title></head><body><main class="alpha-doc" data-alpha-kit="1">${body}</main></body></html>`
type Panel = ReturnType<typeof host.panel>
const latest = (panel: Panel) => panel.webview.postMessage.mock.calls.at(-1)?.[0]

describe("HTML document viewer lifecycle through host boundaries", () => {
	let root: string
	let viewer: HtmlDocumentViewer
	const target = (name: string, taskId = "task-one") => ({
		uri: pathToFileURL(path.join(root, name)).toString(),
		taskId,
	})

	async function flushUntil(assertion: () => void) {
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				assertion()
				return
			} catch {
				await waitForIo(2)
			}
		}
		assertion()
	}
	async function refresh(panel: Panel, fire: () => void) {
		const count = panel.webview.postMessage.mock.calls.length
		fire()
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		await flushUntil(() => expect(panel.webview.postMessage.mock.calls.length).toBeGreaterThan(count))
	}
	async function open(name: string, title: string, body?: string, taskId?: string) {
		await fs.writeFile(path.join(root, name), documentHtml(title, body))
		await viewer.open(target(name, taskId))
		await vi.advanceTimersByTimeAsync(0)
		const panel = host.panels.at(-1)!
		await flushUntil(() => expect(latest(panel)?.title).toBe(title))
		return panel
	}
	function send(panel: Panel, action: string, extra = {}) {
		const current = latest(panel)
		panel.messages.fire({
			action,
			documentId: current.documentId,
			token: current.token,
			revision: current.revision,
			...extra,
		})
	}

	it("refreshes referenced image changes, recovers missing assets, and disposes image watchers", async () => {
		const panel = await open("images.html", "Images", '<img data-image="screen.png" alt="Screen">')
		expect(latest(panel).html).toContain("image-unavailable")
		expect(host.watchers).toHaveLength(2)
		const imageWatcher = host.watchers[1]
		await fs.writeFile(
			path.join(root, "screen.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
				"base64",
			),
		)
		await refresh(panel, () => imageWatcher.create.fire())
		expect(latest(panel).html).toContain("data:image/png;base64,")
		expect(host.watchers).toHaveLength(2)
		await fs.writeFile(path.join(root, "images.html"), documentHtml("Images", "<p>Removed image</p>"))
		await refresh(panel, () => host.watchers[0].change.fire())
		expect(imageWatcher.dispose).toHaveBeenCalledOnce()
		expect(imageWatcher.change.listeners.size).toBe(0)
		panel.dispose()
		expect(panel.webview.html).toContain("img-src data:")
	})

	beforeEach(async () => {
		vi.clearAllMocks()
		Object.assign(vscode.window.tabGroups.activeTabGroup, { viewColumn: 3 })
		vi.mocked(fs.open)
			.mockReset()
			.mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open)
		host.panels.length = 0
		host.watchers.length = 0
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-html-viewer-")))
		Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }], textDocuments: [] })
		viewer = new HtmlDocumentViewer(vscode.Uri.file(root))
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	})
	afterEach(async () => {
		viewer.dispose()
		vi.useRealTimers()
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("keeps two documents/tasks separate and repeated open focuses without creating another panel", async () => {
		const first = await open("one.html", "First", undefined, "task-one")
		const second = await open("two.html", "Second", undefined, "task-two")
		expect(host.panels).toHaveLength(2)
		expect(JSON.parse(load(first.webview.html)("body").attr("data-viewer-config")!).target.taskId).toBe("task-one")
		expect(JSON.parse(load(second.webview.html)("body").attr("data-viewer-config")!).target.taskId).toBe("task-two")
		await viewer.open(target("one.html"))
		expect(first.reveal).toHaveBeenCalledOnce()
		expect(first.reveal).toHaveBeenCalledWith(3, false)
		expect(second.reveal).not.toHaveBeenCalled()
		expect(host.panels).toHaveLength(2)
		await fs.writeFile(path.join(root, "one.html"), documentHtml("Changed"))
		await refresh(first, () => host.watchers[0].change.fire())
		expect(latest(first).title).toBe("Changed")
		expect(latest(second).title).toBe("Second")
		expect(first.reveal).toHaveBeenCalledTimes(1)
	})

	it("opens in the originating tab group even if focus changes during path validation", async () => {
		await fs.writeFile(path.join(root, "current.html"), documentHtml("Current"))
		const opening = viewer.open(target("current.html"))
		Object.assign(vscode.window.tabGroups.activeTabGroup, { viewColumn: 1 })
		await opening
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			expect.any(String),
			"current.html",
			{ viewColumn: 3, preserveFocus: false },
			{},
		)
	})

	it("automatically opens in the active tab group without taking focus or refocusing an existing preview", async () => {
		await fs.writeFile(path.join(root, "auto.html"), documentHtml("Delivered"))
		await viewer.open(target("auto.html"), undefined, { automatic: true, isCurrent: () => true })
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			expect.any(String),
			"auto.html",
			{ viewColumn: 3, preserveFocus: true },
			{},
		)
		await viewer.open(target("auto.html"), undefined, { automatic: true })
		expect(host.panels).toHaveLength(1)
		expect(host.panels[0].reveal).not.toHaveBeenCalled()
	})

	it("does not open after the originating task becomes inactive during path validation", async () => {
		await fs.writeFile(path.join(root, "auto.html"), documentHtml("Delivered"))
		let current = true
		const opening = viewer.open(target("auto.html"), undefined, { automatic: true, isCurrent: () => current })
		current = false
		await opening
		expect(host.panels).toHaveLength(0)
	})

	it("renders unsaved changes without writing and returns to external source after close", async () => {
		const panel = await open("one.html", "Disk")
		const uri = vscode.Uri.file(path.join(root, "one.html"))
		const dirty = {
			uri,
			isDirty: true,
			version: 2,
			getText: () => documentHtml("Unsaved", "<script>evil()</script><p>Updated</p>"),
		}
		Object.assign(vscode.workspace, { textDocuments: [dirty] })
		await refresh(panel, () => host.changes.fire({ document: dirty }))
		expect(latest(panel).title).toBe("Unsaved")
		expect(latest(panel).html).not.toContain("evil")
		expect(await fs.readFile(uri.fsPath, "utf8")).toContain("<title>Disk</title>")
		await fs.writeFile(uri.fsPath, documentHtml("External"))
		await refresh(panel, () => host.watchers[0].change.fire())
		expect(latest(panel).title).toBe("Unsaved")
		Object.assign(vscode.workspace, { textDocuments: [] })
		await refresh(panel, () => host.closes.fire(dirty))
		expect(latest(panel).title).toBe("External")
	})

	it("marks deleted/malformed previews stale and automatically recovers on correction", async () => {
		const panel = await open("one.html", "Before deletion")
		await fs.unlink(path.join(root, "one.html"))
		await refresh(panel, () => host.watchers[0].deleted.fire())
		expect(latest(panel)).toMatchObject({ error: "htmlDocument:errors.missing", stale: true })
		await fs.writeFile(path.join(root, "one.html"), "malformed")
		await refresh(panel, () => host.watchers[0].create.fire())
		expect(latest(panel)).toMatchObject({ error: "htmlDocument:errors.version", stale: true })
		await fs.writeFile(path.join(root, "one.html"), documentHtml("Corrected"))
		await refresh(panel, () => host.watchers[0].change.fire())
		expect(latest(panel)).toMatchObject({ title: "Corrected", stale: false })
		expect(latest(panel).error).toBeUndefined()
	})

	it("reconstructs a restored panel from durable source and disposes duplicate restored panels", async () => {
		await fs.writeFile(path.join(root, "one.html"), documentHtml("Restored"))
		const restored = host.panel()
		await viewer.open(target("one.html"), restored as unknown as vscode.WebviewPanel)
		await vi.advanceTimersByTimeAsync(0)
		await flushUntil(() => expect(latest(restored)?.title).toBe("Restored"))
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		const duplicate = host.panel()
		await viewer.open(target("one.html"), duplicate as unknown as vscode.WebviewPanel)
		expect(duplicate.dispose).toHaveBeenCalledOnce()
		expect(restored.reveal).not.toHaveBeenCalled()
		send(restored, "ready")
		await flushUntil(() => expect(restored.webview.postMessage).toHaveBeenCalledTimes(2))
	})

	it("rejects malformed, stale, cross-document, and unknown-reference messages; follows validated source lines", async () => {
		await fs.writeFile(path.join(root, "evidence.ts"), "one\ntwo\nthree")
		const first = await open("one.html", "First", '<a data-source="evidence.ts" data-line="99">Evidence</a>')
		const second = await open("two.html", "Second")
		send(first, "source", { revision: 0 })
		send(first, "source", { token: latest(second).token })
		send(first, "source", { documentId: latest(second).documentId })
		send(first, "source", { arbitrary: "command:evil" })
		send(first, "reference", { referenceId: "ref-999" })
		first.messages.fire({ action: "executeCommand", command: "evil" })
		await nextTurn()
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
		send(first, "reference", { referenceId: "ref-0" })
		await flushUntil(() => expect(vscode.window.showTextDocument).toHaveBeenCalledOnce())
		expect(vi.mocked(vscode.workspace.openTextDocument).mock.calls[0][0]).toMatchObject({
			fsPath: path.join(root, "evidence.ts"),
		})
		expect(vi.mocked(vscode.window.showTextDocument).mock.calls[0][1]).toMatchObject({
			preview: false,
			selection: { start: { line: 2 } },
		})
		send(first, "source")
		await flushUntil(() => expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(2))
	})

	it("invalidates a pending disk read and publishes only the newest unsaved revision", async () => {
		const panel = await open("one.html", "Initial")
		const originalOpen = vi.mocked(fs.open).getMockImplementation()!
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = false
		vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			started = true
			await gate
			return originalOpen(...args)
		})
		host.watchers[0].change.fire()
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		await flushUntil(() => expect(started).toBe(true))
		const dirty = {
			uri: vscode.Uri.file(path.join(root, "one.html")),
			isDirty: true,
			version: 3,
			getText: () => documentHtml("Latest"),
		}
		Object.assign(vscode.workspace, { textDocuments: [dirty] })
		host.changes.fire({ document: dirty })
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		release()
		await flushUntil(() => expect(latest(panel)?.title).toBe("Latest"))
		expect(panel.webview.postMessage.mock.calls.map(([message]) => message.title)).toEqual(["Initial", "Latest"])
	})

	it("disposes subscriptions, watchers, and pending debounced work on close", async () => {
		const panel = await open("one.html", "Initial")
		host.watchers[0].change.fire()
		panel.dispose()
		await vi.advanceTimersByTimeAsync(1000)
		expect(panel.webview.postMessage).toHaveBeenCalledOnce()
		expect(host.watchers[0].dispose).toHaveBeenCalledOnce()
		for (const event of [host.changes, host.closes, host.folders, panel.messages, panel.closed])
			expect(event.listeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
		await viewer.open(target("one.html"))
		expect(host.panels).toHaveLength(2)
	})

	it("coalesces a burst of file events into one refresh without focus changes", async () => {
		const panel = await open("one.html", "Initial")
		await fs.writeFile(path.join(root, "one.html"), documentHtml("Burst result"))
		for (let count = 0; count < 100; count++) host.watchers[0].change.fire()
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		await flushUntil(() => expect(latest(panel)?.title).toBe("Burst result"))
		expect(panel.webview.postMessage).toHaveBeenCalledTimes(2)
		expect(panel.reveal).not.toHaveBeenCalled()
	})

	it("observes unsaved edits addressed through a canonical filesystem alias", async (context) => {
		const panel = await open("one.html", "Disk")
		const alias = path.join(root, "workspace-alias")
		try {
			await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		const dirty = {
			uri: vscode.Uri.file(path.join(alias, "one.html")),
			isDirty: true,
			version: 2,
			getText: () => documentHtml("Alias edit"),
		}
		Object.assign(vscode.workspace, { textDocuments: [dirty] })
		host.changes.fire({ document: dirty })
		await flushUntil(() => expect(vi.getTimerCount()).toBe(1))
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		await flushUntil(() => expect(latest(panel)?.title).toBe("Alias edit"))
	})

	it("revokes references when workspace authority is removed", async () => {
		const panel = await open("one.html", "Initial", '<a data-source="one.html">Source</a>')
		Object.assign(vscode.workspace, { workspaceFolders: [] })
		await refresh(panel, () => host.folders.fire())
		expect(latest(panel)).toMatchObject({ stale: true, error: "htmlDocument:errors.scope" })
		send(panel, "reference", { referenceId: "ref-0" })
		await nextTurn()
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
	})

	it("opens only a current opaque HTTPS citation on an explicit validated message", async () => {
		const panel = await open(
			"one.html",
			"Citations",
			'<a href="javascript:evil()">Invalid</a><a href="https://example.com/evidence">Evidence</a>',
		)
		expect(latest(panel).html).not.toContain("https://")
		expect(latest(panel).html).not.toContain("javascript:")
		send(panel, "reference", { referenceId: "ref-0", url: "https://evil.example" })
		await nextTurn()
		expect(vscode.env.openExternal).not.toHaveBeenCalled()
		send(panel, "reference", { referenceId: "ref-0" })
		await flushUntil(() => expect(vscode.env.openExternal).toHaveBeenCalledOnce())
		expect(vi.mocked(vscode.env.openExternal).mock.calls[0][0].toString()).toBe("https://example.com/evidence")
		host.watchers[0].change.fire()
		send(panel, "reference", { referenceId: "ref-0" })
		await nextTurn()
		expect(vscode.env.openExternal).toHaveBeenCalledOnce()
	})

	it("rejects an old reference when a symlink changes document identity before a watcher event", async (context) => {
		const directory = path.join(root, "original")
		const replacement = path.join(root, "replacement")
		await fs.mkdir(directory)
		await fs.mkdir(replacement)
		const panel = await open("original/report.html", "Original", '<a data-source="evidence.ts">Evidence</a>')
		await fs.writeFile(path.join(root, "evidence.ts"), "evidence")
		await fs.writeFile(path.join(replacement, "report.html"), documentHtml("Replacement"))
		await fs.rename(directory, path.join(root, "moved"))
		try {
			await fs.symlink(replacement, directory, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		send(panel, "reference", { referenceId: "ref-0" })
		await flushUntil(() => expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce())
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
	})

	it("does not publish or leak listeners after disposal during a pending read", async () => {
		const panel = await open("one.html", "Initial")
		const originalOpen = vi.mocked(fs.open).getMockImplementation()!
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = false
		let finished = false
		vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			started = true
			await gate
			const handle = await originalOpen(...args)
			const close = handle.close.bind(handle)
			handle.close = async () => {
				await close()
				finished = true
			}
			return handle
		})
		host.watchers[0].change.fire()
		await vi.advanceTimersByTimeAsync(HTML_DOCUMENT_LIMITS.refreshDelayMs)
		await flushUntil(() => expect(started).toBe(true))
		viewer.dispose()
		release()
		await vi.mocked(fs.open).mock.results.at(-1)!.value
		await flushUntil(() => expect(finished).toBe(true))
		expect(panel.webview.postMessage).toHaveBeenCalledOnce()
		expect(host.changes.listeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})
})
