import * as vscode from "vscode"

import type { OpenDiffPayload } from "@alpha-code/types"

import { DIFF_VIEW_URI_SCHEME } from "./DiffViewProvider"

const DEFAULT_DIFF_TITLE = "Alpha Diff"

function createVirtualContentUri(identity: string, content: string): vscode.Uri {
	const normalizedIdentity = identity
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")
	return vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:/${normalizedIdentity}`).with({
		query: Buffer.from(content, "utf8").toString("base64"),
	})
}

/**
 * Opens an immutable diff from the before/after snapshots captured in a turn.
 * The content provider registered at activation makes both sides read-only,
 * so opening a historical change set never rereads or mutates the workspace.
 */
export async function openDiff(payload: OpenDiffPayload): Promise<void> {
	const title = payload.title?.trim() || DEFAULT_DIFF_TITLE
	const changes = payload.files.map((file, index) => {
		const identity = `conversation/${index}/${file.path}`
		// `vscode.changes` uses the first URI as the resource identity shown in
		// its file list. Keep that URI virtual as well: a historical diff must not
		// cause VS Code to read the current workspace file when the entry is opened.
		const display = createVirtualContentUri(file.path, file.finalContent)
		const original = createVirtualContentUri(`${identity}/before`, file.originalContent)
		const modified = createVirtualContentUri(`${identity}/after`, file.finalContent)
		return { display, original, modified }
	})

	if (changes.length === 1) {
		const [{ original, modified }] = changes
		await vscode.commands.executeCommand("vscode.diff", original, modified, title, { preserveFocus: false })
		return
	}

	await vscode.commands.executeCommand(
		"vscode.changes",
		title,
		changes.map(({ display, original, modified }) => [display, original, modified]),
	)
}
