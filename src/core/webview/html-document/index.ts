import * as vscode from "vscode"
import { HTML_DOCUMENT_VIEW_TYPE, htmlDocumentTargetSchema, parseHtmlDocumentLink } from "@alpha-code/types"
import { t } from "../../../i18n"
import type { HtmlDocumentViewer } from "./viewer"

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
	} catch {
		await vscode.window.showErrorMessage(t("htmlDocument:openError"))
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
			} catch {
				await vscode.window.showErrorMessage(t("htmlDocument:openError"))
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
