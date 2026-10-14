import * as vscode from "vscode"

import {
	incidentDashboardStartTurnInvestigationSchema,
	incidentDashboardTurnDetailRequestSchema,
	type IncidentDashboardTurnDetail,
} from "@alpha-code/types"
import type { AlphaProvider } from "./AlphaProvider"
import { resolveWebviewHtml } from "./webviewHtml"

/** The panel only presents the provider's bounded incident projection. */
export class IncidentPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel
	private subscriptions: vscode.Disposable[] = []
	private unsubscribe?: () => void
	private publishTimer?: ReturnType<typeof setTimeout>
	private publishRevision = 0
	private disposed = false

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: AlphaProvider,
	) {
		context.subscriptions.push(
			vscode.window.registerWebviewPanelSerializer("alpha.incidents", {
				deserializeWebviewPanel: async (panel) => this.attach(panel),
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("alpha.debug") && !this.provider.isIncidentDashboardEnabled()) {
					this.panel?.dispose()
				}
			}),
		)
	}

	async open(): Promise<void> {
		if (!this.provider.isIncidentDashboardEnabled()) return
		if (this.panel) {
			this.panel.reveal()
			return
		}
		if (this.disposed) return
		const panel = vscode.window.createWebviewPanel("alpha.incidents", "Alpha Incidents", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		})
		await this.attach(panel)
	}

	private async attach(panel: vscode.WebviewPanel): Promise<void> {
		if (!this.provider.isIncidentDashboardEnabled()) {
			panel.dispose()
			return
		}
		if (this.panel && this.panel !== panel) this.panel.dispose()
		panel.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] }
		this.panel = panel
		panel.onDidDispose(() => this.close(), undefined, this.subscriptions)
		panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				if (!message || typeof message !== "object" || !("type" in message)) return
				const detailRequest = incidentDashboardTurnDetailRequestSchema.safeParse(message)
				const turnInvestigation = incidentDashboardStartTurnInvestigationSchema.safeParse(message)
				if (message.type === "incidentDashboardReady") {
					void this.publish()
				} else if (detailRequest.success) {
					void this.publishTurnDetail(panel, detailRequest.data.turnId)
				} else if (turnInvestigation.success) {
					void this.provider.startIncidentDebuggingTurnTask(turnInvestigation.data.turnId).catch(() => {
						this.provider.log("Failed to start turn investigation")
						void vscode.window.showErrorMessage("Could not start the Alpha turn investigation")
					})
				} else if (
					message.type === "startDebuggingTask" &&
					"alertId" in message &&
					typeof message.alertId === "string" &&
					message.alertId.length <= 128
				) {
					void this.provider.startIncidentDebuggingTask(message.alertId).catch(() => {
						this.provider.log("Failed to start incident investigation")
						void vscode.window.showErrorMessage("Could not start the Alpha incident investigation")
					})
				}
			},
			undefined,
			this.subscriptions,
		)
		this.unsubscribe = this.provider.subscribeIncidentDashboard(() => {
			if (this.publishTimer) return
			this.publishTimer = setTimeout(() => {
				this.publishTimer = undefined
				void this.publish()
			}, 100)
		})
		const html = await resolveWebviewHtml({
			webview: panel.webview,
			extensionUri: this.context.extensionUri,
			extensionMode: this.context.extensionMode,
			view: "incidents",
		})
		if (this.panel === panel) panel.webview.html = html
	}

	private async publish(): Promise<void> {
		const panel = this.panel
		if (!panel) return
		const revision = ++this.publishRevision
		const snapshot = await this.provider.getIncidentDashboardSnapshot()
		if (panel === this.panel && revision === this.publishRevision)
			await panel.webview.postMessage({ type: "incidentDashboardUpdate", snapshot })
	}

	private async publishTurnDetail(panel: vscode.WebviewPanel, turnId: string): Promise<void> {
		let detail: IncidentDashboardTurnDetail | undefined
		try {
			detail = await this.provider.getIncidentDashboardTurnDetail(turnId)
		} catch {
			this.provider.log("Failed to load turn details")
		}
		if (panel !== this.panel) return
		await panel.webview.postMessage({
			type: "incidentDashboardTurnDetail",
			turnId,
			...(detail ? { detail } : {}),
		})
	}

	private close(): void {
		this.publishRevision++
		this.panel = undefined
		if (this.publishTimer) clearTimeout(this.publishTimer)
		this.publishTimer = undefined
		this.unsubscribe?.()
		this.unsubscribe = undefined
		for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
	}

	dispose(): void {
		this.disposed = true
		this.panel?.dispose()
		this.close()
	}
}
