import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import type { ProviderSettings } from "@alpha-code/types"
import { waitFor } from "./utils"

suite("Rendered composer", function () {
	this.timeout(120_000)
	test("holds the new-task composer for scrolling and clipping checks", async function () {
		if (!process.env.ALPHA_UI_PROBE_NONCE) this.skip()
		assert.equal(vscode.version, "1.125.0")
		const provider = (
			globalThis.api as unknown as {
				sidebarProvider: {
					upsertProviderProfile(name: string, configuration: ProviderSettings): Promise<unknown>
					activateProviderProfile(args: { name: string }): Promise<unknown>
					postStateToWebview(): Promise<void>
				}
			}
		).sidebarProvider
		await provider.upsertProviderProfile("Composer fixture", {
			apiProvider: "openai",
			openAiApiKey: "local-fixture",
			openAiBaseUrl: "http://127.0.0.1:9/v1",
			openAiModelId: "composer-fixture",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 4096,
				supportsPromptCache: false,
			},
		})
		await provider.activateProviderProfile({ name: "Composer fixture" })
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await waitFor(() => globalThis.api.isReady(), { timeout: 20_000 })
		await provider.postStateToWebview()
		const directory = process.env.ALPHA_E2E_ARTIFACTS_DIR!
		const nonce = process.env.ALPHA_UI_PROBE_NONCE!
		await fs.writeFile(path.join(directory, "ui-ready.json"), JSON.stringify({ nonce, version: vscode.version }), {
			flag: "wx",
		})
		await waitFor(
			async () => {
				try {
					return JSON.parse(await fs.readFile(path.join(directory, "ui-finish.json"), "utf8")).nonce === nonce
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			{ timeout: 90_000 },
		)
	})
})
