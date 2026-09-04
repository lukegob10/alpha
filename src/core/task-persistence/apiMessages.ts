import * as path from "path"
import * as fs from "fs/promises"
import crypto from "crypto"

import { Anthropic } from "@anthropic-ai/sdk"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { atomicWriteText, withFileLock } from "./atomicWrite"
import {
	assertAuthoritativeTranscriptMissing,
	assertAuthoritativeTranscriptReplacementAllowed,
	ProviderTranscriptStoreError,
	serializeProviderTranscript,
	withLegacyTranscriptMigration,
} from "./ProviderTranscriptStore"

/** Receipt for the exact canonical bytes written by the authoritative writer. */
export interface ApiMessagesCommitReceipt {
	taskId: string
	filePath: string
	digest: string
	byteLength: number
	commitId: string
}

export type ApiMessage = Anthropic.MessageParam & {
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	if (await fileExistsAtPath(filePath)) {
		const fileContent = await fs.readFile(filePath, "utf8")
		try {
			const parsedData = JSON.parse(fileContent)
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readApiMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${filePath}`,
				)
				return []
			}
			if (parsedData.length === 0) {
				console.error(
					`[Alpha-Debug] readApiMessages: Found API conversation history file, but it's empty (parsed as []). TaskId: ${taskId}, Path: ${filePath}`,
				)
			}
			return parsedData
		} catch (error) {
			console.warn(
				`[readApiMessages] Error parsing API conversation history file, returning empty. TaskId: ${taskId}, Path: ${filePath}, Error: ${error}`,
			)
			return []
		}
	} else {
		return withLegacyTranscriptMigration(filePath, taskId, async () => {
			const oldPath = path.join(taskDir, "claude_messages.json")

			if (await fileExistsAtPath(oldPath)) {
				const fileContent = await fs.readFile(oldPath, "utf8")
				let parsedData: unknown
				try {
					parsedData = JSON.parse(fileContent)
				} catch (error) {
					console.warn(
						`[readApiMessages] Error parsing OLD API conversation history file (claude_messages.json), returning empty. TaskId: ${taskId}, Path: ${oldPath}, Error: ${error}`,
					)
					// DO NOT unlink oldPath if parsing failed.
					return []
				}

				if (!Array.isArray(parsedData)) {
					console.warn(
						`[readApiMessages] Parsed OLD data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${oldPath}`,
					)
					return []
				}
				if (parsedData.length === 0) {
					console.error(
						`[Alpha-Debug] readApiMessages: Found OLD API conversation history file (claude_messages.json), but it's empty (parsed as []). TaskId: ${taskId}, Path: ${oldPath}`,
					)
				}

				try {
					// Commit the replacement before removing the fallback. resumeTaskFromHistory
					// reads twice, so deleting the only durable copy here loses the task.
					await writeApiMessages({ messages: parsedData, taskId, globalStoragePath, onlyIfMissing: true })
					await fs.unlink(oldPath)
				} catch (error) {
					// An admission conflict is not permission to serve an obsolete prefix.
					if (error instanceof ProviderTranscriptStoreError) throw error
					// Keep serving the parsed fallback and retain whichever durable copy
					// remains. A later read can safely retry the idempotent migration.
					console.warn(
						`[readApiMessages] Failed to migrate OLD API conversation history file. TaskId: ${taskId}, Old path: ${oldPath}, New path: ${filePath}, Error: ${error}`,
					)
				}

				return parsedData
			}
			// If we reach here, neither the new nor the old history file was found.
			console.error(
				`[Alpha-Debug] readApiMessages: API conversation history file not found for taskId: ${taskId}. Expected at: ${filePath}`,
			)
			return []
		})
	}
}

export async function saveApiMessages(input: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessagesCommitReceipt> {
	return writeApiMessages(input)
}

async function writeApiMessages({
	messages,
	taskId,
	globalStoragePath,
	onlyIfMissing = false,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	onlyIfMissing?: boolean
}): Promise<ApiMessagesCommitReceipt> {
	// Serialize before awaiting: caller mutation during filesystem I/O cannot
	// change either the intended snapshot or its receipt. Canonical bytes match
	// the existing in-memory digest fence, including unknown provider metadata.
	const contents = serializeProviderTranscript(messages)
	const digest = crypto.createHash("sha256").update(contents).digest("hex")
	const byteLength = Buffer.byteLength(contents)
	const commitId = crypto.randomUUID()
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	await withFileLock(filePath, async () => {
		// Check inside the lock: a verifier may have detected a conflict while
		// this writer was already queued. All Task generations share this guard.
		assertAuthoritativeTranscriptReplacementAllowed(filePath)
		if (onlyIfMissing) await assertAuthoritativeTranscriptMissing(filePath, taskId)
		await atomicWriteText(filePath, contents, { requireAtomicReplace: true })
	})
	return Object.freeze({ taskId, filePath: path.resolve(filePath), digest, byteLength, commitId })
}
