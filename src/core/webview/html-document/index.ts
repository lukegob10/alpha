import * as vscode from "vscode"
import { HTML_DOCUMENT_VIEW_TYPE, htmlDocumentTargetSchema, parseHtmlDocumentLink } from "@alpha-code/types"
import { t } from "../../../i18n"
import type { HtmlDocumentViewer } from "./viewer"
import type { HtmlDocumentTarget } from "@alpha-code/types"

let service: Promise<HtmlDocumentViewer> | undefined
let extensionUri: vscode.Uri | undefined

function viewer(): Promise<HtmlDocumentViewer> {
	if (!extensionUri) throw new Error("HTML document viewer is not registered")
	const uri = extensionUri
	return (service ??= import("./viewer").then(({ HtmlDocumentViewer }) => new HtmlDocumentViewer(uri)))
}

export async function openHtmlDocumentLink(link: unknown): Promise<void> {
	const target = parseHtmlDocumentLink(link)
	if (!target) {
		await vscode.window.showErrorMessage(t("htmlDocument:errors.path"))
		return
	}
	try {
		await (await viewer()).open(target)
	} catch (error) {
		console.warn("[HtmlDocument] Unable to open document link", error)
		await vscode.window.showErrorMessage(
			t(
				error instanceof Error && error.message === "panelLimit"
					? "htmlDocument:panelLimit"
					: "htmlDocument:openError",
			),
		)
	}
}

export async function autoOpenHtmlDocument(target: HtmlDocumentTarget, isCurrent: () => boolean): Promise<void> {
	try {
		if (isCurrent()) await (await viewer()).open(target, undefined, { automatic: true, isCurrent })
	} catch {
		// Delivery must not fail a completed task. The retained link permits an explicit retry with diagnostics.
		console.warn("[HtmlDocument] Automatic preview unavailable; the document link remains available")
	}
}

/** Register cheap entry points; parser and kit load only when a document is requested. */
export function registerHtmlDocumentViewer(context: vscode.ExtensionContext): void {
	extensionUri = context.extensionUri
	context.subscriptions.push(
		vscode.commands.registerCommand("alpha.previewHtmlDocument", async (resource?: vscode.Uri) => {
			const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri
			if (!uri) {
				await vscode.window.showInformationMessage(t("htmlDocument:chooseSource"))
				return
			}
			try {
				await (await viewer()).open({ uri: uri.toString() })
			} catch (error) {
				console.warn("[HtmlDocument] Unable to preview source", error)
				await vscode.window.showErrorMessage(
					t(
						error instanceof Error && error.message === "panelLimit"
							? "htmlDocument:panelLimit"
							: "htmlDocument:openError",
					),
				)
			}
		}),
	)
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(HTML_DOCUMENT_VIEW_TYPE, {
			async deserializeWebviewPanel(panel, state: unknown) {
				const parsed = htmlDocumentTargetSchema.safeParse(
					state && typeof state === "object" && "target" in state ? state.target : undefined,
				)
				try {
					if (!parsed.success) throw new Error("state")
					await (await viewer()).open(parsed.data, panel)
				} catch {
					panel.dispose()
					await vscode.window.showErrorMessage(t("htmlDocument:reopenError"))
				}
			},
		}),
	)
	context.subscriptions.push({
		dispose() {
			void service?.then((instance) => instance.dispose())
			service = undefined
			extensionUri = undefined
		},
	})
}
