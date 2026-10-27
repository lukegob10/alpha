import * as vscode from "vscode"

import { Package } from "../shared/package"
import { AlphaProvider } from "../core/webview/AlphaProvider"

export const handleNewTask = async (params: { prompt?: string } | null | undefined) => {
	const prompt = params?.prompt

	if (!prompt) {
		await vscode.commands.executeCommand(`${Package.name}.plusButtonClicked`)
		return
	}

	await AlphaProvider.handleCodeAction("newTask", "NEW_TASK", { userInput: prompt })
}
