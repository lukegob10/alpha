import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@alpha-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
	/** Reopening existing tasks must not interpret unreadable history as a new empty task. */
	requireExisting?: boolean
}

export class TaskMessagesReadError extends Error {
	constructor(readonly kind: "not_found" | "invalid" | "io_error") {
		super(`Unable to load saved task messages (${kind})`)
		this.name = "TaskMessagesReadError"
	}
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
	requireExisting = false,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	let contents: string
	try {
		contents = await fs.readFile(filePath, "utf8")
	} catch (error) {
		const kind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "io_error"
		if (requireExisting) throw new TaskMessagesReadError(kind)
		return []
	}
	try {
		const parsedData: unknown = JSON.parse(contents)
		if (Array.isArray(parsedData)) return parsedData
	} catch {
		// Preserve the historical tolerant reader for non-resume consumers. The
		// strict reopen path reports failure without exposing or replacing bytes.
	}
	if (requireExisting) throw new TaskMessagesReadError("invalid")
	return []
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages)
}
