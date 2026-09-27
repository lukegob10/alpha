import fs from "node:fs"
import path from "node:path"
import axios from "axios"
import * as vscode from "vscode"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"

export type WebviewUiView = "app" | "tickets"

const HMR_PROBE_TIMEOUT_MS = 1_000
const DEFAULT_VITE_PORT = "5173"

export async function resolveWebviewHtml(options: {
	webview: vscode.Webview
	extensionUri: vscode.Uri
	extensionMode: vscode.ExtensionMode
	view?: WebviewUiView
	onHmrUnavailable?: () => void
}): Promise<string> {
	if (options.extensionMode === vscode.ExtensionMode.Development) {
		const hmrHtml = await tryHmrHtml(options.webview, options.extensionUri, options.view ?? "app")
		if (hmrHtml) return hmrHtml
		options.onHmrUnavailable?.()
	}

	return getBuiltWebviewHtml(options.webview, options.extensionUri, options.view ?? "app")
}

function viewAttribute(view: WebviewUiView) {
	return view === "tickets" ? ' data-view="tickets"' : ""
}

function readVitePort() {
	try {
		const portFilePath = path.resolve(__dirname, "../../.vite-port")
		if (!fs.existsSync(portFilePath)) return DEFAULT_VITE_PORT
		const port = fs.readFileSync(portFilePath, "utf8").trim()
		return /^\d+$/.test(port) ? port : DEFAULT_VITE_PORT
	} catch {
		return DEFAULT_VITE_PORT
	}
}

async function tryHmrHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewUiView) {
	const localPort = readVitePort()
	const localServerUrl = `127.0.0.1:${localPort}`

	try {
		const response = await axios.get(`http://${localServerUrl}`, {
			timeout: HMR_PROBE_TIMEOUT_MS,
			validateStatus: () => true,
		})
		if (response.status < 200 || response.status >= 300) return undefined
	} catch {
		return undefined
	}

	const nonce = getNonce()
	const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.css"])
	const codiconsUri = getUri(webview, extensionUri, ["assets", "codicons", "codicon.css"])
	const materialIconsUri = getUri(webview, extensionUri, ["assets", "vscode-material-icons", "icons"])
	const imagesUri = getUri(webview, extensionUri, ["assets", "images"])
	const audioUri = getUri(webview, extensionUri, ["webview-ui", "audio"])
	const scriptUri = `http://${localServerUrl}/src/index.tsx`
	const csp = [
		"default-src 'none'",
		`font-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline' http://${localServerUrl}`,
		`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:`,
		`media-src ${webview.cspSource}`,
		// Nonce + strict-dynamic is required: Chromium blocks ES module graph loads (Vite client,
		// React, lazy TicketsView, mermaid) when a nonce is present without strict-dynamic.
		`script-src 'unsafe-eval' 'wasm-unsafe-eval' ${webview.cspSource} http://${localServerUrl} 'nonce-${nonce}' 'strict-dynamic'`,
		`connect-src ${webview.cspSource} https://* https://*.posthog.com ws://${localServerUrl} http://${localServerUrl}`,
	]

	return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>Alpha</title>
				</head>
				<body>
					<div id="root"${viewAttribute(view)}></div>
					<script nonce="${nonce}" type="module">
						import RefreshRuntime from "http://${localServerUrl}/@react-refresh"
						RefreshRuntime.injectIntoGlobalHook(window)
						window.$RefreshReg$ = () => {}
						window.$RefreshSig$ = () => (type) => type
						window.__vite_plugin_react_preamble_installed__ = true
					</script>
					<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
}

function getBuiltWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewUiView) {
	const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.css"])
	const scriptUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.js"])
	const codiconsUri = getUri(webview, extensionUri, ["assets", "codicons", "codicon.css"])
	const materialIconsUri = getUri(webview, extensionUri, ["assets", "vscode-material-icons", "icons"])
	const imagesUri = getUri(webview, extensionUri, ["assets", "images"])
	const audioUri = getUri(webview, extensionUri, ["webview-ui", "audio"])
	const nonce = getNonce()

	return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'; connect-src ${webview.cspSource};">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>Alpha</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"${viewAttribute(view)}></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
}
