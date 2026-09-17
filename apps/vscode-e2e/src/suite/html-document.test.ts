import * as assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { setDefaultSuiteTimeout } from "./test-utils"

const html = (title: string) =>
	`<!doctype html><html><head><meta name="alpha-document" content="1"><title>${title}</title></head><body><main class="alpha-doc" data-alpha-kit="1"><h1>${title}</h1><p>Exact-host fixture.</p></main></body></html>`
const tabs = () =>
	vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter(
			(tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("alpha.htmlDocument"),
		)
async function until(predicate: () => boolean) {
	const end = Date.now() + 10000
	while (!predicate()) {
		if (Date.now() > end) throw new Error("HTML document view did not reach expected state")
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

suite("HTML document exact-host adapter", function () {
	setDefaultSuiteTimeout(this)
	test("Explorer preview opens without chat, follows edits, and closes without duplicate tabs", async () => {
		assert.equal(vscode.version, "1.122.1")
		const extensionId = process.env.ALPHA_E2E_EXTENSION_ID
		assert.ok(extensionId)
		const extension = vscode.extensions.getExtension(extensionId)
		assert.ok(extension)
		const explorerItems: { command?: string }[] = extension.packageJSON.contributes.menus["explorer/context"] ?? []
		const previewCommand = explorerItems.find((item) => item.command === "alpha.previewHtmlDocument")?.command
		assert.ok(previewCommand, "Explorer must expose the HTML document renderer")
		await vscode.commands.executeCommand("workbench.action.closeAllEditors")
		await vscode.commands.executeCommand("workbench.view.explorer")
		await until(() => vscode.window.activeTextEditor === undefined)
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(root)
		const folder = await fs.mkdtemp(path.join(root, "html-viewer-test-"))
		const first = vscode.Uri.file(path.join(folder, "first.html"))
		const second = vscode.Uri.file(path.join(folder, "second.HTM"))
		const third = vscode.Uri.file(path.join(folder, "third.html"))
		try {
			await fs.writeFile(first.fsPath, html("First document"))
			await fs.writeFile(second.fsPath, html("Second document"))
			const cold = Date.now()
			const originalGroup = vscode.window.tabGroups.activeTabGroup
			const originalGroupCount = vscode.window.tabGroups.all.length
			await vscode.commands.executeCommand(previewCommand, first)
			await until(() => tabs().some((tab) => tab.label === "First document"))
			assert.equal(tabs()[0]?.group, originalGroup)
			assert.equal(vscode.window.tabGroups.all.length, originalGroupCount, "Preview must not create a side group")
			console.log(`HTML viewer cold adapter/title: ${Date.now() - cold} ms`)
			await vscode.commands.executeCommand(previewCommand, first)
			assert.equal(tabs().length, 1)
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(first))
			// Explorer supplies the clicked URI even when a different source is active.
			await vscode.commands.executeCommand(previewCommand, second)
			await until(() => tabs().some((tab) => tab.label === "Second document"))
			assert.equal(tabs().length, 2)
			assert.ok(tabs().every((tab) => tab.group === originalGroup))
			// An active webview has no active text editor; it still owns the destination group.
			const chat = vscode.window.createWebviewPanel(
				"alpha.e2e.documentGroup",
				"Chat fixture",
				vscode.ViewColumn.Beside,
				{},
			)
			try {
				await until(() => chat.active && vscode.window.activeTextEditor === undefined)
				const chatGroup = vscode.window.tabGroups.activeTabGroup
				const groupCount = vscode.window.tabGroups.all.length
				await vscode.commands.executeCommand(previewCommand, first)
				await until(() => tabs().some((tab) => tab.label === "First document" && tab.group === chatGroup))
				assert.equal(tabs().length, 2, "Moving an existing preview must not duplicate it")
				assert.equal(vscode.window.tabGroups.all.length, groupCount)
			} finally {
				chat.dispose()
			}
			await fs.writeFile(third.fsPath, html("Third document"))
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(third))
			await vscode.commands.executeCommand("alpha.previewHtmlDocument")
			await until(() => tabs().some((tab) => tab.label === "Third document"))
			assert.equal(tabs().length, 3)
			const document = await vscode.workspace.openTextDocument(first)
			const edit = new vscode.WorkspaceEdit()
			edit.replace(
				first,
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				html("Unsaved revision"),
			)
			assert.equal(await vscode.workspace.applyEdit(edit), true)
			await until(() => tabs().some((tab) => tab.label === "Unsaved revision"))
			assert.ok(document.isDirty)
			assert.ok((await fs.readFile(first.fsPath, "utf8")).includes("First document"))
			await document.save()
			await fs.writeFile(second.fsPath, html("External revision"))
			await until(() => tabs().some((tab) => tab.label === "External revision"))
			await vscode.window.tabGroups.close(tabs())
			await until(() => tabs().length === 0)
			for (let index = 0; index < 5; index++) {
				await vscode.commands.executeCommand("alpha.previewHtmlDocument", first)
				await until(() => tabs().length === 1)
				await vscode.window.tabGroups.close(tabs())
			}
			assert.equal(tabs().length, 0)
		} finally {
			await vscode.window.tabGroups.close(tabs())
			await fs.rm(folder, { recursive: true, force: true })
		}
	})
})
