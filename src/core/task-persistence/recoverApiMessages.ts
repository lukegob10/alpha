import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { getToolCallId, getToolResultId, sanitizeToolUseId } from "../../utils/tool-id"
import type { ApiMessage, ApiMessagesCommitReceipt } from "./apiMessages"
import { atomicWriteText, withFileLock } from "./atomicWrite"
import {
	assertAuthoritativeTranscriptReplacementAllowed,
	ProviderTranscriptStoreError,
	serializeProviderTranscript,
} from "./ProviderTranscriptStore"
import { invalidPersistedApiMessages } from "./validatePersistedApiMessages"

/** Explicit host-approved recovery, never a tolerant fallback for ordinary reads. */
export async function recoverApiMessages({
	taskId,
	globalStoragePath,
	expectedDigest,
	discardMessageIndexes,
}: {
	taskId: string
	globalStoragePath: string
	expectedDigest: string
	/** Exact invalid records approved for removal after inspecting the original history. */
	discardMessageIndexes: readonly number[]
}): Promise<{ messages: ApiMessage[]; archivePath: string; receipt: ApiMessagesCommitReceipt }> {
	const taskDirectory = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
	return withFileLock(filePath, async () => {
		assertAuthoritativeTranscriptReplacementAllowed(filePath)
		const original = await fs.readFile(filePath)
		const digest = crypto.createHash("sha256").update(original).digest("hex")
		const reject = (message: string): never => {
			throw new ProviderTranscriptStoreError("invalid_messages", message, taskId)
		}
		if (digest !== expectedDigest) {
			throw new ProviderTranscriptStoreError("digest_mismatch", "Recovery source changed", taskId, {
				expectedDigest,
				actualDigest: digest,
			})
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(original.toString("utf8"))
		} catch {
			return reject("Recovery requires a complete JSON array; truncated history cannot be safely inferred")
		}
		if (!Array.isArray(parsed)) return reject("Recovery requires a complete history array")
		const discarded = new Set(discardMessageIndexes)
		if (
			discarded.size === 0 ||
			discarded.size !== discardMessageIndexes.length ||
			[...discarded].some((index) => !Number.isSafeInteger(index) || index < 0 || index >= parsed.length)
		) {
			return reject("Recovery requires unique, in-range invalid record indexes")
		}
		for (const index of discarded) {
			const candidate = parsed[index]
			if (!invalidPersistedApiMessages([candidate])) return reject("Recovery cannot discard a valid record")
			// Never erase partial transaction or opaque state evidence to make a history validate.
			if (candidate && typeof candidate === "object") {
				const record = candidate as Record<string, unknown>
				if (Object.keys(record).some((key) => key !== "role" && key !== "content" && key !== "ts")) {
					return reject("Recovery cannot discard records containing continuity or host provenance")
				}
				if (Array.isArray(record.content) && record.content.some((block) => typeof block !== "string")) {
					return reject("Recovery cannot discard structured content or tool transaction evidence")
				}
			}
		}
		const messages = parsed.filter((_message, index) => !discarded.has(index))
		const problem = invalidPersistedApiMessages(messages)
		if (problem) return reject(`Recovered history is invalid: ${problem}`)
		if (messages.length === 0) return reject("Recovery cannot replace history with an empty transcript")
		const calls = new Set<string>()
		const pending = new Set<string>()
		try {
			for (const message of messages) {
				if (!Array.isArray(message.content)) continue
				for (const block of message.content) {
					const call = getToolCallId(block)
					const result = getToolResultId(block)
					if (call !== undefined) {
						if (message.role !== "assistant")
							return reject("Recovery found a tool call outside assistant history")
						const canonicalId = sanitizeToolUseId(call)
						if (calls.has(canonicalId)) return reject("Recovery found duplicate tool calls")
						calls.add(canonicalId)
						pending.add(canonicalId)
					}
					if (
						result !== undefined &&
						(message.role !== "user" || !pending.delete(sanitizeToolUseId(result)))
					) {
						return reject("Recovery found an orphaned, duplicate, or out-of-order tool result")
					}
				}
			}
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError) throw error
			return reject("Recovery found ambiguous tool transaction identifiers")
		}
		if (pending.size > 0) return reject("Recovery cannot resume incomplete tool transactions")
		const archivePath = path.join(taskDirectory, `api_conversation_history.recovery-${digest}.json`)
		try {
			const archive = await fs.open(archivePath, "wx", 0o600)
			try {
				await archive.writeFile(original)
				await archive.sync()
			} finally {
				await archive.close()
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
		const archiveEntry = await fs.lstat(archivePath, { bigint: true })
		if (!archiveEntry.isFile() || archiveEntry.isSymbolicLink()) {
			return reject("Recovery archive must be an independent regular file")
		}
		const archive = await fs.open(archivePath, "r")
		try {
			const opened = await archive.stat({ bigint: true })
			const current = await fs.lstat(archivePath, { bigint: true })
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				opened.dev !== archiveEntry.dev ||
				opened.ino !== archiveEntry.ino ||
				current.dev !== opened.dev ||
				current.ino !== opened.ino ||
				!(await archive.readFile()).equals(original)
			) {
				return reject("Recovery archive verification failed")
			}
		} finally {
			await archive.close()
		}
		// POSIX needs the directory entry synced as well as the archive bytes.
		// Windows does not expose directory fsync through Node's file handles.
		if (process.platform !== "win32") {
			const directory = await fs.open(taskDirectory, "r")
			try {
				await directory.sync()
			} finally {
				await directory.close()
			}
		}
		const contents = serializeProviderTranscript(messages)
		await atomicWriteText(filePath, contents, { requireAtomicReplace: true })
		// The host must acknowledge this receipt with repairAuthoritativeTranscript before effects resume.
		return {
			messages,
			archivePath,
			receipt: Object.freeze({
				taskId,
				filePath: path.resolve(filePath),
				digest: crypto.createHash("sha256").update(contents).digest("hex"),
				byteLength: Buffer.byteLength(contents),
				commitId: crypto.randomUUID(),
			}),
		}
	})
}
