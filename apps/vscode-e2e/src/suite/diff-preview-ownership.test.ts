import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"

import type { RooCodeSettings } from "@alpha-code/types"

import { waitFor } from "./utils"

type ExpectedState = { exists: false } | { exists: true; content: string }
interface HostDiffView {
	editType?: "modify" | "create"
	open(relativePath: string, expectedState: ExpectedState): Promise<void>
	update(content: string, isFinal: boolean): Promise<void>
	saveChanges(diagnostics: boolean, delay: number): Promise<{ finalContent?: string; userEdits?: string }>
	saveDirectly(
		relativePath: string,
		content: string,
		openFile: boolean,
		diagnostics: boolean,
		delay: number,
		expectedState: ExpectedState,
	): Promise<{ finalContent?: string }>
	revertChanges(): Promise<void>
	reset(): Promise<void>
}

interface PreviewRuntime {
	gate: Promise<void>
	release(): void
	requested: boolean
	removeFromCache?: () => void
}

// The Task owns the real bundled DiffViewProvider. Hold its offline model request
// while the test exercises preview/approval/denial with actual VS Code documents.
const runtimes = new WeakMap<object, PreviewRuntime>()
class PreviewScriptedAI {
	readonly id = "diff-preview-ownership-e2e"

	constructor() {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		runtimes.set(this, { gate, release, requested: false })
	}

	get removeFromCache(): (() => void) | undefined {
		return runtimes.get(this)?.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		runtimes.get(this)!.removeFromCache = value
	}

	async *createMessage(): AsyncGenerator<{ type: "text"; text: string }> {
		const runtime = runtimes.get(this)!
		runtime.requested = true
		await runtime.gate
		yield { type: "text", text: "Preview fixture finished." }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8192, supportsImages: false, supportsPromptCache: false },
		}
	}
	async countTokens(): Promise<number> {
		return 1
	}
	async completePrompt(): Promise<string> {
		return ""
	}
}

async function replace(editor: vscode.TextEditor, content: string): Promise<void> {
	assert.equal(
		await editor.edit((edit) => {
			edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), content)
		}),
		true,
	)
}

suite("Diff preview ownership in the Extension Host", function () {
	this.timeout(90_000)

	test("background saves preserve focus, tabs, cursor position, and unsaved typing", async () => {
		assert.equal(vscode.version, "1.122.1")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const prefix = `background-edit-${randomUUID()}`
		const workingPath = `${prefix}-working.txt`
		const targetPath = `${prefix}-target.txt`
		const createdPath = `${prefix}-created.txt`
		const workingUri = vscode.Uri.file(path.join(workspace, workingPath))
		const targetUri = vscode.Uri.file(path.join(workspace, targetPath))
		const createdUri = vscode.Uri.file(path.join(workspace, createdPath))
		const uris = [workingUri, targetUri, createdUri]
		const ownedUris = new Set(uris.map((uri) => uri.toString()))
		const api = globalThis.api
		const configuration = api.getConfiguration()
		const host = (
			api as unknown as {
				sidebarProvider: { getLiveTask(id: string): { diffViewProvider: HostDiffView } | undefined }
			}
		).sidebarProvider
		const scripted = new PreviewScriptedAI()
		let provider: HostDiffView | undefined
		let focusListener: vscode.Disposable | undefined
		let saveListener: vscode.Disposable | undefined

		try {
			await fs.writeFile(workingUri.fsPath, "working file\n", { flag: "wx" })
			await fs.writeFile(targetUri.fsPath, "original\n", { flag: "wx" })
			const taskId = await api.startNewTask({
				text: "Exercise the offline background editing fixture.",
				configuration: {
					...configuration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					autoApprovalEnabled: false,
					experiments: { preventFocusDisruption: true },
					diagnosticsEnabled: true,
					writeDelayMs: 0,
					requestDelaySeconds: 0,
					enableCheckpoints: false,
				},
			})
			await waitFor(() => runtimes.get(scripted)!.requested && !!host.getLiveTask(taskId), {
				description: "the background editing fixture to own its save boundary",
			})
			provider = host.getLiveTask(taskId)!.diffViewProvider
			const workingEditor = await vscode.window.showTextDocument(workingUri, { preview: false })
			await replace(workingEditor, "unsaved typing\n")
			workingEditor.selection = new vscode.Selection(0, 3, 0, 7)
			const selection = workingEditor.selection
			const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
			const focusChanges: string[] = []
			let saves = 0
			focusListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
				focusChanges.push(editor?.document.uri.toString() ?? "none")
			})
			saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
				if (ownedUris.has(document.uri.toString())) saves++
			})

			// Closed-file creation and modification must not open any editor tabs,
			// even when the document is loaded in memory for diagnostics.
			const created = await provider.saveDirectly(createdPath, "created\n", false, true, 0, { exists: false })
			assert.equal(created.finalContent, "created\n")
			await provider.reset()
			await provider.saveDirectly(targetPath, "updated\n", false, true, 0, {
				exists: true,
				content: "original\n",
			})
			assert.equal(await fs.readFile(createdUri.fsPath, "utf8"), "created\n")
			assert.equal(await fs.readFile(targetUri.fsPath, "utf8"), "updated\n")
			assert.deepEqual(
				vscode.window.tabGroups.all.flatMap((group) => group.tabs),
				tabs,
			)
			assert.deepEqual(focusChanges, [])
			assert.equal(vscode.window.activeTextEditor, workingEditor)
			assert.ok(workingEditor.selection.isEqual(selection))
			assert.equal(workingEditor.document.getText(), "unsaved typing\n")
			assert.equal(workingEditor.document.isDirty, true)
			assert.equal(await fs.readFile(workingUri.fsPath, "utf8"), "working file\n")
			assert.equal(saves, 0)

			// An open clean document refreshes; an open dirty document is protected.
			const targetEditor = await vscode.window.showTextDocument(targetUri, {
				preview: false,
				viewColumn: vscode.ViewColumn.Beside,
				preserveFocus: true,
			})
			focusChanges.length = 0
			await provider.saveDirectly(targetPath, "updated again\n", false, true, 0, {
				exists: true,
				content: "updated\n",
			})
			await waitFor(() => targetEditor.document.getText() === "updated again\n", {
				description: "the clean target buffer to observe a background write",
			})
			assert.equal(targetEditor.document.isDirty, false)
			await replace(targetEditor, "unsaved target edit\n")
			await assert.rejects(
				provider.saveDirectly(targetPath, "must not overwrite", false, true, 0, {
					exists: true,
					content: "updated again\n",
				}),
				/unsaved changes/,
			)
			assert.equal(await fs.readFile(targetUri.fsPath, "utf8"), "updated again\n")
			assert.equal(targetEditor.document.getText(), "unsaved target edit\n")
			assert.equal(targetEditor.document.isDirty, true)
			assert.deepEqual(focusChanges, [])
			assert.equal(saves, 0)
		} finally {
			focusListener?.dispose()
			saveListener?.dispose()
			await provider?.reset()
			runtimes.get(scripted)!.release()
			await api.clearCurrentTask().catch(() => undefined)
			scripted.removeFromCache?.()
			await api.setConfiguration(configuration)
			for (const document of vscode.workspace.textDocuments) {
				if (ownedUris.has(document.uri.toString()) && document.isDirty) await document.save()
			}
			const ownedTabs = vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter((tab) => tab.input instanceof vscode.TabInputText && ownedUris.has(tab.input.uri.toString()))
			await vscode.window.tabGroups.close(ownedTabs, true)
			for (const uri of uris) {
				await fs.unlink(uri.fsPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error
				})
			}
		}
	})

	test("preserves source buffers across preview, approval, conflict, and denial", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace, "The isolated test runner must supply ALPHA_E2E_WORKSPACE")
		const relativePath = `diff-preview-${randomUUID()}.txt`
		const filePath = path.join(workspace, relativePath)
		const uri = vscode.Uri.file(filePath)
		const api = globalThis.api
		const host = (
			api as unknown as {
				sidebarProvider?: { getLiveTask(id: string): { diffViewProvider: HostDiffView } | undefined }
			}
		).sidebarProvider
		assert.ok(host)
		const scripted = new PreviewScriptedAI()
		let provider: HostDiffView | undefined
		let sourceDocument: vscode.TextDocument | undefined
		let sourceSaveCount = 0
		const saved = vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.toString() === uri.toString()) sourceSaveCount++
		})
		const original = "before\n"

		try {
			await fs.writeFile(filePath, original, { encoding: "utf8", flag: "wx" })
			const configuration: RooCodeSettings = {
				...api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				autoApprovalEnabled: false,
				experiments: { preventFocusDisruption: false },
				diagnosticsEnabled: false,
				writeDelayMs: 0,
				requestDelaySeconds: 0,
				enableCheckpoints: false,
			}
			const taskId = await api.startNewTask({ configuration, text: "Exercise the offline diff preview fixture." })
			await waitFor(() => runtimes.get(scripted)!.requested && !!host.getLiveTask(taskId), {
				description: "the scripted task to own its diff provider",
				interval: 25,
			})
			provider = host.getLiveTask(taskId)!.diffViewProvider
			const sourceEditor = await vscode.window.showTextDocument(uri, { preview: false })
			sourceDocument = sourceEditor.document

			// A preexisting dirty buffer must never be saved as a preview side effect.
			await replace(sourceEditor, "unsaved user text\n")
			provider.editType = "modify"
			await assert.rejects(provider.open(relativePath, { exists: true, content: original }), /unsaved changes/)
			assert.equal(await fs.readFile(filePath, "utf8"), original)
			assert.equal(sourceDocument.getText(), "unsaved user text\n")
			assert.equal(sourceDocument.isDirty, true)
			assert.equal(sourceSaveCount, 0)
			await provider.reset()

			// Restore only this test-created fixture, then exercise a real editable diff.
			await replace(sourceEditor, original)
			assert.equal(await sourceDocument.save(), true)
			sourceSaveCount = 0
			provider.editType = "modify"
			await provider.open(relativePath, { exists: true, content: original })
			await provider.update("proposal\n", true)
			assert.equal(await fs.readFile(filePath, "utf8"), original)
			assert.equal(sourceDocument.getText(), original)
			assert.equal(sourceDocument.isDirty, false)
			const findPreviewTab = () =>
				vscode.window.tabGroups.all
					.flatMap((group) => group.tabs)
					.find(
						(tab) =>
							tab.input instanceof vscode.TabInputTextDiff &&
							tab.input.original.scheme === "cline-diff" &&
							path.basename(tab.input.modified.fsPath) === relativePath,
					)
			await waitFor(() => !!findPreviewTab(), { description: "the owned diff tab", interval: 25 })
			const diffTab = findPreviewTab()
			assert.ok(diffTab?.input instanceof vscode.TabInputTextDiff)
			const previewUri = diffTab.input.modified
			assert.notEqual(previewUri.toString(), uri.toString())
			const preview = await vscode.window.showTextDocument(previewUri, { preserveFocus: true })
			await replace(preview, "approved user amendment\n")
			const result = await provider.saveChanges(false, 0)
			assert.equal(result.finalContent, "approved user amendment\n")
			assert.ok(result.userEdits)
			await assert.rejects(fs.access(previewUri.fsPath), { code: "ENOENT" })
			assert.equal(await fs.readFile(filePath, "utf8"), result.finalContent)
			assert.equal(sourceSaveCount, 0)
			await waitFor(() => sourceDocument!.getText() === result.finalContent && !sourceDocument!.isDirty, {
				description: "the source editor to refresh after approval",
			})
			await provider.reset()

			// Denial preserves concurrent source-buffer edits and never saves them.
			const approved = "approved user amendment\n"
			provider.editType = "modify"
			await provider.open(relativePath, { exists: true, content: approved })
			await provider.update("unapproved proposal\n", true)
			await replace(await vscode.window.showTextDocument(uri), "concurrent user edit\n")
			await assert.rejects(provider.saveChanges(false, 0), /unsaved changes/)
			await provider.revertChanges()
			assert.equal(await fs.readFile(filePath, "utf8"), approved)
			assert.equal(sourceDocument.getText(), "concurrent user edit\n")
			assert.equal(sourceDocument.isDirty, true)
			assert.equal(sourceSaveCount, 0)
		} finally {
			saved.dispose()
			await provider?.reset()
			runtimes.get(scripted)!.release()
			await api.clearCurrentTask().catch(() => undefined)
			scripted.removeFromCache?.()
			// Only test-owned files/tabs are touched; never close the host's windows.
			if (sourceDocument?.isDirty) await sourceDocument.save()
			for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
					await vscode.window.tabGroups.close(tab)
				}
			}
			await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error
			})
		}
	})
})
