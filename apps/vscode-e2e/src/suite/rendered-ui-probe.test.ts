import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { waitFor } from "./utils"

suite("Rendered UI probe", function () {
	this.timeout(90000)
	test("holds the actual Alpha webview for owned renderer input", async function () {
		if (!process.env.ALPHA_UI_PROBE_NONCE) this.skip()
		assert.equal(vscode.version, "1.122.1")
		const directory = process.env.ALPHA_E2E_ARTIFACTS_DIR!
		const nonce = process.env.ALPHA_UI_PROBE_NONCE!
		assert.ok(directory && nonce)
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await waitFor(() => globalThis.api.isReady(), { timeout: 20000 })
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
			{ timeout: 60000 },
		)
	})
})
