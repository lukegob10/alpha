import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { AlphaMessage } from "@alpha-code/types"

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

function hasTaskMessageEnvelope(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const message = value as Record<string, unknown>
	// Check stable fields without stripping unknown metadata or rejecting legacy ask/say variants.
	return (
		typeof message.ts === "number" &&
		Number.isFinite(message.ts) &&
		(message.type === "ask" || message.type === "say") &&
		(message.text === undefined || typeof message.text === "string") &&
		(message.partial === undefined || typeof message.partial === "boolean")
	)
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
	requireExisting = false,
}: ReadTaskMessagesOptions): Promise<AlphaMessage[]> {
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
		if (Array.isArray(parsedData) && (!requireExisting || parsedData.every(hasTaskMessageEnvelope)))
			return parsedData
	} catch {
		// Preserve the historical tolerant reader for non-resume consumers. The
		// strict reopen path reports failure without exposing or replacing bytes.
	}
	if (requireExisting) throw new TaskMessagesReadError("invalid")
	return []
}

export type SaveTaskMessagesOptions = {
	messages: AlphaMessage[]
	taskId: string
	globalStoragePath: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	// Reopen and background readers do not hold the writer's lease. Keep the
	// previous snapshot at its canonical path until the replacement commits.
	await safeWriteJson(filePath, messages, { atomicReplace: true })
}
