import * as vscode from "vscode"

import { AlphaProvider } from "../core/webview/AlphaProvider"

export const handleUri = async (uri: vscode.Uri, fallbackProvider?: AlphaProvider) => {
	const path = uri.path
	const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
	const provider = AlphaProvider.getVisibleInstance() ?? fallbackProvider

	if (!provider) {
		return
	}

	switch (path) {
		case "/openrouter": {
			const code = query.get("code")
			if (code) {
				await provider.handleOpenRouterCallback(code)
			}
			break
		}
		case "/requesty": {
			const code = query.get("code")
			const baseUrl = query.get("baseUrl")
			if (code) {
				await provider.handleRequestyCallback(code, baseUrl)
			}
			break
		}
		default:
			break
	}
}
