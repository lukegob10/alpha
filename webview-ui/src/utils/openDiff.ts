import type { OpenDiffFile } from "@alpha-code/types"
import { vscode } from "./vscode"

export interface ReviewFile {
	path: string
	diff: string
	originalContent?: string
	finalContent?: string
}

/** Review captured data only; older transcripts can supply a patch without full snapshots. */
export function openFileDiffs(files: ReviewFile[], title: string, fallbackTitle: string): void {
	if (files.length === 0) return
	const safeTitle = title.length <= 256 ? title : fallbackTitle
	const snapshots: OpenDiffFile[] = files.flatMap(({ path, originalContent, finalContent }) =>
		originalContent !== undefined && finalContent !== undefined ? [{ path, originalContent, finalContent }] : [],
	)
	if (snapshots.length === files.length && files.length <= 128) {
		vscode.postMessage({ type: "openDiff", payload: { title: safeTitle, files: snapshots } })
	} else {
		vscode.postMessage({
			type: "openDiff",
			payload: {
				title: safeTitle,
				patch: {
					path: files.length === 1 ? files[0].path : "review",
					content: files
						.map(({ path, diff }) => (diff.startsWith("Index: ") ? diff : `Index: ${path}\n${diff}`))
						.join("\n\n"),
				},
			},
		})
	}
}
