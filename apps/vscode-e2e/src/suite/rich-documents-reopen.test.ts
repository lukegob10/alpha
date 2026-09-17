import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { waitFor } from "./utils"

suite("Rich document reopen in a new installed host", function () {
	this.timeout(30_000)
	test("opens the persisted authored bytes without creating a task or regenerating content", async function () {
		if (process.env.TEST_FILE !== "rich-documents-reopen.test") this.skip()
		assert.equal(vscode.version, "1.122.1")
		const expectedDirectory = process.env.ALPHA_E2E_INSTALLED_EXTENSION_DIR
		const expectedPath = process.env.ALPHA_RICH_REOPEN_PATH
		const expectedHash = process.env.ALPHA_RICH_REOPEN_SHA256
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(expectedDirectory && expectedPath && expectedHash && artifacts)
		assert.match(expectedHash, /^[a-f0-9]{64}$/)
		const extension = vscode.extensions.getExtension("AlphaInc.alpha")!
		assert.ok(extension?.isActive)
		assert.equal(extension.exports, globalThis.api)
		assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(expectedDirectory))
		assert.equal(extension.packageJSON.version, process.env.ALPHA_E2E_INSTALLED_EXTENSION_VERSION)
		const workspace = await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath)
		const source = await fs.realpath(expectedPath)
		const relative = path.relative(workspace, source)
		assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith(".."))
		const bytes = await fs.readFile(source)
		const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex")
		assert.equal(digest(bytes), expectedHash)
		assert.ok(bytes.toString("utf8").includes("Scripted revision 3"))
		const uri = vscode.Uri.file(source)
		const tabs = () =>
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter(
					(tab) =>
						tab.input instanceof vscode.TabInputWebview &&
						tab.input.viewType.includes("alpha.htmlDocument"),
				)
		try {
			await vscode.commands.executeCommand("alpha.previewHtmlDocument", uri)
			await waitFor(() => tabs().some((tab) => tab.label === "Document revision fixture 3"), {
				timeout: 15_000,
				description: "persisted document accepted in a new host",
			})
			assert.equal(tabs().length, 1)
			const document = await vscode.workspace.openTextDocument(uri)
			assert.equal(document.isDirty, false)
			assert.equal(document.getText().replace(/\r\n/g, "\n"), bytes.toString("utf8").replace(/\r\n/g, "\n"))
			assert.equal(digest(await fs.readFile(source)), expectedHash)
			await fs.writeFile(
				path.join(artifacts, "rich-documents-reopen.json"),
				JSON.stringify(
					{
						hostVersion: vscode.version,
						extensionPath: extension.extensionPath,
						documentUri: uri.toString(),
						sourceSha256: expectedHash,
						acceptedTitle: "Document revision fixture 3",
						unchangedPersistedSource: true,
						newTaskCreated: false,
						unverified: [
							"webview DOM paint",
							"source-reference click (this authored fixture has no source anchors)",
						],
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		} finally {
			await vscode.window.tabGroups.close(tabs())
		}
	})
})
