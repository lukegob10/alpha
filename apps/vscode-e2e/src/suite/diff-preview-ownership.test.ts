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
