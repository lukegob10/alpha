import fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as vscode from "vscode"

import { t } from "../../i18n"
import { arePathsEqual } from "../../utils/path"
import { resolvePathWithExistingAncestor } from "./pathSafety"

export type ImageOutputState = {
	resolvedPath: string
	file: { exists: false } | { exists: true; content: Buffer; stat: BigIntStats }
}

const imageOutputConflictReasons = {
	unsavedChanges: "tools:fileConflicts.reasons.destinationUnsavedChanges",
	notRegularFile: "tools:fileConflicts.reasons.destinationNotRegularFile",
	changedDuringInspection: "tools:fileConflicts.reasons.destinationChangedDuringInspection",
	pathChanged: "tools:fileConflicts.reasons.destinationPathChanged",
	createdAfterInspection: "tools:fileConflicts.reasons.destinationCreatedAfterInspection",
	deletedAfterInspection: "tools:fileConflicts.reasons.destinationDeletedAfterInspection",
	changedAfterInspection: "tools:fileConflicts.reasons.destinationChangedAfterInspection",
} as const

export class ImageOutputWriteError extends Error {
	constructor(displayPath: string, cause: unknown) {
		super(
			t("tools:imageOutput.writeIncomplete", {
				path: displayPath,
				cause: cause instanceof Error ? cause.message : String(cause),
			}),
			{ cause },
		)
	}
}

function conflict(displayPath: string, reason: keyof typeof imageOutputConflictReasons): Error {
	return new Error(
		t("tools:fileConflicts.saveDestination", {
			path: displayPath,
			reason: t(imageOutputConflictReasons[reason]),
		}),
	)
}

function assertClean(absolutePath: string, displayPath: string): void {
	const resolvedPath = resolvePathWithExistingAncestor(absolutePath)
	const matches = (uri: vscode.Uri) =>
		uri.scheme === "file" &&
		(arePathsEqual(uri.fsPath, absolutePath) ||
			arePathsEqual(resolvePathWithExistingAncestor(uri.fsPath), resolvedPath))
	const dirtyDocument = vscode.workspace.textDocuments?.some((document) => document.isDirty && matches(document.uri))
	const dirtyTab = vscode.window.tabGroups?.all.some((group) =>
		group.tabs.some((tab) => {
			if (!tab.isDirty) return false
			const input = tab.input
			return (
				((vscode.TabInputText && input instanceof vscode.TabInputText) ||
					(vscode.TabInputCustom && input instanceof vscode.TabInputCustom)) &&
				matches(input.uri)
			)
		}),
	)
	if (dirtyDocument || dirtyTab) throw conflict(displayPath, "unsavedChanges")
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	)
}

/** Capture bytes without decoding them, before either approval or remote generation can yield. */
export async function captureImageOutputState(absolutePath: string, displayPath: string): Promise<ImageOutputState> {
	assertClean(absolutePath, displayPath)
	const resolvedPath = resolvePathWithExistingAncestor(absolutePath)
	let stat: BigIntStats
	try {
		stat = await fs.lstat(absolutePath, { bigint: true })
	} catch (error) {
		if (error.code === "ENOENT") return { resolvedPath, file: { exists: false } }
		throw error
	}
	if (!stat.isFile()) throw conflict(displayPath, "notRegularFile")
	const content = await fs.readFile(absolutePath)
	if (!sameFile(stat, await fs.lstat(absolutePath, { bigint: true }))) {
		throw conflict(displayPath, "changedDuringInspection")
	}
	return { resolvedPath, file: { exists: true, content, stat } }
}

/**
 * Fence the long approval/generation waits. Exclusive creation protects a missing
 * target; an existing target is opened without creating or truncating it, then
 * compared through that handle. This is optimistic validation, not an OS lock
 * against an unrelated process writing the same inode during the final write.
 */
export async function writeImageOutput(
	absolutePath: string,
	displayPath: string,
	content: Buffer,
	expected: ImageOutputState,
	beforeWrite: () => void,
	onSaved: () => void,
): Promise<void> {
	const checkScope = () => {
		beforeWrite()
		assertClean(absolutePath, displayPath)
		if (!arePathsEqual(expected.resolvedPath, resolvePathWithExistingAncestor(absolutePath))) {
			throw conflict(displayPath, "pathChanged")
		}
	}
	checkScope()
	let handle: Awaited<ReturnType<typeof fs.open>>
	try {
		handle = await fs.open(absolutePath, expected.file.exists ? "r+" : "wx")
	} catch (error) {
		if (error.code === "EEXIST") throw conflict(displayPath, "createdAfterInspection")
		if (error.code === "ENOENT") throw conflict(displayPath, "deletedAfterInspection")
		throw error
	}
	// Exclusive creation is the commit boundary for a missing output. Finish its
	// owned handle if cancellation/policy changes while open resolves: the file
	// already exists, and unlinking it could remove a concurrent replacement.
	let mutationStarted = !expected.file.exists
	let saved = false
	let failure: unknown
	try {
		if (expected.file.exists) {
			const baseline = expected.file
			if (
				!sameFile(baseline.stat, await handle.stat({ bigint: true })) ||
				!baseline.content.equals(await handle.readFile()) ||
				!sameFile(baseline.stat, await fs.lstat(absolutePath, { bigint: true }))
			) {
				throw conflict(displayPath, "changedAfterInspection")
			}
			checkScope()
		}
		mutationStarted = true
		// readFile advanced the handle's position; writes must explicitly start at zero.
		let offset = 0
		while (offset < content.length) {
			const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset)
			if (bytesWritten === 0)
				throw new Error(`Failed to finish writing '${displayPath}'; the file may be incomplete.`)
			offset += bytesWritten
		}
		await handle.truncate(content.length)
		saved = true
		onSaved()
	} catch (error) {
		failure = error
	}
	try {
		await handle.close()
	} catch (error) {
		failure ??= error
	}
	if (failure) {
		if (mutationStarted && !saved) throw new ImageOutputWriteError(displayPath, failure)
		throw failure
	}
}
