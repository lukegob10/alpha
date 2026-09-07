import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"
import * as diff from "diff"
import delay from "delay"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { createDirectoriesForFile } from "../../utils/fs"
import { arePathsEqual, getReadablePath } from "../../utils/path"
import { formatResponse } from "../../core/prompts/responses"
import { diagnosticsToProblemsString, getNewDiagnostics } from "../diagnostics"
import { Task } from "../../core/task/Task"
import { t } from "../../i18n"

import { DecorationController } from "./DecorationController"

export const DIFF_VIEW_URI_SCHEME = "cline-diff"
export const DIFF_VIEW_LABEL_CHANGES = "Original ↔ Alpha's Changes"

/**
 * The raw file state used to calculate an edit, captured before preview or approval.
 * Both save paths validate it instead of rebasing the edit onto newer content.
 */
export type ExpectedFileState = { exists: false } | { exists: true; content: string }

// TODO: https://github.com/cline/cline/pull/3354
export class DiffViewProvider {
	// Properties to store the results of saveChanges
	newProblemsMessage?: string
	userEdits?: string
	editType?: "create" | "modify"
	isEditing = false
	originalContent: string | undefined
	private expectedFileState?: ExpectedFileState
	private previewDirectory?: string
	private previewPath?: string
	private previewContent?: string
	private previewVersion?: number
	private editGeneration = 0
	private relPath?: string
	private newContent?: string
	private activeDiffEditor?: vscode.TextEditor
	private fadedOverlayController?: DecorationController
	private activeLineController?: DecorationController
	private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = []
	private taskRef: WeakRef<Task>

	constructor(
		private cwd: string,
		task: Task,
	) {
		this.taskRef = new WeakRef(task)
	}

	async open(relPath: string, expectedFileState?: ExpectedFileState): Promise<void> {
		const generation = ++this.editGeneration
		const absolutePath = path.resolve(this.cwd, relPath)
		this.relPath = relPath
		this.isEditing = true
		let previewDirectory: string | undefined
		let previewPath: string | undefined

		try {
			this.assertNoDirtyDocument(absolutePath, relPath)
			const expectedState =
				expectedFileState ??
				(this.editType === "modify"
					? { exists: true as const, content: await fs.readFile(absolutePath, "utf-8") }
					: { exists: false as const })
			await this.assertExpectedFileState(absolutePath, relPath, expectedState)
			this.assertEditingGeneration(generation)
			this.expectedFileState = { ...expectedState }
			this.originalContent = expectedState.exists ? expectedState.content : ""
			this.preDiagnostics = vscode.languages.getDiagnostics()

			// The modified side belongs to this edit session. Never open, save, or
			// stream into the user's source document just to display a proposal.
			previewDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-diff-"))
			if (generation !== this.editGeneration) {
				await fs.rmdir(previewDirectory)
				throw new Error(t("tools:diffView.editCancelled"))
			}
			this.previewDirectory = previewDirectory
			previewPath = path.join(previewDirectory, path.basename(absolutePath))
			this.previewPath = previewPath
			await fs.writeFile(previewPath, this.originalContent, { encoding: "utf-8", flag: "wx" })
			this.assertEditingGeneration(generation)
			const editor = await this.openDiffEditor()
			this.assertEditingGeneration(generation)
			this.activeDiffEditor = editor
			this.assertPreviewUnchanged(editor.document)
			this.fadedOverlayController = new DecorationController("fadedOverlay", this.activeDiffEditor)
			this.activeLineController = new DecorationController("activeLine", this.activeDiffEditor)
			this.fadedOverlayController.addLines(0, this.activeDiffEditor.document.lineCount)
			this.scrollEditorToLine(0)
		} catch (error) {
			if (generation === this.editGeneration) {
				await this.reset()
			} else if (previewPath && previewDirectory) {
				await this.cleanupPreview(previewPath, previewDirectory)
			}
			throw error
		}
	}

	async update(accumulatedContent: string, isFinal: boolean) {
		const editor = this.activeDiffEditor
		if (!this.relPath || !editor || !this.activeLineController || !this.fadedOverlayController) {
			throw new Error("Required values not set")
		}
		const generation = this.editGeneration
		const document = editor.document
		this.assertPreviewUnchanged(document)
		const version = document.version
		const lines = accumulatedContent.split("\n")
		if (!isFinal) lines.pop()
		const content = isFinal ? accumulatedContent : lines.join("\n") + (lines.length > 0 ? "\n" : "")
		const beginning = new vscode.Position(0, 0)
		editor.selection = new vscode.Selection(beginning, beginning)

		// TextEditor.edit rejects an edit if its document changed in the meantime.
		// One transaction also avoids overwriting user amendments between several
		// awaited partial replacements.
		const applied = await editor.edit((edit) => {
			edit.replace(new vscode.Range(0, 0, document.lineCount, 0), content)
		})
		this.assertEditingGeneration(generation)
		if (!applied) throw new Error(t("tools:diffView.applyContentFailed"))
		// VS Code normalizes inserted line endings to the document's EOL.
		const documentContent = document.getText()
		if (
			documentContent.replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n") ||
			document.version > version + 1
		) {
			throw new Error(t("tools:diffView.previewChangedDuringEdit"))
		}
		this.newContent = accumulatedContent
		this.rememberPreview(document)
		this.activeLineController.setActiveLine(lines.length)
		this.fadedOverlayController.updateOverlayAfterLine(lines.length, document.lineCount)
		const ranges = editor.visibleRanges
		if (ranges?.length > 0 && ranges[0].start.line < lines.length && ranges[0].end.line > lines.length) {
			this.scrollEditorToLine(lines.length)
		}
		if (isFinal) {
			this.fadedOverlayController.clear()
			this.activeLineController.clear()
		}
	}

	async saveChanges(
		diagnosticsEnabled: boolean = true,
		writeDelayMs: number = DEFAULT_WRITE_DELAY_MS,
		saveTo?: { relPath: string; expectedFileState: ExpectedFileState },
	): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		finalContent: string | undefined
	}> {
		if (!this.relPath || this.newContent === undefined || !this.activeDiffEditor || !this.expectedFileState) {
			throw new Error(t("tools:diffView.noEditAvailableToSave"))
		}
		const generation = this.editGeneration
		const sourcePath = this.relPath
		const proposedContent = this.newContent
		const document = this.activeDiffEditor.document
		const editedContent = document.getText()
		const approvedVersion = document.version
		const assertApprovedPreview = () => {
			this.assertEditingGeneration(generation)
			if (document.version !== approvedVersion || document.getText() !== editedContent) {
				throw new Error(t("tools:diffView.previewChangedAfterApproval"))
			}
		}

		// A move must validate both the source and the destination. Ordinary saves
		// validate the source in saveDirectly immediately before the write.
		if (saveTo) {
			await this.assertExpectedFileState(path.resolve(this.cwd, sourcePath), sourcePath, this.expectedFileState)
		}
		const result = await this.saveDirectly(
			saveTo?.relPath ?? sourcePath,
			editedContent,
			true,
			diagnosticsEnabled,
			writeDelayMs,
			saveTo?.expectedFileState ?? this.expectedFileState,
			assertApprovedPreview,
		)

		// Preserve editable-preview feedback while keeping finalContent identical
		// to the bytes committed by the shared save boundary.
		const eol = proposedContent.includes("\r\n") ? "\r\n" : "\n"
		const normalizedEdited = editedContent.replace(/\r\n|\n/g, eol)
		const normalizedProposed = proposedContent.replace(/\r\n|\n/g, eol)
		this.userEdits =
			normalizedEdited !== normalizedProposed
				? formatResponse.createPrettyPatch(sourcePath.toPosix(), normalizedProposed, normalizedEdited)
				: undefined
		// Only this approved revision can be released. Any later preview edit stays open.
		this.previewContent = editedContent
		this.previewVersion = approvedVersion
		await this.closeAllDiffViews()
		return { ...result, userEdits: this.userEdits }
	}

	/**
	 * Formats a standardized response for file write operations
	 *
	 * @param task Task instance to get protocol info
	 * @param cwd Current working directory for path resolution
	 * @param isNewFile Whether this is a new file or an existing file being modified
	 * @returns Formatted message (JSON)
	 */
	async pushToolWriteResult(task: Task, cwd: string, isNewFile: boolean): Promise<string> {
		if (!this.relPath) {
			throw new Error("No file path available in DiffViewProvider")
		}

		// Only send user_feedback_diff if userEdits exists
		if (this.userEdits) {
			// Create say object for UI feedback
			const say: ClineSayTool = {
				tool: isNewFile ? "newFileCreated" : "editedExistingFile",
				path: getReadablePath(cwd, this.relPath),
				diff: this.userEdits,
			}

			// Send the user feedback
			await task.say("user_feedback_diff", JSON.stringify(say))
		}

		// Build notices array
		const notices = [
			"You do not need to re-read the file, as you have seen all changes",
			"Proceed with the task using these changes as the new baseline.",
			...(this.userEdits
				? [
						"If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.",
					]
				: []),
		]

		const result: {
			path: string
			operation: "created" | "modified"
			notice: string
			user_edits?: string
			problems?: string
		} = {
			path: this.relPath,
			operation: isNewFile ? "created" : "modified",
			notice: notices.join(" "),
		}

		if (this.userEdits) {
			result.user_edits = this.userEdits
		}

		if (this.newProblemsMessage) {
			result.problems = this.newProblemsMessage
		}

		return JSON.stringify(result)
	}

	async revertChanges(): Promise<void> {
		// Source files were never used as preview storage, so denial/disposal
		// has nothing to restore or delete in the workspace.
		await this.reset()
	}

	private rememberPreview(document: vscode.TextDocument): void {
		this.previewContent = document.getText()
		this.previewVersion = document.version
	}

	private assertPreviewUnchanged(document: vscode.TextDocument): void {
		if (
			document.isClosed ||
			document.version !== this.previewVersion ||
			document.getText() !== this.previewContent
		) {
			throw new Error(t("tools:diffView.previewHasUserChanges"))
		}
	}

	private assertEditingGeneration(generation: number): void {
		if (generation !== this.editGeneration) throw new Error(t("tools:diffView.editCancelled"))
	}

	private async closeAllDiffViews(): Promise<void> {
		const previewPath = this.previewPath
		const previewDirectory = this.previewDirectory
		if (!previewPath || !previewDirectory) return
		const cleaned = await this.cleanupPreview(
			previewPath,
			previewDirectory,
			this.previewContent,
			this.previewVersion,
		)
		if (cleaned && this.previewPath === previewPath) {
			this.previewPath = undefined
			this.previewDirectory = undefined
		}
	}

	private async cleanupPreview(
		previewPath: string,
		previewDirectory: string,
		content?: string,
		version?: number,
	): Promise<boolean> {
		try {
			const document = vscode.workspace.textDocuments.find(
				(doc) => doc.uri.scheme === "file" && arePathsEqual(doc.uri.fsPath, previewPath),
			)
			// Never save, close, or delete an unapproved user amendment. Retaining
			// its preview document lets the user recover it after denial or failure.
			if (document && !document.isClosed) {
				if (document.version !== version || document.getText() !== content) return false
				if (document.isDirty) {
					const saved = await document.save()
					if (!saved || document.isDirty || document.version !== version) return false
				}
			}
			const tabs = vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter((tab) => {
					const uri =
						tab.input instanceof vscode.TabInputTextDiff
							? tab.input.modified
							: tab.input instanceof vscode.TabInputText
								? tab.input.uri
								: undefined
					return uri?.scheme === "file" && arePathsEqual(uri.fsPath, previewPath)
				})
			for (const tab of tabs) {
				if (tab.isDirty || !(await vscode.window.tabGroups.close(tab))) return false
			}
			// Recheck after closing tabs, which is asynchronous and can be declined.
			if (document && (document.isDirty || document.version !== version)) return false
			await fs.unlink(previewPath).catch((error) => {
				if (!isFileNotFoundError(error)) throw error
			})
			await fs.rmdir(previewDirectory).catch((error) => {
				if (!isFileNotFoundError(error)) throw error
			})
			return true
		} catch (error) {
			// Cleanup cannot turn a committed write into a failed tool result.
			console.warn("Could not clean up the diff preview", error)
			return false
		}
	}

	private async openDiffEditor(): Promise<vscode.TextEditor> {
		if (!this.relPath || !this.previewPath || !this.previewDirectory) {
			throw new Error(t("tools:diffView.noFilePathForOpening"))
		}
		const generation = this.editGeneration
		const relPath = this.relPath
		const previewDirectory = this.previewDirectory
		const expectedText = (this.originalContent ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
		const uri = vscode.Uri.file(this.previewPath)
		const fileName = path.basename(this.relPath)
		try {
			const editor = await vscode.window.showTextDocument(uri, {
				preview: false,
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: true,
			})
			if (editor.document.isDirty || editor.document.getText().replace(/\r\n/g, "\n") !== expectedText) {
				throw new Error(t("tools:diffView.previewChangedWhileOpening"))
			}
			if (generation !== this.editGeneration) {
				await this.cleanupPreview(
					uri.fsPath,
					previewDirectory,
					editor.document.getText(),
					editor.document.version,
				)
				throw new Error(t("tools:diffView.editCancelled"))
			}
			this.rememberPreview(editor.document)
			await vscode.commands.executeCommand(
				"vscode.diff",
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${fileName}`).with({
					query: Buffer.from(this.originalContent ?? "").toString("base64"),
				}),
				uri,
				`${fileName}: ${this.editType === "modify" ? DIFF_VIEW_LABEL_CHANGES : "New File"} (Editable)`,
				{ preserveFocus: true },
			)
			this.assertEditingGeneration(generation)
			return (
				vscode.window.visibleTextEditors.find(
					(visible) => visible.document.uri.toString() === uri.toString(),
				) ?? editor
			)
		} catch (error) {
			throw new Error(
				t("tools:diffView.openFailed", {
					path: relPath,
					message: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}

	private scrollEditorToLine(line: number) {
		if (this.activeDiffEditor) {
			const scrollLine = line + 4

			this.activeDiffEditor.revealRange(
				new vscode.Range(scrollLine, 0, scrollLine, 0),
				vscode.TextEditorRevealType.InCenter,
			)
		}
	}

	scrollToFirstDiff() {
		if (!this.activeDiffEditor) {
			return
		}

		const currentContent = this.activeDiffEditor.document.getText()
		const diffs = diff.diffLines(this.originalContent || "", currentContent)

		let lineCount = 0

		for (const part of diffs) {
			if (part.added || part.removed) {
				// Found the first diff, scroll to it without stealing focus.
				this.activeDiffEditor.revealRange(
					new vscode.Range(lineCount, 0, lineCount, 0),
					vscode.TextEditorRevealType.InCenter,
				)

				return
			}

			if (!part.removed) {
				lineCount += part.count || 0
			}
		}
	}

	async reset(): Promise<void> {
		const generation = ++this.editGeneration
		await this.closeAllDiffViews()
		if (generation !== this.editGeneration) return
		try {
			this.fadedOverlayController?.clear()
			this.activeLineController?.clear()
		} catch (error) {
			console.warn("Could not clear diff preview decorations", error)
		}
		this.newProblemsMessage = undefined
		this.userEdits = undefined
		this.editType = undefined
		this.isEditing = false
		this.originalContent = undefined
		this.relPath = undefined
		this.newContent = undefined
		this.expectedFileState = undefined
		this.previewDirectory = undefined
		this.previewPath = undefined
		this.previewContent = undefined
		this.previewVersion = undefined
		this.activeDiffEditor = undefined
		this.fadedOverlayController = undefined
		this.activeLineController = undefined
		this.preDiagnostics = []
	}

	/**
	 * Directly save content to a file without showing diff view
	 * Used when preventFocusDisruption experiment is enabled
	 *
	 * @param relPath - Relative path to the file
	 * @param content - Content to write to the file
	 * @param openFile - Whether to show the file in editor (false = open in memory only for diagnostics)
	 * @param expectedFileState - Raw file state captured before approval
	 * @returns Result of the save operation including any new problems detected
	 */
	async saveDirectly(
		relPath: string,
		content: string,
		openFile: boolean = true,
		diagnosticsEnabled: boolean = true,
		writeDelayMs: number = DEFAULT_WRITE_DELAY_MS,
		expectedFileState: ExpectedFileState,
		validateBeforeWrite?: () => void,
	): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		finalContent: string | undefined
	}> {
		const absolutePath = path.resolve(this.cwd, relPath)
		const expectedState = expectedFileState

		// Get diagnostics before editing the file
		if (!this.isEditing) this.preDiagnostics = vscode.languages.getDiagnostics()

		// Create parent directories before checking the target. This cannot create
		// the target itself, and the exclusive create below closes the remaining
		// expected-missing race.
		await createDirectoriesForFile(absolutePath)
		await this.assertExpectedFileState(absolutePath, relPath, expectedState)
		validateBeforeWrite?.()

		try {
			// An expected-missing file must never be replaced if it appeared after
			// approval. The wx flag makes that check atomic with file creation.
			await fs.writeFile(
				absolutePath,
				content,
				expectedState.exists === false ? { encoding: "utf-8", flag: "wx" } : "utf-8",
			)
		} catch (error) {
			if (expectedState.exists === false && isFileExistsError(error)) {
				throw createDirectSaveConflict(relPath, "the file was created while approval was pending")
			}

			throw error
		}

		const postWriteWarnings: string[] = []
		const recordPostWriteWarning = (message: string, error: unknown) => {
			const detail = error instanceof Error ? `: ${error.message}` : `: ${String(error)}`
			console.warn(`${message}${detail}`)
			postWriteWarnings.push(`${message}${detail}`)
		}

		// These are best-effort post-write integrations. The file is already
		// committed, so a refresh or diagnostics failure must be reported with
		// the successful write instead of throwing and misreporting the operation.
		try {
			if (openFile) {
				const editor = await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), {
					preview: false,
					preserveFocus: true,
				})
				if (editor?.document?.isDirty) {
					postWriteWarnings.push(
						`The file '${relPath}' was written, but its open editor has unsaved changes.`,
					)
				}
			} else {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
				if (doc.isDirty) {
					postWriteWarnings.push(
						`The file '${relPath}' was written, but its open editor has unsaved changes.`,
					)
				}

				// Force a small delay to ensure diagnostics are triggered
				await new Promise((resolve) => setTimeout(resolve, 100))
			}
		} catch (error) {
			recordPostWriteWarning(`The file '${relPath}' was written, but the editor could not be refreshed`, error)
		}

		let newProblemsMessage = ""

		if (diagnosticsEnabled) {
			try {
				// Add configurable delay to allow linters time to process
				const safeDelayMs = Math.max(0, writeDelayMs)
				await delay(safeDelayMs)

				const postDiagnostics = vscode.languages
					.getDiagnostics()
					.filter(
						([uri]) =>
							!this.previewPath || uri.scheme !== "file" || !arePathsEqual(uri.fsPath, this.previewPath),
					)

				// Get diagnostic settings from state
				const task = this.taskRef.deref()
				const state = await task?.providerRef.deref()?.getState()
				const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
				const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50

				const newProblems = await diagnosticsToProblemsString(
					getNewDiagnostics(this.preDiagnostics, postDiagnostics),
					[vscode.DiagnosticSeverity.Error],
					this.cwd,
					includeDiagnosticMessages,
					maxDiagnosticMessages,
				)

				newProblemsMessage =
					newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
			} catch (error) {
				recordPostWriteWarning(
					`The file '${relPath}' was written, but diagnostics could not be collected`,
					error,
				)
			}
		}

		if (postWriteWarnings.length > 0) {
			newProblemsMessage += `\n\nPost-save checks reported:\n${postWriteWarnings.join("\n")}`
		}

		// Store the results for formatFileWriteResponse
		this.newProblemsMessage = newProblemsMessage
		this.userEdits = undefined
		this.relPath = relPath
		this.newContent = content

		return {
			newProblemsMessage,
			userEdits: undefined,
			finalContent: content,
		}
	}

	async assertExpectedFileState(
		absolutePath: string,
		relPath: string,
		expectedState: ExpectedFileState,
	): Promise<void> {
		const openDocument = this.assertNoDirtyDocument(absolutePath, relPath)
		const version = openDocument?.version
		const assertEditorUnchanged = () => {
			const currentDocument = this.assertNoDirtyDocument(absolutePath, relPath)
			if (currentDocument !== openDocument || currentDocument?.version !== version) {
				throw new DirectSaveConflictError(
					t("tools:fileConflicts.save", {
						path: relPath,
						reason: t("tools:fileConflicts.reasons.editorChangedWhileChecked"),
					}),
				)
			}
		}

		if (!expectedState.exists) {
			try {
				await fs.readFile(absolutePath, "utf-8")
				throw createDirectSaveConflict(relPath, "the file was created while approval was pending")
			} catch (error) {
				if (isFileNotFoundError(error)) {
					assertEditorUnchanged()
					return
				}

				if (error instanceof DirectSaveConflictError) {
					throw error
				}

				throw createDirectSaveConflict(relPath, "the target path became unavailable while approval was pending")
			}
		}

		let currentContent: string
		try {
			currentContent = await fs.readFile(absolutePath, "utf-8")
		} catch (error) {
			if (isFileNotFoundError(error)) {
				throw createDirectSaveConflict(relPath, "the file was deleted while approval was pending")
			}

			throw error
		}

		assertEditorUnchanged()
		if (currentContent !== expectedState.content) {
			throw createDirectSaveConflict(relPath, "the file changed while approval was pending")
		}
	}

	private assertNoDirtyDocument(absolutePath: string, relPath: string): vscode.TextDocument | undefined {
		const document = vscode.workspace.textDocuments?.find(
			(document) => document.uri.scheme === "file" && arePathsEqual(document.uri.fsPath, absolutePath),
		)
		if (document?.isDirty) {
			throw createDirectSaveConflict(relPath, "the file has unsaved changes in an open editor")
		}
		return document
	}
}

class DirectSaveConflictError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DirectSaveConflictError"
	}
}

function createDirectSaveConflict(relPath: string, reason: string): DirectSaveConflictError {
	return new DirectSaveConflictError(
		`Cannot save '${relPath}': ${reason}. Re-read the file and retry so the user's changes are preserved.`,
	)
}

function isFileNotFoundError(error: unknown): boolean {
	return isFileSystemError(error, "ENOENT")
}

function isFileExistsError(error: unknown): boolean {
	return isFileSystemError(error, "EEXIST")
}

function isFileSystemError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}
