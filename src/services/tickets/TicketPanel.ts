import * as vscode from "vscode"
import path from "path"
import os from "os"
import * as fs from "fs/promises"
import { randomUUID } from "crypto"
import { z } from "zod"
import {
	ticketRequestSchema,
	ticketTargetSchema,
	type TicketExportInput,
	type TicketResponse,
	type TicketTarget,
	type TicketTransferEntry,
	type TicketTransferResult,
} from "@alpha-code/types"
import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import { resolveWebviewHtml } from "../../core/webview/webviewHtml"
import { t } from "../../i18n"
import { workOnTicket } from "./TicketTaskLink"
import { TicketStore, type TicketImportPlan } from "./TicketStore"
import { decodeTicketArchive, decodeTicketMarkdown, encodeTicketArchive } from "./TicketArchive"
import { readTicketTransferFile, writeTicketExport } from "./TicketTransferFiles"

const menuContextSchema = z.object({ preserveFocus: z.boolean() }).strict()

/** Presentation adapter only: task execution remains owned by AlphaProvider. */
export class TicketPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel
	private subscriptions: vscode.Disposable[] = []
	private projects = new Map<string, TicketStore>()
	private disposed = false
	private ready = false
	private pendingTarget?: TicketTarget
	private readonly maintenance = new AbortController()
	private transfers = new AbortController()
	private transferBusy = false
	private pendingImport?: { token: string; project: string; plan: TicketImportPlan; createdAt: number }

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: AlphaProvider,
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
					await this.attach(panel)
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
		const panel = vscode.window.createWebviewPanel("alpha.tickets", "Alpha Tickets", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		})
		await this.attach(panel)
	}

	private async attach(panel: vscode.WebviewPanel) {
		if (this.panel && this.panel !== panel) this.panel.dispose()
		this.transfers = new AbortController()
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
		const html = await resolveWebviewHtml({
			webview: panel.webview,
			extensionUri: this.context.extensionUri,
			extensionMode: this.context.extensionMode,
			view: "tickets",
		})
		if (this.panel !== panel) return
		panel.webview.html = html
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
			const store = await TicketStore.forWorkspace(folder.uri.fsPath, undefined, this.maintenance.signal)
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
				let refreshTimer: ReturnType<typeof setTimeout> | undefined
				// One imported hierarchy can change hundreds of files; refresh the projection as a batch.
				const changed = () => {
					if (refreshTimer) clearTimeout(refreshTimer)
					refreshTimer = setTimeout(() => {
						refreshTimer = undefined
						this.post({ type: "ticketChanged", project: store.projectId })
					}, 150)
				}
				watchers.push(watcher, { dispose: () => clearTimeout(refreshTimer) })
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
		if (this.pendingImport && !projects.has(this.pendingImport.project)) this.pendingImport = undefined
		this.post({
			type: "ticketProjects",
			language: vscode.env.language,
			projects: [...this.projects].map(([id, store]) => ({ id, name: path.basename(store.workspace) })),
		})
	}

	/** Native dialogs own file selection; no webview-supplied path is ever opened. */
	private async transfer(
		operation: Extract<
			z.infer<typeof ticketRequestSchema>["operation"],
			{ action: "export" | "previewImport" | "import" | "discardImport" }
		>,
		project: string,
		store: TicketStore,
		panel: vscode.WebviewPanel,
	): Promise<TicketTransferResult | undefined> {
		if (operation.action === "discardImport") {
			if (this.pendingImport?.token === operation.token && this.pendingImport.project === project)
				this.pendingImport = undefined
			return
		}
		if (this.transferBusy) throw new Error(t("common:ticketTransfer.busy"))
		this.transferBusy = true
		const controller = this.transfers
		const current = () => {
			controller.signal.throwIfAborted()
			if (this.panel !== panel || this.disposed || this.projects.get(project) !== store)
				throw new Error(t("common:ticketTransfer.projectChanged"))
		}
		try {
			current()
			if (operation.action === "export")
				return await this.exportTickets(store, operation.input, current, controller.signal)
			if (operation.action === "previewImport") {
				// Keep at most one bounded preview in memory and release it on replacement or close.
				this.pendingImport = undefined
				const files = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: true,
					filters: { [t("common:ticketTransfer.files")]: ["zip", "md"] },
					title: t("common:ticketTransfer.importTitle"),
				})
				current()
				if (!files?.length) return { kind: "cancelled" }
				if (files.length > 1000) throw new Error(t("common:ticketTransfer.tooManyFiles"))
				const entries: TicketTransferEntry[] = []
				let inputBytes = 0
				let expandedBytes = 0
				for (const file of files) {
					current()
					if (file.scheme !== "file") throw new Error(t("common:ticketTransfer.localFiles"))
					const extension = path.extname(file.fsPath).toLowerCase()
					if (extension !== ".zip" && extension !== ".md") throw new Error(t("common:ticketTransfer.files"))
					const bytes = await readTicketTransferFile(
						file.fsPath,
						extension === ".md" ? 100000 : 20 * 1024 * 1024,
						controller.signal,
					)
					inputBytes += bytes.byteLength
					if (inputBytes > 20 * 1024 * 1024) throw new Error(t("common:ticketTransfer.tooLarge"))
					const decoded =
						extension === ".zip"
							? await decodeTicketArchive(bytes, controller.signal)
							: [
									decodeTicketMarkdown(
										path.basename(file.fsPath),
										new TextDecoder("utf-8", { fatal: true }).decode(bytes),
									),
								]
					for (const entry of decoded) {
						expandedBytes += Buffer.byteLength(entry.markdown, "utf8")
						if (expandedBytes > 16 * 1024 * 1024 || entries.length >= 1000)
							throw new Error(t("common:ticketTransfer.tooLarge"))
						entries.push(entry)
					}
				}
				current()
				const plan = await store.previewImport(entries, controller.signal)
				current()
				const token = randomUUID()
				this.pendingImport = { token, project, plan, createdAt: Date.now() }
				return { kind: "importPreview", token, ...plan.preview }
			}
			const pending = this.pendingImport
			if (
				!pending ||
				pending.project !== project ||
				pending.token !== operation.token ||
				Date.now() - pending.createdAt > 30 * 60 * 1000
			)
				throw new Error(t("common:ticketTransfer.expired"))
			// A token is consumed before starting the commit so duplicate messages cannot import twice.
			this.pendingImport = undefined
			const imported = await store.importTickets(
				pending.plan,
				{ mode: operation.mode, resetStatus: operation.resetStatus },
				controller.signal,
			)
			return { kind: "imported", ...imported }
		} finally {
			if (controller === this.transfers) this.transferBusy = false
		}
	}

	private async exportTickets(
		store: TicketStore,
		input: TicketExportInput,
		current: () => void,
		signal: AbortSignal,
	): Promise<TicketTransferResult> {
		const entries = await store.exportTickets(input, signal)
		if (!entries.length) throw new Error(t("common:ticketTransfer.emptyExport"))
		const filename = `${path.basename(store.workspace).replace(/[^a-zA-Z0-9_-]/g, "-") || "alpha"}-tickets.zip`
		const downloads = path.join(os.homedir(), "Downloads")
		const defaultDirectory = await fs.stat(downloads).then(
			(stat) => (stat.isDirectory() ? downloads : os.homedir()),
			() => os.homedir(),
		)
		current()
		const destination = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(defaultDirectory, filename)),
			filters: { [t("common:ticketTransfer.archive")]: ["zip"] },
			title: t("common:ticketTransfer.exportTitle"),
		})
		current()
		if (!destination) return { kind: "cancelled" }
		if (destination.scheme !== "file") throw new Error(t("common:ticketTransfer.localFiles"))
		const bytes = await encodeTicketArchive(entries, signal)
		current()
		await writeTicketExport(destination.fsPath, bytes, signal)
		return { kind: "exported", count: entries.length, fileName: path.basename(destination.fsPath) }
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
				case "overview":
					result.result = await store.overview(this.transfers.signal)
					break
				case "export":
				case "previewImport":
				case "import":
				case "discardImport":
					result.result = await this.transfer(operation, project, store, panel)
					break
				case "read":
					result.result = await store.read(operation.id)
					break
				case "relations":
					result.result = await store.relations(operation.id)
					break
				case "openLinkedTask": {
					const ticket = await store.read(operation.id)
					if (!ticket.linkedTaskIds.includes(operation.taskId))
						throw new Error("This conversation is not linked to the ticket")
					await this.provider.showTaskWithId(operation.taskId)
					await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
					break
				}
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
			if (["create", "update", "delete", "work", "import"].includes(operation.action))
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
		this.transfers.abort()
		this.transferBusy = false
		this.pendingImport = undefined
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
