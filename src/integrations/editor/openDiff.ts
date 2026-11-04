import * as vscode from "vscode"

import type { OpenDiffPayload, OpenDiffPatchPayload } from "@alpha-code/types"

import { Package } from "../../shared/package"

import { DIFF_VIEW_URI_SCHEME } from "./diffViewConstants"

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
export async function openDiff(payload: OpenDiffPayload | OpenDiffPatchPayload): Promise<void> {
	// Sidebar reviews use the main editor. Editor chats keep the conversation visible on the left.
	const group = vscode.window.tabGroups.activeTabGroup
	const input = group.activeTab?.input
	const chatViewType = `${Package.name}.TabPanelProvider`
	// The tab API exposes VS Code's internal prefix for extension webview panels on both supported hosts.
	if (
		input instanceof vscode.TabInputWebview &&
		(input.viewType === chatViewType || input.viewType === `mainThreadWebview-${chatViewType}`)
	) {
		await vscode.commands.executeCommand("workbench.action.focusRightGroupWithoutWrap")
		if (vscode.window.tabGroups.activeTabGroup === group) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}
	}
	const title = payload.title?.trim() || DEFAULT_DIFF_TITLE
	if ("patch" in payload) {
		const resource = createVirtualContentUri(`patch/${payload.patch.path}.diff`, payload.patch.content)
		await vscode.commands.executeCommand("vscode.open", resource, { preserveFocus: false, preview: false }, title)
		return
	}
	const changes = payload.files.map((file, index) => {
		const identity = `conversation/${index}/${file.path}`
		// `vscode.changes` uses the first URI as the resource identity shown in
		// its file list. Keep that URI virtual as well: a historical diff must not
		// cause VS Code to read the current workspace file when the entry is opened.
		const display = createVirtualContentUri(file.path, file.finalContent)
		// Equal paths preserve file labels/languages and avoid falsely marking every edit as a rename.
		// The content query distinguishes immutable before/after documents.
		const original = createVirtualContentUri(identity, file.originalContent)
		const modified = createVirtualContentUri(identity, file.finalContent)
		return { display, original, modified }
	})

	if (changes.length === 1) {
		const [{ original, modified }] = changes
		await vscode.commands.executeCommand("vscode.diff", original, modified, title, {
			preserveFocus: false,
			preview: false,
		})
		return
	}

	await vscode.commands.executeCommand(
		"vscode.changes",
		title,
		changes.map(({ display, original, modified }) => [display, original, modified]),
	)
}
