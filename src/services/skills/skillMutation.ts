import * as fs from "fs/promises"
import * as vscode from "vscode"
import matter from "gray-matter"

import { WorkspaceMutationGate } from "../../core/task/WorkspaceMutationGate"
import { withFileLock } from "../../core/task-persistence/atomicWrite"
import { t } from "../../i18n"

// Settings mutations have no Task owner. Share the existing gate across catalogs,
// and the file lease across extension windows, using the resolved skill identity.
const mutationGate = new WorkspaceMutationGate()

export async function updateSkillModesInDocument(
	filePath: string,
	modeSlugs: string[],
	assertWritablePath: (candidate: string) => Promise<void>,
): Promise<void> {
	const resolvedPath = await fs.realpath(filePath)
	await assertWritablePath(resolvedPath)
	const conflict = () => new Error(t("skills:errors.edit_conflict", { path: filePath }))
	const assertNoDirtyAliases = async (ownedDocument?: vscode.TextDocument) => {
		for (const document of vscode.workspace.textDocuments) {
			if (
				document === ownedDocument ||
				document.isClosed ||
				!document.isDirty ||
				document.uri.scheme !== "file"
			) {
				continue
			}
			try {
				if ((await fs.realpath(document.uri.fsPath)) === resolvedPath) throw conflict()
			} catch (error) {
				// An unrelated document may have been deleted while still open.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
	}
	await mutationGate.run(resolvedPath, "update skill modes", () =>
		withFileLock(resolvedPath, async () => {
			await assertWritablePath(resolvedPath)
			if ((await fs.realpath(filePath)) !== resolvedPath) throw conflict()
			await assertNoDirtyAliases()
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath))
			if (document.isClosed || document.isDirty) throw conflict()
			const assertSaveProtection = () => {
				if (
					vscode.workspace.getConfiguration("files", document).get("saveConflictResolution", "askUser") !==
					"askUser"
				) {
					throw new Error(t("skills:errors.save_conflict_protection"))
				}
			}
			assertSaveProtection()
			const version = document.version
			const originalText = document.getText()
			const diskText = await fs.readFile(resolvedPath, "utf-8")
			await assertNoDirtyAliases()
			// VS Code retains the encoding/BOM separately from TextDocument text.
			if (
				document.isClosed ||
				document.isDirty ||
				document.version !== version ||
				diskText.replace(/^\uFEFF/, "") !== originalText
			) {
				throw conflict()
			}

			const parsed = matter(originalText)
			const frontmatter: Record<string, unknown> = { ...parsed.data, modeSlugs }
			delete frontmatter.mode
			// Strip stringify's synthetic empty-body newline and edit only the header.
			// Instruction bytes, including their final newline, remain in the document.
			const header = matter
				.stringify("", frontmatter)
				.slice(0, -1)
				.replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n")
			const expectedText = header + parsed.content
			const edit = new vscode.WorkspaceEdit()
			edit.replace(
				document.uri,
				new vscode.Range(
					document.positionAt(0),
					document.positionAt(originalText.length - parsed.content.length),
				),
				header,
			)
			// No await separates snapshot validation from applyEdit: VS Code captures
			// this open document's version and rejects changes before host application.
			if (!(await vscode.workspace.applyEdit(edit))) throw conflict()
			const editedVersion = document.version
			const assertEditedDocument = () => {
				if (
					document.isClosed ||
					document.version !== editedVersion ||
					editedVersion > version + 1 ||
					document.getText() !== expectedText
				) {
					throw conflict()
				}
			}
			assertEditedDocument()
			if ((await fs.readFile(resolvedPath, "utf-8")) !== diskText) throw conflict()
			await assertNoDirtyAliases(document)
			assertEditedDocument()
			assertSaveProtection()
			// The host save owns its modified-since check. A separate Node check and
			// write/rename would not be a disk compare-and-swap. Never force or fall back.
			if (!(await document.save())) throw conflict()
			assertEditedDocument()
			if (document.isDirty) throw conflict()
		}),
	)
}
