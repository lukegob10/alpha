import * as assert from "node:assert/strict"
import * as vscode from "vscode"
import type { HistoryItem } from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"

interface HistoryFixtureHost {
	updateTaskHistory(item: HistoryItem, options: { broadcast: boolean }): Promise<unknown>
	postStateToWebview(): Promise<void>
}

suite("Inline Chats rendered history", function () {
	this.timeout(240_000)
	test("retains the composer and searchable history across host themes", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.122.1")
		const provider = (globalThis.api as unknown as { sidebarProvider: HistoryFixtureHost }).sidebarProvider
		await globalThis.api.setConfiguration({
			apiProvider: "openai",
			openAiApiKey: "local-fixture",
			openAiModelId: "fixture",
		})
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace)
		const titles = [
			"hello world and test launch 2 subagents but just close them",
			"hello world",
			"Investigate and fix scroll bar issue",
			"Review workspace cancellation handling",
			"Can you clean out the docs folder and keep the useful guides?",
		]
		for (let index = 0; index < 40; index++) {
			await provider.updateTaskHistory(
				{
					id: `history-visual-${index}`,
					task: `${titles[index % titles.length]}${index > 4 ? ` (${index})` : ""}`,
					ts: Date.now() - (index + 1) * 86_400_000,
					number: index + 1,
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0,
					workspace,
				},
				{ broadcast: false },
			)
			if (index === 2) {
				await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
				await provider.postStateToWebview()
				await uiFixtureBarrier("chats-small", { version: vscode.version })
			}
		}
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await provider.postStateToWebview()
		for (const [stage, theme] of [
			["chats-dark", "Default Dark Modern"],
			["chats-light", "Default Light Modern"],
			["chats-contrast", "Default High Contrast"],
		] as const) {
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", theme, vscode.ConfigurationTarget.Global)
			await uiFixtureBarrier(stage, { version: vscode.version })
		}
	})
})
