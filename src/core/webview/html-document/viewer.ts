import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import {
	HTML_DOCUMENT_LIMITS,
	HTML_DOCUMENT_VIEW_TYPE,
	htmlDocumentMessageSchema,
	htmlDocumentTargetSchema,
	type HtmlDocumentTarget,
} from "@alpha-code/types"
import i18n, { t } from "../../../i18n"
import { resolveDocumentPath, resolveSourcePath } from "./paths"
import type { SanitizedDocument } from "./sanitize"
import { DocumentParser } from "./parser"
import { hydrateDocumentImages } from "./images"

type Snapshot = { revision: number; html?: string; title?: string; error?: string; stale: boolean }
type Entry = {
	parser: DocumentParser
	panel: vscode.WebviewPanel
	target: HtmlDocumentTarget
	root: string
	fsPath: string
	token: string
	revision: number
	running: boolean
	closed: boolean
	timer?: ReturnType<typeof setTimeout>
	disposables: vscode.Disposable[]
	imageWatchers: Map<string, vscode.Disposable>
	document?: SanitizedDocument
	snapshot?: Snapshot
}

/** One extension-wide registry: sidebar, background tasks and editor chat share URI identity. */
export class HtmlDocumentViewer implements vscode.Disposable {
	private readonly entries = new Map<string, Entry>()
	private disposed = false
	constructor(private readonly extensionUri: vscode.Uri) {}

	private roots(): string[] {
		return (vscode.workspace.workspaceFolders ?? [])
			.filter((folder) => folder.uri.scheme === "file")
			.map((folder) => folder.uri.fsPath)
	}

	async open(
		input: unknown,
		restoredPanel?: vscode.WebviewPanel,
		options: { automatic?: boolean; isCurrent?: () => boolean } = {},
	): Promise<void> {
		// Capture the tab group before file validation yields, including when an editor webview has focus.
		const viewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn
		const target = htmlDocumentTargetSchema.parse(input)
		const resolved = await resolveDocumentPath(target.uri, this.roots(), true)
		if (this.disposed || options.isCurrent?.() === false) return
		const existing = this.entries.get(resolved.uri)
		if (existing) {
			restoredPanel?.dispose()
			if (!restoredPanel && !options.automatic) existing.panel.reveal(viewColumn, false)
			return
		}
		if (this.entries.size >= HTML_DOCUMENT_LIMITS.panels) throw new Error("panelLimit")
		const panel =
			restoredPanel ??
			vscode.window.createWebviewPanel(
				HTML_DOCUMENT_VIEW_TYPE,
				path.basename(resolved.fsPath),
				{
					viewColumn,
					preserveFocus: options.automatic === true,
				},
				{},
			)
		const entry: Entry = {
			parser: new DocumentParser(
				vscode.Uri.joinPath(this.extensionUri, "dist", "workers", "sanitizeDocument.js").fsPath,
			),
			panel,
			target: { ...target, uri: resolved.uri },
			root: resolved.root,
			fsPath: resolved.fsPath,
			token: randomBytes(24).toString("hex"),
			revision: 0,
			running: false,
			closed: false,
			disposables: [],
			imageWatchers: new Map(),
		}
		this.entries.set(resolved.uri, entry)
		const assetRoot = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "build")
		panel.webview.options = {
			enableScripts: true,
			enableCommandUris: false,
			enableForms: false,
			localResourceRoots: [
				vscode.Uri.joinPath(assetRoot, "artifact-kit", "v1"),
				vscode.Uri.joinPath(assetRoot, "html-document"),
			],
		}
		entry.disposables.push(panel.onDidDispose(() => this.close(entry)))
		entry.disposables.push(
			panel.webview.onDidReceiveMessage((message: unknown) => {
				void this.message(entry, message).catch(() => {
					if (!entry.closed) void vscode.window.showErrorMessage(t("htmlDocument:referenceError"))
				})
			}),
		)
		entry.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				this.sourceChanged(entry, event.document.uri)
			}),
		)
		entry.disposables.push(
			vscode.workspace.onDidCloseTextDocument((document) => {
				this.sourceChanged(entry, document.uri)
			}),
		)
		entry.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule(entry)))
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(entry.fsPath), path.basename(entry.fsPath)),
		)
		entry.disposables.push(
			watcher,
			watcher.onDidChange(() => this.schedule(entry)),
			watcher.onDidCreate(() => this.schedule(entry)),
			watcher.onDidDelete(() => this.schedule(entry)),
		)
		panel.webview.html = this.shell(entry, assetRoot)
		this.schedule(entry, true)
	}

	private sameFile(a: string, b: string): boolean {
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
	}

	private sourceChanged(entry: Entry, uri: vscode.Uri): void {
		if (uri.scheme !== "file" || !/\.html?$/i.test(uri.fsPath)) return
		// Coalesce before any filesystem work. An alias can name this source even
		// when its lexical path differs; the bounded refresh resolves dirty buffers.
		this.schedule(entry)
	}

	private async validateIdentity(entry: Entry, allowMissing = false) {
		const resolved = await resolveDocumentPath(entry.target.uri, this.roots(), allowMissing)
		if (resolved.uri !== entry.target.uri || resolved.root !== entry.root) throw new Error("scope")
		return resolved
	}

	private shell(entry: Entry, assets: vscode.Uri): string {
		const nonce = randomBytes(24).toString("hex")
		const resource = (...parts: string[]) =>
			escapeHtml(
				entry.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, ...parts)).toString() + `?v=${nonce}`,
			)
		const labels = {
			...i18n.getResourceBundle("en", "htmlArtifactKit"),
			...i18n.getResourceBundle(i18n.language, "htmlArtifactKit"),
		}
		const config = escapeHtml(
			JSON.stringify({ documentId: entry.target.uri, token: entry.token, target: entry.target, labels }),
		)
		return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${entry.panel.webview.cspSource}; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none';"><link rel="stylesheet" href="${resource("artifact-kit", "v1", "kit.css")}"><link rel="stylesheet" href="${resource("html-document", "viewer.css")}"><title>${escapeHtml(t("htmlDocument:title"))}</title></head><body data-viewer-config="${config}"><header class="viewer-toolbar"><span id="viewer-title">${escapeHtml(path.basename(entry.fsPath))}</span><button id="viewer-source" type="button">${escapeHtml(t("htmlDocument:openSource"))}</button></header><p id="viewer-status" role="status">${escapeHtml(t("htmlDocument:loading"))}</p><div id="viewer-content"></div><script nonce="${nonce}" src="${resource("artifact-kit", "v1", "kit.js")}"></script><script nonce="${nonce}" src="${resource("html-document", "viewer.js")}"></script></body></html>`
	}

	private schedule(entry: Entry, immediate = false): void {
		if (entry.closed) return
		entry.revision++ // Invalidates pending reads and navigation immediately.
		entry.parser.cancelPending()
		if (entry.timer) clearTimeout(entry.timer)
		entry.timer = setTimeout(
			() => {
				entry.timer = undefined
				void this.refresh(entry)
			},
			immediate ? 0 : HTML_DOCUMENT_LIMITS.refreshDelayMs,
		)
	}

	private async read(entry: Entry): Promise<string> {
		const resolved = await this.validateIdentity(entry, true)
		for (const document of vscode.workspace.textDocuments) {
			if (!document.isDirty || document.uri.scheme !== "file" || !/\.html?$/i.test(document.uri.fsPath)) continue
			if (this.sameFile(document.uri.fsPath, entry.fsPath)) return document.getText()
			try {
				if ((await resolveDocumentPath(document.uri.toString(), this.roots())).uri === entry.target.uri)
					return document.getText()
			} catch {
				/* Unrelated or inaccessible editor document. */
			}
		}
		const handle = await fs.open(resolved.fsPath, "r")
		try {
			await this.validateIdentity(entry)
			if ((await handle.stat()).size > HTML_DOCUMENT_LIMITS.bytes) throw new Error("size")
			const buffer = Buffer.alloc(HTML_DOCUMENT_LIMITS.bytes + 1)
			let length = 0
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
				if (!bytesRead) break
				length += bytesRead
			}
			if (length > HTML_DOCUMENT_LIMITS.bytes) throw new Error("size")
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
		} finally {
			await handle.close()
		}
	}

	private async refresh(entry: Entry): Promise<void> {
		if (entry.closed || entry.running) return
		entry.running = true
		const revision = entry.revision
		try {
			const source = await this.read(entry)
			if (entry.closed || entry.revision !== revision) return
			const document = await entry.parser.parse(source)
			if (entry.closed || entry.revision !== revision) return
			await this.watchImages(entry, document, revision)
			const html = await hydrateDocumentImages(
				document,
				entry.root,
				async () => {
					if (entry.closed || entry.revision !== revision) return false
					await this.validateIdentity(entry, true)
					return !entry.closed && entry.revision === revision
				},
				t("htmlArtifactKit:imageUnavailable"),
			)
			if (entry.closed || entry.revision !== revision) return
			entry.document = document
			entry.panel.title = document.title
			entry.snapshot = { revision, html, title: document.title, stale: false }
		} catch (error) {
			if (entry.closed || entry.revision !== revision) return
			const code = error instanceof Error ? error.message : "format"
			const known = ["scope", "missing", "path", "size", "version", "reference", "data", "format"].includes(code)
				? code
				: "missing"
			entry.snapshot = {
				revision,
				html: entry.document?.html,
				title: entry.document?.title,
				error: t(`htmlDocument:errors.${known}`),
				stale: Boolean(entry.document),
			}
		} finally {
			entry.running = false
			if (!entry.closed && entry.revision !== revision && !entry.timer) void this.refresh(entry)
		}
		if (!entry.closed && entry.revision === revision) await this.post(entry)
	}

	private async post(entry: Entry): Promise<void> {
		if (entry.snapshot)
			await entry.panel.webview.postMessage({
				type: "document",
				documentId: entry.target.uri,
				token: entry.token,
				...entry.snapshot,
				staleLabel: t("htmlDocument:stale"),
			})
	}

	private async message(entry: Entry, input: unknown): Promise<void> {
		const parsed = htmlDocumentMessageSchema.safeParse(input)
		if (!parsed.success || entry.closed) return
		const message = parsed.data
		if (message.documentId !== entry.target.uri || message.token !== entry.token) return
		if (message.action === "ready") {
			await this.post(entry)
			return
		}
		if (message.revision !== entry.revision) return
		let sourcePath: string
		let line = 1
		if (message.action === "source") sourcePath = (await this.validateIdentity(entry)).fsPath
		else {
			if (entry.snapshot?.error) return
			const reference = entry.document?.references.get(message.referenceId)
			if (!reference) return
			await this.validateIdentity(entry)
			if (reference.kind === "external") {
				if (!entry.closed && message.revision === entry.revision)
					await vscode.env.openExternal(vscode.Uri.parse(reference.url))
				return
			}
			sourcePath = await resolveSourcePath(entry.root, reference.path)
			line = reference.line
		}
		if (entry.closed || message.revision !== entry.revision) return
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath))
		if (entry.closed || message.revision !== entry.revision) return
		const position = new vscode.Position(Math.min(line - 1, Math.max(0, document.lineCount - 1)), 0)
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(position, position),
		})
	}

	private async watchImages(entry: Entry, document: SanitizedDocument, revision: number): Promise<void> {
		const paths = new Set([...document.images.values()].map((image) => image.path))
		for (const [imagePath, watcher] of entry.imageWatchers) {
			if (!paths.has(imagePath)) {
				watcher.dispose()
				entry.imageWatchers.delete(imagePath)
			}
		}
		for (const imagePath of paths) {
			if (entry.imageWatchers.has(imagePath)) continue
			try {
				await resolveSourcePath(entry.root, imagePath, true)
			} catch {
				continue
			}
			if (entry.closed || entry.revision !== revision) return
			const absolute = path.join(entry.root, ...imagePath.split("/"))
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(path.dirname(absolute), path.basename(absolute)),
			)
			const subscriptions = [
				watcher,
				watcher.onDidChange(() => this.schedule(entry)),
				watcher.onDidCreate(() => this.schedule(entry)),
				watcher.onDidDelete(() => this.schedule(entry)),
			]
			entry.imageWatchers.set(imagePath, {
				dispose: () => subscriptions.forEach((subscription) => subscription.dispose()),
			})
		}
	}

	private close(entry: Entry): void {
		if (entry.closed) return
		entry.closed = true
		entry.parser.dispose()
		if (entry.timer) clearTimeout(entry.timer)
		this.entries.delete(entry.target.uri)
		for (const disposable of entry.disposables) disposable.dispose()
		for (const watcher of entry.imageWatchers.values()) watcher.dispose()
		entry.imageWatchers.clear()
		entry.document = undefined
		entry.snapshot = undefined
	}

	dispose(): void {
		this.disposed = true
		for (const entry of [...this.entries.values()]) {
			this.close(entry)
			entry.panel.dispose()
		}
	}
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	)
}
