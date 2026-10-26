import * as fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"

import { WorkspaceMutationGate } from "../../core/task/WorkspaceMutationGate"
import { withFileLock } from "../../core/task-persistence/atomicWrite"
import { arePathsEqual } from "../../utils/path"

export interface MemorySummaryWriteConditions {
	expectedVersion: string | undefined
	signal: AbortSignal
	isCurrent: () => Promise<boolean>
}

export interface MemorySummaryFile {
	text?: string
	version?: string
}

interface MemorySummaryEditorOptions extends MemorySummaryWriteConditions {
	readFile: () => Promise<MemorySummaryFile>
	assertPath: () => Promise<void>
}

export type MemorySummaryWriter = (
	filePath: string,
	text: string,
	options: MemorySummaryEditorOptions,
) => Promise<boolean>

const mutationGate = new WorkspaceMutationGate()

/** Reset is explicit deletion, separate from conditional background publication. */
export async function assertMemoryDocumentsClean(
	targets: readonly string[],
	conflict = () => new Error("Save or close unsaved memory documents before resetting memories"),
): Promise<() => void> {
	const resolved = targets.map((target) => path.resolve(target))
	const includes = (candidate: string) =>
		resolved.some((target) => {
			const relative = path.relative(target, candidate)
			return (
				!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
			)
		})
	const tracked = (document: vscode.TextDocument) =>
		!document.isClosed && (document.uri.scheme === "file" || document.uri.scheme === "untitled")
	const reject = () => {
		throw conflict()
	}
	const aliases = new Set<vscode.TextDocument>()
	const documents = vscode.workspace.textDocuments.filter(tracked)
	const capturedDocuments = new Set(documents)
	for (const document of documents) {
		if (includes(path.resolve(document.uri.fsPath))) aliases.add(document)
		try {
			if (includes(await fs.realpath(document.uri.fsPath))) aliases.add(document)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	const assertClean = () => {
		if (
			vscode.workspace.textDocuments.some(
				(document) =>
					tracked(document) &&
					(!capturedDocuments.has(document) ||
						(document.isDirty && (aliases.has(document) || includes(path.resolve(document.uri.fsPath))))),
			)
		)
			reject()
	}
	assertClean()
	return assertClean
}

/**
 * Existing summaries use the host-owned version/save-conflict boundary, like skill edits.
 * Stable APIs: @types/vscode 1.125.0; host semantics: microsoft/vscode@4cd688bc (2026-10-26).
 */
export const writeMemorySummaryInDocument: MemorySummaryWriter = async (filePath, text, options) =>
	mutationGate.run(
		filePath,
		"publish memory summary",
		() =>
			withFileLock(filePath, async () => {
				const conflict = () => new Error("Memory summary changed before publication")
				const assertNoDirtyTarget = () => {
					if (
						vscode.workspace.textDocuments.some(
							(document) =>
								!document.isClosed &&
								document.isDirty &&
								(document.uri.scheme === "file" || document.uri.scheme === "untitled") &&
								arePathsEqual(document.uri.fsPath, filePath),
						)
					)
						throw conflict()
				}
				const current = async () => {
					options.signal.throwIfAborted()
					await options.assertPath()
					const allowed = await options.isCurrent()
					options.signal.throwIfAborted()
					return allowed
				}
				if (!(await current())) return false
				assertNoDirtyTarget()
				const original = await options.readFile()
				if (original.version !== options.expectedVersion) return false
				if (original.text === undefined) {
					// Link a complete private file into an absent destination atomically.
					// A concurrent creator wins with EEXIST; an unconditional rename could overwrite it.
					const temporary = path.join(path.dirname(filePath), `.memory-summary-${randomUUID()}.tmp`)
					const handle = await fs.open(temporary, "wx", 0o600)
					try {
						try {
							await handle.writeFile(text, "utf8")
							await handle.sync()
						} finally {
							await handle.close()
						}
						const assertAliasesClean = await assertMemoryDocumentsClean([filePath], conflict)
						if (!(await current())) return false
						assertNoDirtyTarget()
						assertAliasesClean()
						options.signal.throwIfAborted()
						try {
							await fs.link(temporary, filePath)
							return true
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
							throw error
						}
					} finally {
						await fs.rm(temporary, { force: true })
					}
				}

				const resolvedPath = await fs.realpath(filePath)
				if (!arePathsEqual(resolvedPath, path.resolve(filePath))) return false
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath))
				const assertSaveProtection = () => {
					if (
						vscode.workspace
							.getConfiguration("files", document)
							.get("saveConflictResolution", "askUser") !== "askUser"
					)
						throw new Error("Memory summary requires editor save-conflict protection")
				}
				assertSaveProtection()
				const version = document.version
				const originalText = document.getText()
				if (originalText !== original.text.replace(/^\uFEFF/, "")) return false
				const assertAliasesClean = await assertMemoryDocumentsClean([filePath], conflict)
				if (!(await current())) return false
				if ((await options.readFile()).version !== options.expectedVersion) return false
				assertAliasesClean()
				if (document.isClosed || document.isDirty || document.version !== version) return false
				assertSaveProtection()
				options.signal.throwIfAborted()
				const expectedText = text.replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n")
				const edit = new vscode.WorkspaceEdit()
				edit.replace(
					document.uri,
					new vscode.Range(document.positionAt(0), document.positionAt(originalText.length)),
					expectedText,
				)
				// Dispatch admits this effect, like WorkspaceMutationGate's active operation.
				// Later cancellation/source changes cannot un-dispatch it: join the protected save.
				if (!(await vscode.workspace.applyEdit(edit))) return false
				const editedVersion = document.version
				const ownsEditedDocument = () =>
					!document.isClosed &&
					document.version === editedVersion &&
					editedVersion <= version + 1 &&
					document.getText() === expectedText
				const assertEditedDocument = () => {
					if (!ownsEditedDocument()) throw conflict()
				}
				const recoverOwnedBuffer = async () => {
					if (!ownsEditedDocument()) return
					const persisted = await options.readFile()
					if (!ownsEditedDocument() || persisted.text === undefined) return
					const restoreText = persisted.text
						.replace(/^\uFEFF/, "")
						.replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n")
					const recovery = new vscode.WorkspaceEdit()
					recovery.replace(
						document.uri,
						new vscode.Range(document.positionAt(0), document.positionAt(expectedText.length)),
						restoreText,
					)
					// This versioned inverse edit is allowed only while the buffer is exactly ours.
					if (!(await vscode.workspace.applyEdit(recovery))) return
					const recoveredVersion = document.version
					if (
						document.isClosed ||
						recoveredVersion > editedVersion + 1 ||
						document.getText() !== restoreText ||
						persisted.version !== options.expectedVersion
					)
						return
					assertSaveProtection()
					// An inverse edit alone remains dirty. Join a protected save of the unchanged
					// durable bytes; a later human amendment or disk edit still wins at the host.
					if (document.version === recoveredVersion) await document.save()
				}
				let saved = false
				try {
					assertEditedDocument()
					assertSaveProtection()
					// VS Code preserves encoding/BOM and owns the modified-since disk check.
					// Never substitute a Node check followed by an unconditional write/rename.
					saved = await document.save()
					if (!saved) return false
					assertEditedDocument()
					return !document.isDirty
				} finally {
					if (!saved) await recoverOwnedBuffer()
				}
			}),
		() => options.signal.aborted,
		options.signal,
	)
