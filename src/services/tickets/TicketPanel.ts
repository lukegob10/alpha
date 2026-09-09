import * as vscode from "vscode"
import path from "path"
import { z } from "zod"
import { ticketRequestSchema, ticketTargetSchema, type TicketResponse, type TicketTarget } from "@alpha-code/types"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { getNonce } from "../../core/webview/getNonce"
import { workOnTicket } from "./TicketTaskLink"
import { TicketStore } from "./TicketStore"

const menuContextSchema = z.object({ preserveFocus: z.boolean() }).strict()

/** Presentation adapter only: task execution remains owned by ClineProvider. */
export class TicketPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel
	private subscriptions: vscode.Disposable[] = []
	private projects = new Map<string, TicketStore>()
	private disposed = false
	private ready = false
	private pendingTarget?: TicketTarget
	private readonly maintenance = new AbortController()

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: ClineProvider,
	) {
		const prepare = () => {
			void this.prepareWorkspaceReferences().catch(() => {
				if (!this.disposed)
					console.error(
						"[Tickets] Reference migration failed; open Alpha Tickets to review the storage error",
					)
			})
		}
		prepare()
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(prepare),
			vscode.window.registerWebviewPanelSerializer("alpha.tickets", {
				deserializeWebviewPanel: async (panel) => {
					this.attach(panel)
				},
			}),
		)
	}

	private async prepareWorkspaceReferences() {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (this.disposed) return
			if (folder.uri.scheme === "file")
				await TicketStore.initializeWorkspace(folder.uri.fsPath, this.maintenance.signal)
		}
	}

	async open(target?: unknown): Promise<void> {
		// VS Code title-menu clicks supply focus context instead of a ticket target.
		if (target !== undefined && target !== null && !menuContextSchema.safeParse(target).success) {
			const parsed = ticketTargetSchema.safeParse(target)
			if (!parsed.success) return
			this.pendingTarget = parsed.data
		}
		if (this.panel) {
			this.panel.reveal()
			this.openPendingTarget()
			return
		}
		if (this.disposed) return
		const panel = vscode.window.createWebviewPanel("alpha.tickets", "Alpha Tickets", vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		})
		this.attach(panel)
	}

	private attach(panel: vscode.WebviewPanel) {
		if (this.panel && this.panel !== panel) this.panel.dispose()
		panel.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] }
		this.panel = panel
		this.ready = false
		panel.onDidDispose(() => this.close(), undefined, this.subscriptions)
		panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				void this.receive(message)
			},
			undefined,
			this.subscriptions,
		)
		this.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void this.loadProjects().catch((error: Error) =>
					this.post(
						{
							type: "ticketProjects",
							projects: [],
							language: vscode.env.language,
							error: error.message,
						},
						panel,
					),
				)
			}),
		)
		const asset = (name: string) =>
			panel.webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "build", "assets", name),
			)
		const nonce = getNonce()
		panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource} data:; script-src ${panel.webview.cspSource} 'nonce-${nonce}';"><link rel="stylesheet" href="${asset("index.css")}"></head><body><div id="root" data-view="tickets"></div><script nonce="${nonce}" type="module" src="${asset("index.js")}"></script></body></html>`
	}

	private post(message: TicketResponse, panel = this.panel) {
		if (panel && panel === this.panel) void panel.webview.postMessage(message)
	}
	private openPendingTarget() {
		if (!this.ready || !this.pendingTarget) return
		this.post({ type: "ticketOpen", target: this.pendingTarget })
		this.pendingTarget = undefined
	}
	private watchers: vscode.Disposable[] = []
	private loadGeneration = 0
	private projectLoad: Promise<void> = Promise.resolve()
	private loadProjects() {
		this.projectLoad = this.collectProjects(++this.loadGeneration)
		return this.waitForProjects()
	}

	/** A restored webview may request its saved project before discovery finishes. */
	private async waitForProjects() {
		while (true) {
			const loading = this.projectLoad
			try {
				await loading
			} catch (error) {
				if (loading === this.projectLoad) throw error
			}
			if (loading === this.projectLoad) return
		}
	}

	private async collectProjects(generation: number) {
		const projects = new Map<string, TicketStore>()
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== "file") continue
			const store = await TicketStore.forWorkspace(folder.uri.fsPath)
			await store.prepareReferences(this.maintenance.signal)
			if (!this.panel || generation !== this.loadGeneration) return
			projects.set(store.projectId, store)
		}
		if (!this.panel || generation !== this.loadGeneration) return
		const watchers: vscode.Disposable[] = []
		try {
			for (const store of projects.values()) {
				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(vscode.Uri.file(store.directory), "**/*.md"),
				)
				const changed = () => this.post({ type: "ticketChanged", project: store.projectId })
				watchers.push(watcher)
				watchers.push(watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed))
			}
		} catch (error) {
			for (const watcher of watchers) watcher.dispose()
			throw error
		}
		// Publish one complete project snapshot; requests wait for this refresh before resolving a store.
		for (const watcher of this.watchers) watcher.dispose()
		this.watchers = watchers
		this.projects = projects
		this.post({
			type: "ticketProjects",
			language: vscode.env.language,
			projects: [...this.projects].map(([id, store]) => ({ id, name: path.basename(store.workspace) })),
		})
	}

	private async receive(message: unknown) {
		const panel = this.panel
		if (typeof message === "object" && message !== null && "type" in message && message.type === "ticketsReady") {
			try {
				await this.loadProjects()
				if (!panel || panel !== this.panel) return
				this.ready = true
				this.openPendingTarget()
			} catch (error) {
				this.post(
					{
						type: "ticketProjects",
						projects: [],
						language: vscode.env.language,
						error: error instanceof Error ? error.message : "Ticket storage unavailable",
					},
					panel,
				)
			}
			return
		}
		const parsed = ticketRequestSchema.safeParse(message)
		if (!parsed.success) return
		const { requestId, project, operation } = parsed.data
		try {
			await this.waitForProjects()
			if (!panel || panel !== this.panel) return
			const store = this.projects.get(project)
			if (!store) throw new Error("Open the ticket's project workspace first")
			let result: TicketResponse & { type: "ticketResponse" } = { type: "ticketResponse", requestId }
			switch (operation.action) {
				case "list":
					result.result = await store.list(operation.input)
					break
				case "read":
					result.result = await store.read(operation.id)
					break
				case "create":
					result.result = await store.create(operation.input)
					break
				case "update":
					result.result = await store.update(operation.input)
					break
				case "delete":
					result.result = await store.delete(operation.input)
					break
				case "openMarkdown":
					await vscode.window.showTextDocument(vscode.Uri.file(await store.markdownPath(operation.id)), {
						preview: false,
					})
					break
				case "work":
					result.result = await workOnTicket(store, this.provider, operation.id, operation.expectedRevision)
					break
			}
			this.post(result, panel)
			if (["create", "update", "delete", "work"].includes(operation.action))
				this.post({ type: "ticketChanged", project }, panel)
		} catch (error) {
			this.post(
				{
					type: "ticketResponse",
					requestId,
					error: error instanceof Error ? error.message : "Ticket operation failed",
				},
				panel,
			)
		}
	}

	private close() {
		this.ready = false
		this.pendingTarget = undefined
		this.loadGeneration++
		this.panel = undefined
		for (const disposable of [...this.subscriptions.splice(0), ...this.watchers.splice(0)]) disposable.dispose()
		this.projects.clear()
	}
	dispose() {
		this.disposed = true
		this.maintenance.abort()
		this.panel?.dispose()
		this.close()
	}
}
