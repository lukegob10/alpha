import fs from "node:fs/promises"
import path from "node:path"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { invalidPersistedApiMessages } from "../task-persistence/validatePersistedApiMessages"
import {
	digestProviderTranscript,
	providerTranscriptEnvelopeSchema,
	providerTranscriptReceiptSchema,
} from "../task-persistence/ProviderTranscriptStore"

async function readThreadHistoryText(
	file: string,
	signal?: AbortSignal,
	maxBytes?: number,
): Promise<string | undefined> {
	signal?.throwIfAborted()
	try {
		const stats = await fs.lstat(file)
		signal?.throwIfAborted()
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Thread history is not a regular file")
		if (stats.size > (maxBytes ?? 128 * 1024 * 1024))
			throw new Error("Thread history exceeds the supported read size")
		if (maxBytes !== undefined) {
			const handle = await fs.open(file, "r")
			try {
				const opened = await handle.stat()
				if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev || opened.size > maxBytes)
					throw new Error("Thread history changed while opening")
				const chunks: Buffer[] = []
				let length = 0
				while (length <= maxBytes) {
					signal?.throwIfAborted()
					const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - length + 1))
					const { bytesRead } = await handle.read(chunk, 0, chunk.length, length)
					if (!bytesRead) break
					chunks.push(chunk.subarray(0, bytesRead))
					length += bytesRead
				}
				if (length > maxBytes) throw new Error("Thread history exceeds the supported read size")
				signal?.throwIfAborted()
				return Buffer.concat(chunks, length).toString("utf8")
			} finally {
				await handle.close()
			}
		}
		const contents = await fs.readFile(file, { encoding: "utf8", signal })
		signal?.throwIfAborted()
		return contents
	} catch (error) {
		signal?.throwIfAborted()
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

async function assertThreadFallbackAllowed(
	directory: string,
	taskId: string,
	signal?: AbortSignal,
	maxBytes?: number,
): Promise<void> {
	const contents = await readThreadHistoryText(
		path.join(directory, GlobalFileNames.providerTranscript),
		signal,
		maxBytes,
	)
	if (contents === undefined) return
	let value: unknown
	try {
		value = JSON.parse(contents)
	} catch {
		// A v1 sidecar does not own the legacy fallback. If that fallback is also
		// absent, the ordinary sidecar reader below will report its invalid JSON.
		return
	}
	if (!value || typeof value !== "object" || !("version" in value) || value.version !== 2) return
	const receipt = providerTranscriptReceiptSchema.safeParse(value)
	if (!receipt.success || receipt.data.taskId !== taskId)
		throw new Error("The saved authoritative transcript receipt is invalid for this thread")
	// A v2 receipt records the sole authority. An old Claude file cannot replace
	// missing acknowledged bytes during inspection or become a new fork's history.
	throw new Error("The thread's authoritative conversation history is missing")
}

/** Inspect saved evidence without creating directories or migrating the source conversation. */
export async function readThreadApiMessages(
	taskId: string,
	storagePath: string,
	signal?: AbortSignal,
	options?: { maxBytes?: number },
): Promise<ApiMessage[]> {
	signal?.throwIfAborted()
	const maxBytes = options?.maxBytes
	if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024))
		throw new Error("Invalid thread history read limit")
	const directory = await resolveExistingTaskDirectoryPathReadOnly(storagePath, taskId)
	signal?.throwIfAborted()
	for (const name of [
		GlobalFileNames.apiConversationHistory,
		"claude_messages.json",
		GlobalFileNames.providerTranscript,
	]) {
		signal?.throwIfAborted()
		if (name === "claude_messages.json") await assertThreadFallbackAllowed(directory, taskId, signal, maxBytes)
		const file = path.join(directory, name)
		const contents = await readThreadHistoryText(file, signal, maxBytes)
		if (contents === undefined) continue
		let value: unknown
		try {
			value = JSON.parse(contents)
		} catch {
			throw new Error("The saved thread conversation contains invalid JSON")
		}
		let messages: unknown = value
		if (name === GlobalFileNames.providerTranscript) {
			const envelope = providerTranscriptEnvelopeSchema.safeParse(value)
			if (!envelope.success || envelope.data.taskId !== taskId)
				throw new Error("The saved provider transcript has no valid conversation for this thread")
			messages = envelope.data.messages
			if (
				!invalidPersistedApiMessages(messages) &&
				digestProviderTranscript(messages as ApiMessage[]) !== envelope.data.digest
			)
				throw new Error("The saved provider transcript digest does not match its conversation")
		}
		const error = invalidPersistedApiMessages(messages)
		if (error) throw new Error(`Unable to inspect saved thread history: ${error}`)
		return messages as ApiMessage[]
	}
	throw new Error("The thread has no saved conversation history")
}
